/**
 * Local cache for channel/DM message history — paints a resumed
 * conversation instantly instead of blanking and reloading from the
 * network every single time a channel/DM is (re-)opened.
 *
 * Mobile port of web's `messageCache.ts` (shipped web 0.80.0, 5 audit
 * rounds) / desktop's (shipped desktop 1.80.0, 3 audit rounds). The pure
 * algorithm below (`mergeMessages`, row projection, byte-bound trimming,
 * dedup/sort/cap ordering) is ported near-verbatim — that logic has no
 * browser/AsyncStorage dependency and was already hardened. What's
 * genuinely different on mobile:
 *
 * 1. **Storage is asynchronous.** `localStorage` (web/desktop) is
 *    synchronous; `@react-native-async-storage/async-storage` is not. Every
 *    function that touches storage here returns a `Promise` — callers seed
 *    `cachedMessages` state from a `useEffect`, not synchronously inline.
 * 2. **A different-shaped cross-wallet hazard than desktop's, still real.**
 *    Desktop needed a wallet-tracked RESEED because a chat screen could
 *    survive an account handover without unmounting. Mobile's `App.tsx`
 *    keys its whole navigation tree on `walletAddress` (`<TabNavigator
 *    key={walletAddress ?? 'no-account'} .../>`), so every account switch
 *    DOES unmount every open chat screen — but that unmount is itself the
 *    hazard: `switchAccount()`/`removeAccount()` (`ConnectionContext.tsx`)
 *    flip `walletScope.ts`'s active wallet BEFORE the remount that unmounts
 *    the old screens actually commits, so a screen's own unmount-triggered
 *    cache flush (armed *before* the switch, e.g. by a WS message that
 *    landed seconds earlier) runs with the NEW wallet already active —
 *    writing the DEPARTING wallet's messages into the ARRIVING wallet's
 *    namespace, and repopulating `warm` for that key moments after
 *    `registerWalletSwitchReset` cleared it. `writeCachedMessages` therefore
 *    takes an explicit `ownerWallet`, captured by the CALLER at the moment
 *    the snapshot being persisted was actually current, and bails if the
 *    active wallet no longer matches it by the time the write actually
 *    runs — the same arm-time-capture/fire-time-bail discipline desktop
 *    uses for its own (structurally different) version of this hazard.
 * 3. **Ciphertext, not plaintext** (matching web/desktop, a deliberate
 *    decision — see `mobile/src/lib/mediaDiskCache.ts` for the opposite,
 *    equally deliberate tradeoff mobile makes for already-decrypted media,
 *    justified there by `expo-file-system`'s sandboxed cache directory).
 *
 * SECURITY-CRITICAL DESIGN CONSTRAINT (carried over from web/desktop,
 * re-derived here rather than assumed, since mobile's real fetch limits
 * differ): a delta fetch using `after=<msg_id>` NEVER resurfaces an edit,
 * deletion, or reaction change on a message that predates the cursor — see
 * web's `messageCache.ts` header comment for the full server-architecture
 * reasoning (l2-node's edit/delete projection has no REST reader over
 * `CHANNEL_EDIT_DELETE_MSGS`/`DM_EDIT_DELETE_MSGS`). Therefore
 * `MAX_ROWS_PER_CONV` MUST stay <= the smallest `limit` either mobile
 * screen's real, unconditional fetch actually requests, so every cached row
 * is revalidated by the very next such fetch. Mobile has NO pagination at
 * all: `ChannelMessagesScreen.tsx` always requests a fixed
 * `getChannelMessages(channelId, 200)`; `DmConversationScreen.tsx` calls
 * `getDmMessages(peerAddress)` with no limit override, taking the SDK's
 * default of 50 (`sdk-js/src/client.ts`). The binding constraint is
 * therefore the DM screen's 50, not the channel screen's 200 — if either
 * caller's real limit ever changes, re-derive this as the MINIMUM across
 * both, not assume it. This cache is never refreshed via `after` — it is
 * only ever wholesale-replaced or merged against a full, unconditional
 * fetch via `mergeMessages`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { scopedKey, registerWalletSwitchReset, getWalletScope } from './walletScope.ts';

// Bumped 1 -> 2 when `cachedAt` (the TTL field) was added mid-development on
// web, before that feature ever shipped — carried over here so a hypothetical
// pre-`cachedAt` blob (there are none on mobile; this module ships with the
// field from day one) would still be recognized as a version mismatch rather
// than reading as permanently expired without ever being cleaned up.
const CACHE_VERSION = 2;
const PREFIX = 'ogmara.msgCache';

/**
 * MUST stay <= the smallest `limit` either mobile screen's real
 * unconditional fetch requests (currently 50, from the DM screen's default
 * page size — see the module doc comment). This is a security control
 * (bounding how long a redacted/deleted/edited message can render from a
 * stale local copy), not merely a size control.
 */
