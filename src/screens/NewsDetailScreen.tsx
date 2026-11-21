/**
 * News Detail — single news post with reactions, bookmark, repost, reply,
 * comments and share links.
 *
 * Shows the post handed over by the feed immediately, and loads
 * `GET /api/v1/news/{msg_id}` (post + its comments, capped at 200 by the node)
 * — the only source when the screen is opened from a link
 * (`news/<hex>[?c=<hex>]`, spec 06 §6.5). A `commentId` param scrolls to and
 * highlights that comment.
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import {
  View,
  Text,
  Image,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Share,
  ActivityIndicator,
  type ScrollViewInstance,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import Toast, { useToast } from '../components/Toast';
import { buildNewsShareUrl } from '../lib/share';
import KeyboardAwareView from '../components/KeyboardAwareView';
import NewsReactionBar from '../components/NewsReactionBar';
import PostImage from '../components/PostImage';
import FormattedText from '../components/FormattedText';
import VerifiedBadge from '../components/VerifiedBadge';
import TipDialog from '../components/TipDialog';
import { ImageViewerModal } from '../components/ImageViewerModal';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useUserDisplay } from '../hooks/useUserDisplay';
import { decodeNewsPost, decodePayload } from '../lib/payloadDecoder';
import { normalizeEnvelope, normalizeEnvelopes } from '../lib/envelopeNormalizer';
import { formatDateTime } from '../lib/datetime';
import { debugLog } from '../lib/debug';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NewsStackParamList } from '../navigation/types';
import { MSG_TYPE_NAME, normalizeMsgId, type Envelope } from '@ogmara/sdk';
import { showAlert } from '../components/AlertHost';
import Button from '../components/Button';

type Props = NativeStackScreenProps<NewsStackParamList, 'NewsDetail'>;

/** 30-minute edit window */
const EDIT_WINDOW_MS = 30 * 60 * 1000;
/** The node returns at most 200 comments inline; never render more. */
const MAX_COMMENTS = 200;
/** How long a linked comment stays highlighted. */
const COMMENT_HIGHLIGHT_MS = 4000;

