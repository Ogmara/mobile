/**
 * News Feed — default start screen.
 *
 * Displays news posts from the network in a card-based layout.
 * Pull-to-refresh, infinite scroll, and FAB for new post (spec 6.4).
 * Includes reaction buttons, repost, and bookmark per backport spec.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  AppState,
  Image,
  type ViewToken,
} from 'react-native';
import NewsReactionBar from '../components/NewsReactionBar';
import PostImage from '../components/PostImage';
import SegmentedControl from '../components/SegmentedControl';
import VerifiedBadge from '../components/VerifiedBadge';
import TipDialog from '../components/TipDialog';
import { ImageViewerModal } from '../components/ImageViewerModal';
import { useTranslation } from 'react-i18next';
import { useNavigation, useRoute, useFocusEffect } from '@react-navigation/native';
import type { RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { debugLog } from '../lib/debug';
import { decodeNewsPost } from '../lib/payloadDecoder';
import { normalizeEnvelopes } from '../lib/envelopeNormalizer';
import { useUserDisplay } from '../hooks/useUserDisplay';
import { formatDateTime } from '../lib/datetime';
import { getSetting, setSetting } from '../lib/settings';
import type { Envelope } from '@ogmara/sdk';
import { isNewsEnvelope, MSG_TYPE_NAME } from '@ogmara/sdk';
import type { NewsStackParamList } from '../navigation/types';
import { showAlert } from '../components/AlertHost';

const PAGE = 20;
const MAX_POSTS = 500;
const RESUME_WINDOW_MS = 24 * 60 * 60 * 1000;

type FeedMode = 'all' | 'following';

const msgIdHex = (p: Envelope): string => p.msg_id;

type NavProp = NativeStackNavigationProp<NewsStackParamList, 'NewsFeed'>;

/** Predefined reaction emojis for news posts. */

