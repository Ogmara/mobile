/**
 * Local settings persistence — AsyncStorage wrapper.
 *
 * Keys use the ogmara. prefix per spec 06-frontend.md section 4.1.
 * All settings are stored on-device, never on the server.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Default start screen options. */
export type StartScreen = 'news' | 'chat' | 'channels';

const KEYS = {
  lang: 'ogmara.lang',
  theme: 'ogmara.theme',
  startScreen: 'ogmara.default_start_screen',
  nodeUrl: 'ogmara.node_url',
  // Klever network the cold-boot SC node discovery targets. Persisted from the
  // connected node's /health.network; defaults to testnet during the testnet phase.
  kleverNetwork: 'ogmara.klever_network',
  // JSON array of node URLs the user has successfully switched to (picker memory).
  knownNodes: 'ogmara.known_nodes',
  // '1' when the user explicitly picked a node in the picker — auto best-ping
  // optimization then leaves their choice alone.
  nodePinned: 'ogmara.node_pinned',
  walletAddress: 'ogmara.wallet_address',
  walletSource: 'ogmara.wallet_source',
  deviceRegistered: 'ogmara.device_registered',
  notificationSound: 'ogmara.notification_sound',
  pushEnabled: 'ogmara.push_enabled',
  compactLayout: 'ogmara.compact_layout',
  fontSize: 'ogmara.font_size',
  pinnedChannels: 'ogmara.pinned_channels',
  mutedChannels: 'ogmara.muted_channels',
  mutedUsers: 'ogmara.muted_users',
  displayName: 'ogmara.display_name',
  bio: 'ogmara.bio',
  avatarCid: 'ogmara.avatar_cid',
  avatarLocalUri: 'ogmara.avatar_local_uri',
  mediaAutoload: 'ogmara.media_autoload',
  currency: 'ogmara.display_currency',
  // News Feed resume position — hex msg_id of the topmost visible post per feed
  // mode, plus a "last viewed" ms timestamp. Reopening within 24h restores the
  // anchor; idle > 24h opens at the newest post.
  newsLastReadAll: 'ogmara.news_last_read_all',
  newsLastReadFollowing: 'ogmara.news_last_read_following',
  newsLastViewedAt: 'ogmara.news_last_viewed_at',
  // E2E encryption (kept in a separate ogmara.e2e.* namespace so wallet-vault
  // migrations never touch these). deviceId/encKeyBound are public markers; the
  // device enc *private* key lives in SecureStore, not here.
  deviceId: 'ogmara.e2e.device_id',
  encKeyBound: 'ogmara.e2e.enc_key_bound',
  e2eDebug: 'ogmara.e2e.debug',
} as const;

/** Read a string setting. */
export async function getSetting(key: keyof typeof KEYS): Promise<string | null> {
  return AsyncStorage.getItem(KEYS[key]);
}

/** Write a string setting. */
export async function setSetting(key: keyof typeof KEYS, value: string): Promise<void> {
  await AsyncStorage.setItem(KEYS[key], value);
}

/** Read the default start screen (defaults to 'news'). */
export async function getStartScreen(): Promise<StartScreen> {
  const value = await AsyncStorage.getItem(KEYS.startScreen);
  if (value === 'chat' || value === 'channels') return value;
  return 'news';
}

/** Write the default start screen. */
export async function setStartScreen(screen: StartScreen): Promise<void> {
  await AsyncStorage.setItem(KEYS.startScreen, screen);
}

/** Read a JSON array setting. */
export async function getArraySetting(key: 'pinnedChannels' | 'mutedChannels' | 'mutedUsers'): Promise<string[]> {
  const raw = await AsyncStorage.getItem(KEYS[key]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Write a JSON array setting. */
export async function setArraySetting(
  key: 'pinnedChannels' | 'mutedChannels' | 'mutedUsers',
  value: string[],
): Promise<void> {
  await AsyncStorage.setItem(KEYS[key], JSON.stringify(value));
}
