/**
 * Encrypted channels (P2 private OECK + P4 public) — mobile port of desktop
 * `channelCrypto.ts`. A channel has a single random 32-byte `channel_key` per epoch,
 * delivered to every member device via `ChannelKeyEnvelope` (0x61, channel scope) and
 * used to XChaCha20-Poly1305-encrypt each message's TEXT (mentions/reply_to/
 * content_rating stay plaintext, spec §3.3).
 *
 * Epochs are NODE-ARBITRATED (l2-node 0.143.0 `key_commitment_v1`, sdk-js 0.67.0):
 * the node keeps one winner per (channel scope, epoch) — the lowest
 * `(key_ts, key_commitment)` pair, final 120 s after it was recorded — and every
 * establishment / rotation / adoption runs the SDK's shared `establishEpochKey`
 * protocol (wired in `epochWiring.ts`). Consequences here:
 *  - every key is cached WITH its `(keyTs, keyCommitment)` pair (in memory; a key
 *    restored from the key vault — whose SDK format carries keys only — gets its
 *    pair back from the node's commitment, verified locally against the key:
 *    `H(scope, epoch, keyTs, key) == commitment`). Covering a new member at an
 *    existing epoch publishes with that SAME pair (strict node policy: a
 *    commitment-less channel envelope is refused at any arbitrated epoch);
 *  - a key is used for SENDING only once the node reports it FINAL (user decision:
 *    a "re-keying…" state of up to ~2 min after a kick), except the very first key
 *    of a brand-new channel whose creator is its only member (early use);
 *  - inbound wraps at arbitrated epochs are VERIFIED (`verifyChannelKeyWrap`:
 *    author is a verified member, commitment matches) — a node can no longer
 *    inject a key of its choosing into this device's slot;
 *  - rotation is a NO-OP for public channels (id below the private floor and no
 *    creator pin): a hostile node cannot make members rotate a public channel.
 */
import {
  computeChannelScope,
  unwrapConvKey,
  randomConvKey,
  decryptDmContent,
  buildEncryptedChannelMessage,
  buildChannelEpochKeyEnvelope,
  computeKeyCommitment,
  keyCommitmentFromHex,
  keyCommitmentsEqual,
  verifyChannelKeyWrap,
  makeOwnWrapFetcher,
  encPublicKeyHex,
  filterVerifiedMembers,
  verifyEncKeyBinding,
  MemberProofCache,
  PendingEpochKeyStore,
  EscalationGate,
  TokenBucket,
  KeyCommitmentConflictError,
  KeyEnvelopeRateLimitedError,
  KeyEnvelopeRejectedError,
  OgmaraClient,
  type WrappedKey,
  type MediaDescriptor,
  type DeviceEncKeyRecord,
  type KeyCommitmentInfo,
  type KeyEnvelopeRecord,
  type EpochKeyTarget,
  type UnconfirmedEpochKey,
} from '@ogmara/sdk';
import { decode } from '@msgpack/msgpack';
import { getSigner, getCryptoClient, walletAddress, e2eAvailable } from './cryptoEnv';
import { e2elog, withRetry } from './e2eDebug';
import {
  deviceCtx, toHex, fromHex, targetKey, toBytes,
  notifyKeyringChanged, requestVaultRestore,
  type DeviceCtx, type Target, type DmDisplay,
} from './dmCrypto';
import { captureAccountContext } from './accountContext';
import {
  getScopeGeneration, registerWalletSwitchReset, scopedGetForStrict, scopedSetFor, scopedRemoveFor,
} from './walletScope';
import { getCurrentNodeUrl, getKnownNodes } from './api';
import { ensureDeviceEncBinding, setBindingSettledHook } from './deviceEnc';
import { nodeHasFeature, FEATURE_KEY_COMMITMENT } from './deviceEncCore';
import {
  classifyPeerResults, shouldRebuildPeers, planHeal, HealLedger, FloorRotationQueue,
  planBest, planNewerLatest, planSeed, earlyUseAllowed, planCover, resumeOpts, statusAfterFlow,
  ChannelKeyStore, ResumeBudget, shouldTakeGate, floorTrust, legacyEnvelopeEpoch, boundedEvidence, SEND_EPOCH_MARGIN,
  resumePlanOpts, legacyMoveTarget, earlyUseAlone, ownSlotWrapOpts, MissFetchLimiter, NODE_HIGHEST_FAIL_TTL_MS,
  type PairKind, type ResumeScheduling, type PairMatchResult, type KeyCacheResult, type PruneLevel, type PrunePlan,
  type PruneResult,
} from './channelKeyCore';
import {
  PchanTrustStore, CoverBackoff, BindingVerdictCache, AccountChangedError, CoverSkippedError,
  resolvePrivateTargets, publishToTargets, decideCoverMode, dedupTargets, guarded, coveredWallets,
  coverThrottleMs, channelTrustKey, isKnownNetwork, isPrivateRangeId,
  type EncKeyRow,
} from './privateCoverCore';
import {
  runEpochFlow, mayRotate, effectiveFloor, targetIdOf, EpochEvidence, EstablishingStore, withTimeout, DEP_TIMEOUT_MS,
  type AccountEpochState, type EpochIo, type EpochFlowResult, type ChannelKeyStatus,
} from './epochWiring';

export type { DmDisplay } from './dmCrypto';
export type { ChannelKeyStatus } from './epochWiring';

/** The account a cover / establish / rotate flow runs for (see accountContext.ts). */
type Acct = ReturnType<typeof captureAccountContext>;

/** The client CAPTURED with the account, or throw — never the live one after a switch. */
function acctClient(acct: Acct): OgmaraClient {
  if (!acct.account || !acct.client) throw new AccountChangedError();
  return acct.client;
}

/**
 * Verify-before-cover state (mobile 0.58.0, privateCoverCore.ts): the
 * per-wallet creator pins + seen removals (persisted under NEW per-wallet
 * AsyncStorage keys via the explicit-address `*For` helpers), the SDK's
 * positive-verdict cache, and the budget-exhaustion backoff. All are dropped
 * on every wallet switch; caches are REPLACED rather than cleared, so work
 * still running for the previous account only ever fills an orphan instance.
 */
const walletRowIo = {
  // STRICT read: a storage error must not read as "nothing stored", or the
  // next persist would overwrite the real rows with a subset.
  read: (wallet: string, base: string) => scopedGetForStrict(wallet, base),
  write: (wallet: string, base: string, value: string) => scopedSetFor(wallet, base, value),
};
const trustStore = new PchanTrustStore({
  ...walletRowIo,
  remove: (wallet, base) => scopedRemoveFor(wallet, base),
});
/** Persisted epoch NUMBERS in establishment (epochWiring `EstablishingStore`). */
const establishingStore = new EstablishingStore(walletRowIo, e2elog);
/** Persisted "healed past epoch E" per channel (channelKeyCore `HealLedger`). */
const healLedger = new HealLedger(walletRowIo);
/** Floor-driven rotation coalescing (channelKeyCore `FloorRotationQueue`, W6). */
const floorQueue = new FloorRotationQueue();
const floorTimers = new Map<number, ReturnType<typeof setTimeout>>();
/** Heals started this session (dedupe before the ledger write lands). */
const healInflight = new Set<string>();
let proofCache = new MemberProofCache();
let bindingCache = new BindingVerdictCache();
const coverBackoff = new CoverBackoff();
/** Per-channel rotation offset for large private channels (see resolvePrivateTargets). */
const coverOffset = new Map<number, number>();

/**
 * Per-account epoch protocol state (SDK pending store, escalation gate, token
 * bucket, authenticated evidence). Created lazily for (wallet, generation),
 * REPLACED on every switch — the pending store is also cleared (zeroed).
 */
let epochState: (AccountEpochState & { gen: number }) | null = null;
function epochStateFor(wallet: string): AccountEpochState & { gen: number } {
  const gen = getScopeGeneration();
  const fresh = (): AccountEpochState & { gen: number } => {
    const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    return {
      wallet,
      gen,
      pending: new PendingEpochKeyStore(),
      gate: new EscalationGate(Date.now),
      bucket: new TokenBucket(Date.now, sleepMs),
      evidence: new EpochEvidence(),
      establishing: establishingStore,
    };
  };
  if (epochState && epochState.wallet === wallet && epochState.gen === gen) return epochState;
  // Only the ACTIVE account may (re)create the shared state: a stale caller
  // for a previous account must never clear the current account's pending
  // keys — it gets a detached throwaway instance instead.
  if (wallet !== walletAddress()) return fresh();
  epochState?.pending.clear();
  epochState = fresh();
  return epochState;
}

/** Positive member verdicts per account: `${channelId}:${wallet}` → verified-at ms. */
let verifiedMembers = new Map<string, number>();
const MEMBER_VERDICT_TTL_MS = 10 * 60_000;
const MAX_MEMBER_VERDICTS = 4096;
function noteVerified(channelId: number, wallets: Iterable<string>): void {
  const now = Date.now();
  for (const w of wallets) {
    const k = `${channelId}:${w}`;
    verifiedMembers.delete(k);
    verifiedMembers.set(k, now);
  }
  while (verifiedMembers.size > MAX_MEMBER_VERDICTS) {
    const oldest = verifiedMembers.keys().next().value;
    if (oldest === undefined) break;
    verifiedMembers.delete(oldest);
  }
}

function resetVerifyState(): void {
  trustStore.reset();
  establishingStore.reset();
  healLedger.reset();
  floorQueue.clear();
  for (const t of floorTimers.values()) clearTimeout(t);
  floorTimers.clear();
  healInflight.clear();
  proofCache = new MemberProofCache();
  bindingCache = new BindingVerdictCache();
  verifiedMembers = new Map();
  coverBackoff.clear();
  coverOffset.clear();
  ownReverified.clear();
  epochState?.pending.clear();
  epochState = null;
  for (const t of resumeTimers.values()) clearTimeout(t);
  resumeTimers.clear();
  resumeBudget.clear();
  establishing.clear();
  statusMap.clear();
  latestCheckedAt.clear();
  nodeHighest.clear();
  nodeHighestFailedAt.clear();
  missFetches.clear();
  staleChannels.clear();
  earlyKeys.clear();
  // Rule 5 (sdk-js 0.68.0 migration): the keyring is cleared on every account
  // switch too (puts for an old generation are refused anyway).
  keyStore.clear();
  peerClients = null;
  resumedGen = -1;
  notifyStatus();
}
registerWalletSwitchReset(resetVerifyState);

/**
 * Pin `wallet` as the creator of the PRIVATE channel it just created — the
 * client's own first contact with the channel, which the SDK names as the
 * strongest creator anchor (the id derivation is only a ~53-bit binding).
 * Writes the explicit wallet's namespace, so it is correct even if an account
 * switch lands meanwhile; never overwrites an existing pin. Best-effort.
 */
export async function pinOwnPrivateChannel(wallet: string, client: OgmaraClient, channelId: number): Promise<void> {
  try {
    const network = await client.getNetwork();
    if (!isKnownNetwork(network)) return;
    // W1-create: only an id in the private namespace can be a private channel.
    if (!Number.isSafeInteger(channelId) || channelId <= 0 || !isPrivateRangeId(channelId)) return;
    const state = await trustStore.load(wallet);
    const outcome = state.pinIfAbsent(channelTrustKey(network, channelId), wallet);
    if (outcome === 'cap') e2elog('pchan pin-on-create refused (pin cap reached)', { channelId });
    if (outcome !== 'pinned') return;
    if (await trustStore.isCurrent(wallet, state)) await trustStore.persist(wallet, state);
  } catch (e) {
    e2elog('pchan pin-on-create failed', { channelId, err: (e as Error)?.message });
  }
}

