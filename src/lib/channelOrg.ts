/**
 * Channel organization — user-defined groups + custom ordering for the channel list.
 *
 * Port of web/desktop's `channel-org.ts`. The *structure* (groups, names, group
 * order, channel→group assignment, custom per-bucket channel order) is synced
 * across the user's devices through the existing encrypted `SettingsSync` blob
 * (see `settingsSync.ts`). Ephemeral view-state — which group is collapsed — is
 * kept LOCAL per device (AsyncStorage) and never synced.
 *
 * The L2 node never sees plaintext (the blob is E2E-encrypted) and stores it as
 * a dumb last-writer-wins value, so cross-device conflicts are resolved here on
 * the client by the `updatedAt` high-water mark: a remote org is applied only
 * when it is strictly newer than the local one (see `applyRemoteOrg`).
 *
 * Unlike web (SolidJS signal over synchronous localStorage), AsyncStorage is
 * async, so this module keeps an in-memory cache hydrated once via
 * `ensureChannelOrgLoaded()` (same pattern as `prices.ts`'s `memForex` cache).
 * After hydration, all mutation functions are synchronous over the cache and
 * persist to AsyncStorage best-effort (fire-and-forget), matching web's API
 * shape so callers don't need to await every mutation.
 */

import { scopedGet, scopedSet, registerWalletSwitchReset } from './walletScope';

/** A user-created group. Render order = position in `ChannelOrg.groups`. */
export interface ChannelGroup {
  /** Stable id (crypto.randomUUID-style); placements reference this, not the name. */
  id: string;
  name: string;
}

/** Where a channel sits. Absent placement = ungrouped + alphabetical (default). */
export interface ChannelPlacement {
  /** Owning group id, or null for the ungrouped bucket. */
  groupId: string | null;
  /** Sort index within its bucket. Lower = higher in the list. */
  order: number;
}

/** The full synced organization payload (one object inside the settings blob). */
export interface ChannelOrg {
  /** Schema version — guards future migrations. */
  v: number;
  /** ms epoch of the last local edit; the client LWW key for sync. */
  updatedAt: number;
  groups: ChannelGroup[];
  /** channel_id → placement. */
  placements: Record<number, ChannelPlacement>;
}

/** Channel shape the resolver needs. */
export interface OrgChannel {
  channel_id: number;
  slug: string;
  display_name?: string;
  channel_type?: number;
  creator?: string;
  logo_cid?: string;
  description?: string;
}

export const CHANNEL_ORG_VERSION = 1;

// Namespaced per wallet (walletScope.ts). This is the third object in the
// cross-device settings blob alongside hiddenDms and topicGroups; leaving it
// global meant one account's channel groups and ordering rendered for the
// next, and settingsSync would then re-upload them under the new wallet.
const STORAGE_KEY = 'ogmara.channelOrg';
// Scoped too: the collapsed-group view state is device-local, but it
// references group ids that are per-account, so a global key would apply one
// account's collapse state to another's groups.
const COLLAPSE_KEY = 'ogmara.groupCollapsed';

/**
 * Collapse-state key for the ungrouped bucket. It has no real group id (a
 * placement's `groupId` is `null` for it), but `isGroupCollapsed`/
 * `toggleGroupCollapsed` are keyed by plain string, so a sentinel lets it
 * collapse exactly like a real group. Matches the `__ungrouped__` sentinel
 * desktop/web already use for their drag-and-drop drop-bucket id.
 */
export const UNGROUPED_GROUP_ID = '__ungrouped__';

/** Default channel always pinned at the top of the list, never grouped. */
export const DEFAULT_CHANNEL_SLUG = 'ogmara';

// Bounds — keep the synced blob small and reject abusive input. The settings
// blob is hard-capped at 1 MiB on the node; these limits keep us far below it.
const MAX_GROUPS = 50;
const MAX_GROUP_NAME = 32;
// Far above any realistic joined-channel count; bounds a corrupt/oversized blob
// the same way MAX_GROUPS bounds the group array.
const MAX_PLACEMENTS = 2000;

/** An empty, zero-config organization → pure alphabetical, no groups. */
export function emptyOrg(): ChannelOrg {
  return { v: CHANNEL_ORG_VERSION, updatedAt: 0, groups: [], placements: {} };
}

function sanitizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
}

