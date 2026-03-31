/**
 * User cache — local address-to-profile mapping.
 *
 * Caches display names and avatar CIDs for addresses we've seen.
 * Used to show usernames on posts/messages when the /users/:address
 * endpoint is not available. Own profile is always cached from settings.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const PREFIX = 'ogmara.user.';

export interface CachedUser {
  displayName: string | null;
  avatarCid: string | null;
  bio: string | null;
  lastUpdated: number;
}

/** Get cached user data for an address. */
export async function getCachedUser(address: string): Promise<CachedUser | null> {
  try {
    const raw = await AsyncStorage.getItem(PREFIX + address);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Cache user data for an address. */
export async function setCachedUser(address: string, data: Partial<CachedUser>): Promise<void> {
  const existing = await getCachedUser(address);
  const merged: CachedUser = {
    displayName: data.displayName ?? existing?.displayName ?? null,
    avatarCid: data.avatarCid ?? existing?.avatarCid ?? null,
    bio: data.bio ?? existing?.bio ?? null,
    lastUpdated: Date.now(),
  };
  await AsyncStorage.setItem(PREFIX + address, JSON.stringify(merged));
}

/** Resolve a display name for an address. Returns null if unknown. */
export async function resolveDisplayName(address: string): Promise<string | null> {
  const cached = await getCachedUser(address);
  return cached?.displayName ?? null;
}
