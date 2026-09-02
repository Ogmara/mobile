/**
 * Followed news topics — hashtags the user follows, optionally organized into
 * named subgroups. Port of web/desktop's `topic-groups.ts`.
 *
 * The object is carried inside the existing encrypted `SettingsSync` blob (see
 * `settingsSync.ts`); the L2 node stores it as an opaque last-writer-wins
 * value, and cross-device conflicts are resolved here by the `updatedAt`
 * high-water mark (a remote copy is applied only when strictly newer, and a
 * remote apply never re-uploads).
 *
 * Same async-cache shape as `channelOrg.ts`: hydrate once via
 * `ensureTopicGroupsLoaded()`, then all mutations are synchronous over the
 * in-memory cache and persist to AsyncStorage best-effort. A tiny listener set
 * lets a screen re-render on change (`subscribeTopicGroups`).
 *
 * Every hashtag is stored in the node's canonical form (`normalizeHashtag`,
 * protocol §3.5) — a follow that normalizes differently would match nothing.
 */

import { scopedGet, scopedSet, registerWalletSwitchReset } from './walletScope';
import { normalizeHashtag } from '@ogmara/sdk';

export interface TopicGroup {
  id: string;
  name: string;
  /** Canonical hashtags in this group — a subset of `follows`. */
  tags: string[];
}

export interface TopicGroups {
  v: number;
  updatedAt: number;
  follows: string[];
  groups: TopicGroup[];
}

export const TOPIC_GROUPS_VERSION = 1;
// Namespaced per wallet (walletScope.ts) — this is account state, and a
// global key meant the previous account's data stayed on screen after a
// wallet switch.
const STORAGE_KEY = 'ogmara.topicGroups';

const MAX_FOLLOWS = 200;
const MAX_GROUPS = 20;
const MAX_TAGS_PER_GROUP = 50;
const MAX_GROUP_NAME = 32;

export function emptyTopicGroups(): TopicGroups {
  return { v: TOPIC_GROUPS_VERSION, updatedAt: 0, follows: [], groups: [] };
}

function sanitizeName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_GROUP_NAME);
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cleanTags(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    if (typeof t !== 'string') continue;
    const n = normalizeHashtag(t);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= max) break;
  }
  return out;
}

function normalize(raw: unknown): TopicGroups {
  const tg = emptyTopicGroups();
  if (!raw || typeof raw !== 'object') return tg;
  const r = raw as Record<string, unknown>;
  if (typeof r.updatedAt === 'number' && Number.isFinite(r.updatedAt)) tg.updatedAt = r.updatedAt;
  tg.follows = cleanTags(r.follows, MAX_FOLLOWS);
  const followSet = new Set(tg.follows);
  if (Array.isArray(r.groups)) {
    const seen = new Set<string>();
    for (const g of r.groups as unknown[]) {
      if (!g || typeof g !== 'object') continue;
      const gr = g as Record<string, unknown>;
      if (typeof gr.id !== 'string' || seen.has(gr.id)) continue;
      seen.add(gr.id);
      tg.groups.push({
        id: gr.id,
        name: sanitizeName(typeof gr.name === 'string' ? gr.name : ''),
        tags: cleanTags(gr.tags, MAX_TAGS_PER_GROUP).filter((x) => followSet.has(x)),
      });
      if (tg.groups.length >= MAX_GROUPS) break;
    }
  }
  return tg;
}

// --- In-memory cache + listeners --------------------------------------

let cache: TopicGroups = emptyTopicGroups();
let loadPromise: Promise<TopicGroups> | null = null;
const listeners = new Set<() => void>();

export function ensureTopicGroupsLoaded(): Promise<TopicGroups> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await scopedGet(STORAGE_KEY);
        cache = raw ? normalize(JSON.parse(raw)) : emptyTopicGroups();
      } catch {
        cache = emptyTopicGroups();
      }
      return cache;
    })();
  }
  return loadPromise;
}

export function getTopicGroups(): TopicGroups {
  return cache;
}