/** Simple random id — group ids are just stable local keys, not security-sensitive. */
function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Coerce arbitrary parsed JSON into a valid ChannelOrg (defensive). */
function normalizeOrg(raw: unknown): ChannelOrg {
  const org = emptyOrg();
  if (!raw || typeof raw !== 'object') return org;
  const r = raw as Record<string, unknown>;
  if (typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt)) {
    org.updatedAt = r.updatedAt;
  }
  if (Array.isArray(r.groups)) {
    const seen = new Set<string>();
    for (const g of r.groups as unknown[]) {
      if (!g || typeof g !== 'object') continue;
      const id = (g as Record<string, unknown>).id;
      const nm = (g as Record<string, unknown>).name;
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      org.groups.push({ id, name: sanitizeName(typeof nm === 'string' ? nm : '') });
      if (org.groups.length >= MAX_GROUPS) break;
    }
  }
  const validGroupIds = new Set(org.groups.map((g) => g.id));
  if (r.placements && typeof r.placements === 'object') {
    let count = 0;
    for (const [k, v] of Object.entries(r.placements as Record<string, unknown>)) {
      if (count >= MAX_PLACEMENTS) break; // bound a corrupt/oversized blob
      // Only integer-coercible keys reach the assignment — "__proto__",
      // "constructor", etc. coerce to NaN and are skipped, so there is no
      // prototype-pollution path (and the target is a fresh object literal).
      const cid = Number(k);
      if (!Number.isInteger(cid) || !v || typeof v !== 'object') continue;
      const pv = v as Record<string, unknown>;
      const order = typeof pv.order === 'number' && Number.isFinite(pv.order) ? pv.order : 0;
      let groupId = typeof pv.groupId === 'string' ? pv.groupId : null;
      // A placement that references a since-deleted group falls back to ungrouped.
      if (groupId !== null && !validGroupIds.has(groupId)) groupId = null;
      org.placements[cid] = { groupId, order };
      count++;
    }
  }
  return org;
}

// --- In-memory cache, hydrated once from AsyncStorage ---------------------

let cache: ChannelOrg = emptyOrg();
let loadPromise: Promise<ChannelOrg> | null = null;

/** Hydrate the in-memory cache from per-wallet storage. Safe to call repeatedly —
 *  only reads storage once. Call before the first `getChannelOrg()` read. */
export function ensureChannelOrgLoaded(): Promise<ChannelOrg> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await scopedGet(STORAGE_KEY);
        cache = raw ? normalizeOrg(JSON.parse(raw)) : emptyOrg();
      } catch {
        cache = emptyOrg();
      }
      return cache;
    })();
  }
  return loadPromise;
}

/** Read the current organization (sync snapshot of the in-memory cache). */
export function getChannelOrg(): ChannelOrg {
  return cache;
}

/**
 * Persist a new organization to the cache, stamp `updatedAt`, best-effort
 * write to AsyncStorage, and schedule a debounced cross-device sync upload.
 * `fromRemote` skips the upload (we just received it) and keeps the remote
 * `updatedAt`.
 */
function commitOrg(next: ChannelOrg, fromRemote = false): void {
  const org: ChannelOrg = {
    v: CHANNEL_ORG_VERSION,
    updatedAt: fromRemote ? next.updatedAt : Date.now(),
    groups: next.groups.slice(0, MAX_GROUPS),
    placements: next.placements,
  };
  cache = org;
  scopedSet(STORAGE_KEY, JSON.stringify(org)).catch(() => { /* best-effort */ });
  if (!fromRemote) scheduleUpload();
}

// --- Mutations ------------------------------------------------------------

/** Create a group and return its id. */
export function createGroup(name: string): string {
  const org = getChannelOrg();
  if (org.groups.length >= MAX_GROUPS) return '';
  const id = randomId();
  commitOrg({ ...org, groups: [...org.groups, { id, name: sanitizeName(name) }] });
  return id;
}

/** Rename a group; ignored if the name is empty after sanitizing. */
export function renameGroup(id: string, name: string): void {
  const clean = sanitizeName(name);
  if (!clean) return;
  const org = getChannelOrg();
  commitOrg({
    ...org,
    groups: org.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)),
  });
}

/** Delete a group; its channels fall back to ungrouped + alphabetical. */
export function deleteGroup(id: string): void {
  const org = getChannelOrg();
  const placements: Record<number, ChannelPlacement> = {};
  for (const [k, p] of Object.entries(org.placements)) {
    if (p.groupId === id) continue; // drop placement → back to alphabetical ungrouped
    placements[Number(k)] = p;
  }
  commitOrg({ ...org, groups: org.groups.filter((g) => g.id !== id), placements });
}

/** Reorder groups to match the given id order (ids not present are appended). */
export function reorderGroups(orderedIds: string[]): void {
  const org = getChannelOrg();
  const byId = new Map(org.groups.map((g) => [g.id, g]));
  const next: ChannelGroup[] = [];
  for (const id of orderedIds) {
    const g = byId.get(id);
    if (g) { next.push(g); byId.delete(id); }
  }
  for (const g of byId.values()) next.push(g); // safety: keep any leftovers
  commitOrg({ ...org, groups: next });
}

