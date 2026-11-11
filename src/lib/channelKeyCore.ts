/**
 * Pure decision cores of `channelCrypto.ts` (mobile 0.58.0): the peer rule,
 * the heal trigger + its persisted ledger, floor-driven rotation coalescing,
 * the send / seed / cover decisions, early-use scope and the evidence rule.
 * React-Native-free so `node --test` pins them (channelCrypto.ts imports
 * react-native modules and cannot run under the test runner).
 */
import {
  ChannelKeyring,
  ChannelKeyringError,
  acceptFetchedEnvelope,
  type ChannelKeyHeld,
  type ChannelKeyInfo,
  type ChannelKeyPair,
  type ChannelKeyPruneResult,
  type ChannelKeyPreparedExport,
  type ChannelKeyExportToken,
  type ChannelKeyPruneClassName,
  type ChannelKeyPutOptions,
  type ChannelKeyPutResult,
  type ChannelKeyringOptions,
  type KeyCommitmentInfo,
} from '@ogmara/sdk';
import type { WalletRowIo, ChannelKeyStatus, EpochProblem } from './epochWiring.ts';

// --- Peer commitments (cross-client rule) ---------------------------------------------

/** HTTP status of an SDK request error (`API error (404): …` or a `status` field), else null. */
export function httpStatusOf(e: unknown): number | null {
  const st = (e as { status?: unknown })?.status;
  if (typeof st === 'number' && Number.isInteger(st) && st >= 100 && st <= 599) return st;
  const m = /API error \((\d{3})\)/.exec(String((e as { message?: unknown })?.message ?? ''));
  return m ? Number(m[1]) : null;
}

/** Thrown when peers were queried, none answered and at least one FAILED. */
export class PeerCommitmentsUnavailableError extends Error {
  constructor(failed: number) {
    super(`no peer node answered the key-commitment query (${failed} failed)`);
    this.name = 'PeerCommitmentsUnavailableError';
  }
}

/**
 * Unified cross-client peer rule for the SDK's `peerCommitments`, per queried
 * peer: a 200 commitment is an ANSWER; 403/404 means "this node does not
 * carry the channel / we are not a member there" → SKIPPED (neither answer
 * nor failure); 401, network errors, timeouts, 5xx, a refused proof-of-work
 * and anything else are FAILURES. Returns the answers when there is at least
 * one (failures ignored); `[]` when there were no peers or every peer was
 * skipped; throws {@link PeerCommitmentsUnavailableError} only when NO peer
 * answered and at least one FAILED (the key then stays unconfirmed).
 */
export function classifyPeerResults(results: readonly PromiseSettledResult<KeyCommitmentInfo>[]): KeyCommitmentInfo[] {
  const answers: KeyCommitmentInfo[] = [];
  let failed = 0;
  for (const r of results) {
    if (r.status === 'fulfilled') {
      answers.push(r.value);
      continue;
    }
    const s = httpStatusOf(r.reason);
    if (s === 403 || s === 404) continue;
    failed++;
  }
  if (answers.length > 0) return answers;
  if (failed > 0) throw new PeerCommitmentsUnavailableError(failed);
  return [];
}

/** Rebuild a peer list that had unreachable peers at most this often / this many times. */
export const PEER_REBUILD_AFTER_MS = 60_000;
export const MAX_PEER_REBUILDS = 5;

/** Should a cached peer list be rebuilt (some peer was unreachable when it was built)? */
export function shouldRebuildPeers(p: { unreachable: number; builtAt: number; rebuilds: number }, now: number): boolean {
  return p.unreachable > 0 && p.rebuilds < MAX_PEER_REBUILDS && now - p.builtAt >= PEER_REBUILD_AFTER_MS;
}

// --- Heal trigger --------------------------------------------------------------------------

/** Inputs of {@link shouldHeal}. */
export interface HealInput {
  /** Epoch of the message that did not decrypt. */
  messageEpoch: number;
  /** Highest epoch we hold a key for (cache), or null. */
  latestHeldEpoch: number | null;
  /** The key at `latestHeldEpoch` is CONFIRMED (node-final winner, our pair). */
  latestConfirmed: boolean;
  rotateAllowed: boolean;
  establishing: boolean;
  /** Highest epoch this wallet already healed past for the channel (persisted). */
  healedUpTo: number;
}

/**
 * Heal only for a message at OUR LATEST epoch whose key is confirmed (an
 * older confirmed epoch is history — rotating again would loop: after a heal
 * to E+1 the same bad message at E would re-heal on every remount), only
 * where rotation is allowed, never while an establishment runs, and never
 * twice for the same epoch (persisted, so a restart cannot re-trigger).
 * The escalation gate is applied on top by the caller.
 */
export function shouldHeal(i: HealInput): boolean {
  if (!i.rotateAllowed || i.establishing || !i.latestConfirmed) return false;
  if (i.latestHeldEpoch === null || !Number.isSafeInteger(i.messageEpoch) || i.messageEpoch < 1) return false;
  if (i.messageEpoch !== i.latestHeldEpoch) return false;
  return i.messageEpoch > i.healedUpTo;
}

/** AsyncStorage base of the heal ledger (NEW key, `::<wallet>` scoped). */
export const HEAL_LEDGER_BASE = 'ogmara.pchan.healed';
/** Channels remembered per wallet (oldest evicted). */
export const MAX_HEAL_LEDGER = 1024;
/** An unfinished heal of an epoch may be retried after this long… */
export const HEAL_RETRY_AFTER_MS = 10 * 60_000;
/** …at most this many times in total for that epoch. */
export const MAX_HEAL_TRIES = 3;

/** One channel's ledger row: epoch `e` healed (`done`) or attempted `tries` times, retry not before `retryAt`. */
interface HealRow { e: number; done: boolean; retryAt: number; tries: number }