/** Subscribe to changes (mutations + remote applies). Returns an unsubscribe. */
export function subscribeTopicGroups(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function topicCaps() {
  return {
    follows: { count: cache.follows.length, max: MAX_FOLLOWS, full: cache.follows.length >= MAX_FOLLOWS },
    groups: { count: cache.groups.length, max: MAX_GROUPS, full: cache.groups.length >= MAX_GROUPS },
    maxTagsPerGroup: MAX_TAGS_PER_GROUP,
  };
}

function commit(next: TopicGroups, fromRemote = false): void {
  cache = {
    v: TOPIC_GROUPS_VERSION,
    updatedAt: fromRemote ? next.updatedAt : Date.now(),
    follows: next.follows.slice(0, MAX_FOLLOWS),
    groups: next.groups.slice(0, MAX_GROUPS),
  };
  scopedSet(STORAGE_KEY, JSON.stringify(cache)).catch(() => {});
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
  if (!fromRemote) scheduleUpload();
}

// --- Mutations ------------------------------------------------------

export function followTag(raw: string): void {
  const n = normalizeHashtag(raw);
  if (!n) return;
  if (cache.follows.includes(n) || cache.follows.length >= MAX_FOLLOWS) return;
  commit({ ...cache, follows: [...cache.follows, n] });
}

export function unfollowTag(raw: string): void {
  const n = normalizeHashtag(raw);
  if (!n || !cache.follows.includes(n)) return;
  commit({
    ...cache,
    follows: cache.follows.filter((t) => t !== n),
    groups: cache.groups.map((g) => ({ ...g, tags: g.tags.filter((t) => t !== n) })),
  });
}

export function isFollowing(raw: string): boolean {
  const n = normalizeHashtag(raw);
  return !!n && cache.follows.includes(n);
}

export function createGroup(name: string): string {
  if (cache.groups.length >= MAX_GROUPS) return '';
  const id = randomId();
  commit({ ...cache, groups: [...cache.groups, { id, name: sanitizeName(name), tags: [] }] });
  return id;
}

export function renameGroup(id: string, name: string): void {
  const clean = sanitizeName(name);
  if (!clean) return;
  commit({ ...cache, groups: cache.groups.map((g) => (g.id === id ? { ...g, name: clean } : g)) });
}

export function deleteGroup(id: string): void {
  commit({ ...cache, groups: cache.groups.filter((g) => g.id !== id) });
}

export function addTagToGroup(groupId: string, raw: string): void {
  const n = normalizeHashtag(raw);
  if (!n) return;
  const follows = cache.follows.includes(n)
    ? cache.follows
    : cache.follows.length < MAX_FOLLOWS
      ? [...cache.follows, n]
      : cache.follows;
  if (!follows.includes(n)) return;
  commit({
    ...cache,
    follows,
    groups: cache.groups.map((g) =>
      g.id === groupId && !g.tags.includes(n) && g.tags.length < MAX_TAGS_PER_GROUP
        ? { ...g, tags: [...g.tags, n] }
        : g,
    ),
  });
}

export function removeTagFromGroup(groupId: string, raw: string): void {
  const n = normalizeHashtag(raw);
  if (!n) return;
  commit({
    ...cache,
    groups: cache.groups.map((g) => (g.id === groupId ? { ...g, tags: g.tags.filter((t) => t !== n) } : g)),
  });
}

// --- Resolvers ----------------------------------------------------

export function allFollowedTags(): string[] {
  return cache.follows;
}

export function tagsForGroup(id: string): string[] {
  return cache.groups.find((g) => g.id === id)?.tags ?? [];
}

// --- Remote sync ------------------------------------------------

export function applyRemoteTopicGroups(raw: unknown): void {
  const remote = normalize(raw);
  const local = cache;
  if (remote.updatedAt < local.updatedAt) return;
  if (remote.updatedAt === local.updatedAt) {
    if (JSON.stringify(remote) <= JSON.stringify(local)) return;
  }
  commit(remote, /* fromRemote */ true);
}

// --- Debounced upload -----------------------------------------

let uploadTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleUpload(): void {
  if (uploadTimer) clearTimeout(uploadTimer);
  uploadTimer = setTimeout(async () => {
    uploadTimer = null;
    try {
      const { uploadSettings } = await import('./settingsSync');
      await uploadSettings();
    } catch {
      /* best-effort; local copy already persisted */
    }
  }, 2500);
}

/**
 * Drop all in-memory state for the current account.
 *
 * Namespacing the STORAGE was not enough on its own: `loadPromise` memoizes
 * for the life of the process, so after a wallet switch the previous
 * account's topic groups would still render — and the first edit would
 * persist it under the NEW wallet and sync it to the node. Called from
 * `setWalletScope` on every scope change.

 * Also cancels any debounced upload: a timer armed just before a switch would
 * otherwise fire afterwards and encrypt the old account's data with the new
 * account's key.
 */
export function resetForWalletSwitch(): void {
  cache = emptyTopicGroups();
  loadPromise = null;
  if (uploadTimer) {
    clearTimeout(uploadTimer);
    uploadTimer = null;
  }
}

// Cleared synchronously whenever the active wallet changes.
registerWalletSwitchReset(resetForWalletSwitch);