export const MAX_ROWS_PER_CONV = 50;

/** Cross-conversation LRU cap, to bound total storage across many channels/DMs. */
const MAX_CACHED_CONVERSATIONS = 30;

/** Matches the protocol's `MAX_CHAT_PAYLOAD_BYTES` (docs/specs/01-protocol.md §3). A row whose payload exceeds this is dropped rather than cached truncated/wrong. */
const MAX_ROW_PAYLOAD_BYTES = 65536;

/** Self-trim budget for one conversation's serialized cache blob — bounds the worst case (50 rows x a near-max payload each) without relying on cross-conversation eviction to absorb it. */
const MAX_CONV_SERIALIZED_BYTES = 512 * 1024;

/** How long a cached conversation is trusted before being treated as cold. Matches `mediaDiskCache.ts`'s own 7-day precedent on this exact codebase. */
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Minimum interval between eviction-of-OTHER-conversations attempts, regardless of how many distinct writes fail in that window — otherwise a write that eviction can never fix repeatedly destroys every other cached conversation for no benefit. */
const MIN_EVICTION_INTERVAL_MS = 10000;
let lastEvictionAttemptAt = 0;

/** Cheap sanity bound on a conversation id used as a storage-key component — not full address validation, just enough to stop a pathological/huge route param from becoming a huge key or a pointless LRU entry. */
const MAX_ID_LEN = 200;

const INDEX_BASE = `${PREFIX}.index`;

export type ConvKind = 'ch' | 'dm';

/** A cached row: the envelope's fields, minus `signature`/`relay_path`/`_`-prefixed client-only fields, `payload` base64-encoded. */
export interface CachedRow {
  msg_id: string;
  timestamp: number;
  payload: string;
  [key: string]: unknown;
}

interface CachedConv {
  v: number;
  /** `Date.now()` at write time — see `MAX_CACHE_AGE_MS`. */
  cachedAt: number;
  rows: CachedRow[];
}

/**
 * Storage backend seam. Defaults to the real AsyncStorage; tests swap this
 * via `__setStorageBackendForTesting` so the pure logic below (dedup, sort,
 * cap, byte-budget trim, `mergeMessages`) can run under plain `node --test`
 * without a React Native runtime — `AsyncStorage.getItem`/`setItem` throw
 * ("window is not defined") outside one, though merely importing the module
 * does not.
 */
interface StorageBackend {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

let storage: StorageBackend = AsyncStorage;

/** Test-only seam — never call from app code. */
export function __setStorageBackendForTesting(impl: StorageBackend): void {
  storage = impl;
}

function base(kind: ConvKind, id: string | number, nodeUrl: string): string {
  return `${PREFIX}.${nodeUrl || ''}.${kind}.${id}`;
}

/** `false` for an id too large to be a plausible channel id / wallet address — see `MAX_ID_LEN`. */
function idLooksPlausible(id: string | number): boolean {
  return String(id).length <= MAX_ID_LEN;
}

function bytesToBase64(bytes: number[] | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  let bin = '';
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  try {
    return btoa(bin);
  } catch {
    return '';
  }
}

function base64ToUint8Array(b64: string): Uint8Array {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return arr;
  } catch {
    return new Uint8Array(0);
  }
}