/**
 * Per wallet, per channel: the epoch a heal rotated past. Written BEFORE the
 * heal rotation starts (so a remount re-decrypting the same bad message can
 * never loop), and marked `done` when the rotation produced a key past it.
 * An attempt that never finished (app killed, account switch, a joined flow
 * for another epoch, a terminal problem) blocks that epoch only until
 * {@link HEAL_RETRY_AFTER_MS} has passed, at most {@link MAX_HEAL_TRIES}
 * times — the escalation gate still applies on top. Loaded once per wallet,
 * writes serialized, whole map every time. A read error makes
 * {@link HealLedger.healedUpTo} return +Infinity (fail closed: no heal).
 */
export class HealLedger {
  private readonly maps = new Map<string, Promise<Map<number, HealRow>>>();
  private chain: Promise<void> = Promise.resolve();
  private readonly io: WalletRowIo;

  constructor(io: WalletRowIo) {
    this.io = io;
  }

  reset(): void {
    this.maps.clear();
  }

  private load(wallet: string): Promise<Map<number, HealRow>> {
    let p = this.maps.get(wallet);
    if (!p) {
      const pending = this.chain;
      p = (async () => {
        await pending;
        const raw = await this.io.read(wallet, HEAL_LEDGER_BASE);
        const m = new Map<number, HealRow>();
        try {
          const o = raw ? JSON.parse(raw) : null;
          if (o && typeof o === 'object' && !Array.isArray(o)) {
            for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
              const ch = Number(k);
              if (m.size >= MAX_HEAL_LEDGER) break;
              const r = v as Partial<HealRow> | null;
              if (!Number.isSafeInteger(ch) || ch <= 0 || !r || !Number.isSafeInteger(r.e) || (r.e as number) < 1) continue;
              m.set(ch, {
                e: r.e as number,
                done: r.done === true,
                retryAt: Number.isSafeInteger(r.retryAt) ? (r.retryAt as number) : 0,
                tries: Number.isSafeInteger(r.tries) ? Math.max(0, r.tries as number) : MAX_HEAL_TRIES,
              });
            }
          }
        } catch { /* corrupt → nothing healed yet */ }
        return m;
      })();
      this.maps.set(wallet, p);
      const self = p;
      self.catch(() => { if (this.maps.get(wallet) === self) this.maps.delete(wallet); });
    }
    return p;
  }

  private async save(wallet: string, m: Map<number, HealRow>): Promise<void> {
    while (m.size > MAX_HEAL_LEDGER) {
      const oldest = m.keys().next().value;
      if (oldest === undefined) break;
      m.delete(oldest);
    }
    const json = JSON.stringify(Object.fromEntries([...m].map(([k, v]) => [String(k), v])));
    const run = this.chain.then(() => this.io.write(wallet, HEAL_LEDGER_BASE, json)).catch(() => {});
    this.chain = run;
    await run;
  }

  /**
   * Highest epoch whose heal must NOT run again at `now`: a finished heal's
   * epoch; an unfinished one's epoch until its retry time (or for good once
   * its tries are spent); else the epoch below it.
   */
  async healedUpTo(wallet: string, channelId: number, now: number): Promise<number> {
    let r: HealRow | undefined;
    try {
      r = (await this.load(wallet)).get(channelId);
    } catch {
      return Number.POSITIVE_INFINITY;
    }
    if (!r) return 0;
    if (r.done || now < r.retryAt || r.tries >= MAX_HEAL_TRIES) return r.e;
    return r.e - 1;
  }

  /** Record an ATTEMPT to heal past `epoch` (before rotating). False if it could not be read (do not heal). */
  async record(wallet: string, channelId: number, epoch: number, now: number): Promise<boolean> {
    let m: Map<number, HealRow>;
    try {
      m = await this.load(wallet);
    } catch {
      return false;
    }
    const prev = m.get(channelId);
    if (prev && (prev.e > epoch || (prev.e === epoch && prev.done))) return true;
    const tries = prev && prev.e === epoch ? prev.tries + 1 : 1;
    m.delete(channelId);
    m.set(channelId, { e: epoch, done: false, retryAt: now + HEAL_RETRY_AFTER_MS, tries });
    await this.save(wallet, m);
    return true;
  }

  /** The heal past `epoch` produced a key above it: never retry it. */
  async complete(wallet: string, channelId: number, epoch: number): Promise<void> {
    let m: Map<number, HealRow>;
    try {
      m = await this.load(wallet);
    } catch {
      return;
    }
    const r = m.get(channelId);
    if (!r || r.e !== epoch || r.done) return;
    r.done = true;
    await this.save(wallet, m);
  }
}

/**
 * The heal decision: {@link shouldHeal}, and the epoch to rotate to (past the
 * message epoch and every authenticated epoch), or null. The account's
 * escalation gate (once per channel per 10 min) is taken by the caller only
 * when the rotation really starts ({@link shouldTakeGate}).
 */
export function planHeal(i: HealInput, highestEvidence: number): number | null {
  if (!shouldHeal(i)) return null;
  return Math.max(i.messageEpoch, highestEvidence) + 1;
}

// --- Floor-driven rotation coalescing ------------------------------------------------------------

/** Minimum spacing between two floor-driven rotations of one channel. */
export const FLOOR_ROTATION_SPACING_MS = 60_000;

/** Result of {@link FloorRotationQueue.request}. */
export type FloorRequest =
  /** `token` identifies this start: only its owner may {@link FloorRotationQueue.finish} it. */
  | { action: 'start'; token: number }
  /** Queued as THE follow-up; `delayMs` = when to try it (null: when the in-flight one ends). */
  | { action: 'queued'; delayMs: number | null }
  | { action: 'ignored' };

/**
 * W6: a node-supplied `channel_members_changed` floor must not drive
 * back-to-back rotations. Per channel: at most ONE rotation in flight plus
 * ONE queued follow-up (the highest floor seen meanwhile — lower or equal
 * floors are dropped), and at least {@link FLOOR_ROTATION_SPACING_MS} between
 * two starts.
 */
export class FloorRotationQueue {
  private readonly m = new Map<number, { inFlight: number | null; token: number; queued: number | null; lastStart: number }>();
  private readonly spacingMs: number;
  private seq = 0;

  constructor(spacingMs = FLOOR_ROTATION_SPACING_MS) {
    this.spacingMs = spacingMs;
  }

