/**
 * Private-channel "verify before cover" — pure core (mobile 0.58.0, protocol
 * §3.9.2, clients spec §8.4 item 5, sdk-js 0.66.0).
 *
 * Before this client wraps a PRIVATE channel's epoch key to anyone (cover-on-
 * join, first establishment, rotation) it no longer trusts the node's member
 * list: every other member is run through the SDK's `filterVerifiedMembers`,
 * which re-verifies the raw signed membership evidence locally. Only members
 * that verify have their enc keys fetched and get a wrap. The caller's OWN
 * wallet is always included explicitly (never sent to the verifier). Anything
 * that cannot be verified is simply not covered — FAIL CLOSED; the member
 * stays in the existing "waiting for key" state until a later pass verifies.
 *
 * React-Native-free and dependency-injected (like `keyVaultCore.ts`) so the
 * account-switch and persistence rules are pinned by `node --test`; the
 * runner cannot resolve modules that import `react-native`/Expo.
 *
 * Per-wallet trust state ({@link PchanTrustStore}): the creator PIN per
 * channel (sdk-js integrator guidance — persist the first established creator
 * and pass it as `pinnedCreator` forever after; a pin always wins over
 * whatever `ChannelCreate` a node serves) and the caller-kept `seenRemovals`
 * (wallet → newest verified Kick/Ban timestamp, from any node). Persisted in
 * NEW AsyncStorage keys namespaced `<base>::<wallet>` (walletScope.ts), so a
 * sign-out wipe removes them with the rest of the account; nothing here
 * touches the vault / SecureStore formats.
 *
 * Account switches: every flow captures its account first and re-checks
 * `stillValid()` after EVERY await (and inside every retried request, see
 * {@link guarded}); on a mismatch it returns `null` / throws
 * {@link AccountChangedError} and neither publishes a key envelope nor writes
 * trust state. A pass that cannot run safely for any OTHER reason (unknown
 * network, unreadable trust state) throws {@link CoverSkippedError}.
 */

/** One wrap target: a member device's enc key (same shape as dmCrypto `Target`). */
export interface CoverTarget {
  target: string;
  deviceId: string;
  encPub: string;
  createdAt: number;
}

/** An enc-key directory row as served by `GET /users/{addr}/enc-keys`. */
export interface EncKeyRow {
  device_id: string;
  enc_pub: string;
  created_at?: number;
  ts?: number;
  revoked?: boolean;
  bound?: boolean;
  wallet_signature?: string;
}

/** The subset of the SDK's `FilterVerifiedMembersResult` this module needs. */
export interface FilterResultLike {
  verified: string[];
  rejected: { wallet: string; reason: string }[];
  creator?: string;
  creatorSource?: string;
  incomplete: boolean;
}

/** Options handed to the injected filter (a subset of the SDK's options). */
export interface FilterOptionsLike {
  network: string;
  pinnedCreator?: string;
  allowUnderivedCreator: false;
  seenRemovals: Map<string, number>;
}

/** Enc-key binding verdict (SDK `verifyEncKeyBinding().status`). */
export type BindingStatus = 'bound' | 'unbound' | 'invalid';

// --- Errors ---------------------------------------------------------------------

/** The account changed mid-flow; nothing further may be published or written. */
export class AccountChangedError extends Error {
  constructor() {
    super('account changed during channel key operation');
    this.name = 'AccountChangedError';
  }
}

/** A cover pass was skipped because it could not run safely (NOT an account change). */
export class CoverSkippedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`channel cover skipped: ${reason}`);
    this.name = 'CoverSkippedError';
    this.reason = reason;
  }
}

/**
 * Wrap a request so the account is re-checked IMMEDIATELY before every
 * attempt — including each retry after a backoff sleep inside `withRetry`
 * — throwing {@link AccountChangedError} instead of sending.
 */
export function guarded<T>(stillValid: () => boolean, fn: () => Promise<T>): () => Promise<T> {
  return () => {
    if (!stillValid()) return Promise.reject(new AccountChangedError());
    return fn();
  };
}

// --- Bounds -------------------------------------------------------------------

/**
 * Wallets handed to ONE `filterVerifiedMembers` call. Equal to the node's
 * per-request cap (`MAX_MEMBER_PROOF_ADDRESSES`), so the number of
 * `member-proofs` requests is the same as letting the SDK chunk — the node
 * allows 20 requests / 60 s per wallet — but we get to YIELD to the UI
 * between chunks: on Hermes the verifier's Ed25519 work is a pure-JS
 * microtask chain that would otherwise run back-to-back for every chunk.
 */
export const VERIFY_CHUNK = 100;
/** Hard cap on members considered per pass (the member listing itself caps at 10k). */
export const MAX_MEMBERS_PER_PASS = 10_000;
/** Channels with a persisted creator pin, per wallet. New pins beyond this are refused (never evict a pin). */
export const MAX_PINNED_CHANNELS = 4096;
/** Channels with persisted seen removals, per wallet. New channels beyond this are not recorded. */
export const MAX_SEEN_CHANNELS = 512;
/** Seen removals kept per channel (newest timestamps win). */
export const MAX_SEEN_PER_CHANNEL = 2048;
/**
 * Enc-key rows examined per member: only rows the node serves `bound: true`
 * are candidates (an unbound row is never wrapped to in a private channel,
 * so it must not take a slot), newest `created_at` first, then this many.
 * Equal to the node's per-wallet directory cap (10): an honest node never
 * serves more, and a node padding one member's directory with junk "bound"
 * rows cannot force more than this many signature checks for that member.
 */
