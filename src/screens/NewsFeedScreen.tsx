/**
 * News Feed — default start screen.
 *
 * Displays news posts from the network in a card-based layout.
 * Pull-to-refresh, infinite scroll, and FAB for new post (spec 6.4).
 * Includes reaction buttons, repost, and bookmark per backport spec.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { debugLog } from '../lib/debug';
import { useApi } from '../hooks/useApi';
import { decodeNewsPost } from '../lib/payloadDecoder';
import { normalizeEnvelopes } from '../lib/envelopeNormalizer';
import type { Envelope } from '@ogmara/sdk';
import type { NewsStackParamList } from '../navigation/types';

type NavProp = NativeStackNavigationProp<NewsStackParamList, 'NewsFeed'>;

/** Predefined reaction emojis for news posts. */
const NEWS_REACTIONS = ['👍', '👎', '❤️', '🔥', '😂'];

export default function NewsFeedScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, status } = useConnection();
  const navigation = useNavigation<NavProp>();

  const { data, loading, refreshing, onRefresh } = useApi(
    async () => {
      if (!client) return { posts: [], total: 0, page: 1 };
      const resp = await client.listNews();
      return { ...resp, posts: normalizeEnvelopes(resp.posts) };
    },
    [client],
  );

  // Auto-refresh when screen gains focus (e.g., after posting)
  useFocusEffect(
    useCallback(() => {
      if (client) onRefresh();
    }, [client]),
  );

  const posts = data?.posts ?? [];

  const renderPost = ({ item }: { item: Envelope }) => (
    <NewsCard
      post={item}
      colors={colors}
      onPress={() => navigation.navigate('NewsDetail', { msgId: item.msg_id, post: item })}
      onAuthorPress={() => navigation.navigate('UserProfile', { address: item.author })}
    />
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

/** Individual news card with reactions, repost, bookmark. */
function NewsCard({
  post,
  colors,
  onPress,
  onAuthorPress,
}: {
  post: Envelope;
  colors: any;
  onPress: () => void;
  onAuthorPress: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useConnection();
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({});
  const [bookmarked, setBookmarked] = useState(false);
  const [reposted, setReposted] = useState(false);

  // Decode the MessagePack payload into readable title/content
  const decoded = decodeNewsPost(post.payload);
  const title = decoded?.title || '';
  const body = decoded?.content || (typeof post.payload === 'string' ? post.payload : '');

  const handleReaction = useCallback(
    async (emoji: string) => {
      if (!client) return;
      try {
        await client.reactToNews(post.msg_id, emoji);
        setReactionCounts((prev) => ({
          ...prev,
          [emoji]: (prev[emoji] ?? 0) + 1,
        }));
      } catch (e) {
        debugLog('warn', `Reaction failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    [client, post.msg_id],
  );

  const handleBookmark = useCallback(async () => {
    if (!client) return;
    try {
      if (bookmarked) {
        await client.removeBookmark(post.msg_id);
        setBookmarked(false);
      } else {
        await client.saveBookmark(post.msg_id);
        setBookmarked(true);
      }
    } catch (e) {
      debugLog('warn', `Bookmark failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [client, post.msg_id, bookmarked]);

  const handleRepost = useCallback(async () => {
    if (reposted || !client) return;
    try {
      await client.repostNews(post.msg_id, post.author);
      setReposted(true);
    } catch (e) {
      debugLog('warn', `Repost failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [client, post.msg_id, post.author, reposted]);

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.bgSecondary }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <TouchableOpacity onPress={onAuthorPress}>
        <Text style={[styles.author, { color: colors.accentPrimary }]}>
          {post.author.slice(0, 16)}...
        </Text>
      </TouchableOpacity>
      {title ? (
        <Text style={[styles.title, { color: colors.textPrimary }]} numberOfLines={2}>
          {title}
        </Text>
      ) : null}
      <Text style={[styles.content, { color: colors.textPrimary }]} numberOfLines={4}>
        {body}
      </Text>
      <Text style={[styles.time, { color: colors.textSecondary }]}>
        {new Date(post.timestamp).toLocaleDateString()}
      </Text>

      {/* Engagement actions */}
      <View style={styles.actions}>
        {NEWS_REACTIONS.map((emoji) => (
          <TouchableOpacity
            key={emoji}
            style={[styles.reactionBtn, { backgroundColor: colors.bgTertiary }]}
            onPress={() => handleReaction(emoji)}
          >
            <Text style={styles.reactionEmoji}>{emoji}</Text>
            {(reactionCounts[emoji] ?? 0) > 0 && (
              <Text style={[styles.reactionCount, { color: colors.textSecondary }]}>
                {reactionCounts[emoji]}
              </Text>
            )}
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[styles.actionBtn, reposted && { opacity: 0.5 }]}
          onPress={handleRepost}
          disabled={reposted}
        >
          <Text style={{ color: reposted ? colors.accentPrimary : colors.textSecondary, fontSize: fontSize.sm }}>
            ↗ {t('news_repost')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.actionBtn} onPress={handleBookmark}>
          <Text style={{ color: bookmarked ? colors.accentPrimary : colors.textSecondary, fontSize: fontSize.sm }}>
            {bookmarked ? '★' : '☆'} {bookmarked ? t('news_bookmarked') : t('news_bookmark')}
          </Text>
        </TouchableOpacity>
      </View>
    </TouchableOpacity>
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
  title: { fontSize: fontSize.lg, fontWeight: '700', lineHeight: 24, marginBottom: spacing.xs },
  content: { fontSize: fontSize.md, lineHeight: 22, marginBottom: spacing.sm },
  time: { fontSize: fontSize.xs, marginBottom: spacing.sm },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: spacing.xs,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.2)',
    paddingTop: spacing.sm,
  },
  reactionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.sm,
    gap: 4,
  },
  reactionEmoji: { fontSize: fontSize.md },
  reactionCount: { fontSize: fontSize.xs, fontWeight: '600' },
  actionBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
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