  private entry(ch: number) {
    let e = this.m.get(ch);
    if (!e) {
      e = { inFlight: null, token: 0, queued: null, lastStart: Number.NEGATIVE_INFINITY };
      this.m.set(ch, e);
    }
    return e;
  }

  request(ch: number, floor: number, now: number): FloorRequest {
    if (!Number.isSafeInteger(floor) || floor <= 0) return { action: 'ignored' };
    const e = this.entry(ch);
    const top = Math.max(e.inFlight ?? 0, e.queued ?? 0);
    if (e.inFlight !== null) {
      if (floor <= top) return { action: 'ignored' };
      e.queued = floor;
      return { action: 'queued', delayMs: null };
    }
    const wait = e.lastStart + this.spacingMs - now;
    if (wait > 0) {
      if (floor <= top) return { action: 'ignored' };
      e.queued = floor;
      return { action: 'queued', delayMs: wait };
    }
    e.inFlight = floor;
    e.token = ++this.seq;
    e.queued = null;
    e.lastStart = now;
    return { action: 'start', token: e.token };
  }

  /**
   * The in-flight rotation started with `token` ended. Returns the queued
   * follow-up's floor + delay, if any. A stale token (the queue was cleared
   * by an account switch and another start owns the channel now) is ignored.
   */
  finish(ch: number, now: number, token: number): { floor: number; delayMs: number } | null {
    const e = this.m.get(ch);
    if (!e || e.inFlight === null || e.token !== token) return null;
    e.inFlight = null;
    if (e.queued === null) return null;
    return { floor: e.queued, delayMs: Math.max(0, e.lastStart + this.spacingMs - now) };
  }

  /** Take the queued follow-up if it may start now (marks it in flight). */
  takeQueued(ch: number, now: number): { floor: number; token: number } | null {
    const e = this.m.get(ch);
    if (!e || e.queued === null || e.inFlight !== null) return null;
    if (now < e.lastStart + this.spacingMs) return null;
    const f = e.queued;
    e.queued = null;
    e.inFlight = f;
    e.token = ++this.seq;
    e.lastStart = now;
    return { floor: f, token: e.token };
  }

  clear(): void {
    this.m.clear();
  }
}

// --- Send decisions ---------------------------------------------------------------------------

/** A node commitment state for a held key (channelCrypto `checkPair`), or null when unreadable. */
export type PairKind = 'ours-final' | 'ours-pending' | 'other' | 'none' | 'legacy' | null;

/** What to do with the best key we HOLD. */
export type BestPlan =
  | { do: 'use' }
  | { do: 'rotate'; epoch: number }
  | { do: 'waiting' }
  /** Let the SDK settle / adopt / report lagging for THIS epoch — we hold a key for it, so it is known. */
  | { do: 'settle'; epoch: number; known: true }
  /**
   * The best key is UNVERIFIABLE but an older TRUSTED + FINAL key at or above
   * the floor exists (`ChannelKeyStore.sendKey`): send under that one — a
   * node-served key at a higher epoch must not block sending.
   */
  | { do: 'fallback' }
  /**
   * The epoch is LEGACY (commitment-less) on the node: never send under a key
   * a node chose there — move (GATED) to a new arbitrated epoch
   * ({@link legacyMoveTarget}).
   */
  | { do: 'move' };

/**
 * Decide with the best held key (epoch `bestEpoch`). `usable` = the key is
 * CONFIRMED or the early-use key; otherwise `pair` is the node's
 * answer. Holding a key for an epoch makes THAT epoch known to exist (B2):
 * a node answering `none` for it is lagging and must not get a new key there.
 */
export function planBest(i: {
  bestEpoch: number; eFloor: number; rotateAllowed: boolean; usable: boolean; pair: PairKind;
  /** May this member open a new epoch (creator / mod, or a channel that may rotate)? */
  mayMove: boolean;
  /** The best key is author-verified (ours / a verified wrap / our provisional key). */
  authorVerified: boolean;
  /** Epoch of `ChannelKeyStore.sendKey` (trusted + final, bounded), or null. */
  fallbackEpoch: number | null;
}): BestPlan {
  if (i.bestEpoch < i.eFloor) return i.rotateAllowed ? { do: 'rotate', epoch: Math.max(i.bestEpoch + 1, i.eFloor) } : { do: 'waiting' };
  if (i.usable || i.pair === 'ours-final') return { do: 'use' };
  // An UNVERIFIABLE best key (node-served / vault whose own wrap did not
  // re-verify, or a LEGACY epoch): never settle on it — fall back to an older
  // trusted final key (as web / desktop), else move off a legacy epoch.
  if (!i.authorVerified || i.pair === 'legacy') {
    if (i.fallbackEpoch !== null && i.fallbackEpoch >= i.eFloor) return { do: 'fallback' };
    // All-clients decision (sdk-js 0.68.0): never send under a key at a LEGACY
    // epoch — whoever may establish moves the channel to an arbitrated epoch
    // (gated); everyone else waits for that move.
    if (i.pair === 'legacy' && i.mayMove) return { do: 'move' };
    return { do: 'waiting' };
  }
  if (i.pair === null) return { do: 'waiting' };
  return { do: 'settle', epoch: i.bestEpoch, known: true };
}

/**
 * Target of a gated move off a legacy epoch (cover or send; same as web
 * `planLegacyMove`): above the TRUSTED rotation base, the node's highest and
 * the authenticated highest — never `best.epoch + 1`.
 */
export function legacyMoveTarget(verifiedBase: number, nodeHighest: number, highestSeen: number): number {
  return Math.max(verifiedBase, nodeHighest, highestSeen) + 1;
}

/**
 * EARLY USE eligibility of a brand-new channel's first key (W2, as web /
 * desktop): only when the VERIFIED member set is COMPLETE, non-empty and every
 * target is our own wallet. The node's member list alone is never proof (an
 * incomplete pass, or an empty list, is NOT "alone").
 */
export function earlyUseAlone(targets: ReadonlyArray<{ target: string }>, incomplete: boolean, self: string): boolean {
  return !incomplete && targets.length > 0 && targets.every((t) => t.target === self);
}

