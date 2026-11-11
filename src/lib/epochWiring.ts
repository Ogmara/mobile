/**
 * Channel key epochs on node-arbitrated l2-nodes (0.143.0+ `key_commitment_v1`)
 * — the mobile wiring around sdk-js 0.67.0 `establishEpochKey` (mobile 0.58.0).
 *
 * Replaces this app's own fork-resolution protocol (`privateCoverCore.ts`
 * `establishEpoch`, removed): with per-device first-write-wins storage,
 * members rotating at the same time each won some devices and no client-side
 * ordering could repair it. The node now keeps ONE winner per (channel scope,
 * epoch) and the SDK runs the one shared client protocol on top of it. This
 * module only supplies the SDK's dependencies and acts on its outcomes:
 *
 *  - every injected async dep gets a timeout ({@link withTimeout}) and an
 *    account guard after it; the guard throws {@link AccountChangedError}
 *    (fatal for the SDK: nothing more is published for a switched account);
 *  - `highestEpochSeen` comes from {@link EpochEvidence} — AUTHENTICATED
 *    evidence only (an epoch whose key this app established/adopted, whose
 *    wrap verified, or whose message decrypted under such a key), never a raw
 *    `key_epoch` number from a message;
 *  - the epoch being established is persisted BEFORE the call and cleared on a
 *    terminal outcome ({@link EstablishingStore}, epoch NUMBER only, never the
 *    key) so a restart resumes it before moving on (SDK caller contract);
 *  - `escalate` / `split` / `node_lagging` arrive already gated by the shared
 *    per-account `EscalationGate` (passed to the SDK); outcomes the SDK does
 *    not gate (`unconfirmed_exhausted`, `legacy`, `epochTooLow`) go through the
 *    same gate here. Follow-up rotations are bounded per call (`maxHops`) and
 *    happen ONLY for channels where rotation is allowed at all
 *    ({@link mayRotate}: private-range id or a creator pin);
 *  - early use (`onUnconfirmed`) is wired ONLY when the caller says this is the
 *    first key of a brand-new channel (user decision: rotations and joins wait
 *    for FINAL, ~120 s, behind a "re-keying…" state).
 *
 * React-Native-free (node --test); `channelCrypto.ts` supplies the real I/O.
 */
import {
  establishEpochKey,
  type EscalationGate,
  type PendingEpochKeyStore,
  type EstablishEpochKeyDeps,
  type EstablishEpochKeyOutcome,
  type EpochKeyTarget,
  type KeyCommitmentInfo,
  type PublishChannelKeyResult,
  type UnconfirmedEpochKey,
  type VerifiedChannelKeyWrap,
} from '@ogmara/sdk';
import { AccountChangedError, isPrivateRangeId } from './privateCoverCore.ts';
import { epochWithinNodeBound } from './channelKeyCore.ts';

// --- Small primitives ---------------------------------------------------------------

/** Default timeout for one injected dependency call (SDK: every dep must time out by itself). */
export const DEP_TIMEOUT_MS = 30_000;

