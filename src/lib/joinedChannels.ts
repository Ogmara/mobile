/**
 * Joined-channel tracking — persisted per wallet (see walletScope.ts).
 *
 * New users only see the default "ogmara" channel. Other channels
 * appear after the user explicitly joins them via Search.
 */

import { scopedGet, scopedSet, scopedGetFor, scopedSetFor } from './walletScope';

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

/**
 * Add a channel to a SPECIFIC account's joined set (explicit address, not the
 * active scope). For async flows that capture the account at start: between a
 * caller's account check and `addJoinedChannel`'s own internal await, a switch
 * would otherwise land the write in the NEW account's namespace.
 */
export async function addJoinedChannelFor(address: string, channelId: number): Promise<void> {
  await addJoinedChannelsFor(address, [channelId]);
}

/**
 * Add multiple channels to a SPECIFIC account's joined set in one
 * read-modify-write (explicit address — see `addJoinedChannelFor`). Used by
 * settings sync, which applies a blob decrypted for a captured account.
 */
export async function addJoinedChannelsFor(address: string, channelIds: number[]): Promise<void> {
  if (!address || !channelIds.length) return;
  let ids = new Set<number>();
  try {
    const raw = await scopedGetFor(address, STORAGE_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr)) ids = new Set(arr);
  } catch { /* treat as empty */ }
  for (const id of channelIds) ids.add(id);
  await scopedSetFor(address, STORAGE_KEY, JSON.stringify([...ids]));
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