/**
 * Whether `wallet` holds a creator pin for `channelId` under any known
 * network. A storage error reads as `false`: this answers "may I perform a
 * SIDE EFFECT (rotate)" and needs positive evidence (shape #23).
 */
async function hasPinFor(wallet: string, channelId: number): Promise<boolean> {
  try {
    return (await trustStore.load(wallet)).hasPinAnyNetwork(channelId);
  } catch {
    return false;
  }
}

/** Yield a macrotask so the Hermes JS thread can render between heavy steps. */
const yieldToUi = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --- Key cache -----------------------------------------------------------------------

/**
 * Channel group keys (mobile 0.58.0 / sdk-js 0.68.0): the SHARED SDK
 * `ChannelKeyring` behind the thin {@link ChannelKeyStore} adapter
 * (channelKeyCore.ts). The keyring holds every key ever seen for an epoch
 * (primary + alternates, never overwritten, all decrypt) with its provenance:
 *  - `wrap`: our own slot's wrap that passed `verifyChannelKeyWrap`;
 *  - `establish`: an `establishEpochKey` result — PROVISIONAL until the node
 *    reports it final (early-use first key included);
 *  - `legacy`: a commitment-less node key (decrypt; never evidence);
 *  - `vault`: restored from the key vault — NOT trusted until this app
 *    re-verifies the own-slot wrap for that epoch and re-puts it as `wrap`.
 * Sending, covering, the rotation base and heal use only CONFIRMED keys
 * (trusted + node-final, pair not lost since), always bounded to the node's
 * highest epoch + 256. Keyed by account generation: a put for a previous
 * account is dropped.
 */
const keyStore = new ChannelKeyStore(getScopeGeneration);
/** `${scopeHex}:${epoch}` — the key of the per-epoch cover bookkeeping below. */
const ckey = (scopeHex: string, epoch: number) => `${scopeHex}:${epoch}`;

/** Act on a cache result: log + gated heal on a mismatch; signal the vault layer when something was kept. */
function onCached(channelId: number, epoch: number, r: KeyCacheResult): void {
  if (r === 'mismatch') {
    e2elog('channel key: a DIFFERENT key for a held epoch — kept both', { channelId, epoch });
    void onKeyMismatch(channelId, epoch).catch(() => {});
  } else if (r === 'refused') {
    e2elog('channel key: node-served key not held (keyring cap / commitment-less duplicate)', { channelId, epoch });
    return;
  } else if (r === 'dropped') {
    return;
  }
  notifyKeyringChanged();
}
/**
 * TWO-STEP vault snapshot (SDK format: the UNION of every exportable key +
 * every entry this app cannot interpret) — nothing is marked persisted until
 * {@link commitChannelKeyExport} after a SUCCESSFUL publish. Throws
 * `ChannelKeyringError` (`vault_too_large` / `opaque_overflow` / `stale`):
 * keyVault.ts surfaces it as "backup paused", never as backed up.
 */
export function prepareChannelKeyExport(): { chan: Record<string, Uint8Array>; commit: () => boolean } {
  const gen = getScopeGeneration();
  const p = keyStore.prepareExport(gen);
  return { chan: p.chan, commit: () => keyStore.commitExport(p.commitToken, gen) };
}
/** Merge vault-restored channel keys in (as `vault`: decrypt only until re-verified); nothing held is replaced. */
export function importChannelKeysFromVault(rec: Record<string, Uint8Array>): number {
  return keyStore.importVault(rec, getScopeGeneration());
}
/**
 * "Free up backup space" ladder (user-confirmed, Settings; same levels as web
 * / desktop): the first level from `from` on whose DRY RUN would remove
 * something, with its per-class counts — nothing removed. null = nothing.
 */
export function previewChannelKeyPrune(from?: PruneLevel): PrunePlan | null {
  return keyStore.nextPrunePlan(getScopeGeneration(), from);
}
/**
 * Apply a plan the user CONFIRMED (same level / scopes as its dry run) — only
 * if a fresh dry run removes no more than it showed, else `'changed'`
 * (nothing removed). Signals the vault layer. null = stale.
 */
export function applyChannelKeyPrune(plan: PrunePlan): PruneResult | 'changed' | null {
  const r = keyStore.applyConfirmedPrune(plan, getScopeGeneration());
  if (r && r !== 'changed' && r.removedCount > 0) notifyKeyringChanged();
  return r;
}
/** Anything to back up on the channel side (cheap: held epochs / uninterpretable entries; no export). */
export function channelKeysHeld(): boolean {
  return keyStore.hasContent;
}

interface KeyEntry { key: Uint8Array; epoch: number }

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Per-channel in-flight establishment (one per channel; the SDK also locks per epoch). */
const establishing = new Map<number, Promise<EpochFlowResult>>();
/** Which `(target, device)` we've wrapped the key to, per `${scopeHex}:${epoch}`. */
const wrappedToDevices = new Map<string, Set<string>>();

const lastCoverMs = new Map<number, number>();
/** Early keys (first key of a brand-new channel) per channel while their epoch settles. */
const earlyKeys = new Map<number, { key: Uint8Array; epoch: number }>();

export function clearChannelKeyCache(): void {
  keyStore.clear();
  wrappedToDevices.clear();
  lastCoverMs.clear();
  fetchingChannelKey.clear();
  resetVerifyState();
}

// --- Key status (UI) --------------------------------------------------------------------

const statusMap = new Map<number, ChannelKeyStatus>();
const statusListeners = new Set<() => void>();
function notifyStatus(): void {
  for (const l of statusListeners) {
    try { l(); } catch { /* a bad listener must not break key handling */ }
  }
}
function setStatus(channelId: number, s: ChannelKeyStatus): void {
  const prev = statusMap.get(channelId);
  if (s.state === 'idle') {
    if (!prev) return;
    statusMap.delete(channelId);
  } else {
    if (prev && JSON.stringify(prev) === JSON.stringify(s)) return;
    statusMap.set(channelId, s);
  }
  notifyStatus();
}
/** The channel's key state for the screen ("re-keying…" / a problem / idle). */
export function getChannelKeyStatus(channelId: number): ChannelKeyStatus {
  return statusMap.get(channelId) ?? { state: 'idle' };
}
/** Subscribe to key-state changes; returns the unsubscribe function. */
export function subscribeChannelKeyStatus(fn: () => void): () => void {
  statusListeners.add(fn);
  return () => { statusListeners.delete(fn); };
}

// --- Node capability + peers -------------------------------------------------------------

const HEALTH_TTL_MS = 5 * 60_000;
const healthCache = new WeakMap<OgmaraClient, { at: number; ok: boolean }>();
/** Whether the node arbitrates epochs (`key_commitment_v1`); error → false (never establish blind). */
async function supportsArbitration(client: OgmaraClient): Promise<boolean> {
  const c = healthCache.get(client);
  if (c && Date.now() - c.at < HEALTH_TTL_MS) return c.ok;
  try {
    const h = await withTimeout(client.health(), DEP_TIMEOUT_MS, 'health');
    const ok = nodeHasFeature(h, FEATURE_KEY_COMMITMENT);
    healthCache.set(client, { at: Date.now(), ok });
    return ok;
  } catch {
    return false;
  }
}

/** Peer nodes queried for split detection. */
const MAX_PEERS = 3;
interface PeerList { clients: OgmaraClient[]; unreachable: number; builtAt: number }
let peerClients: {
  wallet: string; gen: number; home: unknown; rebuilds: number; list: Promise<PeerList>; built: PeerList | null;
} | null = null;
const hostOf = (u: string): string => {
  try { return new URL(u).host.toLowerCase(); } catch { return u.toLowerCase(); }
};

/**
 * Signer-bound clients for up to {@link MAX_PEERS} OTHER nodes from the
 * user's known-node history only (never node-advertised URLs) on the SAME
 * Klever network as the home node (a peer on another network is a different
 * channel namespace, not a peer). Built per (wallet, generation, home client —
 * a node switch creates a new client). A peer whose `/health` cannot be read
 * at build time is left out, and the list is rebuilt (at most
 * {@link MAX_PEER_REBUILDS} times, {@link PEER_REBUILD_AFTER_MS} apart) so a
 * peer that was briefly down comes back. While no reachable peer exists,
 * split detection is OFF (documented residual).
 *
 * Peer probes never solve proof-of-work: a peer demanding it for this wallet
 * is a FAILURE for that probe (no seconds-long Ed25519/SHA grind on the
 * Hermes JS thread for a background check).
 */
function peersFor(acct: Acct, homeNetwork: string): Promise<PeerList> {
  const wallet = acct.account!;
  const gen = getScopeGeneration();
  const build = async (): Promise<PeerList> => {
    const home = await getCurrentNodeUrl();
    const signer = getSigner();
    if (!signer || !acct.stillValid()) return { clients: [], unreachable: 0, builtAt: Date.now() };
    const known = (await getKnownNodes()).filter((u) => hostOf(u) !== hostOf(home));
    const seen = new Set<string>();
    const out: OgmaraClient[] = [];
    let unreachable = 0;
    for (const url of known) {
      if (out.length >= MAX_PEERS) break;
      const h = hostOf(url);
      if (seen.has(h)) continue;
      seen.add(h);
      const c = new OgmaraClient({ nodeUrl: url, timeout: 10_000 });
      // `withSigner` re-points the SHARED signer's network resolver at the
      // peer; keep the home client's resolver (the peer is only ever read).
      const prevProvider = signer.networkProvider;
      c.withSigner(signer);
      signer.networkProvider = prevProvider;
      // HACK: the SDK auto-solves a proof-of-work challenge inside every
      // authenticated GET; for a peer probe that would grind on the JS thread.
      // Replace the instance's solver so a challenge fails the probe instead.
      (c as unknown as { ensurePowSolved: () => Promise<never> }).ensurePowSolved = async () => {
        throw new Error('peer proof-of-work not solved');
      };
      try {
        const net = await withTimeout(c.getNetwork(), 10_000, 'peer health');
        if (net === homeNetwork) out.push(c);
      } catch {
        unreachable++; // not a known peer for now; the list is rebuilt later
      }
    }
    return { clients: out, unreachable, builtAt: Date.now() };
  };
  const cur = peerClients;
  const sameKey = !!cur && cur.wallet === wallet && cur.gen === gen && cur.home === acct.client;
  if (sameKey && cur!.built && shouldRebuildPeers({ ...cur!.built, rebuilds: cur!.rebuilds }, Date.now())) {
    cur!.rebuilds++;
    cur!.built = null;
    cur!.list = build();
    const entry = cur!;
    void entry.list.then((l) => { entry.built = l; }, () => { if (peerClients === entry) peerClients = null; });
  } else if (!sameKey) {
    const entry = { wallet, gen, home: acct.client as unknown, rebuilds: 0, list: build(), built: null as PeerList | null };
    peerClients = entry;
    void entry.list.then((l) => { entry.built = l; }, () => { if (peerClients === entry) peerClients = null; });
  }
  return peerClients!.list;
}

/** SDK `peerCommitments` under the unified cross-client peer rule (channelKeyCore `classifyPeerResults`). */
function makePeerCommitments(acct: Acct, channelId: number, homeNetwork: string) {
  return async (epoch: number): Promise<KeyCommitmentInfo[]> => {
    const peers = await peersFor(acct, homeNetwork);
    if (!acct.stillValid()) throw new AccountChangedError();
    if (peers.clients.length === 0) return [];
    const rs = await Promise.allSettled(
      peers.clients.map((p) => withTimeout(p.getKeyCommitment(channelId, epoch), 10_000, 'peer commitment')),
    );
    if (!acct.stillValid()) throw new AccountChangedError();
    return classifyPeerResults(rs);
  };
}

// --- Targets ----------------------------------------------------------------------------