/**
 * Put options for a wrap `verifyChannelKeyWrap` verified from OUR OWN slot
 * (M11, as desktop `ownSlotWrapOpts`): `ownSlot` exactly when the wrap's
 * verified author wallet is ours; another member's wrap is bounded by the
 * node's highest + 256 and the member caps.
 */
export function ownSlotWrapOpts(authorWallet: string, selfWallet: string, nodeHighest: number): { ownSlot: boolean; nodeHighest: number } {
  return { ownSlot: typeof authorWallet === 'string' && authorWallet === selfWallet, nodeHighest };
}

/** Decrypt-miss fetches per (channel scope, epoch) per minute (B2, desktop `MISS_FETCHES_PER_MIN`). */
export const MISS_FETCHES_PER_MIN = 3;
/** Entries the limiter remembers (oldest dropped). */
export const MAX_MISS_ENTRIES = 2048;

/**
 * B2: every rendered `waiting` message of a missing epoch re-decrypts every
 * few seconds; without a bound each would fetch (with retries) on its own, and
 * a member posting many distinct `key_epoch` values would turn that into a
 * request storm. At most {@link MISS_FETCHES_PER_MIN} fetches per key per
 * minute; bounded; cleared on account switch.
 */
export class MissFetchLimiter {
  private readonly m = new Map<string, { start: number; n: number }>();

  take(k: string, now: number): boolean {
    const cur = this.m.get(k);
    if (cur && now - cur.start < 60_000) {
      if (cur.n >= MISS_FETCHES_PER_MIN) return false;
      cur.n++;
      return true;
    }
    this.m.delete(k);
    while (this.m.size >= MAX_MISS_ENTRIES) {
      const oldest = this.m.keys().next().value;
      if (oldest === undefined) break;
      this.m.delete(oldest);
    }
    this.m.set(k, { start: now, n: 1 });
    return true;
  }

  get size(): number {
    return this.m.size;
  }

  clear(): void {
    this.m.clear();
  }
}

/** A failed node-highest read is not retried for this long (B2: no re-query per rendered message). */
export const NODE_HIGHEST_FAIL_TTL_MS = 30_000;

/** A NEWER epoch than our best exists on the node: what now? */
export function planNewerLatest(i: {
  latestState: KeyCommitmentInfo['state']; fetchedKey: boolean; haveBest: boolean; canEstablish: boolean;
}): 'use-fetched' | 'adopt' | 'keep' {
  if (i.fetchedKey) return 'use-fetched';
  if (i.latestState === 'arbitrated' && (i.haveBest || !i.canEstablish)) return 'adopt';
  return 'keep';
}

/** Seeding when we hold no key at all (`canEstablish` already true). */
export function planSeed(i: {
  latestState: KeyCommitmentInfo['state']; latestEpoch: number; target: number;
}): { do: 'adopt'; epoch: number } | { do: 'seed'; epoch: number; gated: boolean } {
  if (i.latestState === 'arbitrated' && i.latestEpoch >= i.target) return { do: 'adopt', epoch: i.latestEpoch };
  // Past a LEGACY epoch nobody can cover any more: open the next one, GATED
  // (the caller spends the slot only when the flow really starts).
  if (i.latestState === 'legacy' && i.latestEpoch >= i.target) return { do: 'seed', epoch: i.latestEpoch + 1, gated: true };
  return { do: 'seed', epoch: i.target, gated: false };
}

/** User decision: early use ONLY for the very first key of a brand-new channel whose creator is alone. */
export function earlyUseAllowed(i: { epoch: number; latestState: KeyCommitmentInfo['state']; soleMember: boolean }): boolean {
  return i.epoch === 1 && i.latestState === 'none' && i.soleMember;
}

/** Cover decision for the current epoch's node state. */
export function planCover(pair: Exclude<PairKind, 'ours-pending'> | 'ours', rotateAllowed: boolean): 'publish' | 'rotate' | 'skip' | 'adopt' | 'retry' {
  switch (pair) {
    case 'ours':
    case 'ours-final': return 'publish';
    case 'legacy': return rotateAllowed ? 'rotate' : 'skip';
    case 'none': return 'skip';
    case 'other': return 'adopt';
    default: return 'retry';
  }
}

/** Options to resume a persisted establishment with (W4): persisted mode, plus "we hold a key for it". */
export function resumeOpts(p: { isPrivate?: boolean; known?: boolean }, holdsKeyAtEpoch: boolean): { isPrivate: boolean; known: boolean } {
  return { isPrivate: p.isPrivate === true, known: p.known === true || holdsKeyAtEpoch };
}

/**
 * W1 (mobile re-audit): the options an automatic RESUME runs with — the plan's
 * type and `known` only. Never the original plan's `gate` (escalation slot) or
 * `beforeStart` (heal-ledger write): those belong to the plan's real start; a
 * resume replaying them would spend a gate slot / record a heal attempt per
 * retry, or be refused by the gate and leave the pending epoch unfinished.
 * Never early use.
 */
export function resumePlanOpts(o: { isPrivate: boolean; known: boolean }): { isPrivate: boolean; known: boolean; earlyUse: false } {
  return { isPrivate: o.isPrivate, known: o.known, earlyUse: false };
}

// --- Status + message ----------------------------------------------------------------------------

/** What a scheduleResume call did. */
export type ResumeScheduling = 'scheduled' | 'already' | 'exhausted';

/**
 * The channel status after a finished flow (W-A): "re-keying…" only while a
 * resume really is pending — once the automatic attempts are spent the
 * problem sticks (the next send retries), never a "re-keying…" forever.
 */
export function statusAfterFlow(
  r: { kind: 'key'; confirmed: boolean; incomplete: boolean; epoch: number }
    | { kind: 'pending'; epoch: number }
    | { kind: 'problem'; code: EpochProblem; detail?: string },
  resume: ResumeScheduling | null,
): ChannelKeyStatus {
  if (r.kind === 'problem') return { state: 'problem', code: r.code, detail: r.detail };
  if (r.kind === 'key' && r.confirmed) return { state: 'idle' }; // usable; uncovered members resume in the background
  if (resume === 'exhausted') return { state: 'problem', code: 'failed', detail: 'resume_exhausted' };
  return { state: 'rekeying', epoch: r.epoch };
}