/** A dependency call that did not settle in time (treated as transient by the SDK). */
export class DepTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms} ms`);
    this.name = 'DepTimeoutError';
  }
}

/** Race `p` against a timer; the timer is always cleared. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, rej) => {
    t = setTimeout(() => rej(new DepTimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timer]).finally(() => { if (t !== undefined) clearTimeout(t); });
}

/**
 * C (0.58.0): may this app ROTATE this channel's key at all? Only for ids in
 * the private namespace (>= 2^32) or channels this wallet holds a creator pin
 * for. A public encrypted channel never rotates — otherwise a hostile node
 * could make every member rotate it by sending a members-changed event with
 * a floor (or by faking a split / lagging state). Its effective floor is 0.
 */
export function mayRotate(channelId: number, hasPin: boolean): boolean {
  return hasPin || isPrivateRangeId(channelId);
}

/** The floor this app enforces: the node's floor only where rotation is allowed. */
export function effectiveFloor(channelId: number, floor: number, hasPin: boolean): number {
  if (!Number.isSafeInteger(floor) || floor <= 0) return 0;
  return mayRotate(channelId, hasPin) ? floor : 0;
}

// --- Authenticated epoch evidence --------------------------------------------------------

/** Channels remembered per account. */
export const MAX_EVIDENCE_CHANNELS = 2048;

/**
 * Highest AUTHENTICATED epoch per channel (SDK `highestEpochSeen`). Feed it only
 * with epochs of keys this app established/adopted, wraps it verified, keys it
 * matched against the node's commitment hash, and messages that DECRYPTED
 * under such a key. One instance per account (replaced on switch). Bounded
 * LRU.
 */
export class EpochEvidence {
  private readonly m = new Map<number, number>();

  note(channelId: number, epoch: number): void {
    if (!Number.isSafeInteger(channelId) || channelId <= 0 || !Number.isSafeInteger(epoch) || epoch < 1) return;
    const prev = this.m.get(channelId) ?? 0;
    this.m.delete(channelId);
    this.m.set(channelId, Math.max(prev, epoch));
    while (this.m.size > MAX_EVIDENCE_CHANNELS) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
  }

  highest(channelId: number): number {
    return this.m.get(channelId) ?? 0;
  }
}

// --- Persisted "epoch being established" -------------------------------------------

/** Storage I/O with EXPLICIT wallet (walletScope `*For`). `read` rejects on a storage error. */
export interface WalletRowIo {
  read(wallet: string, base: string): Promise<string | null>;
  write(wallet: string, base: string, value: string): Promise<void>;
}

/** AsyncStorage base (NEW key, `::<wallet>` scoped; never vault / SecureStore). */
export const ESTABLISHING_BASE = 'ogmara.pchan.establishing';
/** Channels with an epoch in establishment, per wallet. New ones beyond are not persisted (logged). */
export const MAX_ESTABLISHING = 256;

/** One persisted establishment: the epoch NUMBER (never the key) + how to resume it (W4). */
export interface EstablishingEntry {
  channelId: number;
  epoch: number;
  /** Resolve targets as a private channel. */
  isPrivate: boolean;
  /** The epoch was known to exist (we held a key for it / adopted it). */
  known: boolean;
}

/** Persisted value per channel. */
type EstRow = { e: number; p: boolean; k: boolean };

/**
 * The epoch NUMBER each channel is being established at, per wallet
 * (`{ "<channelId>": { e, p, k } }`, a bare number also accepted) — never the key. Written BEFORE the SDK call,
 * cleared on a terminal outcome; after a restart {@link EstablishingStore.list}
 * names the epochs to resume first (SDK caller contract). Loaded once per
 * wallet (the union with disk), writes serialized and always the whole map.
 */
export class EstablishingStore {
  private readonly maps = new Map<string, Promise<Map<number, EstRow>>>();
  private chain: Promise<void> = Promise.resolve();
  private readonly io: WalletRowIo;
  private readonly log: (s: string, d?: Record<string, unknown>) => void;

  constructor(io: WalletRowIo, log: (s: string, d?: Record<string, unknown>) => void = () => {}) {
    this.io = io;
    this.log = log;
  }

  reset(): void {
    this.maps.clear();
  }

  private load(wallet: string): Promise<Map<number, EstRow>> {
    let p = this.maps.get(wallet);
    if (!p) {
      const pending = this.chain;
      p = (async () => {
        await pending;
        const raw = await this.io.read(wallet, ESTABLISHING_BASE);
        const m = new Map<number, EstRow>();
        try {
          const o = raw ? JSON.parse(raw) : null;
          if (o && typeof o === 'object' && !Array.isArray(o)) {
            for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
              const ch = Number(k);
              if (m.size >= MAX_ESTABLISHING) break;
              if (!Number.isSafeInteger(ch) || ch <= 0) continue;
              const ent = typeof v === 'number' ? { e: v, p: false, k: false } : (v as { e?: unknown; p?: unknown; k?: unknown } | null);
              if (ent && Number.isSafeInteger(ent.e) && (ent.e as number) >= 1) {
                m.set(ch, { e: ent.e as number, p: ent.p === true, k: ent.k === true });
              }
            }
          }
        } catch { /* corrupt → nothing to resume */ }
        return m;
      })();
      this.maps.set(wallet, p);
      const self = p;
      self.catch(() => { if (this.maps.get(wallet) === self) this.maps.delete(wallet); });
    }
    return p;
  }

  private persist(wallet: string, m: Map<number, EstRow>): Promise<void> {
    const json = JSON.stringify(Object.fromEntries([...m].map(([k, v]) => [String(k), v])));
    const run = this.chain.then(() => this.io.write(wallet, ESTABLISHING_BASE, json)).catch(() => {});
    this.chain = run;
    return run;
  }

  /** Every persisted establishment of `wallet` (rejects on a read error). */
  async list(wallet: string): Promise<EstablishingEntry[]> {
    const m = await this.load(wallet);
    return [...m].map(([channelId, v]) => ({ channelId, epoch: v.e, isPrivate: v.p, known: v.k }));
  }

  /** Persist that `channelId` is being established at `epoch` (+ how to resume it). Best-effort. */
  async set(wallet: string, channelId: number, epoch: number, mode: { isPrivate?: boolean; known?: boolean } = {}): Promise<void> {
    let m: Map<number, EstRow>;
    try {
      m = await this.load(wallet);
    } catch {
      this.log('establishing store unreadable; epoch not persisted', { channelId, epoch });
      return;
    }
    const next: EstRow = { e: epoch, p: mode.isPrivate === true, k: mode.known === true };
    const cur = m.get(channelId);
    if (cur && cur.e === next.e && cur.p === next.p && cur.k === next.k) return;
    if (!cur && m.size >= MAX_ESTABLISHING) {
      this.log('establishing store full; epoch not persisted', { channelId, epoch });
      return;
    }
    m.set(channelId, next);
    await this.persist(wallet, m);
  }

  /** Clear `channelId` — only if it is still at `epoch` (a later epoch set meanwhile stays). */
  async clear(wallet: string, channelId: number, epoch: number): Promise<void> {
    let m: Map<number, EstRow>;
    try {
      m = await this.load(wallet);
    } catch {
      return;
    }
    if (m.get(channelId)?.e !== epoch) return;
    m.delete(channelId);
    await this.persist(wallet, m);
  }
}

// --- Dependencies ------------------------------------------------------------------------

/** The I/O one establish call needs (all bound to ONE captured account by the caller). */
export interface EpochIo {
  channelId: number;
  self: EstablishEpochKeyDeps['self'];
  /** False once the account / signer / scope generation / client changed. */
  stillValid(): boolean;
  getCommitment(epoch?: number): Promise<KeyCommitmentInfo>;
  fetchOwnWrap(epoch: number): Promise<VerifiedChannelKeyWrap | null>;
  isSelfBound(): Promise<boolean>;
  listTargets(): Promise<EpochKeyTarget[]>;
  /** Build (sign) a NEW channel-epoch envelope and publish it (typed SDK errors). */
  publish(t: EpochKeyTarget, key: Uint8Array, keyTs: number, epoch: number, opts?: { fresh?: boolean }): Promise<PublishChannelKeyResult>;
  /** Other nodes' commitment for `epoch`; `[]` only when no peer node exists; throws when none answered. */
  peerCommitments?(epoch: number): Promise<KeyCommitmentInfo[]>;
  newKey(): Uint8Array;
  now(): number;
  sleep(ms: number): Promise<void>;
  /** Yield to the UI (Hermes: Ed25519 / X25519 run as pure JS on the JS thread). */
  yieldToUi(): Promise<void>;
  log(step: string, data?: Record<string, unknown>): void;
  depTimeoutMs?: number;
}

/** Per-account protocol state shared by every channel of that account. */
export interface AccountEpochState {
  wallet: string;
  pending: PendingEpochKeyStore;
  gate: EscalationGate;
  bucket: { take: () => Promise<void> };
  evidence: EpochEvidence;
  establishing: EstablishingStore;
}

/** One establish request. */
export interface EpochRequest {
  epoch: number;
  /** The epoch is referenced by authenticated evidence (never true for a fresh rotation). */
  epochKnownToExist: boolean;
  /** Rotation allowed for this channel ({@link mayRotate}). */
  mayRotate: boolean;
  /** Persisted with the epoch so a restart resumes with the same target mode (W4). */
  isPrivate?: boolean;
  /** First key of a brand-new channel (creator is the only member): wire `onUnconfirmed`. */
  earlyUse?: boolean;
  onEarlyKey?: (u: UnconfirmedEpochKey) => void;
  /** Follow-up rotations allowed within this call (default 1). */
  maxHops?: number;
  targetCount?: number;
  options?: EstablishEpochKeyDeps['options'];
}

/** The SDK deps for one call (exported for tests). */
export function buildEstablishDeps(io: EpochIo, st: AccountEpochState, epoch: number, req: EpochRequest): EstablishEpochKeyDeps {
  const ms = io.depTimeoutMs ?? DEP_TIMEOUT_MS;
  const guard = (_step?: string): void => {
    if (!io.stillValid()) throw new AccountChangedError();
  };
  /** Timeout + account check BEFORE every dep call (a switched account sends nothing). */
  const dep = <A extends unknown[], T>(label: string, fn: (...a: A) => Promise<T>) => async (...a: A): Promise<T> => {
    guard(label);
    return withTimeout(fn(...a), ms, label);
  };
  return {
    channelId: io.channelId,
    epoch,
    self: io.self,
    getCommitment: dep('getCommitment', (e?: number) => io.getCommitment(e)),
    fetchOwnWrap: dep('fetchOwnWrap', async (e: number) => {
      await io.yieldToUi(); // wrap verification = Ed25519 + X25519 on the JS thread
      guard('fetchOwnWrap');
      return io.fetchOwnWrap(e);
    }),
    isSelfBound: dep('isSelfBound', () => io.isSelfBound()),
    listTargets: dep('listTargets', () => io.listTargets()),
    publish: dep('publish', async (t: EpochKeyTarget, key: Uint8Array, keyTs: number, e: number, opts?: { fresh?: boolean }) => {
      await io.yieldToUi(); // one signature + one wrap per target
      guard('publish');
      return io.publish(t, key, keyTs, e, opts);
    }),
    peerCommitments: io.peerCommitments ? dep('peerCommitments', (e: number) => io.peerCommitments!(e)) : undefined,
    pending: st.pending,
    newKey: () => io.newKey(),
    now: () => io.now(),
    sleep: (t: number) => io.sleep(t),
    bucket: st.bucket,
    guard,
    isFatalError: (e: unknown) => e instanceof AccountChangedError,
    targetCount: req.targetCount,
    epochKnownToExist: req.epochKnownToExist,
    highestEpochSeen: st.evidence.highest(io.channelId),
    escalationGate: st.gate,
    log: (step: string, data?: Record<string, unknown>) => io.log(`epoch: ${step}`, { channelId: io.channelId, epoch, ...data }),
    onUnconfirmed: req.earlyUse
      ? (u: UnconfirmedEpochKey) => {
        // Only OUR key, and only for the first epoch of a brand-new channel.
        if (u.role === 'established') req.onEarlyKey?.(u);
        else u.key.fill(0);
      }
      : undefined,
    options: req.options,
  };
}

// --- Outcome handling -------------------------------------------------------------------

/** Problems surfaced to the UI (no automatic action left). */
export type EpochProblem =
  | 'epoch_too_high'
  | 'node_lagging_unrecoverable'
  | 'unconfirmed_exhausted'
  | 'needs_binding'
  | 'legacy'
  | 'no_rotate'
  | 'failed';

/** Result of {@link runEpochFlow}. */
export type EpochFlowResult =
  /** A key the node arbitrated for `epoch` (copy owned by the caller). */
  | {
    kind: 'key';
    epoch: number;
    key: Uint8Array;
    keyTs: number;
    keyCommitment: Uint8Array;
    confirmed: boolean;
    role: 'established' | 'adopted';
    /** Some targets are still uncovered (home-node truth): resume later with the same key. */
    incomplete: boolean;
    /** `established` only: targets not covered / refused by the node (ids `wallet:device`). */
    uncovered: string[];
    rejected: string[];
  }
  /** Nothing decided; resume `epoch` later (it stays persisted). */
  | { kind: 'pending'; epoch: number; reason: string }
  /** Needs the user / another node; `epoch` is the epoch it stopped at. */
  | { kind: 'problem'; epoch: number; code: EpochProblem; detail?: string }
  /** The account changed: nothing more happened. */
  | { kind: 'aborted' };

/** What to do after one SDK outcome (pure; exported for tests). */
export type EpochStep =
  | { do: 'result'; result: EpochFlowResult; clear: boolean }
  /** Rotate to `epoch`; `gated` = the SDK already consumed the escalation gate. */
  | { do: 'rotate'; epoch: number; gated: boolean; reason: string };

/** `wallet:device` (lowercase device), the same id as dmCrypto `targetKey`. */
export const targetIdOf = (t: { target: string; deviceId: string }): string => `${t.target}:${t.deviceId.toLowerCase()}`;

/** Map one SDK outcome to the next step (no I/O). */
export function stepFor(o: EstablishEpochKeyOutcome, rotateAllowed: boolean): EpochStep {
  const rotate = (epoch: number, gated: boolean, reason: string): EpochStep =>
    rotateAllowed
      ? { do: 'rotate', epoch, gated, reason }
      : { do: 'result', result: { kind: 'problem', epoch: o.epoch, code: 'no_rotate', detail: reason }, clear: true };
  switch (o.kind) {
    case 'established':
      return {
        do: 'result',
        clear: o.confirmed && o.uncovered.length === 0,
        result: {
          kind: 'key', epoch: o.epoch, key: o.key, keyTs: o.keyTs, keyCommitment: o.keyCommitment,
          confirmed: o.confirmed, role: 'established', incomplete: o.uncovered.length > 0,
          uncovered: o.uncovered.map(targetIdOf), rejected: o.rejected.map(targetIdOf),
        },
      };
    case 'adopted':
      return {
        do: 'result',
        clear: o.confirmed,
        result: {
          kind: 'key', epoch: o.epoch, key: o.key, keyTs: o.keyTs, keyCommitment: o.keyCommitment,
          confirmed: o.confirmed, role: 'adopted', incomplete: false, uncovered: [], rejected: [],
        },
      };
    case 'waiting':
      return { do: 'result', result: { kind: 'pending', epoch: o.epoch, reason: o.reason }, clear: false };
    case 'needs_binding':
      return { do: 'result', result: { kind: 'problem', epoch: o.epoch, code: 'needs_binding' }, clear: false };
    case 'escalate':
      return rotate(o.epoch + 1, true, 'escalate');
    case 'split':
      return rotate(o.epoch + 1, true, 'split');
    case 'node_lagging':
      if (o.unrecoverableHere) {
        return { do: 'result', result: { kind: 'problem', epoch: o.epoch, code: 'node_lagging_unrecoverable' }, clear: true };
      }
      return rotate(o.recoveryEpoch, true, 'node_lagging');
    case 'unconfirmed_exhausted':
      return rotateAllowed
        ? { do: 'rotate', epoch: o.epoch + 1, gated: false, reason: 'unconfirmed_exhausted' }
        : { do: 'result', result: { kind: 'problem', epoch: o.epoch, code: 'unconfirmed_exhausted', detail: o.lastReason }, clear: true };
    case 'legacy':
      return rotateAllowed
        ? { do: 'rotate', epoch: o.epoch + 1, gated: false, reason: 'legacy' }
        : { do: 'result', result: { kind: 'problem', epoch: o.epoch, code: 'legacy' }, clear: true };
    case 'failed':
      if (o.epochTooHigh) {
        return { do: 'result', result: { kind: 'problem', epoch: o.epoch, code: 'epoch_too_high', detail: o.reason }, clear: true };
      }
      if (o.epochTooLow) return rotate(o.epoch + 1, false, `epoch_too_low:${o.reason}`);
      if (o.retryable) return { do: 'result', result: { kind: 'pending', epoch: o.epoch, reason: o.reason }, clear: false };
      return { do: 'result', result: { kind: 'problem', epoch: o.epoch, code: 'failed', detail: o.reason }, clear: true };
    default:
      return { do: 'result', result: { kind: 'pending', epoch: (o as { epoch: number }).epoch, reason: 'unknown_outcome' }, clear: false };
  }
}

/**
 * Establish / adopt `req.epoch` and act on the outcome: persist the epoch
 * first, run the SDK, note authenticated evidence, clear the persisted epoch
 * on a terminal outcome, and follow at most `maxHops` rotations (each one
 * through the escalation gate, and only where rotation is allowed).
 */
export async function runEpochFlow(
  io: EpochIo, st: AccountEpochState, req: EpochRequest,
  /** The SDK protocol (injectable for tests only). */
  establish: (deps: EstablishEpochKeyDeps) => Promise<EstablishEpochKeyOutcome> = establishEpochKey,
): Promise<EpochFlowResult> {
  const maxHops = req.maxHops ?? 1;
  let epoch = req.epoch;
  let known = req.epochKnownToExist;
  for (let hop = 0; ; hop++) {
    if (!io.stillValid()) return { kind: 'aborted' };
    // Unified client guard: never plan an epoch beyond the node's highest
    // known epoch + 256 (the node's own acceptance bound) — a hostile floor or
    // a planted far-ahead key must not make us publish there. Nothing is
    // persisted or published for a refused plan.
    let top: number;
    try {
      top = (await withTimeout(io.getCommitment(), io.depTimeoutMs ?? DEP_TIMEOUT_MS, 'node highest')).epoch;
    } catch {
      if (!io.stillValid()) return { kind: 'aborted' };
      return { kind: 'pending', epoch, reason: 'node_highest_unavailable' };
    }
    if (!io.stillValid()) return { kind: 'aborted' };
    if (!epochWithinNodeBound(epoch, top)) {
      io.log('epoch: plan refused — beyond the node bound', { channelId: io.channelId, epoch, nodeHighest: top });
      await st.establishing.clear(st.wallet, io.channelId, epoch);
      return { kind: 'problem', epoch, code: 'epoch_too_high', detail: 'local_guard' };
    }
    await st.establishing.set(st.wallet, io.channelId, epoch, { isPrivate: req.isPrivate, known });
    if (!io.stillValid()) return { kind: 'aborted' };
    let out: EstablishEpochKeyOutcome;
    try {
      out = await establish(buildEstablishDeps(io, st, epoch, { ...req, epochKnownToExist: known, earlyUse: hop === 0 && req.earlyUse }));
    } catch (e) {
      if (e instanceof AccountChangedError || !io.stillValid()) return { kind: 'aborted' };
      io.log('epoch: establish threw', { channelId: io.channelId, epoch, err: (e as Error)?.message });
      return { kind: 'pending', epoch, reason: 'threw' };
    }
    if (!io.stillValid()) {
      if (out.kind === 'established' || out.kind === 'adopted') out.key.fill(0);
      return { kind: 'aborted' };
    }
    io.log('epoch: outcome', { channelId: io.channelId, epoch, kind: out.kind, reason: (out as { reason?: string }).reason });
    if (out.kind === 'established' || out.kind === 'adopted') st.evidence.note(io.channelId, out.epoch);
    const step = stepFor(out, req.mayRotate);
    if (step.do === 'result') {
      if (step.clear) await st.establishing.clear(st.wallet, io.channelId, epoch);
      return step.result;
    }
    // A rotation: never more than maxHops per call, always through the gate.
    if (hop >= maxHops) return { kind: 'pending', epoch, reason: `hop_cap:${step.reason}` };
    if (!step.gated && !st.gate.tryEscalate(io.channelId)) {
      io.log('epoch: rotation gated', { channelId: io.channelId, epoch, reason: step.reason });
      return { kind: 'pending', epoch, reason: `gated:${step.reason}` };
    }
    await st.establishing.clear(st.wallet, io.channelId, epoch);
    io.log('epoch: rotating', { channelId: io.channelId, from: epoch, to: step.epoch, reason: step.reason });
    epoch = step.epoch;
    known = false;
  }
}

/** Errors the screen may show for a channel's key state. */
export type ChannelKeyStatus =
  | { state: 'idle' }
  | { state: 'rekeying'; epoch: number }
  | { state: 'problem'; code: EpochProblem; detail?: string };