export const MAX_KEYS_PER_MEMBER = 10;

/**
 * The enc-key rows of one member that a PRIVATE cover verifies: filter to
 * well-formed `bound === true` rows FIRST, then newest `created_at` first,
 * then cap at {@link MAX_KEYS_PER_MEMBER}. Filtering before the cap matters:
 * slicing first let a node push a member's real bound rows out of the
 * examined window with newer unbound junk (mobile 0.58.0 audit).
 */
export function selectBoundRows(rows: unknown): EncKeyRow[] {
  return (Array.isArray(rows) ? (rows as EncKeyRow[]) : [])
    .filter((row) => row && typeof row.enc_pub === 'string' && typeof row.device_id === 'string' && row.bound === true)
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0))
    .slice(0, MAX_KEYS_PER_MEMBER);
}
/** Fresh (uncached) binding verifications between two UI yields. */
export const BINDING_YIELD_EVERY = 16;
/** Binding verdicts remembered per account. */
export const MAX_BINDING_CACHE = 2048;

/**
 * Seen-removal entries kept per WALLET across all channels. Each channel is
 * its own AsyncStorage row (Android's AsyncStorage refuses rows over ~2 MB, a
 * single blob of 512 channels x 2048 entries would have hit it), and this
 * global cap bounds the total: a channel that would push past it keeps its
 * NEWEST entries (its oldest are evicted).
 */
export const MAX_SEEN_TOTAL = 65_536;

/** AsyncStorage bases (NEW keys, per wallet via `::<wallet>` — never vault/SecureStore keys). */
export const PIN_STORE_BASE = 'ogmara.pchan.creatorPins';
/**
 * Pre-release (unreleased 0.58.0 draft) single-blob seen-removals row. Read
 * once for migration into the per-channel rows, then removed.
 */
export const SEEN_STORE_BASE = 'ogmara.pchan.seenRemovals';
/** Per-channel seen-removals row: `${SEEN_CHANNEL_BASE}.${network}:${channelId}::<wallet>`. */
export const SEEN_CHANNEL_BASE = 'ogmara.pchan.seen';
/** Per-wallet index `{ "<network>:<channelId>": entryCount }` (caps only; rows are read regardless). */
export const SEEN_INDEX_BASE = 'ogmara.pchan.seenIndex';
/** The storage base of one channel's seen-removals row. */
export const seenChannelBase = (trustKey: string): string => `${SEEN_CHANNEL_BASE}.${trustKey}`;

/** The only networks this client covers on. Anything else fails closed. */
export const KNOWN_NETWORKS = ['mainnet', 'testnet'] as const;
export type KnownNetwork = (typeof KNOWN_NETWORKS)[number];
export const isKnownNetwork = (n: unknown): n is KnownNetwork =>
  n === 'mainnet' || n === 'testnet';

const isKlvAddress = (a: unknown): a is string =>
  typeof a === 'string' && a.startsWith('klv1') && a.length >= 10 && a.length <= 128;
const isTs = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * l2-node `PRIVATE_CHANNEL_ID_FLOOR` (`src/messages/types.rs`, 2^32): the node
 * accepts a `Private` create only above it and every other type only below
 * it. Mirrors `privateInvite.ts` (pinned equal by a test).
 */
export const PRIVATE_CHANNEL_ID_FLOOR = 2 ** 32;

/**
 * True unless `id` is a positive safe integer BELOW the floor — i.e. the id
 * itself says "private" (or is not a valid public id). A node's claim that
 * such a channel is public is never honoured for key cover (B1).
 */
export function isPrivateRangeId(id: number): boolean {
  return !(Number.isSafeInteger(id) && id > 0 && id < PRIVATE_CHANNEL_ID_FLOOR);
}

/** Trust-state key for a channel: channel ids are only meaningful per network. */
export const channelTrustKey = (network: string, channelId: number): string => `${network}:${channelId}`;

// --- Per-wallet trust state -------------------------------------------------------

/** Outcome of {@link PchanTrustState.pinIfAbsent}. */
export type PinOutcome = 'pinned' | 'exists' | 'cap' | 'invalid';

/** Outcome of {@link PchanTrustState.mergeSeen}. */
export interface MergeSeenOutcome {
  changed: boolean;
  /** The channel was new and the per-wallet channel cap refused it. */
  channelRefused: boolean;
  /** Entries dropped by the per-channel cap (oldest timestamps). */
  dropped: number;
}

/** Parse one seen-removals map `{ wallet: ts }`, dropping malformed entries (never throws). */
function parseSeenMap(v: unknown): Map<string, number> {
  const m = new Map<string, number>();
  if (!v || typeof v !== 'object' || Array.isArray(v)) return m;
  for (const [w, ts] of Object.entries(v as Record<string, unknown>)) {
    if (isKlvAddress(w) && isTs(ts)) m.set(w, ts);
  }
  return capSeen(m).kept;
}

