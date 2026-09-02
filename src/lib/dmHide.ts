/**
 * DM conversation hiding — "delete a conversation" from the user's own view.
 *
 * Port of web/desktop's `dm-hide.ts`. DMs are two-wallet; the other party's
 * copy shouldn't be affected, so this is a per-user "hide from my list"
 * action, not a destructive delete. Synced across the user's devices
 * through the existing encrypted `SettingsSync` blob (see `settingsSync.ts`)
 * — the L2 node never sees plaintext.
 *
 * A hidden conversation reappears if the peer sends a new message
 * afterward (`last_message_at` exceeds the hidden timestamp) — matches
 * "delete conversation" behavior in most messengers. There is no
 * "permanent block" here; that's a separate, unbuilt feature.
 *
 * Unlike web (SolidJS signal over synchronous localStorage), AsyncStorage is
 * async, so this module keeps an in-memory cache hydrated once via
 * `ensureHiddenDmsLoaded()` — same pattern as `channelOrg.ts`.
 */

import { scopedGet, scopedSet } from './walletScope';

/** peer wallet address → ms epoch when it was hidden. */
export type HiddenDms = Record<string, number>;

// Namespaced per wallet (walletScope.ts) — this is account state, and a
// global key meant the previous account's data stayed on screen after a
// wallet switch.
const STORAGE_KEY = 'ogmara.hiddenDms';

// Bounds — keep the synced blob small. Far above any realistic count of
// distinct DM peers a user would ever hide.
const MAX_HIDDEN_DMS = 500;

function emptyHidden(): HiddenDms {
  return {};
}

/** Coerce arbitrary parsed JSON into a valid HiddenDms map (defensive). */
function normalize(raw: unknown): HiddenDms {
  const out: HiddenDms = {};
  if (!raw || typeof raw !== 'object') return out;
  let count = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (count >= MAX_HIDDEN_DMS) break;
    // Only wallet-address-shaped keys reach the assignment — "__proto__",
    // "constructor", etc. don't start with "klv1" and are skipped, so there
    // is no prototype-pollution path (and the target is a fresh object literal).
    if (typeof k !== 'string' || !k.startsWith('klv1')) continue;
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    out[k] = v;
    count++;
  }
  return out;
}

let cache: HiddenDms = emptyHidden();
let loadPromise: Promise<HiddenDms> | null = null;

/** Hydrate the in-memory cache from per-wallet storage. Safe to call repeatedly —
 *  only reads storage once. Call before the first `getHiddenDms()` read. */
export function ensureHiddenDmsLoaded(): Promise<HiddenDms> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await scopedGet(STORAGE_KEY);
        cache = raw ? normalize(JSON.parse(raw)) : emptyHidden();
      } catch {
        cache = emptyHidden();
      }
      return cache;
    })();
  }
  return loadPromise;
}

/** Read the current hidden-DM map (sync snapshot of the in-memory cache). */
export function getHiddenDms(): HiddenDms {
  return cache;
}

/** Persist, cap to the most-recently-hidden `MAX_HIDDEN_DMS` entries, and
 *  schedule a debounced cross-device sync upload. `fromRemote` skips the
 *  upload (we just received it). */
function commit(next: HiddenDms, fromRemote = false): void {
  const capped: HiddenDms = Object.fromEntries(
    Object.entries(next)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_HIDDEN_DMS),
  );
  cache = capped;
  scopedSet(STORAGE_KEY, JSON.stringify(capped)).catch(() => { /* best-effort */ });
  if (!fromRemote) scheduleUpload();
}

/** Hide a DM conversation from the list (reappears on new activity from the peer). */
export function hideConversation(peer: string): void {
  commit({ ...getHiddenDms(), [peer]: Date.now() });
}

/** Whether a conversation should be hidden: no activity since it was hidden. */
export function isConversationHidden(peer: string, lastMessageAt: number): boolean {
  const hiddenAt = getHiddenDms()[peer];
  return hiddenAt !== undefined && lastMessageAt <= hiddenAt;
}

/**
 * Merge a hidden-DM map received from another device. Unlike `channelOrg`'s
 * whole-blob LWW, this needs no single `updatedAt` — hiding is monotonic per
 * peer, so the merge is just a per-key max(), which is commutative and
 * converges the same way regardless of merge order or device clock skew.
 */
export function applyRemoteHiddenDms(raw: unknown): void {
  const remote = normalize(raw);
  const local = getHiddenDms();
  const merged: HiddenDms = { ...local };
  for (const [peer, ts] of Object.entries(remote)) {
    if (!(peer in merged) || ts > merged[peer]) merged[peer] = ts;
  }
  commit(merged, /* fromRemote */ true);
}

// --- Debounced upload (decoupled to avoid an import cycle) -----------------

let uploadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleUpload(): void {
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(async () => {
    uploadTimer = null;
    try {
      // Dynamic import breaks the static cycle (settingsSync imports us back).
      const { uploadSettings } = await import('./settingsSync');
      await uploadSettings();
    } catch { /* best-effort; local copy already persisted */ }
  }, 2500);
}

/**
 * Drop all in-memory state for the current account.
 *
 * Namespacing the STORAGE was not enough on its own: `loadPromise` memoizes
 * for the life of the process, so after a wallet switch the previous
 * account's hidden DMs would still render — and the first edit would
 * persist it under the NEW wallet and sync it to the node. Called from
 * `setWalletScope` on every scope change.

 * Also cancels any debounced upload: a timer armed just before a switch would
 * otherwise fire afterwards and encrypt the old account's data with the new
 * account's key.
 */
export function resetForWalletSwitch(): void {
  cache = emptyHidden();
  loadPromise = null;
  if (uploadTimer) {
    clearTimeout(uploadTimer);
    uploadTimer = null;
  }
}
