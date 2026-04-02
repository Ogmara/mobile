/**
 * Chat — channel list with navigation into message views.
 *
 * Fetches channels from the SDK, displays them in a list.
 * Tapping a channel navigates to ChannelMessagesScreen.
 */

import React, { useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { Channel } from '@ogmara/sdk';
import type { ChatStackParamList } from '../navigation/types';

type NavProp = NativeStackNavigationProp<ChatStackParamList, 'ChannelList'>;

export default function ChatScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, status, signer } = useConnection();
  const navigation = useNavigation<NavProp>();

  const { data, refreshing, onRefresh } = useApi(
    async () => {
      if (!client) return { channels: [], total: 0, page: 1 };
      return client.listChannels();
    },
    [client, signer],
  );

  // Refresh when tab gains focus (connection may have established since first render)
  useFocusEffect(
    useCallback(() => {
      if (client) onRefresh();
    }, [client, onRefresh]),
  );

  const channels = data?.channels ?? [];

  const renderChannel = ({ item }: { item: Channel }) => (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.border }]}
      onPress={() =>
        navigation.navigate('ChannelMessages', {
          channelId: item.channel_id,
          channelName: item.display_name || item.slug,
        })
      }
      activeOpacity={0.7}
    >
      <View style={[styles.badge, { backgroundColor: colors.accentSecondary }]}>
        <Text style={[styles.badgeText, { color: colors.textInverse }]}>#</Text>
      </View>
      <View style={styles.rowContent}>
        <Text style={[styles.channelName, { color: colors.textPrimary }]}>
          {item.display_name || item.slug}
        </Text>
        {item.description && (
          <Text style={[styles.description, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.description}
          </Text>
        )}
      </View>
      {item.member_count !== undefined && (
        <Text style={[styles.memberCount, { color: colors.textSecondary }]}>
          {item.member_count} {item.member_count === 1 ? 'member' : 'members'}
        </Text>
      )}
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.accentPrimary }]}
        onPress={() => navigation.navigate('CreateChannel')}
      >
        <Text style={[styles.fabText, { color: colors.textInverse }]}>+</Text>
      </TouchableOpacity>
      <FlatList
        data={channels}
        keyExtractor={(item) => item.channel_id.toString()}
        renderItem={renderChannel}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
          />
        }
        contentContainerStyle={channels.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {status === 'disconnected' ? t('status_disconnected') : t('chat_no_channel')}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 120 },
  emptyText: { fontSize: fontSize.md, textAlign: 'center', paddingHorizontal: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: { fontSize: fontSize.lg, fontWeight: '700' },
  rowContent: { flex: 1, marginLeft: spacing.md },
  channelName: { fontSize: fontSize.md, fontWeight: '600' },
  description: { fontSize: fontSize.sm, marginTop: spacing.xs },
  memberCount: { fontSize: fontSize.sm },
  fab: { position: 'absolute', right: spacing.lg, bottom: spacing.lg, width: 56, height: 56, borderRadius: radius.full, justifyContent: 'center', alignItems: 'center', elevation: 4 },
  fabText: { fontSize: fontSize.xl, fontWeight: '600' },
});