/**
 * The wrap targets for a channel. Throws {@link AccountChangedError} when the
 * account changed (nothing may be published) and {@link CoverSkippedError}
 * when the pass cannot run safely (unknown network, unreadable trust state).
 *
 * PUBLIC channels (unchanged): every listed member's devices.
 * PRIVATE channels — "verify before cover" (protocol §3.9.2): the node's
 * member list is untrusted; each other member's membership evidence is
 * re-verified with the SDK's `filterVerifiedMembers` BEFORE any enc key is
 * fetched, only verified members (plus this wallet itself, always) are
 * returned, and each enc-key row's wallet binding is checked. Unverifiable →
 * not covered (fail closed) — they keep the existing "waiting for key" state.
 * A channel this wallet ever pinned a creator for (under either network) is
 * treated as private even if the node calls it public.
 *
 * @param covered `${wallet}:${device}` keys already covered for this epoch
 *   (verified last, so an early-stopped pass spends its budget on new joiners).
 */
async function getChannelTargets(
  acct: Acct, channelId: number, isPrivate: boolean, covered?: ReadonlySet<string>,
  /** Set to true when the pass could not resolve every member (proofs / enc keys missing). */
  out?: { incomplete: boolean },
): Promise<Target[]> {
  const client = acctClient(acct);
  const self = acct.account!;
  const PAGE = 200;
  const members: { address: string }[] = [];
  for (let page = 1; page <= 50; page++) {
    const resp = await withRetry(
      guarded(acct.stillValid, () => client.getChannelMembers(channelId, { page, limit: PAGE })),
      'fetch channel members',
    );
    if (!acct.stillValid()) throw new AccountChangedError();
    members.push(...resp.members);
    if (resp.members.length < PAGE) break;
    if (page === 50) {
      e2elog('channel targets: member pagination cap hit (>10k)', { channelId });
      if (out) out.incomplete = true;
    }
    await yieldToUi();
    if (!acct.stillValid()) throw new AccountChangedError();
  }

  let network: string | null = null;
  try {
    network = await client.getNetwork();
  } catch {
    network = null;
  }
  if (!acct.stillValid()) throw new AccountChangedError();
  // W1: the node reports the network; only mainnet/testnet are accepted, and
  // a trust-state read error skips the pass — never "unverified because we
  // could not look the pin up".
  const mode = await decideCoverMode(isPrivate, network, channelId, () => trustStore.load(self));
  if (!acct.stillValid()) throw new AccountChangedError();

  if (mode === 'private') {
    if (!isPrivate) e2elog('channel targets: verifying as private (id range / creator pin)', { channelId });
    const net = network!;
    const cache = proofCache; // captured: a switch replaces the instance
    const bindings = bindingCache;
    const res = await resolvePrivateTargets({
      self,
      network: net,
      channelId,
      stillValid: acct.stillValid,
      members: members.map((m) => m?.address).filter((a): a is string => typeof a === 'string'),
      covered: covered ? coveredWallets(covered) : undefined,
      startOffset: coverOffset.get(channelId) ?? 0,
      filter: (wallets, opts) => guarded(acct.stillValid,
        () => filterVerifiedMembers(client, channelId, wallets, cache, opts))(),
      getEncKeys: async (wallet) =>
        (await withRetry(guarded(acct.stillValid, () => client.getEncKeys(wallet)), 'fetch enc keys')).keys as EncKeyRow[],
      verifyBinding: async (row, wallet) =>
        (await verifyEncKeyBinding(row as DeviceEncKeyRecord, wallet, net)).status,
      bindingCache: bindings,
      store: trustStore,
      yieldToUi,
      log: e2elog,
    });
    if (!res) throw new AccountChangedError();
    coverBackoff.record(channelId, res.budgetExhausted, Date.now());
    coverOffset.set(channelId, res.nextOffset);
    noteVerified(channelId, res.verified);
    // Rejected members (proof did not verify) also mean "not provably alone".
    if (out) out.incomplete = res.incomplete || res.stoppedEarly || res.budgetExhausted || res.rejectedCount > 0;
    return res.targets;
  }

  const raw: Target[] = [];
  for (const m of members) {
    let keys: { device_id: string; enc_pub: string; created_at?: number }[] = [];
    try {
      keys = (await withRetry(guarded(acct.stillValid, () => client.getEncKeys(m.address)), 'fetch enc keys')).keys;
    } catch {
      if (!acct.stillValid()) throw new AccountChangedError();
      if (out) out.incomplete = true;
      continue; // covered on the next pass
    }
    if (!acct.stillValid()) throw new AccountChangedError();
    for (const k of keys) {
      raw.push({ target: m.address, deviceId: k.device_id, encPub: k.enc_pub, createdAt: k.created_at ?? 0 });
    }
  }
  return dedupTargets(raw);
}

/** Map a cover target to the SDK's shape (invalid enc keys dropped). */
function toEpochTarget(t: Target): EpochKeyTarget | null {
  if (typeof t.encPub !== 'string' || !/^[0-9a-fA-F]{64}$/.test(t.encPub)) return null;
  if (typeof t.deviceId !== 'string' || t.deviceId.length === 0) return null;
  return { target: t.target, deviceId: t.deviceId.toLowerCase(), encPub: fromHex(t.encPub) };
}

/**
 * Is `wallet` a verified member of `channelId` (for accepting a key WRAP it
 * authored)? Public channels (not private-range, no pin): yes — anyone may
 * join and wrap there. Private: self, or a positive verdict (cached 10 min),
 * else one `filterVerifiedMembers` round for that wallet. `null` = could not
 * be decided right now (fetch failed / unknown network): the caller retries.
 */
async function isVerifiedMemberFor(
  client: OgmaraClient, self: string, stillValid: () => boolean, channelId: number, wallet: string,
): Promise<boolean | null> {
  if (wallet === self) return true;
  let privateLike = isPrivateRangeId(channelId);
  if (!privateLike) {
    try {
      privateLike = (await trustStore.load(self)).hasPinAnyNetwork(channelId);
    } catch {
      return null;
    }
  }
  if (!privateLike) return true;
  const at = verifiedMembers.get(`${channelId}:${wallet}`);
  if (at !== undefined && Date.now() - at < MEMBER_VERDICT_TTL_MS) return true;
  let network: string;
  try {
    network = await client.getNetwork();
  } catch {
    return null;
  }
  if (!stillValid() || !isKnownNetwork(network)) return null;
  const cache = proofCache;
  try {
    const res = await resolvePrivateTargets({
      self, network, channelId, stillValid, members: [wallet],
      filter: (wallets, opts) => guarded(stillValid, () => filterVerifiedMembers(client, channelId, wallets, cache, opts))(),
      getEncKeys: async () => [], // membership only
      verifyBinding: async () => 'invalid',
      bindingCache: new BindingVerdictCache(1),
      store: trustStore,
      yieldToUi,
      log: e2elog,
    });
    if (!res) return null;
    if (res.verified.includes(wallet)) {
      noteVerified(channelId, [wallet]);
      return true;
    }
    return res.incomplete ? null : false;
  } catch {
    return null;
  }
}

// --- Fetching our own wrap --------------------------------------------------------------

/**
 * In-flight de-dup for `fetchChannelKey`, keyed by (scope, epoch). Needed
 * because `ChannelMessagesScreen.tsx`'s decrypt effect fires every visible
 * message's `decryptChannelMessage` call CONCURRENTLY — on a cold open of an
 * encrypted channel, `channelKeys` starts empty, so without this every message
 * in the page misses the cache simultaneously and would each independently
 * call `getKeyEnvelope` for the exact same (scope, epoch). NOT the same map as
 * `establishing` above (the SEND/rotation side).
 */
const fetchingChannelKey = new Map<string, Promise<FetchResult>>();

/** Fetch + unwrap MY wrapped channel key for `epoch` (latest if omitted). */
type FetchResult = { key: Uint8Array; epoch: number; author?: string } | 'missing' | 'corrupt';
async function fetchChannelKey(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, epoch?: number,
): Promise<FetchResult> {
  const dedupKey = `${scopeHex}:${epoch ?? ''}`;
  const inflight = fetchingChannelKey.get(dedupKey);
  if (inflight) return inflight;
  const p: Promise<FetchResult> = fetchChannelKeyUncached(ctx, channelId, scope, scopeHex, epoch)
    .finally(() => { if (fetchingChannelKey.get(dedupKey) === p) fetchingChannelKey.delete(dedupKey); });
  fetchingChannelKey.set(dedupKey, p);
  return p;
}

/**
 * Read our own slot with `?proof=1`. A record carrying a key commitment
 * (arbitrated epoch) is VERIFIED (`verifyChannelKeyWrap`: signed 0x61, bound to
 * this channel / wallet / device, author a verified member, commitment matches
 * the unwrapped key) — the node is no longer trusted with the key it serves. A
 * commitment-less record is a LEGACY epoch (pre-0.143 history): unwrapped as
 * before, cached as `legacy`, never counted as evidence.
 */
async function fetchChannelKeyUncached(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, epoch?: number,
): Promise<FetchResult> {
  // Account guard for the CACHE write below: the key cache is process-wide,
  // so a fetch for account A finishing after a switch must not plant A's
  // channel key into B's session (and B's key-vault backup).
  const startWallet = walletAddress();
  const startGen = getScopeGeneration();
  const client = getCryptoClient();
  if (!client || !startWallet || startWallet !== ctx.wallet) return 'missing';
  const sameAccount = () => walletAddress() === startWallet && getScopeGeneration() === startGen;
  // Every put of a key that is not ours is bounded by the node's highest + 256
  // (SDK `maxEpoch`): without that answer nothing is cached (fail closed).
  const nodeH = await nodeHighestVia(client, channelId, sameAccount);
  if (nodeH === null || !sameAccount()) return 'missing';
  // B2: an epoch above the ceiling could never be held — no request at all.
  if (epoch !== undefined && epoch > nodeH + SEND_EPOCH_MARGIN) return 'missing';
  let resp;
  try {
    resp = await withRetry(guarded(sameAccount, () => client.getKeyEnvelope(scopeHex, ctx.deviceId, '', epoch, { proof: true })), 'fetch channel key');
  } catch (e) {
    if (!(e instanceof AccountChangedError)) {
      e2elog('channel fetchKey: network → missing', { channelId, epoch, err: (e as Error)?.message });
    }
    return 'missing';
  }
  if (!sameAccount()) {
    e2elog('channel fetchKey: account changed mid-fetch, discarded', { channelId, epoch });
    return 'missing';
  }
  const env = resp.envelope as KeyEnvelopeRecord | null;
  if (!env) return 'missing';
  if (env.key_commitment != null) {
    let network: string;
    try {
      network = await client.getNetwork();
    } catch {
      return 'missing';
    }
    if (!sameAccount()) return 'missing';
    let undecided = false;
    await yieldToUi(); // Ed25519 verify + X25519 unwrap on the JS thread
    const v = await verifyChannelKeyWrap(env, {
      self: ctx.wallet, deviceId: ctx.deviceId, network, channelId, encPriv: ctx.encPriv, epoch,
      isVerifiedMember: async (w) => {
        const r = await isVerifiedMemberFor(client, ctx.wallet, sameAccount, channelId, w);
        if (r === null) undecided = true;
        return r === true;
      },
    });
    if (!sameAccount()) {
      if (v.ok) v.wrap.key.fill(0);
      return 'missing';
    }
    if (!v.ok) {
      e2elog('channel fetchKey: wrap NOT verified', { channelId, epoch, reason: v.reason, undecided });
      // Membership not decidable right now (429 / network): retry later.
      return undecided ? 'missing' : 'corrupt';
    }
    const w = v.wrap;
    const wrapOpts = ownSlotWrapOpts(w.wallet, startWallet, nodeH);
    const ownSlot = wrapOpts.ownSlot;
    // After a restart nothing is final: re-verify the latest OWN epoch first,
    // so other members' wraps are counted against the right ceiling.
    if (!ownSlot) {
      await reverifyLatestOwn(client, sameAccount, ctx, channelId, scope, scopeHex, nodeH);
      if (!sameAccount()) { w.key.fill(0); return 'missing'; }
    }
    // Author-verified (`verifyChannelKeyWrap`) → source `wrap`: the keyring
    // re-hashes the pair, never replaces a DIFFERENT key held at this epoch
    // (kept as an alternate) and upgrades a vault copy of the same bytes.
    // `ownSlot` when its verified author is our own wallet (our key: never
    // member-capped); another member's wrap is bounded by nodeHighest + 256.
    // Never `final` here (no commitment read for this pair; checkPair records it).
    const r = keyStore.putWrap(scopeHex, w.epoch, w.key, { keyTs: w.keyTs, commitment: w.keyCommitment }, startGen, wrapOpts);
    onCached(channelId, w.epoch, r);
    if (r === 'dropped' || r === 'refused') return 'missing';
    epochStateFor(startWallet).evidence.note(channelId, w.epoch);
    return { key: w.key, epoch: w.epoch, author: w.wallet };
  }
  // Rule 6 (sdk-js 0.68.0): a node-served legacy envelope is only accepted for
  // the epoch we asked for (its own epoch, never the node's label alone).
  const ep = legacyEnvelopeEpoch(epoch, env.epoch, resp.epoch);
  if (ep === null) {
    e2elog('channel fetchKey: legacy envelope for another epoch — rejected', { channelId, epoch, envEpoch: env.epoch, label: resp.epoch });
    return 'corrupt';
  }
  try {
    const wrapped: WrappedKey = { ephPub: fromHex(env.eph_pub), nonce: fromHex(env.nonce), wrapped: fromHex(env.wrapped) };
    const key = unwrapConvKey(wrapped, ctx.encPriv, scope); // salt = channel scope (matches wrap)
    // A commitment-less key never replaces (or shadows) a key we hold; the
    // keyring refuses a commitment-less duplicate at an occupied epoch and
    // node-served keys beyond its caps — `refused` is respected (no fallback).
    const r = keyStore.putLegacy(scopeHex, ep, key, startGen, nodeH);
    onCached(channelId, ep, r);
    if (r === 'dropped' || r === 'refused') {
      key.fill(0);
      return 'missing';
    }
    return { key, epoch: ep, author: typeof env.author === 'string' ? env.author : undefined };
  } catch (e) {
    e2elog('channel fetchKey: unwrap FAILED → corrupt', { channelId, epoch, err: (e as Error)?.message });
    return 'corrupt';
  }
}