/**
 * The i18n key the screen shows for a status (null = nothing). A node that
 * cannot carry this channel's key (epoch too far, unrecoverable lag, or a
 * PUBLIC channel whose held epoch the node lacks — no rotation allowed there)
 * maps to "switch to another node"; everything else is retried by the next send.
 */
export function statusMessageKey(st: ChannelKeyStatus): 'e2e_channel_rekeying' | 'e2e_channel_key_node_behind' | 'e2e_channel_key_failed' | null {
  if (st.state === 'idle') return null;
  if (st.state === 'rekeying') return 'e2e_channel_rekeying';
  if (st.code === 'epoch_too_high' || st.code === 'node_lagging_unrecoverable') return 'e2e_channel_key_node_behind';
  if (st.code === 'no_rotate' && st.detail === 'node_lagging') return 'e2e_channel_key_node_behind';
  return 'e2e_channel_key_failed';
}

/**
 * How far above the node's highest epoch a held key may be and still be chosen
 * for sending, covering, the rotation base or heal (the node's own acceptance
 * bound): `maxEpoch = nodeHighest + SEND_EPOCH_MARGIN` on every keyring query.
 */
export const SEND_EPOCH_MARGIN = 256;

// --- Node epoch bound (unified client guard) ---------------------------------------------------

/** How far ahead of the node's highest known epoch a client may establish / trust a floor (SDK NODE_EPOCH_MAX_AHEAD, node acceptance bound). */
export const NODE_EPOCH_MAX_AHEAD = 256;

/** May an establish / rotate plan target `epoch` given the node's highest known epoch? */
export function epochWithinNodeBound(epoch: number, nodeHighestEpoch: number): boolean {
  return Number.isSafeInteger(epoch) && epoch >= 1 && Number.isSafeInteger(nodeHighestEpoch) && nodeHighestEpoch >= 0
    && epoch <= nodeHighestEpoch + NODE_EPOCH_MAX_AHEAD;
}

/**
 * A node-served `key_epoch_floor` is only trusted up to the node's highest
 * known epoch + {@link NODE_EPOCH_MAX_AHEAD}: `'ok'` (use it), `'none'` (no
 * floor), `'hostile'` (beyond the bound: rotate to nothing, surface it), or
 * `'unknown'` (node highest not read yet: do not act on it).
 */
export function floorTrust(floor: number, nodeHighestEpoch: number | null): 'ok' | 'none' | 'hostile' | 'unknown' {
  if (!Number.isSafeInteger(floor) || floor <= 0) return 'none';
  if (nodeHighestEpoch === null) return 'unknown';
  return floor <= nodeHighestEpoch + NODE_EPOCH_MAX_AHEAD ? 'ok' : 'hostile';
}

// --- Resume budget ---------------------------------------------------------------------------------

/**
 * Automatic resume attempts per channel. Only a COMPLETE result (confirmed,
 * every target covered) resets the budget — an outcome with uncovered
 * members or an unconfirmed key keeps counting, so the retries really end.
 */
export class ResumeBudget {
  private readonly m = new Map<number, number>();
  readonly max: number;

  constructor(max: number) {
    this.max = max;
  }

  /** Spend one attempt: its 0-based index, or null when exhausted. */
  take(ch: number): number | null {
    const n = this.m.get(ch) ?? 0;
    if (n >= this.max) return null;
    this.m.set(ch, n + 1);
    return n;
  }

  /** The establishment finished completely. */
  complete(ch: number): void {
    this.m.delete(ch);
  }

  clear(): void {
    this.m.clear();
  }
}

/**
 * A gate token (escalation slot) is spent only when a plan REALLY starts: not
 * when it joins an establishment already in flight, and not when a confirmed
 * key at (or above) the target epoch is already held.
 */
export function shouldTakeGate(i: { joining: boolean; alreadyAt: boolean }): boolean {
  return !i.joining && !i.alreadyAt;
}


// --- Key store: adapter over the shared SDK keyring (sdk-js 0.68.0) ------------------------------

/**
 * What caching a key did, as channelCrypto acts on it:
 *  - `stored`   held (new epoch, the same bytes merged, or promoted with no
 *               OTHER key at the epoch);
 *  - `mismatch` a DIFFERENT key was already held at the epoch: both are kept
 *               (both decrypt), the caller logs it and may heal (gated);
 *  - `refused`  an unprotected node-served key the keyring does not hold
 *               (caps, commitment-less duplicate) — never a fallback;
 *  - `dropped`  stale account generation, or malformed / pair-inconsistent input.
 */
export type KeyCacheResult = 'stored' | 'mismatch' | 'refused' | 'dropped';

/** What a prune removed (or would remove, dry run). */
export type PruneResult = ChannelKeyPruneResult;

/** The escalation ladder of the user-confirmed prune, least risky first (same as web / desktop). */
export type PruneLevel = Extract<ChannelKeyPruneClassName, 'nodeServed' | 'memberWraps' | 'restoredAlternates' | 'restoredPrimaries'>;
export const PRUNE_LEVELS: readonly PruneLevel[] = ['nodeServed', 'memberWraps', 'restoredAlternates', 'restoredPrimaries'];

/** A dry-run prune at one level (what the confirm shows), ready to apply. */
export interface PrunePlan {
  level: PruneLevel;
  /** `memberWraps`: only the one channel scope a member flooded most. */
  scopes?: string[];
  result: PruneResult;
}

/** What recording "the node's winner hashes to this held key" did. */
export type PairMatchResult =
  /** Author-verified + pair-consistent + not provisional: send / cover / evidence grade. */
  | 'trusted'
  /** Recorded, but still provisional (our not-yet-final key). */
  | 'untrusted'
  /** A vault / node-served key: re-verify the own-slot wrap (`verifyChannelKeyWrap`) and re-put it as `wrap`. */
  | 'needs_author_proof'
  | 'dropped';

