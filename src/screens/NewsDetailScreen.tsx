/**
 * News Detail — single news post with comments.
 *
 * Reached by tapping a post in the NewsFeed. Shows full post content,
 * author info, and comments thread.
 */

import React from 'react';
import { View, Text, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NewsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<NewsStackParamList, 'NewsDetail'>;

export default function NewsDetailScreen({ route }: Props) {
  const { msgId } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client } = useConnection();

  const { data, loading, error } = useApi(
    async () => {
      if (!client) throw new Error('Not connected');
      return client.getNewsPost(msgId);
    },
    [msgId, client],
  );

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
  content: { fontSize: fontSize.md, lineHeight: 24 },
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