// --- Matching a held key against the node's winner -----------------------------------------

/** What the home node says about a key we hold. */
type PairCheck =
  /** The winner's pair hashes to OUR key; `trust` = what the keyring recorded (see {@link PairMatchResult}). */
  | { kind: 'ours'; keyTs: number; commitment: Uint8Array; final: boolean; trust: PairMatchResult }
  | { kind: 'legacy' }
  | { kind: 'none' }
  | { kind: 'other'; info: KeyCommitmentInfo };

/**
 * Compare a held key with the node's winner for its epoch. `ours` requires the
 * winner's pair to hash to OUR key (`H(scope, epoch, key_ts, key) == C`), so
 * a node cannot make us adopt a pair that is not this key. Records the pair
 * (and finality) in the keyring for an author-verified key; a vault /
 * node-served key comes back `trust: 'needs_author_proof'` — see
 * {@link reverifyOwnWrap}. `null` = the node could not be read.
 */
async function checkPair(
  client: OgmaraClient, stillValid: () => boolean, channelId: number, scope: Uint8Array, scopeHex: string,
  entry: KeyEntry,
): Promise<PairCheck | null> {
  // Captured BEFORE the round trip: a write for a previous account is refused by the keyring.
  const gen = getScopeGeneration();
  let info: KeyCommitmentInfo;
  try {
    info = await withTimeout(client.getKeyCommitment(channelId, entry.epoch), DEP_TIMEOUT_MS, 'key commitment');
  } catch {
    return null;
  }
  if (!stillValid()) throw new AccountChangedError();
  if (info.state === 'legacy') return { kind: 'legacy' };
  if (info.state === 'none') return { kind: 'none' };
  const c = keyCommitmentFromHex(info.key_commitment);
  if (!c || typeof info.key_ts !== 'number') return { kind: 'other', info };
  const h = computeKeyCommitment(scope, entry.epoch, info.key_ts, entry.key);
  if (!keyCommitmentsEqual(h, c)) return { kind: 'other', info };
  const final = info.final === true;
  const trust = keyStore.notePairMatch(scopeHex, entry.epoch, entry.key, { keyTs: info.key_ts, commitment: c }, final, gen);
  // Evidence only through a TRUSTED key (author-verified + pair-consistent):
  // a vault-restored or node-served key whose pair a (hostile) node can
  // compute for any key of its own is not evidence until re-verified.
  const w = walletAddress();
  if (trust === 'trusted' && w) epochStateFor(w).evidence.note(channelId, entry.epoch);
  return { kind: 'ours', keyTs: info.key_ts, commitment: c, final, trust };
}

/**
 * After a restart every held key is a `vault` key (the vault records no
 * provenance): re-read OUR OWN slot's wrap for `epoch` with `?proof=1` and run
 * `verifyChannelKeyWrap` (fetchChannelKey) — a verified wrap of the SAME bytes
 * re-puts the key as `wrap` (author-verified). True when `key` is now held
 * author-verified. Never trusts a node's word: a node cannot sign a member's
 * wrap.
 */
async function reverifyOwnWrap(
  ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, epoch: number, key: Uint8Array,
): Promise<boolean> {
  const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex, epoch);
  if (typeof fetched === 'string' || fetched.epoch !== epoch || !bytesEqual(fetched.key, key)) {
    e2elog('channel key: own-slot wrap did not re-verify this key', { channelId, epoch, res: typeof fetched === 'string' ? fetched : 'other_key' });
    return false;
  }
  return true;
}

/** Channels whose latest held epoch was re-verified this account generation (once each). */
const ownReverified = new Set<number>();

/**
 * After a restart every key is a `vault` key and nothing is FINAL. Before the
 * first wrap ANOTHER member authored is cached for a channel, re-verify the
 * latest held epoch through our own slot (`checkPairTrusted`: node pair +
 * own-wrap `verifyChannelKeyWrap`, `ownSlot` when we authored it, `final`
 * from the node's flag) — once per channel per generation, never recursively.
 */
async function reverifyLatestOwn(
  client: OgmaraClient, stillValid: () => boolean, ctx: DeviceCtx, channelId: number, scope: Uint8Array,
  scopeHex: string, nodeH: number,
): Promise<void> {
  if (ownReverified.has(channelId)) return;
  ownReverified.add(channelId);
  if (keyStore.latestTrusted(scopeHex, nodeH) !== null) return;
  const held = keyStore.latestBounded(scopeHex, nodeH);
  if (!held) return;
  // A fetch of that very epoch already in flight (possibly the caller itself):
  // awaiting it from inside would wait on ourselves through the de-dup map.
  if (fetchingChannelKey.has(`${scopeHex}:${held.epoch}`)) return;
  try {
    await checkPairTrusted(client, stillValid, ctx, channelId, scope, scopeHex, { key: held.key, epoch: held.epoch });
  } catch { /* account changed: the caller re-checks */ }
}

/**
 * {@link checkPair} + {@link reverifyOwnWrap} for a `needs_author_proof` key:
 * after a successful re-verification the node's pair is recorded again.
 */
async function checkPairTrusted(
  client: OgmaraClient, stillValid: () => boolean, ctx: DeviceCtx, channelId: number, scope: Uint8Array,
  scopeHex: string, entry: KeyEntry,
): Promise<PairCheck | null> {
  const gen = getScopeGeneration();
  const check = await checkPair(client, stillValid, channelId, scope, scopeHex, entry);
  if (!check || check.kind !== 'ours' || check.trust !== 'needs_author_proof') return check;
  if (!(await reverifyOwnWrap(ctx, channelId, scope, scopeHex, entry.epoch, entry.key))) return check;
  if (!stillValid()) throw new AccountChangedError();
  const trust = keyStore.notePairMatch(scopeHex, entry.epoch, entry.key, { keyTs: check.keyTs, commitment: check.commitment }, check.final, gen);
  const w = walletAddress();
  if (trust === 'trusted' && w) epochStateFor(w).evidence.note(channelId, entry.epoch);
  return { ...check, trust };
}

// --- Establishment ------------------------------------------------------------------------

/**
 * Captures the account FIRST, then resolves the device context; null when
 * either is unavailable or they disagree (a switch landed in between), or the
 * wallet cannot do E2E (K5 / external wallets: `e2eAvailable` stays limited).
 */
async function startKeyFlow(): Promise<{ acct: Acct; ctx: DeviceCtx } | null> {
  if (!e2eAvailable()) return null;
  const acct = captureAccountContext();
  if (!acct.account || !acct.client) return null;
  const ctx = await deviceCtx();
  if (!ctx || !acct.stillValid() || ctx.wallet !== acct.account || !ctx.signer) return null;
  if (resumedGen !== getScopeGeneration()) void resumeChannelKeyWork();
  return { acct, ctx };
}

interface EstablishOpts {
  /** Channel type for target resolution (verify-before-cover upgrades by id / pin anyway). */
  isPrivate: boolean;
  /** The epoch is referenced by authenticated evidence. */
  known: boolean;
  /** First key of a brand-new channel (creator alone): early use. */
  earlyUse?: boolean;
  /**
   * Escalation slot for a gated plan (heal / legacy / seed past legacy):
   * taken ONLY when this call really starts a flow — never when it joins one
   * in flight or a confirmed key at (or above) the epoch is already held.
   */
  gate?: () => boolean;
  /** Runs right after the gate, before the flow (e.g. the heal ledger write); false = do not start. */
  beforeStart?: () => Promise<boolean>;
}

/** Build the I/O for one establish call, bound to the captured account. */
async function makeEpochIo(
  acct: Acct, ctx: DeviceCtx, channelId: number, isPrivate: boolean, listed: { ids: string[] },
): Promise<EpochIo> {
  const client = acctClient(acct);
  const signer = ctx.signer!;
  const network = await client.getNetwork();
  if (!acct.stillValid()) throw new AccountChangedError();
  const encPubHex = encPublicKeyHex(ctx.encPriv).toLowerCase();
  const self = acct.account!;
  const ownWrap = makeOwnWrapFetcher(
    { getKeyEnvelope: (s, d, a, e, o) => guarded(acct.stillValid, () => client.getKeyEnvelope(s, d, a, e, o))() },
    {
      self, deviceId: ctx.deviceId, network, channelId, encPriv: ctx.encPriv,
      isVerifiedMember: async (w) => (await isVerifiedMemberFor(client, self, acct.stillValid, channelId, w)) === true,
    },
    (reason) => e2elog('epoch: own wrap rejected', { channelId, reason }),
  );
  return {
    channelId,
    self: { wallet: self, deviceId: ctx.deviceId.toLowerCase(), signingAddress: signer.signingAddress, encPub: fromHex(encPubHex) },
    stillValid: acct.stillValid,
    getCommitment: (e) => client.getKeyCommitment(channelId, e),
    fetchOwnWrap: ownWrap,
    isSelfBound: async () => {
      const { keys } = await client.getEncKeys(self);
      if (!acct.stillValid()) throw new AccountChangedError();
      const row = keys.find((r) => (r.device_id ?? '').toLowerCase() === ctx.deviceId.toLowerCase()
        && (r.enc_pub ?? '').toLowerCase() === encPubHex);
      return !!row && (await verifyEncKeyBinding(row as DeviceEncKeyRecord, self, network)).status === 'bound';
    },
    listTargets: async () => {
      const ts = (await getChannelTargets(acct, channelId, isPrivate))
        .map(toEpochTarget).filter((t): t is EpochKeyTarget => t !== null);
      listed.ids = ts.map(targetIdOf);
      return ts;
    },
    publish: async (t, key, keyTs, e) => {
      // A NEW envelope (new timestamp → new msg_id) on every call, never cached bytes.
      const bytes = await buildChannelEpochKeyEnvelope(signer, {
        channelId, epoch: e, key, keyTs, target: t.target, deviceId: t.deviceId, encPub: t.encPub,
      });
      if (!acct.stillValid()) throw new AccountChangedError();
      return client.publishChannelKeyEnvelope(bytes);
    },
    peerCommitments: makePeerCommitments(acct, channelId, network),
    newKey: randomConvKey,
    now: Date.now,
    sleep,
    yieldToUi,
    log: e2elog,
  };
}