const keyEq = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
};

/**
 * The epoch a commitment-less (legacy) key envelope may be cached under, or
 * null (rejected). With a requested epoch the envelope's OWN epoch must equal
 * it (SDK `acceptFetchedEnvelope`); for a "latest" read the node's label must
 * agree with the envelope's own epoch — the node's label alone never decides
 * (a hostile node would otherwise file a key under epoch 100000).
 */
export function legacyEnvelopeEpoch(requested: number | undefined, envelopeEpoch: unknown, nodeLabel: unknown): number | null {
  if (requested !== undefined) return acceptFetchedEnvelope(requested, envelopeEpoch) ? requested : null;
  if (typeof envelopeEpoch !== 'number' || !acceptFetchedEnvelope(envelopeEpoch, envelopeEpoch)) return null;
  if (nodeLabel !== undefined && nodeLabel !== null && nodeLabel !== envelopeEpoch) return null;
  return envelopeEpoch;
}

/**
 * Highest epoch to treat as authenticated for a rotation / heal target:
 * the per-account evidence (EpochEvidence) and the keyring's latest TRUSTED
 * epoch, both only up to `nodeHighest + SEND_EPOCH_MARGIN` — a malicious
 * MEMBER can author a verified wrap at any epoch (SDK 0.68.0 decision).
 */
export function boundedEvidence(evidence: number, latestTrusted: number, nodeHighest: number): number {
  const max = nodeHighest + SEND_EPOCH_MARGIN;
  return Math.max(evidence <= max ? evidence : 0, latestTrusted <= max ? latestTrusted : 0);
}

/**
 * The channel key store of mobile 0.58.0: a thin adapter over the SHARED
 * `ChannelKeyring` (sdk-js 0.68.0, same class as web / desktop). The keyring
 * owns every rule about holding keys (never overwrite, alternates, caps,
 * trust ranks, vault format and union); this adapter only
 *  - maps this app's call sites onto the keyring's provenance
 *    (`wrap` = own slot's wrap that passed `verifyChannelKeyWrap`;
 *    `establish` = an `establishEpochKey` result; `legacy` = commitment-less
 *    node key; vault keys only via {@link importVault}),
 *  - turns put results into {@link KeyCacheResult} (a DIFFERENT key at a
 *    held epoch = `mismatch`, compared BY BYTES — the keyring returns copies),
 *  - keeps the one piece of state the keyring does not support: a confirmed
 *    key whose pair LOST at the node (`KeyCommitmentConflictError` on cover)
 *    — the keyring never downgrades, so "this pair lost" lives here and is
 *    cleared when the node reports the pair as ours again.
 * Every put / import / export passes the account generation captured by the
 * caller BEFORE its network round trip; the keyring refuses stale ones.
 */
/** Channel scopes the prune ladder tracks (a memory bound; the keyring holds the keys). */
export const MAX_TRACKED_SCOPES = 4096;

export class ChannelKeyStore {
  private readonly ring: ChannelKeyring;
  /** slot → keys whose confirmed pair lost at the node (client state). */
  private readonly lost = new Map<string, Uint8Array[]>();

  constructor(generation: () => number, opts: Omit<ChannelKeyringOptions, 'generation'> = {}) {
    this.ring = new ChannelKeyring({ ...opts, generation });
  }

  private put(scopeHex: string, epoch: number, key: Uint8Array, opts: ChannelKeyPutOptions): KeyCacheResult {
    const before = this.ring.keysAt(scopeHex, epoch);
    const r: ChannelKeyPutResult = this.ring.put(scopeHex, epoch, key, opts);
    const different = before.length > 0 && !before.some((k) => keyEq(k, key));
    for (const k of before) k.fill(0);
    if (r === 'refused') return 'refused';
    if (r === 'stale' || r === 'invalid') return 'dropped';
    return (r === 'conflict' || r === 'promoted') && different ? 'mismatch' : 'stored';
  }

  /**
   * A wrap read from OUR OWN enc-key slot, AFTER `verifyChannelKeyWrap`
   * passed (author + membership + commitment). `ownSlot` = its verified
   * author is our own wallet (our key: never member-capped); another
   * member's wrap is bounded by `nodeHighest + 256` (above it: `refused`).
   * `final` ONLY from the node's commitment `final` flag for exactly this pair.
   */
  putWrap(
    scopeHex: string, epoch: number, key: Uint8Array, pair: ChannelKeyPair, generation: number,
    o: { ownSlot: boolean; nodeHighest: number; final?: boolean },
  ): KeyCacheResult {
    return this.noteScope(scopeHex, this.put(scopeHex, epoch, key, {
      source: 'wrap', pair, verified: true, final: o.final === true, generation,
      ...(o.ownSlot ? { ownSlot: true } : { maxEpoch: o.nodeHighest + SEND_EPOCH_MARGIN }),
    }));
  }

  /** A commitment-less (pre-arbitration) node key (epoch checked with {@link legacyEnvelopeEpoch}), bounded by nodeHighest + 256. */
  putLegacy(scopeHex: string, epoch: number, key: Uint8Array, generation: number, nodeHighest: number): KeyCacheResult {
    return this.noteScope(scopeHex, this.put(scopeHex, epoch, key, { source: 'legacy', maxEpoch: nodeHighest + SEND_EPOCH_MARGIN, generation }));
  }

  /** Channel scopes HELD this session (the member-flood prune level picks one); bounded. */
  private readonly scopeSet = new Set<string>();
  /** Remember the scope of a put that is HELD (never of a refused / dropped one); returns `r`. */
  private noteScope(scopeHex: string, r: KeyCacheResult = 'stored'): KeyCacheResult {
    if ((r === 'stored' || r === 'mismatch') && !this.scopeSet.has(scopeHex) && this.scopeSet.size < MAX_TRACKED_SCOPES) this.scopeSet.add(scopeHex);
    return r;
  }