/**
 * One wallet's creator pins + seen removals (in memory; persisted by the store).
 *
 * Seen removals are stored ONE ROW PER CHANNEL (mobile 0.58.0 audit: a single
 * blob of every channel's removals could exceed Android AsyncStorage's ~2 MB
 * row limit) and loaded lazily per channel ({@link PchanTrustStore.ensureSeen}).
 * `seenCounts` is the cap view over every channel known on disk or in memory.
 */
export class PchanTrustState {
  readonly pins = new Map<string, string>();
  /** Seen removals of the channels held in memory. */
  readonly seen = new Map<string, Map<string, number>>();
  /** Entries per channel (index on disk ∪ rows in memory) — used for the caps only. */
  readonly seenCounts = new Map<string, number>();
  /** Channels whose per-channel row was read from disk this session. */
  readonly seenLoaded = new Set<string>();
  /** Channels whose row must be written by the next persist. */
  readonly dirtySeen = new Set<string>();
  /** The pre-release single-blob row was migrated and must be removed once rows are written. */
  legacySeenPending = false;

  /**
   * Parse persisted JSON, dropping anything malformed (never throws).
   * `legacySeenRaw` is the pre-release single-blob row (migrated into
   * per-channel rows on the next persist); `indexRaw` the per-wallet count index.
   */
  static fromJson(pinsRaw: string | null, legacySeenRaw: string | null, indexRaw: string | null = null): PchanTrustState {
    const s = new PchanTrustState();
    try {
      const p = pinsRaw ? JSON.parse(pinsRaw) : null;
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        for (const [k, v] of Object.entries(p)) {
          if (s.pins.size >= MAX_PINNED_CHANNELS) break;
          if (typeof k === 'string' && k.length <= 64 && isKlvAddress(v)) s.pins.set(k, v);
        }
      }
    } catch { /* corrupt → no pins (verification falls back to the id derivation) */ }
    try {
      const ix = indexRaw ? JSON.parse(indexRaw) : null;
      if (ix && typeof ix === 'object' && !Array.isArray(ix)) {
        for (const [k, n] of Object.entries(ix)) {
          if (s.seenCounts.size >= MAX_SEEN_CHANNELS) break;
          if (typeof k === 'string' && k.length <= 64 && isTs(n)) s.seenCounts.set(k, Math.min(n, MAX_SEEN_PER_CHANNEL));
        }
      }
    } catch { /* corrupt index → caps start from the rows read later */ }
    if (legacySeenRaw !== null && legacySeenRaw !== undefined) {
      // Remove the old row once its content is written to per-channel rows
      // (also when it is corrupt: nothing in it is recoverable).
      s.legacySeenPending = true;
      try {
        const r = JSON.parse(legacySeenRaw);
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          for (const [k, v] of Object.entries(r)) {
            if (typeof k !== 'string' || k.length > 64) continue;
            const m = parseSeenMap(v);
            if (m.size === 0) continue;
            // Merge (union, max) — never let the old blob shrink a row.
            s.mergeSeen(k, m);
          }
        }
      } catch { /* corrupt → no seen removals */ }
    }
    return s;
  }

  /** Parse one per-channel row (never throws). */
  static parseSeenRow(raw: string | null): Map<string, number> {
    if (!raw) return new Map();
    try {
      return parseSeenMap(JSON.parse(raw));
    } catch {
      return new Map();
    }
  }

  pinsJson(): string {
    return JSON.stringify(Object.fromEntries(this.pins));
  }

  /** The JSON of one channel's row. */
  seenRowJson(key: string): string {
    return JSON.stringify(Object.fromEntries(this.seen.get(key) ?? []));
  }

  /** The per-wallet count index. */
  seenIndexJson(): string {
    return JSON.stringify(Object.fromEntries(this.seenCounts));
  }

  /**
   * Install a row read from disk: UNION (max) with anything already in memory
   * for that channel (a merge that ran before the read must not be lost, and
   * the disk row must not be shrunk by it either).
   */
  installSeenRow(key: string, fromDisk: Map<string, number>): void {
    this.seenLoaded.add(key);
    if (fromDisk.size === 0) return;
    const cur = this.seen.get(key);
    if (!cur) {
      this.seen.set(key, fromDisk);
      this.seenCounts.set(key, fromDisk.size);
      return;
    }
    this.mergeSeen(key, fromDisk);
  }

  /** The creator pinned for `key`, if any. */
  pin(key: string): string | undefined {
    return this.pins.get(key);
  }

  /** True when `channelId` carries a pin under ANY known network (W1: the node's network claim is untrusted). */
  hasPinAnyNetwork(channelId: number): boolean {
    return KNOWN_NETWORKS.some((n) => this.pins.has(channelTrustKey(n, channelId)));
  }

  /**
   * Pin `creator` for `key` unless a pin already exists (a pin is NEVER
   * overwritten — it is the root of trust).
   */
  pinIfAbsent(key: string, creator: string): PinOutcome {
    if (this.pins.has(key)) return 'exists';
    if (!isKlvAddress(creator)) return 'invalid';
    if (this.pins.size >= MAX_PINNED_CHANNELS) return 'cap';
    this.pins.set(key, creator);
    return 'pinned';
  }

  /** A COPY of the seen removals for `key` (handed to the verifier, which mutates it). */
  seenCopy(key: string): Map<string, number> {
    return new Map(this.seen.get(key) ?? []);
  }

  /** Entries held for every channel except `key` (the global cap's view). */
  private seenTotalExcept(key: string): number {
    let n = 0;
    for (const [k, c] of this.seenCounts) if (k !== key) n += c;
    return n;
  }

  /**
   * Merge `update` INTO the stored seen removals (union, max timestamp) — never
   * replaces the stored map with the verifier's view. Caps: a NEW channel past
   * {@link MAX_SEEN_CHANNELS} is refused; a channel keeps its newest
   * {@link MAX_SEEN_PER_CHANNEL} entries, fewer when the wallet-wide
   * {@link MAX_SEEN_TOTAL} would otherwise be exceeded (oldest evicted).
   */
  mergeSeen(key: string, update: Map<string, number>): MergeSeenOutcome {
    const cur = this.seen.get(key);
    const isNew = !cur && !this.seenCounts.has(key);
    if (!cur && update.size === 0) return { changed: false, channelRefused: false, dropped: 0 };
    if (isNew && this.seenCounts.size >= MAX_SEEN_CHANNELS) return { changed: false, channelRefused: true, dropped: 0 };
    const next = new Map(cur ?? []);
    let changed = false;
    for (const [w, ts] of update) {
      if (!isKlvAddress(w) || !isTs(ts)) continue;
      const prev = next.get(w);
      if (prev === undefined || ts > prev) {
        next.set(w, ts);
        changed = true;
      }
    }
    if (!changed) return { changed: false, channelRefused: false, dropped: 0 };
    const limit = Math.min(MAX_SEEN_PER_CHANNEL, MAX_SEEN_TOTAL - this.seenTotalExcept(key));
    if (limit <= 0) return { changed: false, channelRefused: isNew, dropped: update.size };
    const c = capSeen(next, limit);
    this.seen.set(key, c.kept);
    this.seenCounts.set(key, c.kept.size);
    this.dirtySeen.add(key);
    return { changed: true, channelRefused: false, dropped: c.dropped };
  }
}

