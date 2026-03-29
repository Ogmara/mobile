/**
 * Push notifications — FCM (Android) and APNs (iOS) registration.
 *
 * Handles permission request, device token retrieval, and registration
 * with the Ogmara push gateway. Manages notification tap navigation.
 * Per spec 05-clients.md section 6.
 */

import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as Device from 'expo-device';
import Constants from 'expo-constants';

/** Push gateway URL (configurable per environment). */
const DEFAULT_GATEWAY_URL = 'http://localhost:41722';

// Configure notification behavior when app is in foreground
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    priority: Notifications.AndroidNotificationPriority.HIGH,
  }),
});

/** Request push notification permissions and get the device token. */
export async function getDevicePushToken(): Promise<string | null> {
  if (!Device.isDevice) {
    // Push notifications only work on physical devices
    return null;
  }

  // Request permission
  const { status: existingStatus } = await Notifications.getPermissionsAsync();
  let finalStatus = existingStatus;

  if (existingStatus !== 'granted') {
    const { status } = await Notifications.requestPermissionsAsync();
    finalStatus = status;
  }

  if (finalStatus !== 'granted') {
    return null;
  }

  // Get the Expo push token (works for both FCM and APNs)
  const projectId = Constants.expoConfig?.extra?.eas?.projectId;
  const tokenData = await Notifications.getExpoPushTokenAsync({
    projectId,
  });

  return tokenData.data;
}

/** Get the native FCM/APNs device token (for direct push gateway registration). */
export async function getNativeDeviceToken(): Promise<{ token: string; platform: 'fcm' | 'apns' } | null> {
  if (!Device.isDevice) return null;

  try {
    const tokenData = await Notifications.getDevicePushTokenAsync();
    const platform = Platform.OS === 'ios' ? 'apns' : 'fcm';
    return { token: tokenData.data as string, platform };
  } catch {
    return null;
  }
}

/**
 * Register the device with the Ogmara push gateway.
 *
 * Sends the native device token + Klever address to the gateway,
 * which will forward push notifications when mentions are detected.
 */
export async function registerWithGateway(
  gatewayUrl: string,
  address: string,
  authHeaders: Record<string, string>,
  channels: number[] = [],
): Promise<boolean> {
  const tokenInfo = await getNativeDeviceToken();
  if (!tokenInfo) return false;

  try {
    const resp = await fetch(`${gatewayUrl}/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...authHeaders,
      },
      body: JSON.stringify({
        address,
        token: tokenInfo.token,
        platform: tokenInfo.platform,
        channels,
      }),
    });

    return resp.ok;
  } catch {
    return false;
  }
}

/** Unregister the device from the push gateway. */
export async function unregisterFromGateway(
  gatewayUrl: string,
  address: string,
  token: string,
): Promise<boolean> {
  try {
    const resp = await fetch(`${gatewayUrl}/unregister`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, token }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Parse a push notification's data payload for navigation.
 *
 * Returns a route + params based on the notification type (mention or dm).
 * Per spec 05-clients.md section 6.4.
 */
export function parseNotificationData(
  data: Record<string, unknown>,
): { screen: string; params: Record<string, unknown> } | null {
  const type = data.type as string;

  if (type === 'mention') {
    return {
      screen: 'ChannelMessages',
      params: {
        channelId: Number(data.channel_id),
        channelName: `#${data.channel_id}`,
      },
    };
  }

  if (type === 'dm') {
    return {
      screen: 'DmConversation',
      params: {
        address: data.sender as string,
      },
    };
  }

  return null;
}

/** Set up Android notification channel (required for Android 8+). */
export async function setupNotificationChannel(): Promise<void> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('mentions', {
      name: 'Mentions',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#6c5ce7',
    });
    await Notifications.setNotificationChannelAsync('dms', {
      name: 'Direct Messages',
      importance: Notifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 250, 250],
      lightColor: '#e17055',
    });
  }
}