const HEX = '0123456789abcdef';
function bytesToHex(bytes: number[] | Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    const n = typeof b === 'number' && b >= 0 && b <= 255 ? b : 0;
    out += HEX[(n >> 4) & 0xf] + HEX[n & 0xf];
  }
  return out;
}

/**
 * Normalizes a `msg_id` to its hex-string form, matching this app's own
 * `msgIdToHex` helpers (`ChannelMessagesScreen.tsx`, `DmConversationScreen.
 * tsx`) — a `msg_id` can arrive as a hex string, a `number[]`, or a
 * `Uint8Array` depending on the source, and this module must recognize all
 * three or it silently drops rows a live screen already renders correctly.
 */
function msgIdOf(m: unknown): string | null {
  const id = (m as { msg_id?: unknown } | null)?.msg_id;
  if (typeof id === 'string') return id.length > 0 ? id : null;
  if (Array.isArray(id) || id instanceof Uint8Array) {
    const hex = bytesToHex(id as number[] | Uint8Array);
    return hex.length > 0 ? hex : null;
  }
  return null;
}

/**
 * An optimistic/local-only row must never be persisted — it has no server
 * identity. The `_optimistic` flag is the primary signal; the id-prefix
 * check is the fallback for when it's lost (a spread that drops it, a
 * future refactor) — `local-` is `ChannelMessagesScreen.tsx`'s optimistic
 * id prefix, `dm-` is `DmConversationScreen.tsx`'s. Both are checked: DM
 * content is the highest-value plaintext in this app, so that fallback
 * needs to actually cover it, not just channel messages.
 */
function isOptimistic(m: any): boolean {
  return !!m?._optimistic || (typeof m?.msg_id === 'string' &&
    (m.msg_id.startsWith('local-') || m.msg_id.startsWith('dm-')));
}

function toCacheRow(m: any): CachedRow | null {
  const id = msgIdOf(m);
  if (!id || isOptimistic(m)) return null;
  const { signature: _sig, relay_path: _rp, payload, ...rest } = m;
  // Drop every client-only `_`-prefixed field, not just the ones known
  // today (`_optimistic`, `_decodedContent`, `_decodedEncryptedMedia`, ...)
  // — `_decodedEncryptedMedia` on an optimistic row carries plaintext
  // per-file content keys, and relying on "only optimistic rows ever carry
  // it" (already filtered above via `isOptimistic`) is a coincidence, not a
  // guarantee, the next time this shape is touched.
  const cleaned: Record<string, unknown> = {};
  for (const k of Object.keys(rest)) {
    if (!k.startsWith('_')) cleaned[k] = rest[k];
  }
  // `payload` must actually be byte data — mobile's own optimistic-edit
  // fallback path can set it to a plain string (see `ChannelMessagesScreen.
  // tsx`'s edit handler), and `bytesToBase64` would silently encode that as
  // garbage (NaN -> 0 for every "byte"), caching a zero-filled payload
  // under a REAL msg_id rather than dropping it.
  let encodedPayload = '';
  if (Array.isArray(payload) || payload instanceof Uint8Array) {
    if (payload.length > MAX_ROW_PAYLOAD_BYTES) return null; // oversized — drop rather than cache truncated
    encodedPayload = bytesToBase64(payload);
  } else if (payload != null) {
    return null; // malformed payload shape — don't cache a row we can't round-trip
  }
  return {
    ...cleaned,
    msg_id: id,
    timestamp: typeof m.timestamp === 'number' ? m.timestamp : 0,
    payload: encodedPayload,
  };
}

/**
 * Rehydrate a cached row back to the shape the rest of the app expects —
 * `payload` as `Uint8Array`. `null` for a malformed row (e.g. a corrupted
 * blob with a `null`/non-object entry in `rows`) rather than throwing —
 * `readConvFromDisk` only validates that `rows` IS an array, not the shape
 * of each element, and an uncaught throw here would propagate out of
 * `readCachedMessages` into a screen's `useEffect`, which React surfaces as
 * an unhandled rejection rather than a contained failure.
 */
