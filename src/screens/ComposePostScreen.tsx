/**
 * Compose Post — create a new news post with optional media attachments.
 *
 * Input for title, content, optional tags, and image/video picker.
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
  Image,
  ActivityIndicator,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import type { Attachment } from '@ogmara/sdk';

interface PendingAttachment {
  uri: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  /** Set after successful upload */
  uploaded?: Attachment;
}

export default function ComposePostScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer } = useConnection();
  const navigation = useNavigation();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tags, setTags] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [uploading, setUploading] = useState(false);

  const pickImage = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 5,
      quality: 0.8,
    });

    if (result.canceled || !result.assets) return;

    const newAttachments: PendingAttachment[] = result.assets.map((asset) => ({
      uri: asset.uri,
      mimeType: asset.mimeType ?? 'application/octet-stream',
      fileName: asset.fileName ?? `file-${Date.now()}`,
      fileSize: asset.fileSize ?? 0,
    }));

    setAttachments((prev) => [...prev, ...newAttachments].slice(0, 10));
  };

  const removeAttachment = (index: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  };

  /** Sanitize filename: strip path separators and non-printable characters. */
  const sanitizeFilename = (name: string): string =>
    name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);

  const uploadAttachments = async (): Promise<Attachment[]> => {
    if (!client || attachments.length === 0) return [];
    setUploading(true);

    try {
      const uploaded: Attachment[] = [];
      for (const att of attachments) {
        if (att.uploaded) {
          uploaded.push(att.uploaded);
          continue;
        }
        try {
          const safeName = sanitizeFilename(att.fileName);
          const resp = await fetch(att.uri);
          const blob = await resp.blob();
          const result = await client.uploadMedia(blob, safeName);
          const attachment: Attachment = {
            cid: result.cid,
            mime_type: att.mimeType,
            size_bytes: att.fileSize || result.size,
            filename: safeName,
            thumbnail_cid: result.thumbnail_cid,
          };
          att.uploaded = attachment;
          uploaded.push(attachment);
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Upload failed';
          if (msg.includes('404') || msg.includes('Network request failed')) {
            Alert.alert('Media upload unavailable', 'The node does not support media uploads yet. Your post will be submitted without attachments.');
            return uploaded; // skip remaining uploads
          }
          Alert.alert('Upload error', `${att.fileName}: ${msg}`);
        }
      }
      return uploaded;
    } finally {
      setUploading(false);
    }
  };

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

      // Upload media first (if any)
      const uploadedAttachments = await uploadAttachments();

      await client.postNews(title.trim(), content.trim(), {
        tags: tagList,
        attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
      });
      navigation.goBack();
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    } finally {
      setSubmitting(false);
    }
  };

  const isImage = (mime: string) => mime.startsWith('image/');

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

        {/* Attachment previews */}
        {attachments.length > 0 && (
          <View style={styles.attachmentList}>
            {attachments.map((att, idx) => (
              <View key={idx} style={[styles.attachmentItem, { backgroundColor: colors.bgSecondary }]}>
                {isImage(att.mimeType) ? (
                  <Image source={{ uri: att.uri }} style={styles.attachmentThumb} />
                ) : (
                  <View style={[styles.attachmentThumb, { justifyContent: 'center', alignItems: 'center' }]}>
                    <Ionicons name="videocam" size={24} color={colors.textSecondary} />
                  </View>
                )}
                <Text style={[styles.attachmentName, { color: colors.textPrimary }]} numberOfLines={1}>
                  {att.fileName}
                </Text>
                <TouchableOpacity onPress={() => removeAttachment(idx)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                  <Ionicons name="close-circle" size={20} color={colors.error} />
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Media picker + tags */}
        <View style={styles.toolRow}>
          <TouchableOpacity
            style={[styles.mediaBtn, { backgroundColor: colors.bgSecondary }]}
            onPress={pickImage}
          >
            <Ionicons name="image-outline" size={20} color={colors.accentPrimary} />
            <Text style={[styles.mediaBtnText, { color: colors.accentPrimary }]}>
              Add Media
            </Text>
          </TouchableOpacity>
          {uploading && <ActivityIndicator color={colors.accentPrimary} />}
        </View>

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
  toolRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.md,
  },
  mediaBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  mediaBtnText: { fontSize: fontSize.sm, fontWeight: '600' },
  attachmentList: { marginTop: spacing.md, gap: spacing.xs },
  attachmentItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.xs,
    borderRadius: radius.md,
    gap: spacing.sm,
  },
  attachmentThumb: { width: 40, height: 40, borderRadius: radius.sm },
  attachmentName: { flex: 1, fontSize: fontSize.sm },
  submitBtn: {
    margin: spacing.md,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  submitText: { fontSize: fontSize.md, fontWeight: '600' },
});