export default function NewsFeedScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, status, signer, address: myAddress, onWsEvent } = useConnection();
  const navigation = useNavigation<NavProp>();
  const route = useRoute<RouteProp<NewsStackParamList, 'NewsFeed'>>();
  const [feedMode, setFeedMode] = useState<FeedMode>('all');

  // --- Feed accumulator ---------------------------------------------------
  // The feed is a growing list, not a fixed page. `onEndReached` autoloads the
  // next-older page (`before` cursor); pull-to-refresh loads posts that arrived
  // since (`after` cursor) when resumed, otherwise reloads the newest page.
  // Reopening within 24h restores the last-read post as the scroll anchor.
  const [posts, setPosts] = useState<Envelope[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [hasMoreNewer, setHasMoreNewer] = useState(false);
  const [newPosts, setNewPosts] = useState(0);
  const [tipTarget, setTipTarget] = useState<string | null>(null);

  const listRef = useRef<FlatList<Envelope>>(null);
  const postsRef = useRef<Envelope[]>([]);
  postsRef.current = posts;
  const atNewestRef = useRef(true);
  const loadTokenRef = useRef(0);
  const topVisibleRef = useRef<string>('');
  const pendingAnchorRef = useRef<string | null>(null);
  const anchorAttemptsRef = useRef(0);
  // Synchronous re-entrancy guards — `onEndReached` / pull-to-refresh can fire
  // again before a `setState` flush, and `loadOlder`'s append is not idempotent.
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);

  const lastReadKey = useCallback(
    (): 'newsLastReadAll' | 'newsLastReadFollowing' =>
      feedMode === 'following' ? 'newsLastReadFollowing' : 'newsLastReadAll',
    [feedMode],
  );

  const dedupe = (arr: Envelope[]): Envelope[] => {
    const seen = new Set<string>();
    const out: Envelope[] = [];
    for (const p of arr) {
      const id = msgIdHex(p);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(p);
    }
    return out;
  };

  const fetchPage = useCallback(
    async (opts: { before?: string; after?: string }): Promise<{ posts: Envelope[]; hasMore: boolean }> => {
      if (!client) return { posts: [], hasMore: false };
      const resp =
        feedMode === 'following' && signer
          ? await client.getFeed({ limit: PAGE, ...opts })
          : await client.listNews({ limit: PAGE, ...opts });
      const list = normalizeEnvelopes((resp as any).posts ?? []) as Envelope[];
      return { posts: list, hasMore: (resp as any).has_more ?? list.length >= PAGE };
    },
    [client, feedMode, signer],
  );

  const persistPosition = useCallback(() => {
    if (postsRef.current.length === 0) return;
    const id = topVisibleRef.current || msgIdHex(postsRef.current[0]);
    if (id) void setSetting(lastReadKey(), id);
    void setSetting('newsLastViewedAt', String(Date.now()));
  }, [lastReadKey]);

  const initFeed = useCallback(async () => {
    const myToken = ++loadTokenRef.current;
    setLoading(true);
    setNewPosts(0);
    setPosts([]);
    try {
      if (feedMode === 'following' && !signer) {
        setHasMoreOlder(false);
        setHasMoreNewer(false);
        atNewestRef.current = true;
        return;
      }
      const [savedId, viewedAtRaw] = await Promise.all([
        getSetting(lastReadKey()),
        getSetting('newsLastViewedAt'),
      ]);
      const viewedAt = Number(viewedAtRaw ?? 0);
      const stale = !savedId || Date.now() - viewedAt > RESUME_WINDOW_MS;

      if (stale) {
        const { posts: fresh, hasMore } = await fetchPage({});
        if (myToken !== loadTokenRef.current) return;
        setPosts(dedupe(fresh));
        setHasMoreOlder(hasMore);
        setHasMoreNewer(false);
        atNewestRef.current = true;
        pendingAnchorRef.current = null;
        return;
      }

      const [older, newer, anchorResp] = await Promise.all([
        fetchPage({ before: savedId! }),
        fetchPage({ after: savedId! }),
        client!
          .getNewsPost(savedId!)
          .then((r) => r.post as Envelope)
          .catch(() => null),
      ]);
      if (myToken !== loadTokenRef.current) return;
      const anchor = anchorResp
        ? (normalizeEnvelopes([anchorResp])[0] as Envelope)
        : null;
      const merged = dedupe([...newer.posts, ...(anchor ? [anchor] : []), ...older.posts]);
      setPosts(merged);
      setHasMoreNewer(newer.hasMore);
      setHasMoreOlder(older.hasMore);
      atNewestRef.current = !newer.hasMore && newer.posts.length === 0;
      pendingAnchorRef.current =
        (anchor && msgIdHex(anchor)) ||
        (older.posts[0] && msgIdHex(older.posts[0])) ||
        (newer.posts.length && msgIdHex(newer.posts[newer.posts.length - 1])) ||
        null;
      anchorAttemptsRef.current = 0;
      // Hard stop — never let the anchor scroll linger past the initial layout.
      if (pendingAnchorRef.current) {
        setTimeout(() => {
          pendingAnchorRef.current = null;
        }, 4000);
      }
    } catch (e) {
      if (myToken !== loadTokenRef.current) return;
      debugLog('warn', `News init failed: ${e instanceof Error ? e.message : e}`);
      setPosts([]);
      setHasMoreOlder(false);
      setHasMoreNewer(false);
      atNewestRef.current = true;
    } finally {
      if (myToken === loadTokenRef.current) setLoading(false);
    }
  }, [feedMode, signer, client, fetchPage, lastReadKey]);

  const loadOlder = useCallback(async () => {
    if (loadingOlderRef.current || !hasMoreOlder || postsRef.current.length === 0) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const oldest = postsRef.current[postsRef.current.length - 1];
      const { posts: older, hasMore } = await fetchPage({ before: msgIdHex(oldest) });
      const known = new Set(postsRef.current.map(msgIdHex));
      const fresh = older.filter((p) => !known.has(msgIdHex(p)));
      if (fresh.length > 0) {
        setPosts((prev) => {
          // Re-filter against `prev` — a racing call may have appended since.
          const seen = new Set(prev.map(msgIdHex));
          const add = fresh.filter((p) => !seen.has(msgIdHex(p)));
          const next = [...prev, ...add];
          if (next.length > MAX_POSTS) {
            atNewestRef.current = false;
            setHasMoreNewer(true);
            return next.slice(next.length - MAX_POSTS);
          }
          return next;
        });
      }
      // `loadingOlderRef` serialises this fn, so a zero-`fresh` page here is
      // genuine end-of-history (or a pre-0.123.0 node echoing the same page) —
      // latch false so scroll-to-bottom stops re-fetching. Anything strictly
      // older than the current oldest item cannot already be loaded.
      setHasMoreOlder(hasMore && fresh.length > 0);
    } catch (e) {
      debugLog('warn', `Load older failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }, [hasMoreOlder, fetchPage]);

  // Load posts newer than the current top. FlatList's
  // `maintainVisibleContentPosition` keeps the viewport pinned when rows are
  // prepended, so the user stays put and scrolls up into the new posts.
  const loadNewer = useCallback(async (): Promise<number> => {
    if (loadingNewerRef.current || postsRef.current.length === 0) return 0;
    loadingNewerRef.current = true;
    try {
      const newest = postsRef.current[0];
      const { posts: newer, hasMore } = await fetchPage({ after: msgIdHex(newest) });
      // `loadingNewerRef` serialises this fn, and nothing else prepends, so the
      // head of `postsRef.current` is stable across the await.
      const seen = new Set(postsRef.current.map(msgIdHex));
      const add = newer.filter((p) => !seen.has(msgIdHex(p)));
      if (add.length > 0) setPosts((prev) => dedupe([...add, ...prev]));
      const more = hasMore && newer.length >= PAGE;
      setHasMoreNewer(more);
      if (!more) atNewestRef.current = true;
      return add.length;
    } catch (e) {
      debugLog('warn', `Load newer failed: ${e instanceof Error ? e.message : e}`);
      return 0;
    } finally {
      loadingNewerRef.current = false;
    }
  }, [fetchPage]);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    setNewPosts(0);
    try {
      if (hasMoreNewer && postsRef.current.length > 0) {
        await loadNewer();
      } else {
        const { posts: fresh, hasMore } = await fetchPage({});
        setPosts(dedupe(fresh));
        setHasMoreOlder(hasMore);
        setHasMoreNewer(false);
        atNewestRef.current = true;
      }
    } catch (e) {
      debugLog('warn', `Refresh failed: ${e instanceof Error ? e.message : e}`);
    } finally {
      setRefreshing(false);
    }
  }, [hasMoreNewer, loadNewer, fetchPage]);

  // "Show new posts" tap — reload the newest page and jump to the top.
  const jumpToNewest = useCallback(async () => {
    setNewPosts(0);
    try {
      const { posts: fresh, hasMore } = await fetchPage({});
      setPosts(dedupe(fresh));
      setHasMoreOlder(hasMore);
      setHasMoreNewer(false);
      atNewestRef.current = true;
      requestAnimationFrame(() =>
        listRef.current?.scrollToOffset({ offset: 0, animated: true }),
      );
    } catch (e) {
      debugLog('warn', `Jump to newest failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [fetchPage]);

  // Apply a live news envelope IN PLACE — never a blanket refetch. This is what
  // stops the feed jumping to the newest post on every reaction/comment/edit
  // (including the echo of the user's own action).
  const applyNewsEnvelope = useCallback(
    (env: any) => {
      const type = env?.msg_type;
      const mine = !!env?.author && env.author === myAddress;

      if (type === 'NewsPost' || type === 'NewsRepost') {
        if (mine) return;
        if (atNewestRef.current) void loadNewer();
        else setNewPosts((n) => n + 1);
        return;
      }
      const targetHex: string | undefined = env?.target_msg_id;
      if (!targetHex) return;
      setPosts((prev) => {
        const idx = prev.findIndex((p) => msgIdHex(p) === targetHex);
        if (idx < 0) return prev;
        const item: any = { ...prev[idx] };
        if (type === 'NewsReaction') {
          if (mine || !env?.emoji) return prev;
          const rc = { ...(item.reaction_counts || {}) };
          const next = (rc[env.emoji] ?? 0) + (env.remove ? -1 : 1);
          if (next <= 0) delete rc[env.emoji];
          else rc[env.emoji] = next;
          item.reaction_counts = rc;
        } else if (type === 'NewsComment') {
          item.comment_count = (item.comment_count ?? 0) + 1;
        } else if (type === 'NewsEdit') {
          item.edited = true;
        } else if (type === 'NewsDelete') {
          item.deleted = true;
        } else {
          return prev;
        }
        const copy = [...prev];
        copy[idx] = item;
        return copy;
      });
    },
    [myAddress, loadNewer],
  );

  useEffect(() => {
    const unsubscribe = onWsEvent((event) => {
      if (event.type !== 'message') return;
      const env = (event as { envelope?: unknown }).envelope;
      if (!isNewsEnvelope(env)) return;
      applyNewsEnvelope(env as any);
    });
    return unsubscribe;
  }, [onWsEvent, applyNewsEnvelope]);

  // Load on mount and whenever the feed mode / auth state changes.
  useEffect(() => {
    void initFeed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [feedMode, signer, client]);

  // After a resume load, scroll to the saved anchor once rows are laid out.
  // `scrollToIndex` on a far index with variable-height rows often can't
  // resolve on the first try (the row isn't rendered yet) — RN then calls
  // `onScrollToIndexFailed`, which nudges to an estimated offset (rendering
  // more rows) and re-arms this via the next `onContentSizeChange`, capped at
  // `anchorAttemptsRef`. `pendingAnchorRef` is cleared on arrival
  // (`onViewableItemsChanged`) or by the 4s hard-stop timer in `initFeed`.
  const tryScrollToAnchor = useCallback(() => {
    const anchor = pendingAnchorRef.current;
    if (!anchor) return;
    const idx = postsRef.current.findIndex((p) => msgIdHex(p) === anchor);
    if (idx <= 0) {
      pendingAnchorRef.current = null;
      return;
    }
    listRef.current?.scrollToIndex({ index: idx, animated: false, viewPosition: 0 });
  }, []);

  const onContentSizeChange = useCallback(() => {
    if (pendingAnchorRef.current) tryScrollToAnchor();
  }, [tryScrollToAnchor]);

  const onScrollToIndexFailed = useCallback(
    (info: { index: number; averageItemLength: number }) => {
      if (!pendingAnchorRef.current) return;
      anchorAttemptsRef.current += 1;
      if (anchorAttemptsRef.current > 5) {
        pendingAnchorRef.current = null;
        return;
      }
      listRef.current?.scrollToOffset({
        offset: Math.max(0, info.averageItemLength * info.index),
        animated: false,
      });
      setTimeout(tryScrollToAnchor, 150);
    },
    [tryScrollToAnchor],
  );

  const onViewableItemsChanged = useRef(
    ({ viewableItems }: { viewableItems: ViewToken[] }) => {
      const first = viewableItems[0]?.item as Envelope | undefined;
      if (!first) return;
      const id = msgIdHex(first);
      topVisibleRef.current = id;
      if (pendingAnchorRef.current === id) pendingAnchorRef.current = null; // arrived
    },
  ).current;

  // Persist position on blur and when the app is backgrounded.
  useFocusEffect(
    useCallback(() => {
      const sub = AppState.addEventListener('change', (s) => {
        if (s === 'background') persistPosition();
      });
      return () => {
        sub.remove();
        persistPosition();
      };
    }, [persistPosition]),
  );

  // ComposePost hands back `{ refresh }` after a successful post/edit (the WS
  // echo of our own write is dropped, and this screen stays mounted) — reload
  // the newest page and jump to the top so the user sees what they just wrote.
  const lastRefreshRef = useRef(0);
  useFocusEffect(
    useCallback(() => {
      const r = route.params?.refresh ?? 0;
      if (r && r !== lastRefreshRef.current) {
        lastRefreshRef.current = r;
        navigation.setParams({ refresh: undefined });
        void jumpToNewest();
      }
    }, [route.params?.refresh, navigation, jumpToNewest]),
  );

  const renderPost = ({ item }: { item: Envelope }) => (
    <NewsCard
      post={item}
      colors={colors}
      myAddress={myAddress}
      onTip={setTipTarget}
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
      {newPosts > 0 && (
        <TouchableOpacity
          style={[styles.newPostsPill, { backgroundColor: colors.accentPrimary }]}
          onPress={() => void jumpToNewest()}
          activeOpacity={0.85}
        >
          <Text style={{ color: colors.textInverse, fontWeight: '600', fontSize: fontSize.sm }}>
            ↑ {t('news_show_new_posts')}
          </Text>
        </TouchableOpacity>
      )}
      <FlatList
        ref={listRef}
        data={posts}
        keyExtractor={(item) => item.msg_id}
        renderItem={renderPost}
        onEndReached={() => void loadOlder()}
        onEndReachedThreshold={0.5}
        onContentSizeChange={onContentSizeChange}
        onViewableItemsChanged={onViewableItemsChanged}
        maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
        onScrollToIndexFailed={onScrollToIndexFailed}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
          />
        }
        ListFooterComponent={
          loadingOlder ? (
            <ActivityIndicator style={{ paddingVertical: spacing.md }} color={colors.accentPrimary} />
          ) : null
        }
        contentContainerStyle={posts.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {loading
                ? t('loading')
                : status === 'disconnected'
                ? t('status_disconnected')
                : t('news_no_posts')}
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
      <TipDialog
        visible={!!tipTarget}
        recipientAddress={tipTarget ?? ''}
        onClose={() => setTipTarget(null)}
      />
    </View>
  );
}

/** Individual news card with reactions, repost, bookmark, tip. */
function NewsCard({
  post,
  colors,
  myAddress,
  onTip,
  onPress,
  onAuthorPress,
}: {
  post: Envelope;
  colors: any;
  myAddress: string | null | undefined;
  onTip: (address: string) => void;
  onPress: () => void;
  onAuthorPress: () => void;
}) {
  const { t } = useTranslation();
  const { client } = useConnection();
  const navigation = useNavigation<NavProp>();
  const { displayName: authorName, avatarUri: authorAvatar, verified: authorVerified } =
    useUserDisplay(post.author);
  // `Envelope.msg_type` is typed `number` (the signed wire envelope's
  // representation), but the node's REST responses serialize it as the Rust
  // enum's variant NAME string (e.g. "NewsRepost") — see @ogmara/sdk's
  // `isNewsEnvelope`/`MSG_TYPE_NAME` doc comments for the same duality.
  const msgTypeName =
    typeof post.msg_type === 'number'
      ? MSG_TYPE_NAME[post.msg_type]
      : (post.msg_type as unknown as string);
  const isRepost = msgTypeName === 'NewsRepost';
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

  // A NewsRepost payload only carries {original_id, original_author, comment}
  // — no title/content — so decoding it as a NewsPost is meaningless. The
  // l2-node enriches repost feed items with original_* / repost_comment
  // fields instead (mirroring the parent_* enrichment comments get).
  const decoded = isRepost ? null : decodeNewsPost(post.payload);
  const title = decoded?.title || '';
  const body = decoded?.content || (typeof post.payload === 'string' ? post.payload : '');
  const repostFields = post as unknown as {
    repost_comment?: string;
    original_available?: boolean;
    original_id?: string;
    original_author?: string;
    original_title?: string;
    original_content?: string;
    original_deleted?: boolean;
    original_attachment?: { cid: string; mime_type: string; thumbnail_cid?: string };
  };

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
        <VerifiedBadge verified={authorVerified} />
      </TouchableOpacity>
      {isRepost ? (
        <>
          {repostFields.repost_comment ? (
            <Text style={[styles.content, { color: colors.textPrimary }]} numberOfLines={4}>
              {repostFields.repost_comment}
            </Text>
          ) : null}
          {repostFields.original_available ? (
            <TouchableOpacity
              style={[styles.repostQuote, { borderColor: colors.border }]}
              activeOpacity={0.8}
              onPress={() =>
                repostFields.original_id &&
                navigation.navigate('NewsDetail', { msgId: repostFields.original_id })
              }
            >
              <Text style={[styles.repostQuoteAuthor, { color: colors.textSecondary }]}>
                {repostFields.original_author
                  ? `${repostFields.original_author.slice(0, 16)}...`
                  : ''}
              </Text>
              {repostFields.original_deleted ? (
                <Text style={{ color: colors.textSecondary, fontStyle: 'italic', fontSize: fontSize.sm }}>
                  {t('message_deleted')}
                </Text>
              ) : (
                <>
                  {repostFields.original_title ? (
                    <Text style={[styles.repostQuoteTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                      {repostFields.original_title}
                    </Text>
                  ) : null}
                  <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm }} numberOfLines={2}>
                    {repostFields.original_content}
                  </Text>
                </>
              )}
            </TouchableOpacity>
          ) : (
            <Text style={{ color: colors.textSecondary, fontStyle: 'italic', fontSize: fontSize.sm }}>
              {t('news_original_unavailable')}
            </Text>
          )}
        </>
      ) : (
        <>
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
        </>
      )}
      <Text style={[styles.time, { color: colors.textSecondary }]}>
        {formatDateTime(post.timestamp)}
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
        {post.author !== myAddress && (
          <TouchableOpacity style={styles.actionBtn} onPress={() => onTip(post.author)}>
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm }}>💰 {t('chat_tip')}</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  feedToggle: { marginHorizontal: spacing.md, marginTop: spacing.sm, marginBottom: spacing.xs },
  newPostsPill: {
    alignSelf: 'center',
    marginTop: spacing.xs,
    marginBottom: spacing.xs,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
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
  repostQuote: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.sm,
  },
  repostQuoteAuthor: { fontSize: fontSize.xs, marginBottom: 2 },
  repostQuoteTitle: { fontSize: fontSize.md, fontWeight: '600', marginBottom: 2 },
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