function fromCacheRow(row: CachedRow): any {
  if (!row || typeof row !== 'object') return null;
  const { payload, ...rest } = row;
  return { ...rest, payload: payload ? base64ToUint8Array(payload) : new Uint8Array(0) };
}

// In-memory warm layer, mirrors what is on disk for the conversations this
// process has actually opened. Dropped synchronously on wallet switch (same
// reasoning as `walletScope.ts`'s own switch-reset) — belt-and-braces on
// mobile, since `App.tsx`'s `key={walletAddress}` remount already tears down
// every screen that could read `warm`, but `warm` itself is module-level and
// would otherwise outlive that remount.
let warm = new Map<string, CachedConv>();
registerWalletSwitchReset(() => { warm = new Map(); });

async function readConvFromDisk(b: string): Promise<CachedConv | null> {
  const key = scopedKey(b);
  if (!key) return null;
  try {
    const raw = await storage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.v !== CACHE_VERSION || !Array.isArray(parsed.rows)) {
      // A version mismatch (as opposed to garbage JSON) is a KNOWN blob this
      // module wrote itself in a previous format — remove it rather than
      // leaving a permanently-unreadable, permanently-untracked-by-the-LRU
      // entry stranded in storage after a future CACHE_VERSION bump.
      if (parsed && typeof parsed === 'object' && typeof parsed.v === 'number' && parsed.v !== CACHE_VERSION) {
        try { await storage.removeItem(key); } catch { /* best-effort */ }
      }
      return null;
    }
    const conv = parsed as CachedConv;
    if (typeof conv.cachedAt !== 'number' || Date.now() - conv.cachedAt > MAX_CACHE_AGE_MS) {
      return null; // expired — treat as cold rather than paint stale-beyond-trust content
    }
    return conv;
  } catch {
    return null;
  }
}

/**
 * Trim `conv.rows` (from the oldest end) so the conversation fits
 * `MAX_CONV_SERIALIZED_BYTES`, computing each row's serialized size ONCE
 * rather than re-stringifying the whole object on every trim step (O(n),
 * matching web/desktop's round-2 re-audit fix for the same shape).
 */
function trimToByteBudget(conv: CachedConv): CachedConv {
  if (conv.rows.length === 0) return conv;
  const rowSizes = conv.rows.map((r) => JSON.stringify(r).length);
  const envelopeOverhead = JSON.stringify({ ...conv, rows: [] }).length;
  let total = envelopeOverhead;
  let keepFrom = conv.rows.length;
  for (let i = conv.rows.length - 1; i >= 0; i--) {
    total += rowSizes[i] + 1; // +1 for the array-element separator
    if (total > MAX_CONV_SERIALIZED_BYTES) break;
    keepFrom = i;
  }
  return keepFrom > 0 ? { ...conv, rows: conv.rows.slice(keepFrom) } : conv;
}

/**
 * Returns the ACTUALLY-persisted (post-trim) `CachedConv` on success, so the
 * caller can keep the in-memory `warm` layer consistent with what's on disk.
 */
async function writeConvToDisk(b: string, conv: CachedConv): Promise<CachedConv | null> {
  const key = scopedKey(b);
  if (!key) return null;
  const trimmed = trimToByteBudget(conv);
  try {
    await storage.setItem(key, JSON.stringify(trimmed));
    return trimmed;
  } catch {
    return null;
  }
}

