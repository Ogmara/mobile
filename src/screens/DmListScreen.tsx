/**
 * DM List — direct message conversations.
 *
 * Lists conversations ordered by last activity. Requires wallet auth.
 * Tapping a conversation navigates to DM message view.
 */

import React from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { DmConversation } from '@ogmara/sdk';

export default function DmListScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer } = useConnection();

  const { data, refreshing, onRefresh } = useApi(
    async () => {
      if (!client || !signer) return { conversations: [], total: 0 };
      return client.getDmConversations();
    },
    [client, signer],
  );

  const conversations = data?.conversations ?? [];

  const renderConversation = ({ item }: { item: DmConversation }) => (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.border }]}
      activeOpacity={0.7}
    >
      <View style={[styles.avatar, { backgroundColor: colors.dm }]}>
        <Text style={[styles.avatarText, { color: colors.textInverse }]}>
          {item.peer[4]?.toUpperCase() || '?'}
        </Text>
      </View>
      <View style={styles.rowContent}>
        <Text style={[styles.peer, { color: colors.textPrimary }]}>
          {item.peer.slice(0, 16)}...
        </Text>
        <Text style={[styles.time, { color: colors.textSecondary }]}>
          {new Date(item.last_message_at).toLocaleDateString()}
        </Text>
      </View>
      {item.unread_count > 0 && (
        <View style={[styles.unread, { backgroundColor: colors.accentPrimary }]}>
          <Text style={[styles.unreadText, { color: colors.textInverse }]}>
            {item.unread_count}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );

  // Not authenticated — prompt to connect wallet
  if (!signer) {
    return (
      <View style={[styles.container, styles.empty, { backgroundColor: colors.bgPrimary }]}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          {t('wallet_connect')}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.conversation_id}
        renderItem={renderConversation}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
          />
        }
        contentContainerStyle={conversations.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {t('sidebar_dms')}
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
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: fontSize.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { fontSize: fontSize.lg, fontWeight: '600' },
  rowContent: { flex: 1, marginLeft: spacing.md },
  peer: { fontSize: fontSize.md, fontWeight: '600' },
  time: { fontSize: fontSize.xs, marginTop: spacing.xs },
  unread: {
    minWidth: 24,
    height: 24,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
  },
  unreadText: { fontSize: fontSize.xs, fontWeight: '700' },
});
