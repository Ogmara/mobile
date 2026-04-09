/**
 * Compose Post — create or edit a news post with optional media attachments.
 *
 * When route params include `editMsgId`, operates in edit mode:
 * pre-fills title/content/tags and calls editNews instead of postNews.
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
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import type { Attachment } from '@ogmara/sdk';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { NewsStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<NewsStackParamList, 'ComposePost'>;

interface PendingAttachment {
  uri: string;
  mimeType: string;
  fileName: string;
  fileSize: number;
  uploaded?: Attachment;
}

export default function ComposePostScreen({ route, navigation }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer } = useConnection();

  // Edit mode: pre-fill from route params
  const editMsgId = route.params?.editMsgId;
  const isEdit = !!editMsgId;

  const [title, setTitle] = useState(route.params?.editTitle || '');
  const [content, setContent] = useState(route.params?.editContent || '');
  const [tags, setTags] = useState((route.params?.editTags || []).join(', '));
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

  const sanitizeFilename = (name: string): string =>
    name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);

  const uploadAttachments = async (): Promise<Attachment[]> => {
    if (!client || attachments.length === 0) return [];
    setUploading(true);

    try {
      const uploaded: Attachment[] = [];
      const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
      for (const att of attachments) {
        if (att.uploaded) {
          uploaded.push(att.uploaded);
          continue;
        }
        if (att.fileSize > MAX_FILE_SIZE) {
          Alert.alert(t('error_generic'), `${att.fileName}: file too large (max 50MB)`);
          continue;
        }
        try {
          const safeName = sanitizeFilename(att.fileName);
          // React Native FormData needs {uri, type, name} — not a Blob
          const formData = new FormData();
          formData.append('file', {
            uri: att.uri,
            type: att.mimeType,
            name: safeName,
          } as any);

          const headers = signer ? await signer.signRequest('POST', '/api/v1/media/upload') : {};
          const nodeUrl = (client as any).nodeUrl || '';
          const uploadResp = await fetch(`${nodeUrl}/api/v1/media/upload`, {
            method: 'POST',
            headers: { ...headers },
            body: formData,
          });
          if (!uploadResp.ok) {
            const errText = await uploadResp.text().catch(() => '');
            throw new Error(`Upload failed (${uploadResp.status}): ${errText.slice(0, 150)}`);
          }
          const result = await uploadResp.json();
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
            Alert.alert(t('news_upload_unavailable'), t('news_upload_fallback'));
            return uploaded;
          }
          Alert.alert(t('error_generic'), `${att.fileName}: ${msg}`);
        }
      }
      return uploaded;
    } finally {
      setUploading(false);
    }
  };

  const handleSubmit = async () => {
    if (!content.trim()) {
      Alert.alert(t('error_generic'), t('news_content_required'));
      return;
    }
    if (!isEdit && !title.trim()) {
      Alert.alert(t('error_generic'), t('news_title_required'));
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

      if (isEdit) {
        // Edit existing post
        await client.editNews(editMsgId!, content.trim(), {
          title: title.trim() || undefined,
          tags: tagList.length > 0 ? tagList : undefined,
        });
      } else {
        // Create new post
        const uploadedAttachments = await uploadAttachments();
        await client.postNews(title.trim(), content.trim(), {
          tags: tagList,
          attachments: uploadedAttachments.length > 0 ? uploadedAttachments : undefined,
        });
      }
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
          placeholder={t('news_title_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={title}
          onChangeText={setTitle}
          maxLength={200}
          autoFocus={!isEdit}
        />
        <TextInput
          style={[styles.bodyInput, { color: colors.textPrimary }]}
          placeholder={t('news_content_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={content}
          onChangeText={setContent}
          maxLength={10000}
          multiline
          textAlignVertical="top"
          autoFocus={isEdit}
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

        {/* Media picker + tags (only for new posts — edits can't add attachments) */}
        {!isEdit && (
          <View style={styles.toolRow}>
            <TouchableOpacity
              style={[styles.mediaBtn, { backgroundColor: colors.bgSecondary }]}
              onPress={pickImage}
            >
              <Ionicons name="image-outline" size={20} color={colors.accentPrimary} />
              <Text style={[styles.mediaBtnText, { color: colors.accentPrimary }]}>
                {t('news_add_media')}
              </Text>
            </TouchableOpacity>
            {uploading && <ActivityIndicator color={colors.accentPrimary} />}
          </View>
        )}

        <TextInput
          style={[styles.tagsInput, { color: colors.textPrimary, backgroundColor: colors.bgSecondary }]}
          placeholder={t('news_tags_placeholder')}
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
          {submitting ? t('loading') : isEdit ? t('save') : t('news_new_post')}
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