async function readIndex(): Promise<Record<string, number>> {
  const key = scopedKey(INDEX_BASE);
  if (!key) return {};
  try {
    const raw = await storage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function writeIndex(idx: Record<string, number>): Promise<void> {
  const key = scopedKey(INDEX_BASE);
  if (!key) return;
  try { await storage.setItem(key, JSON.stringify(idx)); } catch { /* best-effort */ }
}

/**
 * Serializes every read-modify-write of the shared LRU index. On web/desktop
 * `localStorage` is synchronous, so `readIndex()` -> mutate -> `writeIndex()`
 * is atomic for free. AsyncStorage is not: there are `await` suspension
 * points between the read and the write, and mobile genuinely runs two
 * conversations' persist effects concurrently (the bottom-tab navigator
 * keeps a Chat-tab channel AND a DM-tab conversation mounted at once, each
 * independently debouncing its own write) — two concurrent callers can read
 * the same index snapshot and the second writer silently clobbers the
 * first's entry. A clobbered entry can never be reached by `touch`'s LRU
 * trim or `evictOldestHalf` again, so the orphaned conversation blob (up to
 * `MAX_CONV_SERIALIZED_BYTES`) is never reclaimed by anything — not the LRU
 * cap (untracked) and not the TTL (`readConvFromDisk` only removes a blob on
 * a VERSION mismatch, never on expiry). Every index mutation in this module
 * (`touch`, the eviction path inside `writeCachedMessages`,
 * `clearCachedMessages`) goes through this lock.
 */
let indexQueue: Promise<unknown> = Promise.resolve();
function withIndexLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = indexQueue.then(fn, fn);
  indexQueue = next.then(() => undefined, () => undefined);
  return next;
}

/** Evict the oldest half of cached conversations (by last-touched time). Used both for the cross-conversation LRU cap and as a quota-exceeded recovery step. */
async function evictOldestHalf(idx: Record<string, number>): Promise<Record<string, number>> {
  const keys = Object.keys(idx).sort((a, b) => idx[a] - idx[b]);
  const evictCount = Math.max(1, Math.floor(keys.length / 2));
  const toEvict = keys.slice(0, evictCount);
  const next = { ...idx };
  for (const b of toEvict) {
    delete next[b];
    const key = scopedKey(b);
    if (key) { try { await storage.removeItem(key); } catch { /* best-effort */ } }
    warm.delete(b);
  }
  return next;
}

/**
 * Record a conversation as just-touched, LRU-evicting beyond
 * `MAX_CACHED_CONVERSATIONS`. Body factored out as `touchLocked` (assumes
 * the caller already holds `withIndexLock`) so `writeCachedMessages` can
 * run it in the SAME lock acquisition as its own `warm.set` — `withIndexLock`
 * is not reentrant (a nested call would deadlock, awaiting a queue it is
 * itself currently occupying), so a caller already inside the lock must
 * call `touchLocked` directly, never `touch`.
 */
async function touchLocked(b: string): Promise<void> {
  let idx = await readIndex();
  idx[b] = Date.now();
  const keys = Object.keys(idx);
  if (keys.length > MAX_CACHED_CONVERSATIONS) {
    keys.sort((x, y) => idx[x] - idx[y]);
    const toEvict = keys.slice(0, keys.length - MAX_CACHED_CONVERSATIONS);
    idx = { ...idx };
    for (const k of toEvict) {
      delete idx[k];
      const key = scopedKey(k);
      if (key) { try { await storage.removeItem(key); } catch { /* best-effort */ } }
      warm.delete(k);
    }
  }
  await writeIndex(idx);
}

/**
 * Read a conversation's cached messages, oldest first. Empty array on a
 * cold/corrupt/expired/absent cache — callers never need to special-case
 * "no cache". `nodeUrl` scopes alongside wallet, mirroring the app's
 * existing per-(node,wallet) cache-fallback precedent — keeps a node switch
 * from serving one node's history under another's.
 */
export async function readCachedMessages(kind: ConvKind, id: string | number | null | undefined, nodeUrl: string): Promise<any[]> {
  try {
    if (id === null || id === undefined || id === '' || !idLooksPlausible(id)) return [];
    const b = base(kind, id, nodeUrl);
    // No active wallet — there is no per-wallet data to read. Checked here
    // too (not just relied on implicitly via `scopedKey` returning `null`
    // inside `readConvFromDisk`), because `warm` is consulted FIRST and is
    // keyed by the base string alone, with no wallet awareness of its own.
    if (scopedKey(b) === null) return [];
    let conv = warm.get(b);
    if (!conv) {
      const fromDisk = await readConvFromDisk(b);
      if (fromDisk) { conv = fromDisk; warm.set(b, conv); }
    }
    if (!conv) return [];
    return conv.rows.map(fromCacheRow).filter((r) => r !== null);
  } catch {
    return [];
  }
}

/**
 * Persist `messages` (any shape — optimistic/local rows, duplicates, and
 * oversized/malformed payloads are filtered and deduped) as this
 * conversation's cache, capped at `MAX_ROWS_PER_CONV`, keeping the newest
 * rows. Safe to call often; callers should still debounce on a hot path
 * (e.g. every WS message) rather than calling this on every state update.
 *
 * Callers MUST have already filtered `messages` down to rows that actually
 * belong to `(kind, id)` — this function does not know a channel/DM's
 * identity and cannot detect a stale, previous-conversation's messages
 * being passed in during a fast switch.
 */
/**
 * `ownerWallet` MUST be the wallet the CALLER captured at the moment
 * `messages` was known to be current for it (e.g. `getWalletScope()` read
 * at the same time a debounced write was armed) — NOT re-read here at call
 * time. This function re-checks it against the ACTIVE wallet both before
 * touching storage and again right before updating `warm`/the LRU index,
 * and bails silently on a mismatch. See the module doc comment for why:
 * a write can be armed by one screen instance and only actually execute
 * (a debounce timer firing, or an unmount flush) after an account switch
 * has already moved the active wallet on — without this check, that write
 * lands under the NEW wallet's scope with the OLD wallet's content.
 */
export async function writeCachedMessages(kind: ConvKind, id: string | number | null | undefined, messages: any[], nodeUrl: string, ownerWallet: string | null): Promise<void> {
  if (id === null || id === undefined || id === '' || !idLooksPlausible(id)) return;
  const b = base(kind, id, nodeUrl);
  if (scopedKey(b) === null) return;
  if (getWalletScope() !== ownerWallet) return;
  // Dedupe + sort + cap the RAW messages FIRST, and only project the
  // surviving <= MAX_ROWS_PER_CONV rows through `toCacheRow` — base64
  // encoding a payload is the expensive part (matches web/desktop's
  // round-4 re-audit ordering fix for the same shape).
  const byId = new Map<string, any>();
  for (const m of messages) {
    if (isOptimistic(m)) continue;
    const mid = msgIdOf(m);
    if (mid) byId.set(mid, m);
  }
  // `typeof === 'number'` matches `toCacheRow`'s own timestamp
  // normalization exactly — a drift between the two here would sort a
  // bogus/non-numeric timestamp by its coerced value in one place and by
  // `0` in the other, letting it displace a legitimate row from the cap.
  const tsOf = (m: any): number => typeof m?.timestamp === 'number' ? m.timestamp : 0;
  const rawRows = Array.from(byId.values()).sort((x, y) => tsOf(x) - tsOf(y));
  const cappedRaw = rawRows.length > MAX_ROWS_PER_CONV ? rawRows.slice(-MAX_ROWS_PER_CONV) : rawRows;
  const rows: CachedRow[] = [];
  for (const m of cappedRaw) {
    const row = toCacheRow(m);
    if (row) rows.push(row);
  }
  const conv: CachedConv = { v: CACHE_VERSION, cachedAt: Date.now(), rows };
  let persisted = await writeConvToDisk(b, conv);
  if (!persisted) {
    // Quota exceeded (or similar) even after this conversation's own
    // byte-budget self-trim — evict the oldest half of OTHER conversations
    // and retry once, then give up silently. Rate-limited: if eviction
    // can't actually fix the failure, retrying it on every debounced write
    // would otherwise repeatedly destroy every OTHER cached conversation
    // for no benefit. A message cache is a paint optimization; losing one
    // write is never worth surfacing an error to the user.
    const now = Date.now();
    if (now - lastEvictionAttemptAt >= MIN_EVICTION_INTERVAL_MS) {
      lastEvictionAttemptAt = now;
      await withIndexLock(async () => {
        const idx = await readIndex();
        await writeIndex(await evictOldestHalf(idx));
      });
      // Re-checked HERE too (round-2 re-audit finding), not just at entry
      // and again below: `withIndexLock` can queue behind arbitrarily many
      // OTHER wallets'/conversations' pending index operations, so this is
      // a real, possibly-long suspension point the wallet can move during —
      // not just the narrow "flip happened before the call even started"
      // window the entry check covers. Skipping the retry on a mismatch
      // also protects the JUST-EVICTED-FOR wallet: `evictOldestHalf` above
      // ran against whatever wallet was active at ITS OWN call time, and if
      // that's now a DIFFERENT (arriving) wallet, letting the retry proceed
      // would write the departing wallet's content into the arriving
      // wallet's freshly-evicted space.
      if (getWalletScope() !== ownerWallet) return;
      persisted = await writeConvToDisk(b, conv);
    }
  }
  // `warm.set` + the hard bound + `touchLocked` all run inside ONE
  // `withIndexLock` acquisition (round-2 re-audit finding): `warm.set` was
  // previously unlocked, so a `clearCachedMessages` call that ran (and
  // completed) IN BETWEEN this point and the old separate `touch(b)` call
  // below could have its own `warm.delete(b)` overwritten right back by
  // this write's `warm.set(b, ...)` landing after — resurrecting exactly
  // what the clear was supposed to remove. Locking the two together makes
  // whichever of "clear" or "this write" actually runs LAST the one that
  // wins, deterministically, instead of racing on `warm` outside the lock
  // while only the disk-index halves of each operation were serialized.
  await withIndexLock(async () => {
    // Re-checked here (not just at entry above): the active wallet could
    // have moved DURING the awaits above (the eviction-and-retry path in
    // particular does several) OR while queued behind other operations on
    // this very lock. Aborting before `warm.set` matters independently of
    // whether the disk write itself already landed under the wrong scope —
    // it stops this call from ALSO repopulating `warm` for a key
    // `registerWalletSwitchReset` may have just cleared, which is what let
    // the leak keep painting without even hitting disk.
    if (getWalletScope() !== ownerWallet) return;
    // `warm` is set to whatever ACTUALLY got persisted (the trimmed
    // version) whenever the write succeeds, keeping the in-memory layer
    // consistent with disk. On total failure, `warm` deliberately falls
    // back to the fuller pre-trim `conv` rather than nothing — the rows are
    // still capped to `MAX_ROWS_PER_CONV` and are the same ones already on
    // screen, so the cache's core revalidation invariant is untouched.
    warm.set(b, persisted ?? conv);
    // Hard, unconditional bound on `warm` itself, on top of `touchLocked`
    // below — if AsyncStorage is entirely unwritable (a near-zero quota, or
    // already exhausted by non-cache data), `writeIndex` silently fails
    // every time too, the index is never recorded, and `warm` would
    // otherwise grow without bound. Oldest-first (Map iteration is
    // insertion order) — a coarser bound than the index-based one, but one
    // that doesn't depend on any disk write succeeding at all.
    while (warm.size > MAX_CACHED_CONVERSATIONS) {
      const oldest = warm.keys().next().value;
      if (oldest === undefined) break;
      warm.delete(oldest);
    }
    // ALWAYS touch, regardless of whether `persisted` — `warm.set` above
    // runs unconditionally (by design), and `warm` is only ever pruned by
    // walking the LRU INDEX (`touchLocked`/`evictOldestHalf`); an entry
    // that's in `warm` but never in the index can never be evicted by
    // anything else.
    await touchLocked(b);
  });
}

/**
 * `true` when `e` is the SDK's `Error(\`API error (${status}): ${text}\`)`
 * for a 403 or 404 — i.e. access was actually revoked (removed from a
 * private channel, channel/DM deleted), not a transient network failure.
 * Anchored to the START of the message — an unanchored match could
 * false-positive on a response whose body text happens to mention a string
 * shaped like "API error (404)" despite the ACTUAL status being something
 * else, like a 500.
 */
export function isAccessRevokedError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e ?? '');
  return /^API error \((403|404)\)/.test(msg);
}

