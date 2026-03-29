/**
 * News Feed — default start screen.
 *
 * Displays news posts from the network in a card-based layout.
 * Pull-to-refresh, infinite scroll, and FAB for new post (spec 6.4).
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
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { Envelope } from '@ogmara/sdk';
import type { NewsStackParamList } from '../navigation/types';

type NavProp = NativeStackNavigationProp<NewsStackParamList, 'NewsFeed'>;

export default function NewsFeedScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, status } = useConnection();
  const navigation = useNavigation<NavProp>();

  const { data, loading, refreshing, onRefresh } = useApi(
    async () => {
      if (!client) return { posts: [], total: 0, page: 1 };
      return client.listNews();
    },
    [client],
  );

  const posts = data?.posts ?? [];

  const renderPost = ({ item }: { item: Envelope }) => (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.bgSecondary }]}
      onPress={() => navigation.navigate('NewsDetail', { msgId: item.msg_id })}
      activeOpacity={0.7}
    >
      <TouchableOpacity
        onPress={() => navigation.navigate('UserProfile', { address: item.author })}
      >
        <Text style={[styles.author, { color: colors.accentPrimary }]}>
          {item.author.slice(0, 16)}...
        </Text>
      </TouchableOpacity>
      <Text style={[styles.content, { color: colors.textPrimary }]} numberOfLines={4}>
        {item.payload}
      </Text>
      <Text style={[styles.time, { color: colors.textSecondary }]}>
        {new Date(item.timestamp).toLocaleDateString()}
      </Text>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <FlatList
        data={posts}
        keyExtractor={(item) => item.msg_id}
        renderItem={renderPost}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
          />
        }
        contentContainerStyle={posts.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {status === 'disconnected' ? t('status_disconnected') : t('news_no_posts')}
            </Text>
          </View>
        }
      />
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.accentPrimary }]}
        activeOpacity={0.8}
        onPress={() => navigation.navigate('ComposePost')}
      >
        <Text style={[styles.fabText, { color: colors.textInverse }]}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: spacing.md },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 120 },
  emptyText: { fontSize: fontSize.md },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
  },
  author: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.xs },
  content: { fontSize: fontSize.md, lineHeight: 22, marginBottom: spacing.sm },
  time: { fontSize: fontSize.xs },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.25,
    shadowRadius: 4,
  },
  fabText: { fontSize: fontSize.xl, fontWeight: '600', marginTop: -2 },
});