/** Keep the newest `limit` removals (by timestamp). */
function capSeen(m: Map<string, number>, limit = MAX_SEEN_PER_CHANNEL): { kept: Map<string, number>; dropped: number } {
  if (m.size <= limit) return { kept: m, dropped: 0 };
  return {
    kept: new Map([...m].sort((a, b) => b[1] - a[1]).slice(0, limit)),
    dropped: m.size - limit,
  };
}

/** Storage I/O for {@link PchanTrustStore}: EXPLICIT-wallet reads/writes (walletScope `*For`). */
export interface TrustStorageIo {
  read(wallet: string, base: string): Promise<string | null>;
  write(wallet: string, base: string, value: string): Promise<void>;
  /** Remove a row (used once, for the pre-release seen blob). Optional: skipped when absent. */
  remove?(wallet: string, base: string): Promise<void>;
}

/**
 * Loads, memoizes and persists {@link PchanTrustState} per wallet.
 *
 * `reset()` (registered as a wallet-switch reset) drops every memoized state,
 * so a run holding an old state object only ever mutates that orphan
 * (`isCurrent` is false for it). Writes always target the explicit wallet the
 * state was loaded for and are serialized; each write persists the pins, the
 * DIRTY per-channel rows (each the union of its disk row and every merge
 * since — never a filtered view) and the count index. Every read (the state
 * itself and each lazily read channel row) waits for every queued write
 * first, so it never reads a value that an in-flight write is about to
 * replace.
 */
export class PchanTrustStore {
  private readonly states = new Map<string, Promise<PchanTrustState>>();
  private writeChain: Promise<void> = Promise.resolve();
  private readonly io: TrustStorageIo;

  constructor(io: TrustStorageIo) {
    this.io = io;
  }

  /** Drop all memoized state (account switch / sign-out). */
  reset(): void {
    this.states.clear();
  }

  /** The trust state of `wallet` (loaded once until the next reset). Rejects on a read ERROR. */
  load(wallet: string): Promise<PchanTrustState> {
    let p = this.states.get(wallet);
    if (!p) {
      const pending = this.writeChain;
      p = (async () => {
        await pending; // never read under a queued write (N1)
        // A read ERROR rejects (never "nothing stored"): treating it as empty
        // would let the next persist overwrite the real pins with a subset.
        const [pins, legacySeen, index] = await Promise.all([
          this.io.read(wallet, PIN_STORE_BASE),
          this.io.read(wallet, SEEN_STORE_BASE),
          this.io.read(wallet, SEEN_INDEX_BASE),
        ]);
        const state = PchanTrustState.fromJson(pins, legacySeen, index);
        // Migration: a channel taken from the old blob is unioned with its
        // per-channel row (if one exists) BEFORE anything can persist it, so a
        // persist never writes the blob's subset over a fuller row.
        for (const key of [...state.seen.keys()]) {
          const raw = await this.io.read(wallet, seenChannelBase(key));
          state.installSeenRow(key, PchanTrustState.parseSeenRow(raw));
        }
        return state;
      })();
      this.states.set(wallet, p);
      const self = p;
      // A failed load is not memoized: the next pass retries the read.
      self.catch(() => {
        if (this.states.get(wallet) === self) this.states.delete(wallet);
      });
    }
    return p;
  }

