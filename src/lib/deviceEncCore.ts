/**
 * Device enc-key binding rules — pure core (mobile 0.58.0, sdk-js 0.67.0,
 * l2-node 0.142.0+ `bound` rows). React-Native-free so `node --test` pins it;
 * `deviceEnc.ts` wires it to SecureStore / AsyncStorage / the SDK.
 *
 *  - {@link semverAtLeast} / {@link nodeReportsBinding} / {@link nodeHasFeature}:
 *    capability checks against a node's `/health`.
 *  - {@link RebindBackoff}: own-device RE-binding (a row the node serves
 *    `bound: false`) is rate-limited per (wallet, device, enc_pub) —
 *    1 h → 4 h → 24 h between attempts, 1 h after a 429 — because the node
 *    allows only 10 DeviceEnc envelopes per hour per wallet and a hostile or
 *    confused node could otherwise make every connect spend one.
 *  - {@link selectStaleOwnRows}: only rows whose WALLET-SIGNED binding verifies
 *    for OUR device id are ever revoked (a node must not be able to make us
 *    revoke another device's key by serving it under our device id).
 */

/** Minimum l2-node version that stores and reports `bound` + `wallet_signature` on enc-key rows. */
export const BINDING_MIN_NODE_VERSION = '0.142.0';

/** Feature flag of node-arbitrated key epochs (sdk-js `FEATURE_KEY_COMMITMENT_V1`). */
export const FEATURE_KEY_COMMITMENT = 'key_commitment_v1';

/**
 * True when `version` (e.g. "0.143.0", "v0.143.0-rc1") is >= `min`. Anything
 * unparseable is false (fail closed: an unknown node is treated as old).
 */
export function semverAtLeast(version: unknown, min: string): boolean {
  const parse = (v: unknown): [number, number, number] | null => {
    if (typeof v !== 'string') return null;
    const m = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})/.exec(v.trim());
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
  };
  const a = parse(version);
  const b = parse(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]!;
  }
  return true;
}

/** Minimal `/health` shape these checks read. */
export interface HealthLike {
  version?: unknown;
  features?: unknown;
}

/** Whether the node lists `feature` in `/health.features` (absent list = older node = false). */
export function nodeHasFeature(health: HealthLike | null | undefined, feature: string): boolean {
  return !!health && Array.isArray(health.features) && health.features.includes(feature);
}

/**
 * Whether a `bound: false` own row on this node really means "re-bind me":
 * only nodes >= 0.142.0 store wallet signatures. Against an older node a
 * re-bind can never produce a bound row (it would only burn the 10/h budget).
 */
export function nodeReportsBinding(health: HealthLike | null | undefined): boolean {
  return !!health && semverAtLeast(health.version, BINDING_MIN_NODE_VERSION);
}

/** Delays between own-device re-bind attempts (1 h, 4 h, then 24 h for every later one). */
export const REBIND_DELAYS_MS = [60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000] as const;
/** Wait after a 429 from the DeviceEnc endpoint (the node's window is 1 h). */
export const REBIND_RATE_LIMIT_DELAY_MS = 60 * 60_000;
/** Entries kept (per wallet store); oldest evicted. */
export const MAX_REBIND_ENTRIES = 64;

interface RebindEntry {
  /** Attempts so far. */
  n: number;
  /** Earliest next attempt (local ms). */
  next: number;
}

/**
 * Per-(wallet, device, enc_pub) re-bind backoff. Serializable (`toJson` /
 * `fromJson`) so a restart does not reset it.
 */
export class RebindBackoff {
  private readonly m = new Map<string, RebindEntry>();

  static key(wallet: string, deviceId: string, encPubHex: string): string {
    return `${wallet}|${deviceId.toLowerCase()}|${encPubHex.toLowerCase()}`;
  }

  /** Parse persisted JSON, dropping malformed entries (never throws). */
  static fromJson(raw: string | null): RebindBackoff {
    const b = new RebindBackoff();
    if (!raw) return b;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object' && !Array.isArray(o)) {
        for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
          if (b.m.size >= MAX_REBIND_ENTRIES) break;
          const e = v as { n?: unknown; next?: unknown } | null;
          if (typeof k === 'string' && k.length <= 256 && e && Number.isSafeInteger(e.n) && Number.isSafeInteger(e.next)
            && (e.n as number) >= 0 && (e.next as number) >= 0) {
            b.m.set(k, { n: e.n as number, next: e.next as number });
          }
        }
      }
    } catch { /* corrupt → no backoff state (worst case one extra attempt) */ }
    return b;
  }

  toJson(): string {
    return JSON.stringify(Object.fromEntries(this.m));
  }

  /** May a re-bind for `k` be attempted at `now`? */
  allowed(k: string, now: number): boolean {
    const e = this.m.get(k);
    return !e || now >= e.next;
  }

  /** Ms until the next allowed attempt (0 = now). */
  remainingMs(k: string, now: number): number {
    const e = this.m.get(k);
    return e ? Math.max(0, e.next - now) : 0;
  }

  /**
   * Record an attempt at `now`: the next one waits 1 h, then 4 h, then 24 h;
   * `rateLimited` (a 429) waits 1 h without advancing the ladder.
   */
  record(k: string, now: number, rateLimited = false): void {
    const n = this.m.get(k)?.n ?? 0;
    const entry: RebindEntry = rateLimited
      ? { n, next: now + REBIND_RATE_LIMIT_DELAY_MS }
      : { n: n + 1, next: now + REBIND_DELAYS_MS[Math.min(n, REBIND_DELAYS_MS.length - 1)]! };
    this.m.delete(k); // re-insert as the newest entry (eviction drops the oldest)
    this.m.set(k, entry);
    while (this.m.size > MAX_REBIND_ENTRIES) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }

  /** Whether `k` has backoff state. */
  has(k: string): boolean {
    return this.m.has(k);
  }

  /** The row is bound now: forget its backoff. */
  clear(k: string): void {
    this.m.delete(k);
  }

  get size(): number {
    return this.m.size;
  }
}

/** An enc-key directory row (subset). */
export interface OwnEncRow {
  device_id?: string;
  enc_pub?: string;
  bound?: boolean;
  revoked?: boolean;
}

/**
 * The rows to REVOKE after this device bound a new enc key: rows for OUR
 * device id with a different `enc_pub` whose wallet-signed binding VERIFIES
 * (`verify(row) === 'bound'` — the signature covers `device_id` and the
 * wallet, so a verifying row really is one of our own device's old keys).
 * Unbound / invalid / revoked rows are never revoked by us: the node could
 * have served another device's (or a fabricated) row under our device id.
 * Verification errors count as "not ours" (fail closed: nothing revoked).
 */
export async function selectStaleOwnRows<R extends OwnEncRow>(
  rows: readonly R[],
  deviceId: string,
  currentEncPub: string,
  verify: (row: R) => Promise<'bound' | 'unbound' | 'invalid'>,
): Promise<R[]> {
  const did = deviceId.toLowerCase();
  const cur = currentEncPub.toLowerCase();
  const out: R[] = [];
  for (const row of Array.isArray(rows) ? rows.slice(0, 32) : []) {
    if (!row || typeof row.enc_pub !== 'string' || typeof row.device_id !== 'string') continue;
    if (row.device_id.toLowerCase() !== did || row.enc_pub.toLowerCase() === cur) continue;
    if (row.revoked === true || row.bound !== true) continue;
    let status: 'bound' | 'unbound' | 'invalid' = 'invalid';
    try {
      status = await verify(row);
    } catch {
      status = 'invalid';
    }
    if (status === 'bound') out.push(row);
  }
  return out;
}