/** Remove one conversation's cache immediately — e.g. "leave channel", "hide DM", or a fetch that came back 403/404 (access revoked, so the cache must not keep painting content from before that). */
export async function clearCachedMessages(kind: ConvKind, id: string | number, nodeUrl: string): Promise<void> {
  const b = base(kind, id, nodeUrl);
  const key = scopedKey(b);
  if (key) { try { await storage.removeItem(key); } catch { /* best-effort */ } }
  // `warm.delete` runs INSIDE the same `withIndexLock` acquisition as the
  // index removal (round-2 re-audit finding) — and, critically, the same
  // lock `writeCachedMessages`'s own `warm.set`/`touchLocked` now runs
  // through. Previously `warm.delete` ran unlocked, so a concurrently
  // in-flight write (its own `storage.setItem` already past, only its
  // `warm.set`/index-touch still pending) could land AFTER this clear and
  // silently resurrect the just-cleared conversation in memory — exactly
  // the "leave/kick/delete didn't actually stick" bug this function exists
  // to prevent. With both operations sharing one lock, whichever of
  // "clear" or "write" is enqueued LAST deterministically wins, instead of
  // racing on `warm` outside any serialization.
  await withIndexLock(async () => {
    warm.delete(b);
    const idx = await readIndex();
    if (b in idx) { delete idx[b]; await writeIndex(idx); }
  });
}

