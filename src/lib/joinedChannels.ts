/**
 * Joined-channel tracking — persisted per wallet (see walletScope.ts).
 *
 * New users only see the default "ogmara" channel. Other channels
 * appear after the user explicitly joins them via Search.
 */

import { scopedGet, scopedSet } from './walletScope';

// Namespaced per wallet (walletScope.ts) — this is account state, and a
// global key meant the previous account's data stayed on screen after a
// wallet switch.
const STORAGE_KEY = 'ogmara_joined_channels';

/** Add a channel to the joined set. */
export async function addJoinedChannel(channelId: number): Promise<void> {
  const ids = await loadJoinedChannels();
  ids.add(channelId);
  await scopedSet(STORAGE_KEY, JSON.stringify([...ids]));
}

/** Add multiple channels to the joined set in a single read-modify-write. */
export async function addJoinedChannels(channelIds: number[]): Promise<void> {
  if (!channelIds.length) return;
  const ids = await loadJoinedChannels();
  for (const id of channelIds) ids.add(id);
  await scopedSet(STORAGE_KEY, JSON.stringify([...ids]));
}

/** Remove a channel from the joined set. */
export async function removeJoinedChannel(channelId: number): Promise<void> {
  const ids = await loadJoinedChannels();
  ids.delete(channelId);
  await scopedSet(STORAGE_KEY, JSON.stringify([...ids]));
}

/** Load the set of joined channel IDs from storage. */
export async function loadJoinedChannels(): Promise<Set<number>> {
  try {
    const raw = await scopedGet(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch { /* ignore */ }
  return new Set();
}

/** Check whether the joined-channel storage has been initialized. */
export async function isJoinedStorageInitialized(): Promise<boolean> {
  return (await scopedGet(STORAGE_KEY)) !== null;
}
