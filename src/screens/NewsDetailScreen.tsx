/**
 * News Detail — single news post with reactions, bookmark, repost, reply.
 *
 * Receives post data from the feed to avoid 404 on missing single-post endpoint.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { decodeNewsPost } from '../lib/payloadDecoder';
import { normalizeEnvelope } from '../lib/envelopeNormalizer';
import { debugLog } from '../lib/debug';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NewsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<NewsStackParamList, 'NewsDetail'>;

const NEWS_REACTIONS = ['👍', '👎', '❤️', '🔥', '😂'];

export default function NewsDetailScreen({ route, navigation }: Props) {
  const { msgId, post: rawPost } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer } = useConnection();
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({});
  const [bookmarked, setBookmarked] = useState(false);
  const [reposted, setReposted] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replySending, setReplySending] = useState(false);

  const post = rawPost ? normalizeEnvelope(rawPost) : null;
  const decoded = post ? decodeNewsPost(post.payload) : null;

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
      Alert.alert('Reposted', 'Post shared to your followers');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Repost failed: ${msg}`);
      Alert.alert('Repost failed', msg.slice(0, 100));
    }
  }, [client, signer, msgId, post, reposted]);

  const handleReply = useCallback(async () => {
    if (!replyText.trim() || !client || !signer) return;
    setReplySending(true);
    try {
      await client.postComment(msgId, replyText.trim());
      setReplyText('');
      Alert.alert('Reply sent');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Reply failed: ${msg}`);
      Alert.alert('Reply failed', msg.slice(0, 100));
    } finally {
      setReplySending(false);
    }
  }, [client, signer, replyText, msgId]);

  if (!post || !decoded) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.textSecondary }}>{t('error_not_found')}</Text>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView style={styles.scroll}>
        <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
          <TouchableOpacity onPress={() => navigation.navigate('UserProfile', { address: post.author })}>
            <Text style={[styles.author, { color: colors.accentPrimary }]}>
              {post.author.slice(0, 20)}...
            </Text>
          </TouchableOpacity>

          {decoded.title ? (
            <Text style={[styles.title, { color: colors.textPrimary }]}>{decoded.title}</Text>
          ) : null}

          <Text style={[styles.content, { color: colors.textPrimary }]}>{decoded.content}</Text>

          <Text style={[styles.time, { color: colors.textSecondary }]}>
            {new Date(post.timestamp).toLocaleDateString()}
          </Text>

          {decoded.tags && decoded.tags.length > 0 && (
            <View style={styles.tagRow}>
              {decoded.tags.map((tag) => (
                <View key={tag} style={[styles.tag, { backgroundColor: colors.bgTertiary }]}>
                  <Text style={[styles.tagText, { color: colors.accentPrimary }]}>#{tag}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Reactions */}
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
                {bookmarked ? '★ Saved' : '☆ Bookmark'}
              </Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* Reply section */}
        {signer && (
          <View style={[styles.replySection, { backgroundColor: colors.bgSecondary }]}>
            <Text style={[styles.replyTitle, { color: colors.textSecondary }]}>Reply</Text>
            <TextInput
              style={[styles.replyInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder="Write a reply..."
              placeholderTextColor={colors.textSecondary}
              value={replyText}
              onChangeText={setReplyText}
              multiline
              maxLength={2000}
              textAlignVertical="top"
            />
            <TouchableOpacity
              style={[styles.replyBtn, { backgroundColor: replySending || !replyText.trim() ? colors.textSecondary : colors.accentPrimary }]}
              onPress={handleReply}
              disabled={replySending || !replyText.trim()}
            >
              <Text style={[styles.replyBtnText, { color: colors.textInverse }]}>
                {replySending ? 'Sending...' : 'Send Reply'}
              </Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: { margin: spacing.md, padding: spacing.md, borderRadius: radius.lg },
  author: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.sm },
  title: { fontSize: fontSize.xl, fontWeight: '700', lineHeight: 28, marginBottom: spacing.sm },
  content: { fontSize: fontSize.md, lineHeight: 24, marginBottom: spacing.md },
  time: { fontSize: fontSize.xs, marginBottom: spacing.sm },
  tagRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.md },
  tag: { paddingHorizontal: 8, paddingVertical: 4, borderRadius: radius.sm },
  tagText: { fontSize: fontSize.xs, fontWeight: '600' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginBottom: spacing.sm },
  reactionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    gap: 4,
  },
  reactionEmoji: { fontSize: fontSize.lg },
  reactionCount: { fontSize: fontSize.sm, fontWeight: '600' },
  metaActions: {
    flexDirection: 'row',
    gap: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(128,128,128,0.2)',
    paddingTop: spacing.sm,
  },
  metaBtn: { paddingVertical: 4, paddingHorizontal: 8 },
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
  replyBtnText: { fontSize: fontSize.md, fontWeight: '600' },
});
