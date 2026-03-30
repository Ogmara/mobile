/**
 * News Detail — single news post with comments, reactions, bookmark, repost.
 */

import React, { useState, useCallback } from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator, TouchableOpacity } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NewsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<NewsStackParamList, 'NewsDetail'>;

const NEWS_REACTIONS = ['👍', '👎', '❤️', '🔥', '😂'];

export default function NewsDetailScreen({ route }: Props) {
  const { msgId } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client } = useConnection();
  const [reactionCounts, setReactionCounts] = useState<Record<string, number>>({});
  const [bookmarked, setBookmarked] = useState(false);
  const [reposted, setReposted] = useState(false);

  const { data, loading, error } = useApi(
    async () => {
      if (!client) throw new Error('Not connected');
      return client.getNewsPost(msgId);
    },
    [msgId, client],
  );

  const handleReaction = useCallback(
    async (emoji: string) => {
      if (!client) return;
      try {
        await client.reactToNews(msgId, emoji);
        setReactionCounts((prev) => ({
          ...prev,
          [emoji]: (prev[emoji] ?? 0) + 1,
        }));
      } catch {}
    },
    [client, msgId],
  );

  const handleBookmark = useCallback(async () => {
    if (!client) return;
    try {
      if (bookmarked) {
        await client.removeBookmark(msgId);
        setBookmarked(false);
      } else {
        await client.saveBookmark(msgId);
        setBookmarked(true);
      }
    } catch {}
  }, [client, msgId, bookmarked]);

  const handleRepost = useCallback(async () => {
    if (reposted || !client || !data) return;
    try {
      await client.repostNews(msgId, data.post.author);
      setReposted(true);
    } catch {}
  }, [client, msgId, data, reposted]);

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator color={colors.accentPrimary} size="large" />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.error }}>{error || t('error_not_found')}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.author, { color: colors.accentPrimary }]}>
          {data.post.author}
        </Text>
        <Text style={[styles.content, { color: colors.textPrimary }]}>
          {data.post.payload}
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
        </View>
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
              {bookmarked ? '★' : '☆'} {bookmarked ? t('news_bookmarked') : t('news_bookmark')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('news_comments')} ({data.comments.length})
      </Text>

      {data.comments.map((comment) => (
        <View
          key={comment.msg_id}
          style={[styles.comment, { backgroundColor: colors.bgSecondary }]}
        >
          <Text style={[styles.commentAuthor, { color: colors.accentPrimary }]}>
            {comment.author}
          </Text>
          <Text style={{ color: colors.textPrimary }}>{comment.payload}</Text>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  card: { margin: spacing.md, padding: spacing.md, borderRadius: radius.lg },
  author: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.sm },
  content: { fontSize: fontSize.md, lineHeight: 24, marginBottom: spacing.md },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    marginBottom: spacing.sm,
  },
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
  metaBtn: {
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  sectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  comment: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.md,
  },
  commentAuthor: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.xs },
});
