/**
 * Joined-channel tracking — persisted via AsyncStorage.
 *
 * New users only see the default "ogmara" channel. Other channels
 * appear after the user explicitly joins them via Search.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'ogmara_joined_channels';

/** Add a channel to the joined set. */
export async function addJoinedChannel(channelId: number): Promise<void> {
  const ids = await loadJoinedChannels();
  ids.add(channelId);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

/** Remove a channel from the joined set. */
export async function removeJoinedChannel(channelId: number): Promise<void> {
  const ids = await loadJoinedChannels();
  ids.delete(channelId);
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
}

/** Load the set of joined channel IDs from storage. */
export async function loadJoinedChannels(): Promise<Set<number>> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch { /* ignore */ }
  return new Set();
}

/** Check whether the joined-channel storage has been initialized. */
export async function isJoinedStorageInitialized(): Promise<boolean> {
  return (await AsyncStorage.getItem(STORAGE_KEY)) !== null;
}
