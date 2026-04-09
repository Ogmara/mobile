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
  Image,
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
import { useUserDisplay } from '../hooks/useUserDisplay';
import type { Envelope } from '@ogmara/sdk';
import type { NewsStackParamList } from '../navigation/types';

type NavProp = NativeStackNavigationProp<NewsStackParamList, 'NewsFeed'>;

/** Predefined reaction emojis for news posts. */
const NEWS_REACTIONS = ['👍', '👎', '❤️', '🔥', '😂'];

export default function NewsFeedScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, status, signer } = useConnection();
  const navigation = useNavigation<NavProp>();
  const [feedMode, setFeedMode] = useState<'all' | 'following'>('all');

  const { data, refreshing, onRefresh } = useApi(
    async () => {
      if (!client) return { posts: [], total: 0, page: 1 };
      if (feedMode === 'following' && signer) {
        try {
          const resp = await client.getFeed({ page: 1, limit: 50 });
          return { ...resp, posts: normalizeEnvelopes((resp as any).posts ?? []) };
        } catch {
          return { posts: [], total: 0, page: 1 };
        }
      }
      const resp = await client.listNews();
      return { ...resp, posts: normalizeEnvelopes(resp.posts) };
    },
    [client, feedMode, signer],
  );

  // Auto-refresh when screen gains focus (e.g., after posting)
  useFocusEffect(
    useCallback(() => {
      if (client) onRefresh();
    }, [client, onRefresh]),
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
      {/* Feed mode toggle */}
      {signer && (
        <View style={[styles.feedToggle, { backgroundColor: colors.bgSecondary }]}>
          <TouchableOpacity
            style={[styles.feedTab, feedMode === 'all' && { backgroundColor: colors.accentPrimary }]}
            onPress={() => setFeedMode('all')}
          >
            <Text style={{ color: feedMode === 'all' ? colors.textInverse : colors.textPrimary, fontWeight: '600', fontSize: fontSize.sm }}>
              {t('news_all')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.feedTab, feedMode === 'following' && { backgroundColor: colors.accentPrimary }]}
            onPress={() => setFeedMode('following')}
          >
            <Text style={{ color: feedMode === 'following' ? colors.textInverse : colors.textPrimary, fontWeight: '600', fontSize: fontSize.sm }}>
              {t('news_following')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
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
  const { displayName: authorName, avatarUri: authorAvatar } = useUserDisplay(post.author);

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
      const msg = e instanceof Error ? e.message : String(e);
      debugLog('warn', `Bookmark failed: ${msg}`);
      Alert.alert('Bookmark failed', msg.slice(0, 150));
    }
  }, [client, post.msg_id, bookmarked]);

  const handleRepost = useCallback(async () => {
    if (reposted || !client) return;
    try {
      await client.repostNews(post.msg_id, post.author);
      setReposted(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      debugLog('warn', `Repost failed: ${msg}`);
      Alert.alert('Repost failed', msg.slice(0, 150));
    }
  }, [client, post.msg_id, post.author, reposted]);

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: colors.bgSecondary }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <TouchableOpacity onPress={onAuthorPress} style={styles.authorRow}>
        {authorAvatar ? (
          <Image source={{ uri: authorAvatar }} style={styles.miniAvatar} />
        ) : (
          <View style={[styles.miniAvatar, { backgroundColor: colors.accentPrimary }]}>
            <Text style={{ color: colors.textInverse, fontSize: 10, fontWeight: '700' }}>
              {(authorName || post.author)[0]?.toUpperCase() || '?'}
            </Text>
          </View>
        )}
        <Text style={[styles.author, { color: colors.accentPrimary }]}>
          {authorName || `${post.author.slice(0, 16)}...`}
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
      {/* Inline image attachments */}
      {decoded?.attachments && decoded.attachments.length > 0 && client && (
        <View style={styles.attachRow}>
          {decoded.attachments.filter((a) => a.mime_type.startsWith('image/')).slice(0, 4).map((att, idx) => (
            <Image
              key={idx}
              source={{ uri: client.getMediaUrl(att.cid) }}
              style={styles.postImage}
              resizeMode="contain"
            />
          ))}
        </View>
      )}
      <Text style={[styles.time, { color: colors.textSecondary }]}>
        {new Date(post.timestamp).toLocaleDateString()}
      </Text>

      {/* Reactions row — right aligned */}
      <View style={styles.reactionsRow}>
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
      </View>

      {/* Actions row — left aligned */}
      <View style={styles.actionsRow}>
        <TouchableOpacity style={styles.actionBtn} onPress={onPress}>
          <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm }}>💬 Reply</Text>
        </TouchableOpacity>
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
  feedToggle: {
    flexDirection: 'row',
    padding: spacing.xs,
    gap: spacing.xs,
  },
  feedTab: {
    flex: 1,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  list: { padding: spacing.md },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 120 },
  emptyText: { fontSize: fontSize.md },
  card: {
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.md,
  },
  authorRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.xs },
  miniAvatar: { width: 22, height: 22, borderRadius: 11, justifyContent: 'center', alignItems: 'center', overflow: 'hidden' },
  author: { fontSize: fontSize.sm, fontWeight: '600' },
  title: { fontSize: fontSize.lg, fontWeight: '700', lineHeight: 24, marginBottom: spacing.xs },
  content: { fontSize: fontSize.md, lineHeight: 22, marginBottom: spacing.sm },
  attachRow: { gap: spacing.xs, marginBottom: spacing.sm },
  postImage: { width: '100%', height: 180, borderRadius: radius.md },
  time: { fontSize: fontSize.xs, marginBottom: spacing.sm },
  reactionsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.xs,
    marginBottom: spacing.xs,
  },
  actionsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