/** Resume timers per channel (pending outcomes), bounded attempts. */
const resumeTimers = new Map<number, ReturnType<typeof setTimeout>>();
const resumeBudget = new ResumeBudget(12);
const RESUME_DELAYS_MS = [20_000, 45_000, 90_000, 180_000, 300_000, 600_000];

/**
 * Schedule an automatic resume; reports whether one is pending (the status
 * depends on it, W-A). W1 (mobile re-audit): a resume NEVER carries the
 * original plan's `gate` / `beforeStart` — the escalation slot and the heal
 * ledger write belong to the plan's real start only; a resume replaying them
 * would spend a gate slot per retry (and record a new heal attempt each time),
 * or be refused by the gate and leave the pending epoch unfinished.
 */
function scheduleResume(channelId: number, epoch: number, opts: EstablishOpts): ResumeScheduling {
  const resumeWith: EstablishOpts = resumePlanOpts(opts);
  if (resumeTimers.has(channelId)) return 'already';
  const n = resumeBudget.take(channelId);
  if (n === null) {
    e2elog('epoch: resume attempts exhausted', { channelId, epoch });
    return 'exhausted';
  }
  const gen = getScopeGeneration();
  const t = setTimeout(() => {
    resumeTimers.delete(channelId);
    if (getScopeGeneration() !== gen) return;
    void (async () => {
      const flow = await startKeyFlow();
      if (!flow || getScopeGeneration() !== gen) return;
      startEstablish(flow.acct, flow.ctx, channelId, epoch, resumeWith);
    })();
  }, RESUME_DELAYS_MS[Math.min(n, RESUME_DELAYS_MS.length - 1)]);
  resumeTimers.set(channelId, t);
  return 'scheduled';
}

/**
 * Start (or join) the establishment of `epoch` for a channel in the
 * background. Shows "re-keying…" meanwhile (not for an early-use first key),
 * caches the resulting key with its pair, schedules resumes for pending
 * outcomes and surfaces problems.
 */
function startEstablish(
  acct: Acct, ctx: DeviceCtx, channelId: number, epoch: number, opts: EstablishOpts,
  onEarlyKey?: (u: UnconfirmedEpochKey) => void,
): Promise<EpochFlowResult> {
  const running = establishing.get(channelId);
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  // Captured BEFORE any round trip: every keyring write of this flow carries it.
  const gen = getScopeGeneration();
  if (opts.gate) {
    const alreadyAt = keyStore.epochsFrom(scopeHex, epoch).some((e) => keyStore.anyConfirmed(scopeHex, e));
    if (!shouldTakeGate({ joining: !!running, alreadyAt })) {
      return running ?? Promise.resolve<EpochFlowResult>({ kind: 'pending', epoch, reason: 'already_at' });
    }
    if (!opts.gate()) {
      e2elog('epoch: plan gated', { channelId, epoch });
      return Promise.resolve<EpochFlowResult>({ kind: 'pending', epoch, reason: 'gated' });
    }
  }
  if (running) return running;
  if (!opts.earlyUse) setStatus(channelId, { state: 'rekeying', epoch });
  /** The targets the SDK listed (what an `established` outcome covered, minus its uncovered / rejected). */
  const listed = { ids: [] as string[] };
  const p: Promise<EpochFlowResult> = (async (): Promise<EpochFlowResult> => {
    const client = acctClient(acct);
    if (!(await supportsArbitration(client))) {
      e2elog('epoch: node lacks key_commitment_v1 — not establishing', { channelId });
      return { kind: 'problem', epoch, code: 'failed', detail: 'node_no_arbitration' };
    }
    if (!acct.stillValid()) return { kind: 'aborted' };
    if (opts.beforeStart && !(await opts.beforeStart())) return { kind: 'aborted' };
    if (!acct.stillValid()) return { kind: 'aborted' };
    const self = acct.account!;
    const st = epochStateFor(self);
    const rot = mayRotate(channelId, await hasPinFor(self, channelId));
    const io = await makeEpochIo(acct, ctx, channelId, opts.isPrivate, listed);
    return runEpochFlow(io, st, {
      epoch,
      epochKnownToExist: opts.known,
      mayRotate: rot,
      isPrivate: opts.isPrivate,
      earlyUse: opts.earlyUse,
      onEarlyKey: (u) => {
        if (!acct.stillValid()) { u.key.fill(0); return; }
        // Early-use first key: PROVISIONAL (held, not exported until final).
        onCached(channelId, u.epoch, keyStore.putEstablished(scopeHex, u.epoch, u.key, { keyTs: u.keyTs, commitment: u.keyCommitment }, false, gen));
        earlyKeys.set(channelId, { key: u.key, epoch: u.epoch });
        onEarlyKey?.(u);
      },
    });
  })().catch((e): EpochFlowResult => {
    if (e instanceof AccountChangedError || !acct.stillValid()) return { kind: 'aborted' };
    e2elog('epoch: establish failed', { channelId, epoch, err: (e as Error)?.message });
    return { kind: 'pending', epoch, reason: 'error' };
  }).then((r) => {
    if (establishing.get(channelId) === p) establishing.delete(channelId);
    if (!acct.stillValid()) return r;
    // Aborted with the account still valid = the plan did not start
    // (beforeStart refused): never leave "re-keying…" behind.
    if (r.kind === 'aborted') { setStatus(channelId, { state: 'idle' }); return r; }
    applyFlowResult(channelId, scopeHex, r, opts, listed.ids, gen);
    return r;
  });
  establishing.set(channelId, p);
  return p;
}

/** Act on a finished flow: cache, mark covered, schedule resumes, surface problems. */
function applyFlowResult(
  channelId: number, scopeHex: string, r: EpochFlowResult, opts: EstablishOpts, listedIds: string[], gen: number,
): void {
  switch (r.kind) {
    case 'key': {
      const k = ckey(scopeHex, r.epoch);
      const early = earlyKeys.get(channelId);
      // `establish` source; final only when the node reports the pair final
      // (else PROVISIONAL until a later check / resume finalises it).
      onCached(channelId, r.epoch, keyStore.putEstablished(scopeHex, r.epoch, r.key, { keyTs: r.keyTs, commitment: r.keyCommitment }, r.confirmed, gen));
      if (r.confirmed || !early || early.epoch !== r.epoch || !bytesEqual(early.key, r.key)) earlyKeys.delete(channelId);
      if (r.role === 'established') {
        // The SDK covered every listed target except these (home-node truth):
        // the next cover pass only wraps to members that joined since.
        const skip = new Set([...r.uncovered, ...r.rejected]);
        wrappedToDevices.set(k, new Set(listedIds.filter((id) => !skip.has(id))));
      } else {
        // Adopted: the author covered the members; our next pass fills gaps
        // (already-present wraps are answered without being stored again).
        wrappedToDevices.delete(k);
      }
      e2elog('epoch: key ready', { channelId, epoch: r.epoch, role: r.role, confirmed: r.confirmed, incomplete: r.incomplete });
      let resume: ResumeScheduling | null = null;
      // The budget resets ONLY on a complete result (uncovered members keep counting).
      if (r.incomplete || !r.confirmed) resume = scheduleResume(channelId, r.epoch, { ...opts, known: true, earlyUse: false });
      else resumeBudget.complete(channelId);
      setStatus(channelId, statusAfterFlow(r, resume));
      return;
    }
    case 'pending': {
      const resume = scheduleResume(channelId, r.epoch, { ...opts, earlyUse: false });
      setStatus(channelId, statusAfterFlow(r, resume));
      return;
    }
    case 'problem':
      earlyKeys.delete(channelId);
      e2elog('epoch: problem', { channelId, epoch: r.epoch, code: r.code, detail: r.detail });
      setStatus(channelId, statusAfterFlow(r, null));
      if (r.code === 'needs_binding') {
        // Own enc row unbound: re-bind (rate-limited in deviceEnc), then retry.
        void ensureDeviceEncBinding().catch(() => {});
        scheduleResume(channelId, r.epoch, { ...opts, earlyUse: false });
      }
      return;
    default:
      return;
  }
}

/** The generation whose persisted establishments were resumed. */
let resumedGen = -1;

/**
 * After a restart (or account switch): re-run every epoch this account
 * persisted as "being established" BEFORE moving on (SDK caller contract — a
 * winner this device signed is resumed so members not yet covered still get
 * it). Runs once per account generation, sequentially, in the background.
 */
export async function resumeChannelKeyWork(): Promise<void> {
  const gen = getScopeGeneration();
  if (resumedGen === gen) return;
  resumedGen = gen;
  const flow = await startKeyFlow();
  if (!flow) {
    if (resumedGen === gen) resumedGen = -1; // not ready yet: try again on the next flow
    return;
  }
  const { acct, ctx } = flow;
  let list: Awaited<ReturnType<typeof establishingStore.list>>;
  try {
    list = await establishingStore.list(acct.account!);
  } catch {
    if (resumedGen === gen) resumedGen = -1;
    return;
  }
  for (const ent of list) {
    if (!acct.stillValid()) return;
    await yieldToUi();
    const { channelId, epoch } = ent;
    const holds = keyStore.holds(toHex(computeChannelScope(channelId)), epoch);
    const o = resumeOpts(ent, holds);
    e2elog('epoch: resuming persisted establishment', { channelId, epoch, ...o });
    await startEstablish(acct, ctx, channelId, epoch, o);
  }
}
setBindingSettledHook(() => { void resumeChannelKeyWork(); });

// --- Cover ----------------------------------------------------------------------------------

/**
 * Wrap the current channel key to any member device we haven't covered yet
 * (new joiners) — at the EXISTING epoch, with the key's own `(keyTs,
 * keyCommitment)` pair, and only while that pair is the node's winner. A key
 * of a LEGACY epoch cannot be covered at all on an arbitrating node: for a
 * channel that may rotate, uncovered members then trigger a (gated) rotation;
 * a public channel keeps them waiting (documented limitation).
 *
 * @param isPrivate the channel's type from a RESOLVED channel record; `null`
 *   while it is unknown → no cover at all (fail closed: an unresolved record
 *   defaults to Public, which would skip verify-before-cover).
 */