/** Move a group up or down by one position in the render order. */
export function moveGroup(id: string, direction: 'up' | 'down'): void {
  const org = getChannelOrg();
  const ids = org.groups.map((g) => g.id);
  const idx = ids.indexOf(id);
  if (idx < 0) return;
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= ids.length) return;
  [ids[idx], ids[swapWith]] = [ids[swapWith], ids[idx]];
  reorderGroups(ids);
}

/**
 * Materialize the exact order of one bucket (`groupId` = null for ungrouped).
 * Every listed channel gets an explicit placement, pinning the given order.
 * Channels not listed keep their existing placement.
 *
 * Note: `orderedChannelIds` is whatever the calling device currently has
 * joined/visible in that bucket. If another device has joined a superset of
 * channels in the same group, its untouched members can end up sharing an
 * `order` value with a renumbered one here — rendering still stays
 * deterministic (alpha tiebreak in `resolveChannelLayout`), but the intended
 * cross-device order can drift. Same limitation as the ported web design.
 */
export function setBucketOrder(groupId: string | null, orderedChannelIds: number[]): void {
  const org = getChannelOrg();
  const placements = { ...org.placements };
  orderedChannelIds.forEach((cid, i) => {
    placements[cid] = { groupId, order: i };
  });
  commitOrg({ ...org, placements });
}

/** Move a single channel up or down within its current bucket. */
export function moveChannel(channelId: number, bucketOrder: number[], direction: 'up' | 'down'): void {
  const idx = bucketOrder.indexOf(channelId);
  if (idx < 0) return;
  const swapWith = direction === 'up' ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= bucketOrder.length) return;
  const next = [...bucketOrder];
  [next[idx], next[swapWith]] = [next[swapWith], next[idx]];
  const groupId = getChannelOrg().placements[channelId]?.groupId ?? null;
  setBucketOrder(groupId, next);
}

/**
 * Move a single channel into a group (or out to ungrouped with `null`),
 * appended at the end of the target bucket. Used by the "Move to group" menu.
 */
export function assignChannel(channelId: number, groupId: string | null): void {
  const org = getChannelOrg();
  let maxOrder = -1;
  for (const p of Object.values(org.placements)) {
    if (p.groupId === groupId && p.order > maxOrder) maxOrder = p.order;
  }
  commitOrg({
    ...org,
    placements: { ...org.placements, [channelId]: { groupId, order: maxOrder + 1 } },
  });
}

/** Drop a channel's custom placement → returns it to ungrouped + alphabetical. */
export function clearPlacement(channelId: number): void {
  const org = getChannelOrg();
  if (!(channelId in org.placements)) return;
  const placements = { ...org.placements };
  delete placements[channelId];
  commitOrg({ ...org, placements });
}

/**
 * "Sort A–Z" reset: clear ALL custom channel ordering/placement but KEEP the
 * groups themselves. Every channel returns to its group's alphabetical default
 * (or ungrouped if it had no group). Groups stay so the user keeps their
 * structure; only manual ordering is wiped.
 */
export function resetToAlphabetical(): void {
  const org = getChannelOrg();
  commitOrg({ ...org, placements: {} });
}

// --- Remote sync ------------------------------------------------------------

/**
 * Apply an organization received from another device. Last-writer-wins by
 * `updatedAt`; on an exact-millisecond tie, a deterministic content comparison
 * picks the same winner on every device so they still converge (and never
 * ping-pong, since a remote apply does not re-upload). Returns the channel ids
 * placed in the incoming org so the caller can auto-join them — a synced
 * placement implies the channel should be visible on this device.
 */
