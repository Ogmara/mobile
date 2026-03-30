/**
 * FormattedText — renders message content with clickable URLs, inline formatting, and images.
 *
 * Supports: **bold**, *italic*, __underline__, `code`, ~~strikethrough~~
 * URLs open in system browser via Linking.
 * Image attachments render inline.
 */

import React, { useMemo } from 'react';
import { Text, Image, Linking, StyleSheet, View, TouchableOpacity } from 'react-native';
import { parseMessageContent, type TextSegment, type Attachment } from '@ogmara/sdk';
import { useTheme, spacing, fontSize, radius } from '../theme';

/** Image MIME types that render inline. */
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];

interface Props {
  content: string;
  attachments?: Attachment[];
  /** Base URL for fetching IPFS media via the node. */
  mediaBaseUrl?: string;
}

export default function FormattedText({ content, attachments, mediaBaseUrl }: Props) {
  const { colors } = useTheme();
  const segments = useMemo(() => parseMessageContent(content), [content]);

  const getMediaUrl = (cid: string) =>
    mediaBaseUrl ? `${mediaBaseUrl}/api/v1/media/${encodeURIComponent(cid)}` : '';

  const renderSegment = (seg: TextSegment, idx: number) => {
    switch (seg.type) {
      case 'url': {
        // Defense-in-depth: only allow http/https links
        const safe = seg.url.startsWith('http://') || seg.url.startsWith('https://');
        return (
          <Text
            key={idx}
            style={safe ? [styles.link, { color: colors.accentPrimary }] : undefined}
            onPress={safe ? () => Linking.openURL(seg.url) : undefined}
          >
            {seg.display}
          </Text>
        );
      }
      case 'bold':
        return <Text key={idx} style={styles.bold}>{seg.content}</Text>;
      case 'italic':
        return <Text key={idx} style={styles.italic}>{seg.content}</Text>;
      case 'underline':
        return <Text key={idx} style={styles.underline}>{seg.content}</Text>;
      case 'code':
        return (
          <Text key={idx} style={[styles.code, { backgroundColor: colors.bgTertiary }]}>
            {seg.content}
          </Text>
        );
      case 'strikethrough':
        return <Text key={idx} style={styles.strikethrough}>{seg.content}</Text>;
      default:
        return <Text key={idx}>{seg.content}</Text>;
    }
  };

  return (
    <View>
      <Text style={{ color: colors.textPrimary, fontSize: fontSize.md, lineHeight: 22 }}>
        {segments.map(renderSegment)}
      </Text>

      {/* Inline images from attachments */}
      {attachments && attachments.length > 0 && (
        <View style={styles.attachments}>
          {attachments.map((att, idx) => {
            const isImage = IMAGE_TYPES.includes(att.mime_type);
            if (isImage) {
              const url = att.thumbnail_cid
                ? getMediaUrl(att.thumbnail_cid)
                : getMediaUrl(att.cid);
              return (
                <TouchableOpacity
                  key={idx}
                  onPress={() => Linking.openURL(getMediaUrl(att.cid))}
                  activeOpacity={0.8}
                >
                  <Image
                    source={{ uri: url }}
                    style={styles.image}
                    resizeMode="cover"
                  />
                </TouchableOpacity>
              );
            }
            return (
              <TouchableOpacity
                key={idx}
                style={[styles.file, { backgroundColor: colors.bgTertiary }]}
                onPress={() => Linking.openURL(getMediaUrl(att.cid))}
              >
                <Text style={{ color: colors.accentPrimary, fontSize: fontSize.sm }}>
                  {att.filename || att.cid.slice(0, 12) + '...'}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  link: { textDecorationLine: 'underline' },
  bold: { fontWeight: '700' },
  italic: { fontStyle: 'italic' },
  underline: { textDecorationLine: 'underline' },
  code: {
    fontFamily: 'monospace',
    paddingHorizontal: 3,
    borderRadius: 3,
  },
  strikethrough: { textDecorationLine: 'line-through' },
  attachments: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  image: {
    width: 200,
    height: 150,
    borderRadius: radius.md,
  },
  file: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
});