  /**
   * Make sure the seen-removals row of `key` is in `state` (read once per
   * session; rejects on a read ERROR — the caller then skips its pass rather
   * than verifying against fewer removals than it knows). The row is read even
   * when the index does not list it (a crash between the row and the index
   * write must not orphan it).
   */
  async ensureSeen(wallet: string, state: PchanTrustState, key: string): Promise<void> {
    if (state.seenLoaded.has(key)) return;
    await this.writeChain; // never read under a queued write
    if (state.seenLoaded.has(key)) return;
    const raw = await this.io.read(wallet, seenChannelBase(key));
    state.installSeenRow(key, PchanTrustState.parseSeenRow(raw));
  }

  /** True when `state` is still the memoized state of `wallet` (no reset since it was loaded). */
  async isCurrent(wallet: string, state: PchanTrustState): Promise<boolean> {
    const p = this.states.get(wallet);
    if (!p) return false;
    try {
      return (await p) === state;
    } catch {
      return false;
    }
  }

  /** Persist `state` for `wallet` (serialized; best-effort — a failed row stays dirty for the next pass). */
  persist(wallet: string, state: PchanTrustState): Promise<void> {
    const pins = state.pinsJson();
    // Only rows whose disk copy was read (and unioned) are written: writing
    // an unread channel would replace its disk row with a subset.
    const dirty = [...state.dirtySeen].filter((k) => state.seenLoaded.has(k));
    const rows = dirty.map((k) => [k, state.seenRowJson(k)] as const);
    const index = state.seenIndexJson();
    const dropLegacy = state.legacySeenPending;
    for (const k of dirty) state.dirtySeen.delete(k);
    state.legacySeenPending = false;
    const run = this.writeChain.then(async () => {
      await this.io.write(wallet, PIN_STORE_BASE, pins);
      for (const [k, v] of rows) await this.io.write(wallet, seenChannelBase(k), v);
      await this.io.write(wallet, SEEN_INDEX_BASE, index);
      // Only after every row landed: the old blob is the only other copy.
      if (dropLegacy && this.io.remove) await this.io.remove(wallet, SEEN_STORE_BASE);
    }).catch(() => {
      // Best-effort; re-mark so the next pass re-persists (never lose a row).
      for (const k of dirty) state.dirtySeen.add(k);
      if (dropLegacy) state.legacySeenPending = true;
    });
    this.writeChain = run;
    return run;
  }
}

// --- Cover mode ------------------------------------------------------------------

/** How a channel's cover pass must run. */
export type CoverMode = 'private' | 'public';

/**
 * Decide whether a cover pass verifies (W1):
 * - the node-reported network must be `mainnet` or `testnet` — anything else
 *   throws {@link CoverSkippedError} (no cover at all);
 * - a caller-resolved private channel verifies, and so does every id in the
 *   private namespace (>= {@link PRIVATE_CHANNEL_ID_FLOOR}) whatever the node
 *   says its type is (B1);
 * - otherwise the wallet's trust state is consulted: a channel ever pinned
 *   under ANY known network is verified even if a node now calls it public
 *   (so a node that lies about both the type and the network cannot dodge the
 *   pin). A trust-state read error throws {@link CoverSkippedError}.
 */
export async function decideCoverMode(
  isPrivate: boolean,
  network: string | null,
  channelId: number,
  loadState: () => Promise<PchanTrustState>,
): Promise<CoverMode> {
  if (!isKnownNetwork(network)) throw new CoverSkippedError(`unknown network ${JSON.stringify(network)}`);
  if (isPrivate || isPrivateRangeId(channelId)) return 'private';
  let state: PchanTrustState;
  try {
    state = await loadState();
  } catch {
    throw new CoverSkippedError('trust state unreadable');
  }
  return state.hasPinAnyNetwork(channelId) ? 'private' : 'public';
}

// --- Binding verdict cache -----------------------------------------------------------

/**
 * Bounded LRU of enc-key binding verdicts keyed by everything the verdict
 * depends on (network, wallet, device, enc key, signed ts, `bound`, the
 * signature). Replace the instance on account switch.
 */
export class BindingVerdictCache {
  private readonly m = new Map<string, BindingStatus>();
  readonly max: number;

  constructor(max = MAX_BINDING_CACHE) {
    this.max = max;
  }

  static key(network: string, wallet: string, row: EncKeyRow): string {
    return [network, wallet, row.device_id, row.enc_pub, String(row.ts ?? ''), String(row.bound === true),
      typeof row.wallet_signature === 'string' ? row.wallet_signature : ''].join('\u0000');
  }

  get(k: string): BindingStatus | undefined {
    const v = this.m.get(k);
    if (v !== undefined) {
      this.m.delete(k);
      this.m.set(k, v);
    }
    return v;
  }