/** Hex id of an envelope (`msg_id` may arrive as hex or bytes). */
function hexId(m: { msg_id: unknown }): string {
  const id = m.msg_id;
  if (typeof id === 'string') return id.toLowerCase();
  if (id instanceof Uint8Array || Array.isArray(id)) {
    return Array.from(id as ArrayLike<number>).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return '';
}


export default function NewsDetailScreen({ route, navigation }: Props) {
  const { post: passedPost } = route.params;
  // Canonical (lower-case hex) when it is a msg_id; link params were already
  // validated by `parsePermalink` (deepLinkPaths.ts).
  const msgId = normalizeMsgId(route.params.msgId) ?? route.params.msgId;
  const commentTarget = normalizeMsgId(route.params.commentId);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress } = useConnection();
  const [toast, showToast] = useToast();

  // Post + comments from the node. Keyed by (client, msgId): a result for a
  // previous post or node is ignored.
  const [fetched, setFetched] = useState<{ key: string; post: Envelope | null; comments: Envelope[] } | null>(null);
  const [fetchFailed, setFetchFailed] = useState(false);
  // Bumped after posting a comment so the list reloads with it.
  const [reloadNonce, setReloadNonce] = useState(0);
  const fetchKey = `${(client as { nodeUrl?: string } | null)?.nodeUrl ?? ''}|${msgId}`;
  useEffect(() => {
    if (!client || !msgId) return;
    let cancelled = false;
    setFetchFailed(false);
    client.getNewsPost(msgId)
      .then((r) => {
        if (cancelled) return;
        const comments = Array.isArray(r?.comments) ? normalizeEnvelopes(r.comments.slice(0, MAX_COMMENTS)) : [];
        setFetched({ key: fetchKey, post: r?.post ?? null, comments });
      })
      .catch((e) => {
        if (cancelled) return;
        debugLog('warn', `News post fetch failed: ${e instanceof Error ? e.message : ''}`);
        setFetchFailed(true);
      });
    return () => { cancelled = true; };
  }, [client, msgId, fetchKey, reloadNonce]);
  const current = fetched && fetched.key === fetchKey ? fetched : null;
  const rawPost = passedPost ?? current?.post ?? undefined;
  const comments = useMemo(
    () => [...(current?.comments ?? [])].sort((a, b) => Number(a.timestamp) - Number(b.timestamp)),
    [current],
  );
  // Seeded from the server's counts — see the same fix in NewsFeedScreen. This
  // screen renders the post object handed over by the feed, which carries the
  // node's `reaction_counts`; starting at `{}` meant other people's reactions
  // were invisible here too.
  const seededCounts =
    (rawPost as unknown as { reaction_counts?: Record<string, number> } | undefined)
      ?.reaction_counts ?? {};
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>(seededCounts);
  // Opened from a link: no feed post to seed from — take the fetched post's.
  const fetchedCounts = passedPost ? undefined
    : (current?.post as unknown as { reaction_counts?: Record<string, number> } | undefined)?.reaction_counts;
  useEffect(() => {
    if (fetchedCounts) setReactionCounts(fetchedCounts);
  }, [fetchedCounts]);
  const [bookmarked, setBookmarked] = useState(false);
  const [reposted, setReposted] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [showTip, setShowTip] = useState(false);
  const { verified: authorVerified } = useUserDisplay(rawPost?.author);

  const post = rawPost ? normalizeEnvelope(rawPost) : null;
  // `Envelope.msg_type` is typed `number` (the signed wire envelope's
  // representation), but the node's REST responses serialize it as the Rust
  // enum's variant NAME string (e.g. "NewsRepost") — see @ogmara/sdk's
  // `isNewsEnvelope`/`MSG_TYPE_NAME` doc comments for the same duality.
  const msgTypeName =
    typeof post?.msg_type === 'number'
      ? MSG_TYPE_NAME[post.msg_type]
      : (post?.msg_type as unknown as string | undefined);
  const isRepost = msgTypeName === 'NewsRepost';
  // A NewsRepost payload only carries {original_id, original_author, comment}
  // — no title/content — so decoding it as a NewsPost is meaningless. The
  // l2-node enriches repost feed items with original_* / repost_comment
  // fields instead.
  const decoded = post && !isRepost ? decodeNewsPost(post.payload) : null;
  const repostFields = post as unknown as {
    repost_comment?: string;
    original_available?: boolean;
    original_id?: string;
    original_author?: string;
    original_title?: string;
    original_content?: string;
    original_deleted?: boolean;
  } | null;

  const isOwn = post?.author === myAddress;
  const canEdit = useMemo(() => {
    if (!isOwn || !post) return false;
    return (Date.now() - new Date(post.timestamp).getTime()) < EDIT_WINDOW_MS;
  }, [isOwn, post]);

  const handleReaction = useCallback(
    async (emoji: string) => {
      if (!client || !signer) return;
      try {
        await client.reactToNews(msgId, emoji);
        setReactionCounts((prev) => ({
          ...prev,
          [emoji]: (prev[emoji] ?? 0) + 1,
        }));
      } catch (e) {
        debugLog('warn', `Reaction failed: ${e instanceof Error ? e.message : e}`);
      }
    },
    [client, signer, msgId],
  );

  const handleBookmark = useCallback(async () => {
    if (!client || !signer) return;
    try {
      if (bookmarked) {
        await client.removeBookmark(msgId);
        setBookmarked(false);
      } else {
        await client.saveBookmark(msgId);
        setBookmarked(true);
      }
    } catch (e) {
      debugLog('warn', `Bookmark failed: ${e instanceof Error ? e.message : e}`);
    }
  }, [client, signer, msgId, bookmarked]);

  const handleRepost = useCallback(async () => {
    if (reposted || !client || !signer || !post) return;
    try {
      await client.repostNews(msgId, post.author);
      setReposted(true);
      showAlert(t('news_reposted'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Repost failed: ${msg}`);
      showAlert(t('error_generic'), msg.slice(0, 100));
    }
  }, [client, signer, msgId, post, reposted]);

  const handleReply = useCallback(async () => {
    if (!replyText.trim() || !client || !signer) return;
    setReplySending(true);
    try {
      await client.postComment(msgId, replyText.trim());
      setReplyText('');
      setReloadNonce((n) => n + 1);
      showAlert(t('news_reply_sent'));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Reply failed: ${msg}`);
      showAlert(t('error_generic'), msg.slice(0, 100));
    } finally {
      setReplySending(false);
    }
  }, [client, signer, replyText, msgId]);

  const handleEdit = useCallback(() => {
    if (!decoded || !canEdit) return;
    navigation.navigate('ComposePost', {
      editMsgId: msgId,
      editTitle: decoded.title,
      editContent: decoded.content,
      editTags: decoded.tags,
    });
  }, [decoded, canEdit, msgId, navigation]);

  const handleDelete = useCallback(async () => {
    if (!client || !signer || !isOwn) return;
    showAlert(
      t('chat_delete'),
      t('confirm_delete'),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('chat_delete'),
          style: 'destructive',
          onPress: async () => {
            try {
              await client.deleteNews(msgId);
              setDeleted(true);
            } catch (e) {
              debugLog('warn', `Delete news failed: ${e instanceof Error ? e.message : ''}`);
              showAlert(t('error_generic'), e instanceof Error ? e.message : '');
            }
          },
        },
      ],
    );
  }, [client, signer, isOwn, msgId, t]);

  // Share links (spec 06 §6.5): the post through the OS share sheet, a
  // comment copied to the clipboard.
  const handleShare = useCallback(async () => {
    const url = buildNewsShareUrl(msgId);
    if (!url) { showToast(t('share_link_failed')); return; }
    try {
      await Share.share({ message: url });
    } catch (e) {
      debugLog('warn', `Share post failed: ${e instanceof Error ? e.message : ''}`);
    }
  }, [msgId, showToast, t]);
  const handleCopyCommentLink = useCallback(async (commentId: string) => {
    const url = buildNewsShareUrl(msgId, commentId);
    if (!url) { showToast(t('share_link_failed')); return; }
    try {
      await Clipboard.setStringAsync(url);
      showToast(t('share_link_copied'));
    } catch {
      showToast(t('share_link_failed'));
    }
  }, [msgId, showToast, t]);

  // News-comment permalink: scroll to + highlight the comment once both the
  // comments and its row's position are known. A comment beyond the node's
  // 200-comment cap just leaves the post open.
  const scrollRef = useRef<ScrollViewInstance>(null);
  const commentY = useRef<Map<string, number>>(new Map());
  const commentsTopRef = useRef(-1); // -1 until the section is laid out
  const [highlightComment, setHighlightComment] = useState<string | null>(null);
  const landedCommentRef = useRef<string | null>(null);
  const tryLandComment = useCallback(() => {
    if (!commentTarget || landedCommentRef.current === commentTarget || commentsTopRef.current < 0) return;
    const y = commentY.current.get(commentTarget);
    if (y === undefined) return;
    landedCommentRef.current = commentTarget;
    scrollRef.current?.scrollTo({ y: Math.max(0, commentsTopRef.current + y - 80), animated: true });
    setHighlightComment(commentTarget);
  }, [commentTarget]);
  useEffect(() => {
    if (!highlightComment) return;
    const timer = setTimeout(() => setHighlightComment(null), COMMENT_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [highlightComment]);

  if (deleted) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.textSecondary }}>{t('chat_message_deleted')}</Text>
      </View>
    );
  }

  if (!post && !fetchFailed && client) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator color={colors.textSecondary} />
      </View>
    );
  }

  if (!post || (!decoded && !isRepost)) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.textSecondary }}>{t('error_not_found')}</Text>
      </View>
    );
  }

  return (
    <KeyboardAwareView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
    >
      <ScrollView style={styles.scroll} ref={scrollRef}>
        <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
          <TouchableOpacity
            style={styles.authorRow}
            onPress={() => navigation.navigate('UserProfile', { address: post.author })}
          >
            <Text style={[styles.author, { color: colors.accentPrimary }]}>
              {post.author.slice(0, 20)}...
            </Text>
            <VerifiedBadge verified={authorVerified} />
          </TouchableOpacity>

          {isRepost ? (
            <>
              {repostFields?.repost_comment ? (
                <Text style={[styles.content, { color: colors.textPrimary }]}>
                  {repostFields.repost_comment}
                </Text>
              ) : null}
              {repostFields?.original_available ? (
                <TouchableOpacity
                  style={[styles.repostQuote, { borderColor: colors.border }]}
                  activeOpacity={0.8}
                  onPress={() =>
                    repostFields.original_id &&
                    navigation.push('NewsDetail', { msgId: repostFields.original_id })
                  }
                >
                  <Text style={[styles.repostQuoteAuthor, { color: colors.textSecondary }]}>
                    {repostFields.original_author ? `${repostFields.original_author.slice(0, 20)}...` : ''}
                  </Text>
                  {repostFields.original_deleted ? (
                    <Text style={{ color: colors.textSecondary, fontStyle: 'italic' }}>
                      {t('chat_message_deleted')}
                    </Text>
                  ) : (
                    <>
                      {repostFields.original_title ? (
                        <Text style={[styles.repostQuoteTitle, { color: colors.textPrimary }]}>
                          {repostFields.original_title}
                        </Text>
                      ) : null}
                      <Text style={{ color: colors.textSecondary }}>{repostFields.original_content}</Text>
                    </>
                  )}
                </TouchableOpacity>
              ) : (
                <Text style={{ color: colors.textSecondary, fontStyle: 'italic' }}>
                  {t('news_original_unavailable')}
                </Text>
              )}
            </>
          ) : (
            <>
              {decoded!.title ? (
                <Text style={[styles.title, { color: colors.textPrimary }]}>{decoded!.title}</Text>
              ) : null}

              <View style={styles.contentWrap}>
                <FormattedText content={decoded!.content} />
              </View>

              {/* Inline image attachments */}
              {decoded!.attachments && decoded!.attachments.length > 0 && client && (
                <View style={styles.attachRow}>
                  {decoded!.attachments.filter((a) => a.mime_type.startsWith('image/')).map((att, idx) => (
                    <TouchableOpacity
                      key={idx}
                      activeOpacity={0.9}
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

          {decoded?.tags && decoded.tags.length > 0 && (
            <View style={styles.tagRow}>
              {decoded.tags.map((tag) => (
                <View key={tag} style={[styles.tag, { backgroundColor: colors.bgTertiary }]}>
                  <Text style={[styles.tagText, { color: colors.accentPrimary }]}>#{tag}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Reactions — collapsed until somebody actually reacts. */}
          <View style={styles.actions}>
            <NewsReactionBar counts={reactionCounts} onReact={handleReaction} colors={colors} />
          </View>

          {/* Meta actions */}
          <View style={styles.metaActions}>
            <TouchableOpacity
              style={[styles.metaBtn, reposted && { opacity: 0.5 }]}
              onPress={handleRepost}
              disabled={reposted}
            >
              <Text style={{ color: reposted ? colors.accentPrimary : colors.textSecondary }}>
                ↗ {reposted ? t('news_reposted') : t('news_repost')}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity style={styles.metaBtn} onPress={handleBookmark}>
              <Text style={{ color: bookmarked ? colors.accentPrimary : colors.textSecondary }}>
                {bookmarked ? `★ ${t('news_bookmarked')}` : `☆ ${t('news_bookmark')}`}
              </Text>
            </TouchableOpacity>
            {!isOwn && (
              <TouchableOpacity style={styles.metaBtn} onPress={() => setShowTip(true)}>
                <Text style={{ color: colors.textSecondary }}>💰 {t('chat_tip')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.metaBtn} onPress={() => { void handleShare(); }} accessibilityLabel={t('news_share')}>
              <Text style={{ color: colors.textSecondary }}>🔗 {t('news_share')}</Text>
            </TouchableOpacity>
          </View>

          {/* Owner actions: edit / delete */}
          {isOwn && (
            <View style={[styles.metaActions, { marginTop: spacing.xs }]}>
              {canEdit && (
                <TouchableOpacity style={styles.metaBtn} onPress={handleEdit}>
                  <Text style={{ color: colors.accentPrimary }}>✎ {t('chat_edit')}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity style={styles.metaBtn} onPress={handleDelete}>
                <Text style={{ color: colors.error }}>✕ {t('chat_delete')}</Text>
              </TouchableOpacity>
            </View>
          )}
        </View>

        {/* Comments (inline from the node, capped at 200) */}
        {comments.length > 0 && (
          <View
            style={[styles.commentsSection, { backgroundColor: colors.bgSecondary }]}
            onLayout={(e) => { commentsTopRef.current = e.nativeEvent.layout.y; tryLandComment(); }}
          >
            <Text style={[styles.replyTitle, { color: colors.textSecondary }]}>{t('news_comments')}</Text>
            {comments.map((c) => {
              const id = hexId(c);
              // A deleted comment: placeholder, no decode, no link (as web).
              const isDeleted = (c as { deleted?: boolean }).deleted === true;
              const body = isDeleted ? null : decodePayload(c.payload);
              const text = typeof body?.content === 'string' ? body.content : '';
              const lit = highlightComment !== null && id === highlightComment;
              return (
                <View
                  key={id || `${c.author}-${c.timestamp}`}
                  style={[
                    styles.comment,
                    { borderTopColor: colors.border },
                    lit && { backgroundColor: colors.bgTertiary, borderLeftColor: colors.accentPrimary, borderLeftWidth: 3 },
                  ]}
                  onLayout={(e) => {
                    if (!id) return;
                    commentY.current.set(id, e.nativeEvent.layout.y);
                    if (id === commentTarget) tryLandComment();
                  }}
                >
                  <View style={styles.commentHead}>
                    <TouchableOpacity onPress={() => navigation.navigate('UserProfile', { address: c.author })} style={{ flex: 1 }}>
                      <Text style={[styles.commentAuthor, { color: colors.accentPrimary }]} numberOfLines={1}>
                        {c.author.slice(0, 20)}...
                      </Text>
                    </TouchableOpacity>
                    {!isDeleted && /^[0-9a-f]{64}$/.test(id) && (
                      <TouchableOpacity
                        onPress={() => { void handleCopyCommentLink(id); }}
                        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        accessibilityLabel={t('share_comment_link')}
                      >
                        <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm }}>🔗</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                  {isDeleted ? (
                    <Text style={{ color: colors.textSecondary, fontStyle: 'italic' }}>{t('chat_message_deleted')}</Text>
                  ) : text ? <FormattedText content={text} /> : null}
                  <Text style={[styles.time, { color: colors.textSecondary, marginBottom: 0 }]}>
                    {formatDateTime(c.timestamp)}
                  </Text>
                </View>
              );
            })}
          </View>
        )}

        {/* Reply section */}
        {signer && (
          <View style={[styles.replySection, { backgroundColor: colors.bgSecondary }]}>
            <Text style={[styles.replyTitle, { color: colors.textSecondary }]}>{t('chat_reply')}</Text>
            <TextInput
              style={[styles.replyInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder={t('news_reply_placeholder')}
              placeholderTextColor={colors.textSecondary}
              value={replyText}
              onChangeText={setReplyText}
              multiline
              maxLength={2000}
              textAlignVertical="top"
            />
            <Button
              label={t('news_send_reply')}
              onPress={handleReply}
              loading={replySending}
              disabled={!replyText.trim()}
              size="sm"
            />
          </View>
        )}
      </ScrollView>
      <ImageViewerModal uri={viewerImage} onClose={() => setViewerImage(null)} />
      <TipDialog
        visible={showTip}
        recipientAddress={post.author}
        onClose={() => setShowTip(false)}
      />
      <Toast message={toast} />
    </KeyboardAwareView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: { margin: spacing.md, padding: spacing.md, borderRadius: radius.lg },
  authorRow: { flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm },
  author: { fontSize: fontSize.sm, fontWeight: '600' },
  title: { fontSize: fontSize.xl, fontWeight: '700', lineHeight: 28, marginBottom: spacing.sm },
  content: { fontSize: fontSize.md, lineHeight: 24, marginBottom: spacing.md },
  contentWrap: { marginBottom: spacing.md },
  attachRow: { gap: spacing.sm, marginBottom: spacing.md },
  repostQuote: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  repostQuoteAuthor: { fontSize: fontSize.xs, marginBottom: 2 },
  repostQuoteTitle: { fontSize: fontSize.md, fontWeight: '600', marginBottom: 2 },
  time: { fontSize: fontSize.xs, marginBottom: spacing.sm },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.md },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm },
  tagText: { fontSize: fontSize.xs, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  metaActions: {
    flexDirection: 'row',
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.2)',
    paddingTop: spacing.sm,
  },
  metaBtn: { paddingVertical: 4, paddingHorizontal: 8 },
  commentsSection: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
  },
  comment: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xs,
    borderRadius: radius.sm,
  },
  commentHead: { flexDirection: 'row', alignItems: 'center', marginBottom: 2, gap: spacing.sm },
  commentAuthor: { fontSize: fontSize.xs, fontWeight: '600' },
  replySection: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.xl,
    padding: spacing.md,
    borderRadius: radius.lg,
  },
  replyTitle: { fontSize: fontSize.sm, fontWeight: '600', textTransform: 'uppercase', marginBottom: spacing.sm },
  replyInput: {
    minHeight: 80,
    padding: spacing.md,
    borderRadius: radius.md,
    fontSize: fontSize.md,
    marginBottom: spacing.md,
  },
  replyBtn: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
});
