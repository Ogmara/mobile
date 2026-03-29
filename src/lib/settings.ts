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
  walletAddress: 'ogmara.wallet_address',
  notificationSound: 'ogmara.notification_sound',
  pushEnabled: 'ogmara.push_enabled',
  compactLayout: 'ogmara.compact_layout',
  fontSize: 'ogmara.font_size',
  pinnedChannels: 'ogmara.pinned_channels',
  mutedChannels: 'ogmara.muted_channels',
  mutedUsers: 'ogmara.muted_users',
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
