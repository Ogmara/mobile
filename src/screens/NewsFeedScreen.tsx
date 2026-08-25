/**
 * News Feed — default start screen.
 *
 * Displays news posts from the network in a card-based layout.
 * Pull-to-refresh, infinite scroll, and FAB for new post (spec 6.4).
 * Includes reaction buttons, repost, and bookmark per backport spec.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  Image,
} from 'react-native';
import NewsReactionBar from '../components/NewsReactionBar';
import PostImage from '../components/PostImage';
import SegmentedControl from '../components/SegmentedControl';
import { ImageViewerModal } from '../components/ImageViewerModal';
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
import { isNewsEnvelope } from '@ogmara/sdk';
import type { NewsStackParamList } from '../navigation/types';
import { showAlert } from '../components/AlertHost';

type NavProp = NativeStackNavigationProp<NewsStackParamList, 'NewsFeed'>;

/** Predefined reaction emojis for news posts. */

export default function NewsFeedScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, status, signer, onWsEvent } = useConnection();
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

  // Live feed updates. l2-node 0.119.0+ broadcasts news envelopes over the WS;
  // before that the node pushed nothing for news at all, so the only thing that
  // refreshed this list was the focus effect below — which is why a new post
  // appeared only after leaving the feed and coming back.
  //
  // Refresh rather than splicing the envelope in: the WS frame is a raw envelope
  // (msgpack payload) while this list holds node-decoded posts normalized by
  // `normalizeEnvelopes`, so they are not the same shape. Refreshing also covers
  // edits, deletes, reactions and reposts with one code path.
  useEffect(() => {
    const unsubscribe = onWsEvent((event) => {
      if (event.type !== 'message') return;
      if (!isNewsEnvelope((event as { envelope?: unknown }).envelope)) return;
      onRefresh();
    });
    return unsubscribe;
  }, [onWsEvent, onRefresh]);

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
        <View style={styles.feedToggle}>
          <SegmentedControl
            segments={[
              { value: 'all', label: t('news_all') },
              { value: 'following', label: t('news_following') },
            ]}
            value={feedMode}
            onChange={setFeedMode}
          />
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
  // Seed from the server's counts. This was hardcoded to `{}`, so a card only
  // ever showed reactions YOU added in this session — everyone else's were
  // invisible on mobile no matter how often you refreshed. The node returns
  // `reaction_counts` on every news item and `normalizeEnvelope` spreads it
  // through untouched; it was simply never read.
  const serverCounts = (post as unknown as { reaction_counts?: Record<string, number> })
    .reaction_counts;
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>(
    serverCounts ?? {},
  );
  // Re-seed when the list refetches. FlatList reuses card instances by key, so
  // useState's initial value alone would keep showing the count from whenever
  // this row was first mounted.
  useEffect(() => {
    setReactionCounts(serverCounts ?? {});
  }, [serverCounts]);
  const [bookmarked, setBookmarked] = useState(false);
  const [reposted, setReposted] = useState(false);
  const [viewerImage, setViewerImage] = useState<string | null>(null);

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
      showAlert('Bookmark failed', msg.slice(0, 150));
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
      showAlert('Repost failed', msg.slice(0, 150));
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
            <TouchableOpacity
              key={idx}
              activeOpacity={0.9}
              // Nested Touchable: the tap is consumed here and never reaches the
              // card's own onPress, so tapping an image zooms it while tapping
              // anywhere else still opens the post.
              onPress={() => setViewerImage(client.getMediaUrl(att.cid))}
            >
              <PostImage uri={client.getMediaUrl(att.cid)} />
            </TouchableOpacity>
          ))}
        </View>
      )}
      <Text style={[styles.time, { color: colors.textSecondary }]}>
        {new Date(post.timestamp).toLocaleDateString()}
      </Text>

      {/* Reactions — collapsed until somebody actually reacts. */}
      <View style={styles.reactionsRow}>
        <NewsReactionBar counts={reactionCounts} onReact={handleReaction} colors={colors} />
      </View>

      <ImageViewerModal uri={viewerImage} onClose={() => setViewerImage(null)} />

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
  feedToggle: { marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.xs },
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
