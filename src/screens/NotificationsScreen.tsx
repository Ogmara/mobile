/**
 * Notifications — in-app notification center.
 *
 * Types: mention, reply, follow, dm.
 * Polls every 30 seconds for new notifications.
 * Tapping a notification navigates to the relevant screen.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { debugLog } from '../lib/debug';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<any, 'Notifications'>;

const NOTIFICATION_ICONS: Record<string, string> = {
  mention: '@',
  reply: '↩',
  follow: '👤',
  dm: '💬',
};

const POLL_INTERVAL = 30000; // 30 seconds

interface Notification {
  id: string;
  type: string;
  from: string;
  msg_id?: string;
  channel_id?: number;
  timestamp: number;
  content_preview?: string;
}

export default function NotificationsScreen({ navigation }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer } = useConnection();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const sinceRef = useRef<number | undefined>(undefined);

  const fetchNotifications = useCallback(async (showSpinner = false) => {
    if (!client || !signer) return;
    if (showSpinner) setRefreshing(true);
    try {
      const resp = await client.getNotifications(sinceRef.current, 50);
      const items: Notification[] = (resp as any).notifications ?? [];
      if (items.length > 0) {
        // Update cursor for next poll
        sinceRef.current = Math.max(...items.map((n) => n.timestamp));
        // Merge with existing (dedup by id)
        setNotifications((prev) => {
          const existingIds = new Set(prev.map((n) => n.id));
          const newItems = items.filter((n) => !existingIds.has(n.id));
          return [...newItems, ...prev].slice(0, 200);
        });
      }
    } catch (e) {
      debugLog('warn', `Notifications fetch failed: ${e instanceof Error ? e.message : ''}`);
    } finally {
      if (showSpinner) setRefreshing(false);
    }
  }, [client, signer]);

  // Initial fetch (with spinner)
  useEffect(() => { fetchNotifications(true); }, [fetchNotifications]);

  // Poll every 30s
  useEffect(() => {
    if (!client || !signer) return;
    const timer = setInterval(fetchNotifications, POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [client, signer, fetchNotifications]);

  const handlePress = useCallback((notif: Notification) => {
    switch (notif.type) {
      case 'mention':
      case 'reply':
        if (notif.channel_id) {
          navigation.navigate('ChannelMessages' as any, {
            channelId: notif.channel_id,
            channelName: `${notif.channel_id}`,
          });
        }
        break;
      case 'follow':
        navigation.navigate('UserProfile' as any, { address: notif.from });
        break;
      case 'dm':
        navigation.navigate('DmConversation' as any, {
          address: notif.from,
        });
        break;
    }
  }, [navigation]);

  const formatTime = (ts: number) => {
    const diff = Date.now() - ts;
    if (diff < 60000) return t('notifications_just_now');
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return new Date(ts).toLocaleDateString();
  };

  const getLabel = (type: string) => {
    switch (type) {
      case 'mention': return t('notifications_mentioned');
      case 'reply': return t('notifications_replied');
      case 'follow': return t('notifications_followed');
      case 'dm': return t('notifications_dm');
      default: return type;
    }
  };

  const renderItem = useCallback(({ item }: { item: Notification }) => (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: colors.bgSecondary }]}
      onPress={() => handlePress(item)}
      activeOpacity={0.7}
    >
      <View style={[styles.iconCircle, { backgroundColor: colors.accentPrimary }]}>
        <Text style={{ color: colors.textInverse, fontWeight: '700' }}>
          {NOTIFICATION_ICONS[item.type] || '?'}
        </Text>
      </View>
      <View style={styles.content}>
        <Text style={[styles.label, { color: colors.textPrimary }]}>
          <Text style={{ fontWeight: '700' }}>{item.from.slice(0, 12)}...</Text>
          {' '}{getLabel(item.type)}
        </Text>
        {item.content_preview && (
          <Text style={[styles.preview, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.content_preview}
          </Text>
        )}
      </View>
      <Text style={[styles.time, { color: colors.textSecondary }]}>
        {formatTime(item.timestamp)}
      </Text>
    </TouchableOpacity>
  ), [colors, handlePress, t]);

  if (!signer) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.textSecondary }}>{t('wallet_connect')}</Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <FlatList
        data={notifications}
        keyExtractor={(item) => item.id || `${item.type}-${item.timestamp}`}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={() => fetchNotifications(true)} tintColor={colors.accentPrimary} />
        }
        contentContainerStyle={notifications.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: colors.textSecondary }}>{t('notifications_empty')}</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  list: { padding: spacing.md },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  iconCircle: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  content: { flex: 1, minWidth: 0 },
  label: { fontSize: fontSize.sm },
  preview: { fontSize: fontSize.xs, marginTop: 2 },
  time: { fontSize: fontSize.xs },
});