export async function coverChannelMembers(channelId: number, isPrivate: boolean | null): Promise<void> {
  if (isPrivate === null) return;
  const flow = await startKeyFlow();
  if (!flow) return;
  const { acct, ctx } = flow;
  const now = Date.now();
  const privateLike = isPrivate || isPrivateRangeId(channelId);
  if (now - (lastCoverMs.get(channelId) ?? 0) < coverThrottleMs(privateLike)) return;
  if (privateLike && coverBackoff.blocked(channelId, now)) return;
  if (establishing.has(channelId)) return; // the establishing protocol covers
  lastCoverMs.set(channelId, now);
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  try {
    const client = acctClient(acct);
    // Every keyring query is bounded to the node's highest epoch + 256 (a key
    // planted far ahead is never covered under).
    const nodeH = await readNodeHighest(acct, channelId);
    if (nodeH === null) { lastCoverMs.set(channelId, 0); return; }
    let held = keyStore.latestBounded(scopeHex, nodeH);
    if (!held) {
      const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex);
      if (typeof fetched === 'string') return; // I don't have the key myself yet
      if (!acct.stillValid()) return;
      held = keyStore.latestBounded(scopeHex, nodeH);
      if (!held) return; // the fetched key is beyond the bound / was not held
    }
    const entry: KeyEntry = { key: held.key, epoch: held.epoch };
    if (!acct.stillValid()) return;
    const k = ckey(scopeHex, entry.epoch);
    const done = wrappedToDevices.get(k) ?? new Set<string>();
    const targets = await getChannelTargets(acct, channelId, isPrivate, done);
    const missing = targets.filter((t) => !done.has(targetKey(t)));
    if (missing.length === 0) return;
    // A vault-restored key is re-verified through our own slot's wrap before
    // we wrap it to anyone (we would otherwise VOUCH for a key a node served).
    const pair = await checkPairTrusted(client, acct.stillValid, ctx, channelId, scope, scopeHex, entry);
    if (!acct.stillValid()) return;
    const rot = mayRotate(channelId, await hasPinFor(acct.account!, channelId));
    if (!acct.stillValid()) return;
    const action = planCover(pair ? pair.kind : null, rot);
    if (action === 'retry') { lastCoverMs.set(channelId, 0); return; }
    if (action === 'rotate') {
      e2elog('channel cover: current epoch is legacy (no commitment) — rotating (gated)', { channelId, epoch: entry.epoch, missing: missing.length });
      const st = epochStateFor(acct.account!);
      const base = keyStore.latestTrusted(scopeHex, nodeH)?.epoch ?? 0;
      const target = legacyMoveTarget(base, nodeH, boundedEvidence(st.evidence.highest(channelId), base, nodeH));
      startEstablish(acct, ctx, channelId, target,
        { isPrivate: true, known: false, gate: () => st.gate.tryEscalate(channelId) });
      return;
    }
    if (action === 'skip') {
      e2elog('channel cover: cannot cover at this epoch (legacy public / node has no state)', { channelId, epoch: entry.epoch, kind: pair?.kind });
      return;
    }
    if (action === 'adopt') {
      // Our cached key is not this epoch's winner here: adopt (SDK) instead.
      // We hold a key for this epoch, so it is known to exist (B2).
      e2elog('channel cover: our key is not the winner — adopting', { channelId, epoch: entry.epoch });
      startEstablish(acct, ctx, channelId, entry.epoch, { isPrivate, known: true });
      return;
    }
    if (!pair || pair.kind !== 'ours') return;
    // Only an AUTHOR-VERIFIED key is covered under: ours / an adopted winner
    // (`establish`, final or provisional) or a verified own-slot wrap.
    if (pair.trust === 'needs_author_proof' || pair.trust === 'dropped') {
      e2elog('channel cover: held key not author-verified (own wrap did not re-verify) — not covering', { channelId, epoch: entry.epoch });
      return;
    }
    const key = entry.key;
    const epoch = entry.epoch;
    const signer = ctx.signer!;
    let stop = false;
    const n = await publishToTargets(
      missing,
      () => acct.stillValid() && !stop,
      async (tg) => {
        const et = toEpochTarget(tg);
        if (!et) return;
        await yieldToUi();
        if (!acct.stillValid()) throw new AccountChangedError();
        const bytes = await buildChannelEpochKeyEnvelope(signer, {
          channelId, epoch, key, keyTs: pair.keyTs, target: et.target, deviceId: et.deviceId, encPub: et.encPub,
        });
        if (!acct.stillValid()) throw new AccountChangedError();
        try {
          await client.publishChannelKeyEnvelope(bytes);
        } catch (e) {
          if (e instanceof KeyCommitmentConflictError) {
            stop = true; // the winner changed under us — adopt on the next pass
            // The keyring never downgrades: "this pair lost" is client state —
            // recorded only for the account this publish ran for.
            if (acct.stillValid()) keyStore.markLost(scopeHex, epoch, key);
            return;
          }
          if (e instanceof KeyEnvelopeRateLimitedError) { stop = true; return; }
          if (e instanceof KeyEnvelopeRejectedError) {
            e2elog('channel cover: target rejected', { channelId, epoch, code: e.code });
            return;
          }
          throw e;
        }
      },
      (tg) => { done.add(targetKey(tg)); },
    );
    if (n === null && !acct.stillValid()) throw new AccountChangedError();
    wrappedToDevices.set(k, done);
    if (stop) lastCoverMs.set(channelId, Date.now());
    e2elog('channel cover: wrapped to new devices', { channelId, count: n ?? 0, private: isPrivate });
  } catch (e) {
    // Account change / unsafe pass: keep the throttle (no tight retry loop);
    // any other failure may retry on the next trigger.
    if (!(e instanceof AccountChangedError) && !(e instanceof CoverSkippedError)) lastCoverMs.set(channelId, 0);
    e2elog('channel cover skipped', { err: (e as Error)?.message, kind: (e as Error)?.name });
  }
}

// --- Rotation + heal ------------------------------------------------------------------------

/**
 * P2d rotation: establish a fresh epoch >= `floor` (SDK protocol; members
 * rotating concurrently converge on the node's one winner). NO-OP unless the
 * channel may rotate at all (private-range id or a creator pin — never on the
 * node's word: a hostile node could otherwise make every member of a public
 * encrypted channel rotate by sending a floor). The latest epoch is read from
 * the NODE as well as the cache, so a partially covered member never rotates
 * from a stale epoch. Runs in the background; the screen shows "re-keying…".
 */
export async function rotateChannelKey(channelId: number, floor: number): Promise<void> {
  if (!Number.isSafeInteger(floor) || floor <= 0) return;
  // W6: a node-supplied floor must not drive back-to-back rotations — one in
  // flight, ONE queued follow-up (highest floor), >= 60 s between starts.
  const req = floorQueue.request(channelId, floor, Date.now());
  if (req.action === 'ignored') return;
  if (req.action === 'queued') {
    if (req.delayMs !== null) armFloorTimer(channelId, req.delayMs);
    return;
  }
  await runFloorRotation(channelId, floor, req.token);
}

/** Start the queued follow-up once its spacing has passed. */
function armFloorTimer(channelId: number, delayMs: number): void {
  if (floorTimers.has(channelId)) return;
  const gen = getScopeGeneration();
  floorTimers.set(channelId, setTimeout(() => {
    floorTimers.delete(channelId);
    if (getScopeGeneration() !== gen) return;
    const f = floorQueue.takeQueued(channelId, Date.now());
    if (f !== null) void runFloorRotation(channelId, f.floor, f.token);
  }, Math.max(0, delayMs)));
}

/** One floor-driven rotation; always releases the coalescing slot. */
async function runFloorRotation(channelId: number, floor: number, token: number): Promise<void> {
  const gen = getScopeGeneration();
  try {
    const p = await startFloorRotation(channelId, floor);
    if (p) await p;
  } catch (e) {
    e2elog('channel rotate failed', { channelId, err: (e as Error)?.message });
  } finally {
    // N2: only the owner of THIS start releases it — after an account switch
    // the queue was cleared and the channel may belong to a new start.
    if (getScopeGeneration() === gen) {
      const next = floorQueue.finish(channelId, Date.now(), token);
      if (next) armFloorTimer(channelId, next.delayMs);
    }
  }
}

async function startFloorRotation(channelId: number, floor: number): Promise<Promise<EpochFlowResult> | null> {
  const flow = await startKeyFlow();
  if (!flow) return null;
  const { acct, ctx } = flow;
  if (!mayRotate(channelId, await hasPinFor(acct.account!, channelId))) {
    e2elog('channel rotate: ignored (public channel — no private id, no pin)', { channelId, floor });
    return null;
  }
  if (!acct.stillValid()) return null;
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  const nodeH = await readNodeHighest(acct, channelId);
  if (!acct.stillValid() || nodeH === null) return null;
  // Our own slot's latest wrap (verified → trusted) before deciding.
  await fetchChannelKey(ctx, channelId, scope, scopeHex);
  if (!acct.stillValid()) return null;
  // "Already rotated" only through a TRUSTED key (bounded): a node-planted or
  // vault-restored key at >= floor must not suppress the rotation after a kick.
  // FINAL only (as web / desktop): a trusted but not-yet-final key at >= floor
  // (e.g. another member's unconfirmed wrap) does not prove the rotation landed.
  const trusted = keyStore.latestTrusted(scopeHex, nodeH, true);
  if (trusted && trusted.epoch >= floor) return null; // already rotated
  if (floorTrust(floor, nodeH) === 'hostile') {
    e2elog('channel rotate: floor beyond the node bound — refused', { channelId, floor });
    return null;
  }
  // Rotate above everything the node has and every trusted epoch (bounded);
  // runEpochFlow re-checks the target against a fresh node highest.
  const targetEpoch = Math.max(Math.max(trusted?.epoch ?? 0, nodeH) + 1, floor);
  e2elog('channel rotate: starting', { channelId, targetEpoch });
  return startEstablish(acct, ctx, channelId, targetEpoch, { isPrivate: true, known: false });
}

/**
 * Heal trigger (split the peer check could not see): a message at our LATEST
 * epoch, whose key this app CONFIRMED, does not decrypt → another member
 * confirmed a different key → rotate past it (channelKeyCore `shouldHeal`).
 * Older epochs never heal (no E+2, E+3… loop on a remount), each epoch heals
 * at most once ever (persisted ledger, written before the rotation), only
 * channels that may rotate heal, and the account's shared escalation gate
 * (once per channel per 10 min) rate-limits garbage ciphertext.
 */
async function healChannel(channelId: number, epoch: number): Promise<void> {
  const flow = await startKeyFlow();
  if (!flow) return;
  const { acct, ctx } = flow;
  const self = acct.account!;
  const dedupe = `${channelId}:${epoch}`;
  if (healInflight.has(dedupe)) return;
  const scopeHex = toHex(computeChannelScope(channelId));
  const nodeH = await readNodeHighest(acct, channelId);
  if (nodeH === null) return; // unbounded view: no heal (fail closed)
  const latest = keyStore.latestBounded(scopeHex, nodeH);
  const rot = mayRotate(channelId, await hasPinFor(self, channelId));
  const healedUpTo = await healLedger.healedUpTo(self, channelId, Date.now());
  if (!acct.stillValid()) return;
  const st = epochStateFor(self);
  const target = planHeal({
    messageEpoch: epoch,
    latestHeldEpoch: latest?.epoch ?? null,
    latestConfirmed: !!latest && keyStore.anyConfirmed(scopeHex, latest.epoch),
    rotateAllowed: rot,
    establishing: establishing.has(channelId),
    healedUpTo,
  }, boundedEvidence(st.evidence.highest(channelId), keyStore.latestTrusted(scopeHex, nodeH)?.epoch ?? 0, nodeH));
  if (target === null) return;
  healInflight.add(dedupe);
  e2elog('epoch: heal — undecryptable message at our latest confirmed epoch, rotating', { channelId, epoch, target });
  const r = await startEstablish(acct, ctx, channelId, target, {
    isPrivate: true,
    known: false,
    // The gate is spent only if the rotation really starts (not on a join).
    gate: () => st.gate.tryEscalate(channelId),
    // Persist the ATTEMPT before rotating: a restart (or a remount
    // re-decrypting the same bad message) must not loop. Marked done once
    // the rotation produced a key past it; an unfinished attempt may be
    // retried (bounded, gated) — see HealLedger.
    beforeStart: () => healLedger.record(self, channelId, epoch, Date.now()),
  });
  if (r.kind === 'key' && r.epoch > epoch && acct.stillValid()) await healLedger.complete(self, channelId, epoch);
}