/**
 * Reconcile a cached snapshot against a FRESH, unconditional (non-`after`)
 * page fetch. `requestedLimit` is the `limit` that fetch was made with —
 * used to tell "the server returned a full page with zero overlap" (the
 * cache is older than everything the server just sent — DISCARD it) apart
 * from "the server returned a short/empty page with zero overlap" (there
 * simply isn't more history yet; keep the cache as-is via the merge branch,
 * where empty `fresh` is a no-op union).
 *
 * On any id present in both: `fresh` wins WHOLESALE, never a field-level
 * merge — a field merge could resurrect a cached `payload` for a message
 * the server now returns with `deleted: true`.
 *
 * Callers MUST ensure `fresh` actually belongs to the SAME conversation
 * `cached` is for — a stale, superseded fetch result merged here would mix
 * one conversation's messages into another's cache. See each screen's
 * result-tagging (`{ channelId, ...resp }` / `{ peer, ...resp }`) for how
 * that's guarded, given `useApi` itself retains the previous result during
 * a refetch with no built-in staleness guard.
 */
export function mergeMessages(cached: any[], fresh: any[], requestedLimit: number): any[] {
  const freshIds = new Set<string>();
  for (const m of fresh) { const id = msgIdOf(m); if (id) freshIds.add(id); }
  let overlap = false;
  for (const m of cached) {
    const id = msgIdOf(m);
    if (id && freshIds.has(id)) { overlap = true; break; }
  }

  let result: any[];
  if (!overlap && fresh.length >= requestedLimit) {
    // Copy rather than alias `fresh` — callers may hold this array in React
    // state elsewhere; sorting in place below must not mutate their copy.
    result = [...fresh];
  } else {
    const byId = new Map<string, any>();
    for (const m of cached) { const id = msgIdOf(m); if (id) byId.set(id, m); }
    for (const m of fresh) { const id = msgIdOf(m); if (id) byId.set(id, m); }
    result = Array.from(byId.values());
  }
  result.sort((a, b) => (a?.timestamp ?? 0) - (b?.timestamp ?? 0));
  return result.length > MAX_ROWS_PER_CONV ? result.slice(-MAX_ROWS_PER_CONV) : result;
}