  /**
   * An `establishEpochKey` result (our own key, or the winner it adopted from
   * an author-verified wrap). `final` = the node reports the pair final; a
   * not-yet-final key (incl. the early-use first key) is PROVISIONAL: held,
   * not exported, never sent under except via the early-use path, until an
   * author-source put / mark finalises it.
   */
  putEstablished(scopeHex: string, epoch: number, key: Uint8Array, pair: ChannelKeyPair, final: boolean, generation: number): KeyCacheResult {
    return this.noteScope(scopeHex, this.put(scopeHex, epoch, key, final
      ? { source: 'establish', pair, verified: true, final: true, provisional: false, generation }
      : { source: 'establish', pair, verified: true, provisional: true, generation }));
  }


  /**
   * The node's winner pair hashes to this held key. For an author-verified key
   * the pair (and finality) is recorded; a vault / node-served key needs its
   * own-slot wrap re-verified first (`needs_author_proof`).
   */
  notePairMatch(scopeHex: string, epoch: number, key: Uint8Array, pair: ChannelKeyPair, final: boolean, generation: number): PairMatchResult {
    const r = this.ring.markVerified(scopeHex, epoch, key, pair, { final, generation });
    if (r === 'needs_author_proof') return 'needs_author_proof';
    if (r !== 'verified' && r !== 'promoted') return 'dropped';
    this.unlose(scopeHex, epoch, key);
    return this.flags(scopeHex, epoch, key)?.trusted ? 'trusted' : 'untrusted';
  }

  /** The node's winner changed away from this key (cover got `KeyCommitmentConflictError`). */
  markLost(scopeHex: string, epoch: number, key: Uint8Array): void {
    const s = `${scopeHex}:${epoch}`;
    const l = this.lost.get(s) ?? [];
    if (!l.some((k) => keyEq(k, key))) l.push(key.slice());
    this.lost.set(s, l);
  }

  private unlose(scopeHex: string, epoch: number, key: Uint8Array): void {
    const s = `${scopeHex}:${epoch}`;
    const l = this.lost.get(s);
    if (!l) return;
    const rest = l.filter((k) => {
      if (!keyEq(k, key)) return true;
      k.fill(0);
      return false;
    });
    if (rest.length > 0) this.lost.set(s, rest);
    else this.lost.delete(s);
  }

  private isLost(scopeHex: string, epoch: number, key: Uint8Array): boolean {
    return this.lost.get(`${scopeHex}:${epoch}`)?.some((k) => keyEq(k, key)) ?? false;
  }

  /** Flags of one held key (no key copy is kept), or undefined. */
  private flags(scopeHex: string, epoch: number, key: Uint8Array): Omit<ChannelKeyInfo, 'key'> | undefined {
    let hit: Omit<ChannelKeyInfo, 'key'> | undefined;
    for (const e of this.ring.entriesAt(scopeHex, epoch)) {
      if (!hit && keyEq(e.key, key)) {
        const { key: _k, ...rest } = e;
        hit = rest;
      }
      e.key.fill(0);
    }
    return hit;
  }

  /** Flags of one held key (no key bytes), or undefined. */
  info(scopeHex: string, epoch: number, key: Uint8Array): Omit<ChannelKeyInfo, 'key'> | undefined {
    return this.flags(scopeHex, epoch, key);
  }

  /** TRUSTED (author-verified + pair-consistent + not provisional): counts as evidence. */
  isTrusted(scopeHex: string, epoch: number, key: Uint8Array): boolean {
    return this.flags(scopeHex, epoch, key)?.trusted === true;
  }

  /** CONFIRMED = trusted AND node-final AND its pair has not lost since: send / cover / heal grade. */
  isConfirmed(scopeHex: string, epoch: number, key: Uint8Array): boolean {
    const f = this.flags(scopeHex, epoch, key);
    return !!f && f.trusted && f.final && !this.isLost(scopeHex, epoch, key);
  }

  /** Some key held at the epoch is CONFIRMED. */
  anyConfirmed(scopeHex: string, epoch: number): boolean {
    let ok = false;
    for (const e of this.ring.entriesAt(scopeHex, epoch)) {
      if (!ok && e.trusted && e.final && !this.isLost(scopeHex, epoch, e.key)) ok = true;
      e.key.fill(0);
    }
    return ok;
  }

  /** A held provisional (not-yet-final own) key. */
  isProvisional(scopeHex: string, epoch: number, key: Uint8Array): boolean {
    return this.flags(scopeHex, epoch, key)?.provisional === true;
  }

  /** Every key held at the epoch for DECRYPTION, primary first (copies). */
  keysAt(scopeHex: string, epoch: number): Uint8Array[] {
    return this.ring.keysAt(scopeHex, epoch);
  }

  /** Some key is held at the epoch (makes THAT epoch known; never global evidence). */
  holds(scopeHex: string, epoch: number): boolean {
    return this.ring.holds(scopeHex, epoch);
  }

  /** Epochs held at or above `minEpoch` (ascending). */
  epochsFrom(scopeHex: string, minEpoch: number): number[] {
    return this.ring.epochs(scopeHex).filter((e) => e >= minEpoch);
  }

  /** The highest held epoch ≤ nodeHighest + margin (any key; its primary), or null. */
  latestBounded(scopeHex: string, nodeHighest: number): ChannelKeyHeld | null {
    return this.ring.latestBounded(scopeHex, nodeHighest + SEND_EPOCH_MARGIN);
  }

  /** The highest TRUSTED epoch ≤ nodeHighest + margin (rotation base, heal, evidence), or null. */
  latestTrusted(scopeHex: string, nodeHighest: number, finalOnly = false): ChannelKeyHeld | null {
    return this.ring.latestVerified(scopeHex, { maxEpoch: nodeHighest + SEND_EPOCH_MARGIN, finalOnly });
  }

  /**
   * The key to send / cover under without asking the node: the primary of the
   * highest epoch ≤ nodeHighest + margin that is trusted AND final (user
   * decision: rotations wait for FINAL) and whose pair has not lost since.
   * Never the unverified / legacy fallbacks (all-clients decision: legacy epochs move, gated).
   */
  sendKey(scopeHex: string, nodeHighest: number): ChannelKeyHeld | null {
    const k = this.ring.bestForSend(scopeHex, { finalOnly: true, maxEpoch: nodeHighest + SEND_EPOCH_MARGIN });
    if (k && this.isLost(scopeHex, k.epoch, k.key)) {
      k.key.fill(0);
      return null;
    }
    return k;
  }