export function applyRemoteOrg(raw: unknown): number[] {
  const remote = normalizeOrg(raw);
  const local = getChannelOrg();
  if (remote.updatedAt < local.updatedAt) return [];
  if (remote.updatedAt === local.updatedAt) {
    // Tie-break deterministically; skip if local already is (or outranks) remote.
    if (JSON.stringify(remote) <= JSON.stringify(local)) return [];
  }
  commitOrg(remote, /* fromRemote */ true);
  return Object.keys(remote.placements).map(Number).filter(Number.isInteger);
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

// --- Local per-device collapse state (NOT synced) --------------------------

let collapsedCache: Record<string, boolean> = {};
let collapsedLoadPromise: Promise<Record<string, boolean>> | null = null;

function ensureCollapsedLoaded(): Promise<Record<string, boolean>> {
  if (!collapsedLoadPromise) {
    collapsedLoadPromise = (async () => {
      try {
        const raw = await scopedGet(COLLAPSE_KEY);
        const v = raw ? JSON.parse(raw) : {};
        collapsedCache = v && typeof v === 'object' ? v : {};
      } catch {
        collapsedCache = {};
      }
      return collapsedCache;
    })();
  }
  return collapsedLoadPromise;
}

/** Hydrate collapsed-group state. Call once alongside `ensureChannelOrgLoaded()`. */
export async function ensureCollapsedStateLoaded(): Promise<void> {
  await ensureCollapsedLoaded();
}

/** Whether a group is currently collapsed on this device. */
export function isGroupCollapsed(id: string): boolean {
  return collapsedCache[id] === true;
}

/** Toggle a group's collapsed state (local only — never synced). */
export function toggleGroupCollapsed(id: string): void {
  const next = { ...collapsedCache, [id]: !isGroupCollapsed(id) };
  collapsedCache = next;
  scopedSet(COLLAPSE_KEY, JSON.stringify(next)).catch(() => { /* ignore */ });
}

// --- Layout resolver ---------------------------------------------------------

/** A resolved group with its ordered channels. Generic so callers keep their
 *  concrete channel type (e.g. the SDK's richer `Channel`) instead of the
 *  minimal `OrgChannel` shape the resolver actually needs. */
export interface ResolvedGroup<C extends OrgChannel = OrgChannel> {
  group: ChannelGroup;
  channels: C[];
}

/** The full ordered layout produced from channels + organization. */
export interface ChannelLayout<C extends OrgChannel = OrgChannel> {
  /** The pinned default channel, rendered first (if joined). */
  defaultChannel: C | null;
  groups: ResolvedGroup<C>[];
  ungrouped: C[];
}

function alpha(a: OrgChannel, b: OrgChannel): number {
  return (a.display_name || a.slug).localeCompare(b.display_name || b.slug, undefined, {
    sensitivity: 'base',
  });
}

/**
 * Produce the ordered channel-list layout. Rules:
 *  1. The default channel is pinned first, never grouped.
 *  2. Groups render in `org.groups` order; channels within a group by their
 *     placement `order`.
 *  3. Ungrouped channels: those with an explicit placement first (by `order`),
 *     then the rest alphabetically — so a fresh, un-customized list is purely
 *     alphabetical (requirement: alphabetical by default).
 */
export function resolveChannelLayout<C extends OrgChannel>(channels: C[], org: ChannelOrg): ChannelLayout<C> {
  const groups: ResolvedGroup<C>[] = org.groups.map((g) => ({ group: g, channels: [] as C[] }));
  const groupIndex = new Map(groups.map((rg) => [rg.group.id, rg]));

  let defaultChannel: C | null = null;
  const ungroupedPinned: { ch: C; order: number }[] = [];
  const ungroupedAuto: C[] = [];

  for (const ch of channels) {
    if (ch.slug === DEFAULT_CHANNEL_SLUG) { defaultChannel = ch; continue; }
    const p = org.placements[ch.channel_id];
    if (p && p.groupId && groupIndex.has(p.groupId)) {
      groupIndex.get(p.groupId)!.channels.push(ch);
    } else if (p && p.groupId === null) {
      ungroupedPinned.push({ ch, order: p.order });
    } else {
      ungroupedAuto.push(ch);
    }
  }

  // Within each group, order by placement.order (fall back to alpha for ties).
  for (const rg of groups) {
    rg.channels.sort((a, b) => {
      const oa = org.placements[a.channel_id]?.order ?? 0;
      const ob = org.placements[b.channel_id]?.order ?? 0;
      return oa !== ob ? oa - ob : alpha(a, b);
    });
  }

  ungroupedPinned.sort((a, b) => (a.order !== b.order ? a.order - b.order : alpha(a.ch, b.ch)));
  ungroupedAuto.sort(alpha);

  return {
    defaultChannel,
    groups,
    ungrouped: [...ungroupedPinned.map((x) => x.ch), ...ungroupedAuto],
  };
}

/**
 * Drop all in-memory state for the current account.
 *
 * Namespacing the STORAGE was not enough on its own: `loadPromise` memoizes
 * for the life of the process, so after a wallet switch the previous
 * account's channel organization would still render — and the first edit would
 * persist it under the NEW wallet and sync it to the node. Called from
 * `setWalletScope` on every scope change.

 * Also cancels any debounced upload: a timer armed just before a switch would
 * otherwise fire afterwards and encrypt the old account's data with the new
 * account's key.
 */
export function resetForWalletSwitch(): void {
  cache = emptyOrg();
  loadPromise = null;
  if (uploadTimer) {
    clearTimeout(uploadTimer);
    uploadTimer = null;
  }
}

// Cleared synchronously whenever the active wallet changes.
registerWalletSwitchReset(resetForWalletSwitch);