/**
 * Two DIFFERENT keys arrived for the same epoch (a split, or a hostile node's
 * wrap): both are kept (never overwritten). If it is our latest epoch and the
 * channel may rotate, rotate past it — gated (slot spent only on a real
 * start) and recorded in the heal ledger like a heal, so a restart cannot
 * repeat it.
 */
async function onKeyMismatch(channelId: number, epoch: number): Promise<void> {
  const flow = await startKeyFlow();
  if (!flow) return;
  const { acct, ctx } = flow;
  const self = acct.account!;
  const scopeHex = toHex(computeChannelScope(channelId));
  const nodeH = await readNodeHighest(acct, channelId);
  if (nodeH === null || !acct.stillValid()) return;
  if (keyStore.latestBounded(scopeHex, nodeH)?.epoch !== epoch) return;
  const rot = mayRotate(channelId, await hasPinFor(self, channelId));
  const healedUpTo = await healLedger.healedUpTo(self, channelId, Date.now());
  if (!rot || healedUpTo >= epoch || !acct.stillValid()) return;
  const st = epochStateFor(self);
  const target = Math.max(epoch, boundedEvidence(st.evidence.highest(channelId), keyStore.latestTrusted(scopeHex, nodeH)?.epoch ?? 0, nodeH)) + 1;
  e2elog('epoch: key mismatch at our latest epoch — rotating past it (gated)', { channelId, epoch, target });
  const r = await startEstablish(acct, ctx, channelId, target, {
    isPrivate: true,
    known: false,
    gate: () => st.gate.tryEscalate(channelId),
    beforeStart: () => healLedger.record(self, channelId, epoch, Date.now()),
  });
  if (r.kind === 'key' && r.epoch > epoch && acct.stillValid()) await healLedger.complete(self, channelId, epoch);
}

// --- Send -----------------------------------------------------------------------------------

/** Re-query the node's latest epoch on send when the last check is older than this (F). */
const LATEST_RECHECK_MS = 30_000;
const latestCheckedAt = new Map<number, number>();
/** The node's highest epoch per channel as last read (bounds the send-key choice, N1). */
const nodeHighest = new Map<number, number>();
const staleChannels = new Set<number>();

/**
 * The node's highest epoch for a channel (bounds every keyring query:
 * `maxEpoch = nodeHighest + 256`): the value read within the last
 * {@link LATEST_RECHECK_MS}, else a fresh read. null = unreadable (callers
 * fail closed: no send / cover / rotation / heal on an unbounded view).
 */
async function readNodeHighest(acct: Acct, channelId: number): Promise<number | null> {
  return nodeHighestVia(acctClient(acct), channelId, acct.stillValid);
}

/** {@link readNodeHighest} for callers holding a client + validity check instead of an Acct. */
async function nodeHighestVia(client: OgmaraClient, channelId: number, stillValid: () => boolean): Promise<number | null> {
  const cached = nodeHighest.get(channelId);
  const now = Date.now();
  if (cached !== undefined && now - (latestCheckedAt.get(channelId) ?? 0) <= LATEST_RECHECK_MS) return cached;
  // B2: a failed read is remembered briefly — a failing (or pre-0.143) node is
  // not re-queried by every rendered message.
  const failedAt = nodeHighestFailedAt.get(channelId);
  if (failedAt !== undefined && now - failedAt < NODE_HIGHEST_FAIL_TTL_MS) return cached ?? null;
  try {
    const l = await withTimeout(client.getKeyCommitment(channelId), DEP_TIMEOUT_MS, 'latest commitment');
    if (!stillValid() || !Number.isSafeInteger(l.epoch) || l.epoch < 0) return null;
    latestCheckedAt.set(channelId, Date.now());
    nodeHighest.set(channelId, l.epoch);
    nodeHighestFailedAt.delete(channelId);
    return l.epoch;
  } catch {
    if (stillValid()) {
      if (nodeHighestFailedAt.size >= 2048) {
        const oldest = nodeHighestFailedAt.keys().next().value;
        if (oldest !== undefined) nodeHighestFailedAt.delete(oldest);
      }
      nodeHighestFailedAt.set(channelId, Date.now());
    }
    return cached ?? null;
  }
}

/** Channel → when its node-highest read last FAILED (B2; cleared on switch). */
const nodeHighestFailedAt = new Map<number, number>();
/** Decrypt-miss fetch limiter (B2; cleared on switch). */
const missFetches = new MissFetchLimiter();

/** A members-changed / key WS event arrived: re-query the latest epoch on the next send (F). */
export function markChannelKeyStale(channelId: number): void {
  staleChannels.add(channelId);
}

/** Usable without asking the node: CONFIRMED, or the early-use first key while its epoch settles. */
function usableNow(channelId: number, scopeHex: string, epoch: number, key: Uint8Array): boolean {
  if (keyStore.isConfirmed(scopeHex, epoch, key)) return true;
  const early = earlyKeys.get(channelId);
  return !!early && early.epoch === epoch && bytesEqual(early.key, key) && keyStore.isProvisional(scopeHex, epoch, key);
}

/**
 * Which key held at `entry.epoch` may we SEND under right now? Every held key
 * for the epoch is a candidate (the given one first, then the others —
 * alternates are kept, never overwritten); a CONFIRMED one (trusted + final +
 * pair not lost) or the early-use key wins, else the first whose pair the
 * node's FINAL winner hashes to AND that is author-verified (a vault key is
 * re-verified through our own slot's wrap first). A key at an epoch the node
 * reports LEGACY is NEVER usable (all-clients decision, sdk-js 0.68.0): the
 * caller moves the channel to an arbitrated epoch (gated) instead. Returns
 * that key, or the last node answer when none is usable.
 */
async function usableForSend(
  acct: Acct, ctx: DeviceCtx, channelId: number, scope: Uint8Array, scopeHex: string, entry: KeyEntry, nodeH: number,
): Promise<{ ok: true; key: Uint8Array } | { ok: false; check: PairCheck | null }> {
  const held = keyStore.keysAt(scopeHex, entry.epoch);
  const cands = [entry.key, ...held.filter((x) => !bytesEqual(x, entry.key))];
  for (const key of cands) if (usableNow(channelId, scopeHex, entry.epoch, key)) return { ok: true, key };
  let check: PairCheck | null = null;
  for (const key of cands) {
    try {
      check = await checkPairTrusted(acctClient(acct), acct.stillValid, ctx, channelId, scope, scopeHex, { key, epoch: entry.epoch });
    } catch {
      return { ok: false, check: null }; // account changed: the caller re-checks and returns null
    }
    if (check && check.kind === 'ours' && check.final && check.trust === 'trusted') return { ok: true, key };
    // `none` / `legacy` are answers about the EPOCH: the same for every key.
    if (!check || check.kind === 'none' || check.kind === 'legacy') break;
  }
  return { ok: false, check };
}

/**
 * W2: are we the channel's only member? Proven only by the VERIFIED
 * establishment targets (as web / desktop `earlyUseAlone`): a COMPLETE pass,
 * non-empty, every target our own wallet. The node's member list alone is
 * never proof; any error → not alone (the first key then waits for FINAL).
 */
async function isSoleMember(acct: Acct, channelId: number, isPrivate: boolean): Promise<boolean> {
  try {
    const out = { incomplete: false };
    const targets = await getChannelTargets(acct, channelId, isPrivate, undefined, out);
    if (!acct.stillValid()) return false;
    return earlyUseAlone(targets, out.incomplete, acct.account!);
  } catch {
    return false;
  }
}

/** Wait for the early key of a brand-new channel (or the flow's own result). */
const EARLY_KEY_WAIT_MS = 60_000;

/**
 * Ensure a channel key for sending. Returns the key; `'waiting'` when none
 * exists yet that this client may use and it may not establish (a non-mod
 * waits for a mod to seed / cover it); `'rekeying'` while an epoch is being
 * established / adopted and not yet FINAL (~2 min after a kick); or `null` if
 * the device isn't ready. Enforces the rotation floor (P2d) where rotation is
 * allowed (effective floor 0 for public channels).
 *
 * @param canEstablish creator/mods only — gates SEEDING the first epoch.
 * @param floor lowest epoch we may encrypt under (channel's `key_epoch_floor`).
 */