  /**
   * TWO-STEP vault export (side-effect free): the `chan` record + a token.
   * Redeem the token with {@link commitExport} ONLY after the sealed vault
   * was published; a failed / stale publish commits nothing. Throws
   * `ChannelKeyringError` — `vault_too_large` / `opaque_overflow` (surface as
   * "backup paused") or `stale` (account changed).
   */
  prepareExport(generation: number): ChannelKeyPreparedExport {
    return this.ring.prepareExport(generation);
  }

  /** The publish of a prepared export succeeded: mark its keys persisted. False when stale / unknown token. */
  commitExport(token: ChannelKeyExportToken, generation: number): boolean {
    try {
      this.ring.commitExport(token, generation);
      return true;
    } catch (e) {
      if (e instanceof ChannelKeyringError) return false;
      throw e;
    }
  }

  /**
   * Merge a vault `chan` record (keys come back as `vault`: NOT trusted until
   * re-verified). The record spans every channel, so no per-channel ceiling
   * is passed (SDK gap: `importFromVault` takes one `maxEpoch` only). 0 when stale.
   */
  importVault(rec: Record<string, Uint8Array>, generation: number): number {
    for (const name of Object.keys(rec)) {
      const m = /^([0-9a-fA-F]{64}):/.exec(name);
      if (m) this.noteScope(m[1]!.toLowerCase());
    }
    try {
      return this.ring.importFromVault(rec, generation);
    } catch (e) {
      if (e instanceof ChannelKeyringError && e.code === 'stale') return 0;
      throw e;
    }
  }

  /** Dry run of one prune level (nothing removed). `memberWraps`: only the most flooded channel. null = stale. */
  planPrune(level: PruneLevel, generation: number): PrunePlan | null {
    try {
      if (level !== 'memberWraps') {
        return { level, result: this.ring.pruneUnverified({ dryRun: true, classes: [level], generation }) };
      }
      let best: PrunePlan | null = null;
      for (const scope of this.scopeSet) {
        const result = this.ring.pruneUnverified({ dryRun: true, classes: ['memberWraps'], scopes: [scope], generation });
        if (result.removedCount > 0 && (!best || result.removedCount > best.result.removedCount)) best = { level, scopes: [scope], result };
      }
      return best ?? { level, scopes: [], result: this.ring.pruneUnverified({ dryRun: true, classes: ['memberWraps'], scopes: [], generation }) };
    } catch (e) {
      if (e instanceof ChannelKeyringError && e.code === 'stale') return null;
      throw e;
    }
  }

  /** The first ladder level (from `from` on) whose dry run would remove something, or null. */
  nextPrunePlan(generation: number, from: PruneLevel = 'nodeServed'): PrunePlan | null {
    for (const level of PRUNE_LEVELS.slice(PRUNE_LEVELS.indexOf(from))) {
      const plan = this.planPrune(level, generation);
      if (!plan) return null;
      if (plan.result.removedCount > 0) return plan;
    }
    return null;
  }

  /**
   * B1: true when a fresh dry run of `plan` (same level AND scopes) would
   * remove MORE than the confirmed one showed — in total, in bytes, or in any
   * class (keys arrived while the dialog was open, e.g. a pre-seal re-import).
   * The user must see the new counts first. A stale generation counts as grown.
   */
  pruneGrew(plan: PrunePlan, generation: number): boolean {
    let now: PruneResult;
    try {
      now = this.ring.pruneUnverified({ dryRun: true, classes: [plan.level], scopes: plan.scopes, generation });
    } catch (e) {
      if (e instanceof ChannelKeyringError && e.code === 'stale') return true;
      throw e;
    }
    const was = plan.result;
    if (now.removedCount > was.removedCount || now.removedBytes > was.removedBytes) return true;
    for (const k of Object.keys(now.byClass) as Array<keyof PruneResult['byClass']>) {
      if (now.byClass[k].count > was.byClass[k].count || now.byClass[k].bytes > was.byClass[k].bytes) return true;
    }
    return false;
  }

  /**
   * Apply a CONFIRMED plan (same level / scopes as its dry run). The SDK
   * remembers pruned keys for the session, so the pre-seal re-import of the
   * remote vault does not bring them back. null = stale.
   */
  applyPrune(plan: PrunePlan, generation: number): PruneResult | null {
    // A member-wrap plan is ALWAYS scoped (the flooded channel, or none).
    if (plan.level === 'memberWraps' && !plan.scopes) throw new Error('memberWraps prune plan without scopes');
    try {
      return this.ring.pruneUnverified({
        classes: [plan.level], scopes: plan.scopes, includeRestoredPrimaries: plan.level === 'restoredPrimaries', generation,
      });
    } catch (e) {
      if (e instanceof ChannelKeyringError && e.code === 'stale') return null;
      throw e;
    }
  }

  /**
   * B1: apply a plan the user CONFIRMED only if a fresh dry run removes no
   * more than the confirmation showed; else `'changed'` (nothing removed) —
   * re-confirm with the new counts. null = stale.
   */
  applyConfirmedPrune(plan: PrunePlan, generation: number): PruneResult | 'changed' | null {
    if (this.pruneGrew(plan, generation)) return 'changed';
    return this.applyPrune(plan, generation);
  }

  /** Anything to back up (cheap; no export): held epochs or uninterpretable vault entries. */
  get hasContent(): boolean {
    return this.ring.heldEpochCount > 0 || this.ring.opaqueCount > 0;
  }

  /** Held epochs over all scopes. */
  get size(): number {
    return this.ring.heldEpochCount;
  }

  /** Zero and drop everything (sign-out / account switch). */
  clear(): void {
    this.ring.clear();
    for (const l of this.lost.values()) for (const k of l) k.fill(0);
    this.lost.clear();
    this.scopeSet.clear();
  }
}