  set(k: string, v: BindingStatus): void {
    this.m.delete(k);
    this.m.set(k, v);
    while (this.m.size > this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }

  get size(): number {
    return this.m.size;
  }
}

// --- Target resolution ------------------------------------------------------------

/** Everything {@link resolvePrivateTargets} needs, injected. */
export interface PrivateTargetDeps {
  /** The wallet this flow runs FOR (captured at start). */
  self: string;
  /** Klever network string — must be "mainnet"/"testnet" (else CoverSkippedError). */
  network: string;
  channelId: number;
  /** False as soon as the account (wallet / signer / scope generation / client) changed. */
  stillValid(): boolean;
  /** The node's member list (UNTRUSTED). */
  members: readonly string[];
  /**
   * Wallets already covered for the epoch being covered: verified LAST, so a
   * pass that stops early (rate limit) spends its budget on uncovered members.
   */
  covered?: ReadonlySet<string>;
  /** Rotation offset for this channel (returned as `nextOffset`, see {@link PrivateTargetsResult}). */
  startOffset?: number;
  /** SDK `filterVerifiedMembers` bound to the captured client + per-wallet cache. */
  filter(wallets: string[], opts: FilterOptionsLike): Promise<FilterResultLike>;
  getEncKeys(wallet: string): Promise<EncKeyRow[]>;
  /** SDK `verifyEncKeyBinding(row, wallet, network).status`. */
  verifyBinding(row: EncKeyRow, wallet: string): Promise<BindingStatus>;
  /** Per-account binding-verdict cache (replaced on switch). */
  bindingCache: BindingVerdictCache;
  store: PchanTrustStore;
  /** Yield to the UI thread between verification chunks (setTimeout 0 in the app). */
  yieldToUi(): Promise<void>;
  log(step: string, data?: Record<string, unknown>): void;
}

/** Outcome of {@link resolvePrivateTargets}; `null` from the function = aborted (account changed). */
export interface PrivateTargetsResult {
  targets: CoverTarget[];
  /** Wallets whose membership verified (excluding self). */
  verified: string[];
  rejectedCount: number;
  /** Some proofs could not be fetched (old node / 429 / network) — retry later. */
  incomplete: boolean;
  /** The pass stopped at a failed fetch; later chunks were not attempted. */
  stoppedEarly: boolean;
  /** The verifier ran out of budget at least once (pathological / hostile response). */
  budgetExhausted: boolean;
  /** Offset to pass as `startOffset` next time (rotates through large channels). */
  nextOffset: number;
}

/** Dedup to one target per (wallet, device), newest `created_at` wins (matches dmCrypto `targetKey`). */
export function dedupTargets(raw: CoverTarget[]): CoverTarget[] {
  const byDevice = new Map<string, CoverTarget>();
  for (const t of raw) {
    const k = `${t.target}:${(t.deviceId ?? '').toLowerCase()}`;
    const prev = byDevice.get(k);
    if (!prev || t.createdAt > prev.createdAt) byDevice.set(k, t);
  }
  return [...byDevice.values()];
}

/** Rotate `arr` left by `offset` (mod length). */
function rotate<T>(arr: T[], offset: number): T[] {
  if (arr.length === 0) return arr;
  const o = ((offset % arr.length) + arr.length) % arr.length;
  return o === 0 ? arr : [...arr.slice(o), ...arr.slice(0, o)];
}

/** A chunk result that means "the node did not answer": stop the pass. */
function fetchFailed(res: FilterResultLike): boolean {
  return res.incomplete || res.rejected.some((r) => typeof r.reason === 'string' && r.reason.startsWith('fetch_failed'));
}

/**
 * Verify-before-cover target resolution for a PRIVATE channel. Returns the
 * wrap targets for the caller's own devices plus every VERIFIED member's
 * devices, or `null` if the account changed at any point (nothing must be
 * published or written then). Throws {@link CoverSkippedError} when the
 * network is unknown or the trust state is unreadable. Persists a newly
 * established creator pin and the merged seen removals for the captured
 * wallet.
 */
export async function resolvePrivateTargets(deps: PrivateTargetDeps): Promise<PrivateTargetsResult | null> {
  const { self, network, channelId } = deps;
  if (!deps.stillValid()) return null;
  if (!isKnownNetwork(network)) throw new CoverSkippedError(`unknown network ${JSON.stringify(network)}`);
  let state: PchanTrustState;
  const key = channelTrustKey(network, channelId);
  try {
    state = await deps.store.load(self);
    if (!deps.stillValid()) return null;
    // This channel's seen-removals row (one row per channel, read lazily).
    await deps.store.ensureSeen(self, state, key);
  } catch (e) {
    if (!deps.stillValid()) return null;
    // Without the pin / seen removals we would verify against less than we
    // know — fail closed for this pass.
    deps.log('pchan verify: trust state unreadable, skipping pass', { channelId, err: (e as Error)?.message });
    throw new CoverSkippedError('trust state unreadable');
  }
  if (!deps.stillValid()) return null;

  const pinned = state.pin(key);
  const seen = state.seenCopy(key);

  // Untrusted list → unique, never self (self is added explicitly below), bounded.
  const uncovered: string[] = [];
  const alreadyCovered: string[] = [];
  const dedup = new Set<string>([self]);
  let count = 0;
  for (const m of deps.members) {
    if (typeof m !== 'string' || dedup.has(m)) continue;
    dedup.add(m);
    (deps.covered?.has(m) ? alreadyCovered : uncovered).push(m);
    if (++count >= MAX_MEMBERS_PER_PASS) break;
  }
  const offset = Number.isSafeInteger(deps.startOffset) && deps.startOffset! >= 0 ? deps.startOffset! : 0;
  // Uncovered members first; within each group, rotate so a large channel's
  // tail is reached even when every pass stops early.
  const others = [...rotate(uncovered, offset), ...rotate(alreadyCovered, offset)];

  const verified: string[] = [];
  const reasons: Record<string, number> = {};
  let rejectedCount = 0;
  let incomplete = false;
  let stoppedEarly = false;
  let budgetExhausted = false;
  let processed = 0;
  // The creator every chunk must agree on: the pin, else the first chunk's.
  let chunkPin = pinned;
  let established: string | undefined;
  const t0 = Date.now();

  for (let i = 0; i < others.length; i += VERIFY_CHUNK) {
    if (i > 0) {
      await deps.yieldToUi();
      if (!deps.stillValid()) return null;
    }
    const chunk = others.slice(i, i + VERIFY_CHUNK);
    let res: FilterResultLike;
    try {
      res = await deps.filter(chunk, {
        network,
        pinnedCreator: chunkPin,
        // Mobile never keeps its own `ChannelCreate` envelopes, so it can
        // never know that a channel was created before 0.139 — the only
        // situation in which the SDK allows trusting an underived create.
        allowUnderivedCreator: false,
        seenRemovals: seen,
      });
    } catch (e) {
      if (e instanceof AccountChangedError || !deps.stillValid()) return null;
      // filterVerifiedMembers does not throw by contract; fail closed anyway.
      res = { verified: [], rejected: chunk.map((w) => ({ wallet: w, reason: 'fetch_failed:threw' })), incomplete: true };
      deps.log('pchan verify: filter threw', { channelId, err: (e as Error)?.message });
    }
    if (!deps.stillValid()) return null;
    const inChunk = new Set(chunk);
    for (const w of res.verified) if (inChunk.has(w)) verified.push(w);
    for (const r of res.rejected) {
      rejectedCount++;
      const reason = typeof r.reason === 'string' ? r.reason.split(':')[0]! : 'unknown';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
      if (r.reason === 'verification_budget_exhausted') budgetExhausted = true;
    }
    if (chunkPin === undefined && isKlvAddress(res.creator)) {
      chunkPin = res.creator;
      established = res.creator;
    }
    if (fetchFailed(res)) {
      // 429/503/network/old node: every further request would fail the same
      // way and only burn the node's per-wallet budget. Stop; members not
      // reached stay uncovered until a later pass (fail closed).
      incomplete = true;
      if (i + VERIFY_CHUNK < others.length) stoppedEarly = true;
      break;
    }
    processed += chunk.length;
  }

  // Scoped writes: only while the account is unchanged, and only into the
  // state loaded for THIS wallet (an orphaned state after a reset is skipped).
  if (!deps.stillValid()) return null;
  if (!(await deps.store.isCurrent(self, state))) return null;
  if (!deps.stillValid()) return null;
  let dirty = false;
  if (pinned === undefined && established !== undefined) {
    const outcome = state.pinIfAbsent(key, established);
    if (outcome === 'pinned') {
      dirty = true;
      deps.log('pchan verify: creator pinned', { channelId, creator: established });
    } else if (outcome === 'cap') {
      deps.log('pchan verify: creator pin refused (pin cap reached)', { channelId });
    } else if (outcome === 'exists' && state.pin(key) !== established) {
      // A concurrent pass pinned a DIFFERENT creator meanwhile: this pass
      // verified against a creator the pin now contradicts — discard it.
      deps.log('pchan verify: creator disagrees with a concurrent pin, discarding pass', { channelId });
      return null;
    }
  }
  const merged = state.mergeSeen(key, seen);
  if (merged.changed) dirty = true;
  if (merged.channelRefused || merged.dropped > 0) {
    deps.log('pchan verify: seen removals capped', { channelId, channelRefused: merged.channelRefused, dropped: merged.dropped });
  }
  if (dirty) await deps.store.persist(self, state);
  if (!deps.stillValid()) return null;

  deps.log('pchan verify: members filtered', {
    channelId,
    listed: others.length,
    verified: verified.length,
    rejected: rejectedCount,
    reasons,
    incomplete,
    stoppedEarly,
    budgetExhausted,
    pinned: pinned !== undefined,
    ms: Date.now() - t0,
  });

  // Enc keys ONLY for self + verified members, each row's wallet binding checked.
  const raw: CoverTarget[] = [];
  let unbound = 0;
  let invalid = 0;
  let fresh = 0;
  for (const wallet of [self, ...verified]) {
    let rows: EncKeyRow[];
    try {
      rows = await deps.getEncKeys(wallet);
    } catch {
      if (!deps.stillValid()) return null;
      continue; // covered on a later pass
    }
    if (!deps.stillValid()) return null;
    const all = Array.isArray(rows) ? rows : [];
    const usable = selectBoundRows(all);
    // Rows the node itself serves as unbound never reach the verifier (they
    // are never wrapped to here); counted for the log only.
    unbound += all.filter((row) => row && row.bound !== true).length;
    for (const row of usable) {
      const ck = BindingVerdictCache.key(network, wallet, row);
      let status = deps.bindingCache.get(ck);
      if (status === undefined) {
        if (fresh > 0 && fresh % BINDING_YIELD_EVERY === 0) {
          await deps.yieldToUi();
          if (!deps.stillValid()) return null;
        }
        fresh++;
        try {
          status = await deps.verifyBinding(row, wallet);
        } catch {
          status = 'invalid';
        }
        if (!deps.stillValid()) return null;
        deps.bindingCache.set(ck, status);
      }
      if (status === 'invalid') {
        invalid++;
        continue;
      }
      if (status === 'unbound') {
        // B2: a node can mint an unsigned row for ANY wallet (this one
        // included) and shadow a bound row via its own `created_at`. Private
        // channels wrap only to wallet-signed rows; an own device still on a
        // pre-0.142 row re-binds itself (deviceEnc.ts) and is covered then.
        unbound++;
        continue;
      }
      // Order by the wallet-SIGNED binding timestamp, never the node-supplied
      // `created_at`, when two bound rows exist for one device.
      raw.push({ target: wallet, deviceId: row.device_id, encPub: row.enc_pub, createdAt: isTs(row.ts) ? row.ts : 0 });
    }
  }
  if (!deps.stillValid()) return null;
  if (unbound > 0 || invalid > 0) {
    deps.log('pchan verify: enc-key rows skipped (unbound / invalid)', { channelId, unbound, invalid });
  }
  return {
    targets: dedupTargets(raw),
    verified,
    rejectedCount,
    incomplete,
    stoppedEarly,
    budgetExhausted,
    nextOffset: offset + processed,
  };
}

/**
 * Wrap + publish to each target, re-checking the account before EVERY
 * publish (and after it). Returns how many were published, or `null` if it
 * aborted because the account changed (nothing further is published).
 * `publishOne` should itself use {@link guarded} inside any retry loop.
 */
export async function publishToTargets(
  targets: readonly CoverTarget[],
  stillValid: () => boolean,
  publishOne: (t: CoverTarget) => Promise<void>,
  onPublished: (t: CoverTarget) => void,
): Promise<number | null> {
  let n = 0;
  for (const t of targets) {
    if (!stillValid()) return null;
    try {
      await publishOne(t);
    } catch (e) {
      if (e instanceof AccountChangedError || !stillValid()) return null;
      throw e;
    }
    if (!stillValid()) return null;
    onPublished(t);
    n++;
  }
  return n;
}

/** Wallets of a `${wallet}:${deviceId}` cover set (dmCrypto `targetKey`). */
export function coveredWallets(targetKeys: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const k of targetKeys) {
    const i = k.indexOf(':');
    if (i > 0) out.add(k.slice(0, i));
  }
  return out;
}