export async function ensureChannelKeyForSend(
  channelId: number, canEstablish: boolean, floor: number, isPrivate: boolean,
): Promise<{ convKey: Uint8Array; epoch: number } | 'waiting' | 'rekeying' | null> {
  const flow = await startKeyFlow();
  if (!flow) return null;
  const { acct, ctx } = flow;
  const client = acctClient(acct);
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  const hasPin = await hasPinFor(acct.account!, channelId);
  if (!acct.stillValid()) return null;
  const rot = mayRotate(channelId, hasPin);
  const eFloor = effectiveFloor(channelId, floor, hasPin);

  if (establishing.has(channelId)) {
    const early = earlyKeys.get(channelId);
    if (early && early.epoch >= eFloor) return { convKey: early.key, epoch: early.epoch };
    return 'rekeying';
  }

  // F: re-query the node's latest epoch when our view may be stale — and
  // always before the first send, since it bounds which held key we may pick.
  let latest: KeyCommitmentInfo | null = null;
  const now = Date.now();
  if (staleChannels.has(channelId) || !nodeHighest.has(channelId)
    || now - (latestCheckedAt.get(channelId) ?? 0) > LATEST_RECHECK_MS) {
    try {
      latest = await withTimeout(client.getKeyCommitment(channelId), DEP_TIMEOUT_MS, 'latest commitment');
      latestCheckedAt.set(channelId, Date.now());
      nodeHighest.set(channelId, latest.epoch);
      staleChannels.delete(channelId);
    } catch {
      latest = null;
    }
    if (!acct.stillValid()) return null;
  }
  // N1: every keyring query is bounded to the node's highest epoch + 256 (a
  // key planted at epoch 100000 never becomes the send key, even once a node
  // reports a commitment matching it). Without the node's answer there is no
  // bound: fail closed.
  const nodeH = nodeHighest.get(channelId);
  if (nodeH === undefined) return 'waiting';
  const heldAt = (e: number): KeyEntry | null => {
    const k = keyStore.keysAt(scopeHex, e)[0];
    return k ? { key: k, epoch: e } : null;
  };
  const top = keyStore.latestBounded(scopeHex, nodeH);
  let best: KeyEntry | null = top ? { key: top.key, epoch: top.epoch } : null;
  if (!best) {
    const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex);
    if (!acct.stillValid()) return null;
    // Only what the keyring now HOLDS (a refused / out-of-bound key is not a send candidate).
    if (typeof fetched !== 'string' && fetched.epoch <= nodeH + SEND_EPOCH_MARGIN) best = heldAt(fetched.epoch);
  }
  if (latest && latest.state !== 'none' && latest.epoch > (best?.epoch ?? 0)) {
    const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex, latest.epoch);
    if (!acct.stillValid()) return null;
    const fetchedHeld = typeof fetched !== 'string' ? heldAt(latest.epoch) : null;
    const plan = planNewerLatest({
      latestState: latest.state, fetchedKey: !!fetchedHeld, haveBest: !!best, canEstablish,
    });
    if (plan === 'use-fetched' && fetchedHeld) {
      best = fetchedHeld;
    } else if (plan === 'adopt') {
      // A newer arbitrated epoch we hold no key for (yet): adopt it (the SDK
      // waits for our verified wrap, escalates if it never comes). The node's
      // word alone is not evidence that it exists, so known stays false.
      startEstablish(acct, ctx, channelId, latest.epoch, { isPrivate, known: false });
      return 'rekeying';
    } else if (latest.state === 'legacy' && best) {
      e2elog('channel send: newer legacy epoch without our wrap — using our best key', { channelId, epoch: best.epoch, latest: latest.epoch });
    }
  }

  // Unified guard: a node-served floor beyond the node's highest + 256 is never
  // trusted (it would drive a rotation the node itself must refuse).
  if (floorTrust(eFloor, nodeHighest.get(channelId) ?? null) === 'hostile') {
    e2elog('channel send: key_epoch_floor beyond the node bound — refused', { channelId, floor: eFloor, nodeHighest: nodeHighest.get(channelId) });
    setStatus(channelId, { state: 'problem', code: 'epoch_too_high', detail: 'hostile_floor' });
    return 'waiting';
  }

  if (best) {
    let usable = false;
    let pair: PairKind = null;
    if (best.epoch >= eFloor) {
      const u = await usableForSend(acct, ctx, channelId, scope, scopeHex, best, nodeH);
      if (!acct.stillValid()) return null;
      usable = u.ok;
      if (u.ok) best = { key: u.key, epoch: best.epoch };
      if (!u.ok && u.check) {
        const c = u.check;
        // planBest treats `ours-final` as sendable: only when usableForSend
        // really accepted that key; any other `ours` answer is pending.
        pair = c.kind === 'ours' ? 'ours-pending' : c.kind;
      }
    }
    // W3 (as web): an UNVERIFIABLE best key (node-served / vault whose own
    // wrap did not re-verify) never blocks sending — fall back to the highest
    // trusted FINAL key (`sendKey`, bounded) at or above the floor.
    const bestInfo = keyStore.info(scopeHex, best.epoch, best.key);
    const fb = keyStore.sendKey(scopeHex, nodeH);
    const plan = planBest({
      bestEpoch: best.epoch, eFloor, rotateAllowed: rot, usable, pair, mayMove: canEstablish || rot,
      authorVerified: usable || bestInfo?.authorVerified === true, fallbackEpoch: fb?.epoch ?? null,
    });
    if (plan.do !== 'fallback') fb?.key.fill(0);
    switch (plan.do) {
      case 'use':
        void coverChannelMembers(channelId, isPrivate).catch(() => {});
        return { convKey: best.key, epoch: best.epoch };
      case 'fallback':
        e2elog('channel send: latest key unverifiable — sending under the highest trusted final key', { channelId, epoch: fb!.epoch, best: best.epoch });
        void coverChannelMembers(channelId, isPrivate).catch(() => {});
        return { convKey: fb!.key, epoch: fb!.epoch };
      case 'rotate':
        startEstablish(acct, ctx, channelId, plan.epoch, { isPrivate: true, known: false });
        return 'rekeying';
      case 'waiting':
        return 'waiting';
      case 'settle':
        // Not final yet / not the winner / node has no state. We HOLD a key
        // for this epoch, so it is known to exist: a node answering `none`
        // yields node_lagging and never gets a second key there (B2).
        startEstablish(acct, ctx, channelId, plan.epoch, { isPrivate, known: plan.known });
        return 'rekeying';
      case 'move': {
        // LEGACY epoch (all-clients decision): never send under a key a node
        // chose there — open an arbitrated epoch above it and above everything
        // the node has, GATED (the slot is spent only if the flow really starts).
        const st = epochStateFor(acct.account!);
        const base = keyStore.latestTrusted(scopeHex, nodeH)?.epoch ?? 0;
        const target = legacyMoveTarget(base, nodeH, boundedEvidence(st.evidence.highest(channelId), base, nodeH));
        e2elog('channel send: epoch is legacy — moving to an arbitrated epoch (gated)', { channelId, epoch: best.epoch, target });
        void startEstablish(acct, ctx, channelId, target, { isPrivate, known: false, gate: () => st.gate.tryEscalate(channelId) });
        return establishing.has(channelId) ? 'rekeying' : 'waiting';
      }
    }
  }

  if (!canEstablish) return 'waiting';
  // Seed. An existing epoch we hold no key for: wait to be covered — except a
  // LEGACY one, which nobody can cover any more: open the next epoch (gated).
  if (latest === null) {
    try {
      latest = await withTimeout(client.getKeyCommitment(channelId), DEP_TIMEOUT_MS, 'latest commitment');
    } catch {
      return 'waiting';
    }
    if (!acct.stillValid()) return null;
  }
  const seed = planSeed({ latestState: latest.state, latestEpoch: latest.epoch, target: Math.max(1, eFloor) });
  if (seed.do === 'adopt') {
    startEstablish(acct, ctx, channelId, seed.epoch, { isPrivate, known: false });
    return 'rekeying';
  }
  const target = seed.epoch;
  if (seed.gated) {
    // Opening the epoch past a LEGACY one nobody can cover: gated, the slot
    // spent only if the flow really starts.
    const gate = epochStateFor(acct.account!).gate;
    void startEstablish(acct, ctx, channelId, target, { isPrivate, known: false, gate: () => gate.tryEscalate(channelId) });
    // startEstablish registers a flow synchronously iff it really started.
    return establishing.has(channelId) ? 'rekeying' : 'waiting';
  }
  const earlyUse = earlyUseAllowed({
    epoch: target, latestState: latest.state,
    soleMember: target === 1 && latest.state === 'none' && (await isSoleMember(acct, channelId, isPrivate)),
  });
  if (!acct.stillValid()) return null;
  if (!earlyUse) {
    startEstablish(acct, ctx, channelId, target, { isPrivate, known: false });
    return 'rekeying';
  }
  // First key of a brand-new channel, creator alone: use it as soon as it is
  // the node's winner (user decision; residual: orphaned only if a better key
  // supersedes it within ~120 s — nobody else is a member to produce one).
  const early = await new Promise<{ key: Uint8Array; epoch: number } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), EARLY_KEY_WAIT_MS);
    const done = (v: { key: Uint8Array; epoch: number } | null) => { clearTimeout(timer); resolve(v); };
    void startEstablish(acct, ctx, channelId, target, { isPrivate, known: false, earlyUse: true },
      (u) => done({ key: u.key, epoch: u.epoch }))
      .then((r) => done(r.kind === 'key' && (r.confirmed || r.role === 'established') ? { key: r.key, epoch: r.epoch } : null));
  });
  if (!acct.stillValid()) return null;
  if (!early) {
    if (establishing.has(channelId)) setStatus(channelId, { state: 'rekeying', epoch: target });
    return 'rekeying';
  }
  return { convKey: early.key, epoch: early.epoch };
}

/** Build a signed, encrypted ChatMessage for an encrypted channel. When `opts.media`
 *  is set (P5), each file is encrypted under its own key BEFORE upload and only a
 *  stripped `{ cid, size }` reaches the wire; per-file keys ride inside the ciphertext. */
export async function buildEncryptedChannelMsg(
  channelId: number, canEstablish: boolean, text: string,
  opts: {
    replyTo?: string; mentions?: string[];
    contentRating?: 'general' | 'teen' | 'mature' | 'explicit';
    attachments?: Array<{ cid: string; mime_type: string; size_bytes: number; filename?: string; thumbnail_cid?: string }>;
    media?: MediaDescriptor[];
    /**
     * Set when this message IS a button press (protocol §3.3). Forwarded
     * verbatim to the SDK, which stamps it into the PLAINTEXT outer payload
     * (never sealed) — feed-suppression rendering hints work identically to
     * a plaintext channel's messages.
     */
    viaButton?: boolean;
  } | undefined,
  floor: number,
  /** Channel type from the RESOLVED channel record (drives verify-before-cover). */
  isPrivate: boolean,
): Promise<Uint8Array | 'waiting' | 'rekeying'> {
  const acct = captureAccountContext();
  const established = await ensureChannelKeyForSend(channelId, canEstablish, floor, isPrivate);
  if (established === 'waiting' || established === 'rekeying') return established;
  if (!established) throw new Error('device not ready for encrypted channels');
  if (!acct.stillValid()) throw new AccountChangedError();
  const signer = getSigner();
  if (!signer) throw new Error('no signer');
  return buildEncryptedChannelMessage(signer, {
    channelId, convKey: established.convKey, epoch: established.epoch,
    text, replyTo: opts?.replyTo, mentions: opts?.mentions,
    contentRating: opts?.contentRating, attachments: opts?.attachments,
    media: opts?.media && opts.media.length > 0 ? opts.media : undefined,
    viaButton: opts?.viaButton,
  });
}

// --- Decrypt --------------------------------------------------------------------------------

interface RawChannelPayload {
  content?: unknown;
  enc_content?: unknown;
  enc_nonce?: unknown;
  key_epoch?: number;
}

const asBytes = (v: unknown): Uint8Array | null =>
  v instanceof Uint8Array ? v : Array.isArray(v) ? Uint8Array.from(v as number[]) : null;

/** Decrypt a channel message for rendering. v1 plaintext passes through. */
export async function decryptChannelMessage(
  payload: number[] | Uint8Array | string, channelId: number,
): Promise<DmDisplay> {
  const bytes = toBytes(payload);
  if (!bytes) return { kind: 'error' };
  let decoded: RawChannelPayload;
  try {
    decoded = decode(bytes) as RawChannelPayload;
  } catch {
    return { kind: 'error' };
  }
  const enc = asBytes(decoded.enc_content);
  if (!enc) {
    // v1 plaintext (or empty/attachment-only) message.
    return { kind: 'plain', text: typeof decoded.content === 'string' ? decoded.content : '' };
  }
  const nonce = asBytes(decoded.enc_nonce);
  if (!nonce) return { kind: 'error' };
  const rawEpoch = decoded.key_epoch ?? 1;
  if (!Number.isSafeInteger(rawEpoch) || rawEpoch < 1) return { kind: 'error' };
  const epoch = rawEpoch;

  const ctx = await deviceCtx();
  if (!ctx) return { kind: 'waiting' };
  const scope = computeChannelScope(channelId);
  const scopeHex = toHex(scope);
  let keys = keyStore.keysAt(scopeHex, epoch);
  if (keys.length === 0) {
    // B2: at most MISS_FETCHES_PER_MIN fetches per (scope, epoch) per minute —
    // every rendered `waiting` message re-decrypts every few seconds.
    // (Joining a fetch of the same epoch already in flight costs nothing.)
    if (!fetchingChannelKey.has(`${scopeHex}:${epoch}`) && !missFetches.take(`${scopeHex}:${epoch}`, Date.now())) {
      requestVaultRestore();
      return { kind: 'waiting' };
    }
    const fetched = await fetchChannelKey(ctx, channelId, scope, scopeHex, epoch);
    if (fetched === 'missing') {
      requestVaultRestore();
      return { kind: 'waiting' };
    }
    if (fetched === 'corrupt') return { kind: 'error' };
    keys = [fetched.key];
  }
  // Every key held for the epoch is tried (alternates are kept, never overwritten).
  for (const key of keys) {
    try {
      const pt = decryptDmContent(key, scope, epoch, enc, nonce);
      // Authenticated evidence: a message that decrypted under a TRUSTED key
      // (author-verified + pair-consistent; never a legacy / vault / fetched one).
      const w = walletAddress();
      if (w && w === ctx.wallet && keyStore.isTrusted(scopeHex, epoch, key)) epochStateFor(w).evidence.note(channelId, epoch);
      return { kind: 'text', text: pt.text, media: pt.media };
    } catch { /* next candidate */ }
  }
  // Heal trigger: undecryptable at our LATEST epoch whose key we CONFIRMED
  // (the full rule, incl. the persisted once-per-epoch ledger, is shouldHeal).
  if (keyStore.anyConfirmed(scopeHex, epoch)) void healChannel(channelId, epoch).catch(() => {});
  return { kind: 'error' };
}
