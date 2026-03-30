/**
 * Bookmarks — saved posts list.
 *
 * Shows all posts the user has bookmarked, ordered by save time.
 * Pull-to-refresh, tap to navigate to detail.
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
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { Envelope } from '@ogmara/sdk';

export default function BookmarksScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client } = useConnection();
  const navigation = useNavigation<any>();

  const { data, loading, refreshing, onRefresh } = useApi(
    async () => {
      if (!client) return { bookmarks: [], total: 0 };
      return client.listBookmarks({ page: 1, limit: 50 });
    },
    [client],
  );

  const bookmarks = data?.bookmarks ?? [];

  const renderItem = ({ item }: { item: Envelope }) => (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.bgSecondary }]}
      onPress={() => navigation.navigate('NewsDetail', { msgId: item.msg_id })}
      activeOpacity={0.7}
    >
      <Text style={[styles.author, { color: colors.accentPrimary }]}>
        {item.author.slice(0, 16)}...
      </Text>
      <Text style={[styles.content, { color: colors.textPrimary }]} numberOfLines={3}>
        {item.payload}
      </Text>
      <Text style={[styles.time, { color: colors.textSecondary }]}>
        {new Date(item.timestamp).toLocaleDateString()}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>
        {t('bookmarks_title')}
      </Text>
      <FlatList
        data={bookmarks}
        keyExtractor={(item) => item.msg_id}
        renderItem={renderItem}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
          />
        }
        contentContainerStyle={bookmarks.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: colors.textSecondary }}>{t('bookmarks_empty')}</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  title: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    padding: spacing.md,
    paddingBottom: 0,
  },
  list: { padding: spacing.md },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 120 },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
  },
  author: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.xs },
  content: { fontSize: fontSize.md, lineHeight: 22, marginBottom: spacing.sm },
  time: { fontSize: fontSize.xs },
});