// --- Throttle + backoff ---------------------------------------------------------------

/** Minimum gap between two cover passes of a PUBLIC channel. */
export const COVER_THROTTLE_PUBLIC_MS = 10_000;
/**
 * Minimum gap between two cover passes of a PRIVATE channel: each pass costs
 * one `member-proofs` request per 100 members against the node's 20 / 60 s
 * per-wallet limit, plus Ed25519 work on the JS thread.
 */
export const COVER_THROTTLE_PRIVATE_MS = 60_000;

/** The cover throttle for a channel type. */
export const coverThrottleMs = (isPrivate: boolean): number =>
  (isPrivate ? COVER_THROTTLE_PRIVATE_MS : COVER_THROTTLE_PUBLIC_MS);

/** First backoff after a verification-budget exhaustion. */
export const BUDGET_BACKOFF_MIN_MS = 60_000;
/** Backoff ceiling. */
export const BUDGET_BACKOFF_MAX_MS = 10 * 60_000;

/**
 * Per-channel cover backoff: a response that exhausts the verifier's budget
 * costs ~2000 pure-JS Ed25519 verifications on the Hermes JS thread (seconds
 * of jank). Only a hostile or pathological node produces one, so after it
 * the channel's next private cover pass waits 60 s, doubling to 10 min, and
 * resets on the first pass that did not exhaust the budget.
 */
export class CoverBackoff {
  private readonly m = new Map<number, { until: number; delay: number }>();

  /** True while `channelId` is backing off at `now`. */
  blocked(channelId: number, now: number): boolean {
    const e = this.m.get(channelId);
    return !!e && now < e.until;
  }

  /** Record a pass outcome. */
  record(channelId: number, budgetExhausted: boolean, now: number): void {
    if (!budgetExhausted) {
      this.m.delete(channelId);
      return;
    }
    const prev = this.m.get(channelId);
    const delay = prev ? Math.min(prev.delay * 2, BUDGET_BACKOFF_MAX_MS) : BUDGET_BACKOFF_MIN_MS;
    this.m.set(channelId, { until: now + delay, delay });
  }

  clear(): void {
    this.m.clear();
  }
}
