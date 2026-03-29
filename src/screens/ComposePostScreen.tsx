/**
 * Compose Post — create a new news post.
 *
 * Input for title, content, and optional tags.
 * Requires wallet authentication.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';

export default function ComposePostScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer } = useConnection();
  const navigation = useNavigation();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    if (!title.trim() || !content.trim()) {
      Alert.alert(t('error_generic'), 'Title and content are required');
      return;
    }
    if (!client || !signer) {
      Alert.alert(t('error_generic'), t('wallet_connect'));
      return;
    }

    setSubmitting(true);
    try {
      const tagList = tags
        .split(',')
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0)
        .slice(0, 10);

      await client.postNews(0, title.trim(), content.trim(), tagList);
      navigation.goBack();
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <TextInput
          style={[styles.titleInput, { color: colors.textPrimary, borderBottomColor: colors.border }]}
          placeholder="Title"
          placeholderTextColor={colors.textSecondary}
          value={title}
          onChangeText={setTitle}
          maxLength={200}
          autoFocus
        />
        <TextInput
          style={[styles.bodyInput, { color: colors.textPrimary }]}
          placeholder="Write your post..."
          placeholderTextColor={colors.textSecondary}
          value={content}
          onChangeText={setContent}
          maxLength={10000}
          multiline
          textAlignVertical="top"
        />
        <TextInput
          style={[styles.tagsInput, { color: colors.textPrimary, backgroundColor: colors.bgSecondary }]}
          placeholder="Tags (comma-separated)"
          placeholderTextColor={colors.textSecondary}
          value={tags}
          onChangeText={setTags}
          maxLength={200}
        />
      </ScrollView>

      <TouchableOpacity
        style={[
          styles.submitBtn,
          { backgroundColor: submitting ? colors.textSecondary : colors.accentPrimary },
        ]}
        onPress={handleSubmit}
        disabled={submitting}
      >
        <Text style={[styles.submitText, { color: colors.textInverse }]}>
          {submitting ? t('loading') : t('news_new_post')}
        </Text>
      </TouchableOpacity>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.md },
  titleInput: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  bodyInput: {
    fontSize: fontSize.md,
    lineHeight: 24,
    minHeight: 200,
    paddingVertical: spacing.md,
  },
  tagsInput: {
    fontSize: fontSize.sm,
    padding: spacing.md,
    borderRadius: radius.md,
    marginTop: spacing.md,
  },
  submitBtn: {
    margin: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  submitText: { fontSize: fontSize.md, fontWeight: '600' },
});
