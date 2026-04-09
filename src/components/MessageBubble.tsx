/**
 * Message Bubble — renders a single chat message with long-press menu.
 *
 * Actions on long-press: Reply, React, Edit (own, 30-min window),
 * Delete (own), Tip.
 * Displays: author name, content, timestamp, edited indicator,
 * deleted state, reply context, reaction badges.
 *
 * Per spec 06-frontend.md section 6.1.
 */

import React, { useCallback, useMemo, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  ActionSheetIOS,
  Platform,
  Alert,
  Modal,
  Dimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import type { Envelope } from '@ogmara/sdk';

/** 30-minute edit window matching desktop */
const EDIT_WINDOW_MS = 30 * 60 * 1000;

/** Chat reaction emoji set — matches desktop ReactionPicker */
export const CHAT_REACTIONS = ['👍', '👎', '❤️', '🔥', '😂'];

export interface ReplyContext {
  msgId: string;
  author: string;
  preview: string;
}

export interface MessageAttachment {
  cid: string;
  mime_type: string;
  filename?: string;
  thumbnail_cid?: string;
}

interface Props {
  message: Envelope & {
    deleted?: boolean;
    edited?: boolean;
    last_edited_at?: number;
    reactions?: Record<string, number>;
  };
  content: string;
  isOwn: boolean;
  authorLabel: string;
  attachments?: MessageAttachment[];
  /** Base URL for media (e.g., "https://node.ogmara.org/api/v1/media/") */
  mediaBaseUrl?: string;
  replyContext?: ReplyContext | null;
  onReply?: (msg: Envelope) => void;
  onEdit?: (msg: Envelope) => void;
  onDelete?: (msg: Envelope) => void;
  onReact?: (msg: Envelope, emoji: string) => void;
  onTip?: (msg: Envelope) => void;
  onAuthorPress?: (address: string) => void;
  onReplyPress?: (msgId: string) => void;
  /** Hide author + avatar for grouped consecutive messages */
  isGrouped?: boolean;
}

export default function MessageBubble({
  message,
  content,
  isOwn,
  authorLabel,
  attachments,
  mediaBaseUrl,
  replyContext,
  onReply,
  onEdit,
  onDelete,
  onReact,
  onTip,
  onAuthorPress,
  onReplyPress,
  isGrouped,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactPickerOpen, setReactPickerOpen] = useState(false);

  const canEdit = useMemo(() => {
    if (!isOwn || message.deleted) return false;
    return (Date.now() - new Date(message.timestamp).getTime()) < EDIT_WINDOW_MS;
  }, [isOwn, message.deleted, message.timestamp]);

  const canDelete = isOwn && !message.deleted;

  const handleLongPress = useCallback(() => {
    if (message.deleted) return;
    setMenuOpen(true);
  }, [message.deleted]);

  const handleMenuAction = useCallback((action: string) => {
    setMenuOpen(false);
    switch (action) {
      case 'reply': onReply?.(message); break;
      case 'react': setReactPickerOpen(true); break;
      case 'edit': onEdit?.(message); break;
      case 'delete':
        Alert.alert(t('chat_delete'), t('confirm_delete'), [
          { text: t('cancel'), style: 'cancel' },
          { text: t('chat_delete'), style: 'destructive', onPress: () => onDelete?.(message) },
        ]);
        break;
      case 'tip': onTip?.(message); break;
    }
  }, [message, onReply, onEdit, onDelete, onTip, t]);

  const handleReact = useCallback((emoji: string) => {
    setReactPickerOpen(false);
    onReact?.(message, emoji);
  }, [message, onReact]);

  // Reaction badges — filter to known emoji, cap at 20
  const MAX_REACTION_DISPLAY = 20;
  const activeReactions = useMemo(() => {
    const reactions = message.reactions || {};
    const reactionsSet = new Set(CHAT_REACTIONS);
    return (Object.entries(reactions)
      .filter(([emoji, count]) => reactionsSet.has(emoji) && (count as number) > 0) as [string, number][])
      .slice(0, MAX_REACTION_DISPLAY);
  }, [message.reactions]);

  // Deleted message
  if (message.deleted) {
    return (
      <View style={[styles.container, isOwn && styles.containerOwn]}>
        <View style={[styles.bubble, styles.deletedBubble, { backgroundColor: colors.bgTertiary }]}>
          <Text style={[styles.deletedText, { color: colors.textSecondary }]}>
            {t('chat_message_deleted')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <TouchableOpacity
      onLongPress={handleLongPress}
      delayLongPress={400}
      activeOpacity={0.8}
      style={[styles.container, isOwn && styles.containerOwn]}
    >
      {/* Author name (hidden for grouped messages or own messages) */}
      {!isOwn && !isGrouped && (
        <TouchableOpacity onPress={() => onAuthorPress?.(message.author)}>
          <Text style={[styles.author, { color: colors.accentPrimary }]}>
            {authorLabel}
          </Text>
        </TouchableOpacity>
      )}

      {/* Reply context */}
      {replyContext && (
        <TouchableOpacity
          style={[styles.replyBar, { backgroundColor: colors.bgTertiary, borderLeftColor: colors.accentPrimary }]}
          onPress={() => onReplyPress?.(replyContext.msgId)}
        >
          <Text style={[styles.replyAuthor, { color: colors.accentPrimary }]} numberOfLines={1}>
            {replyContext.author}
          </Text>
          <Text style={[styles.replyPreview, { color: colors.textSecondary }]} numberOfLines={1}>
            {replyContext.preview}
          </Text>
        </TouchableOpacity>
      )}

      {/* Message bubble */}
      <View style={[
        styles.bubble,
        {
          backgroundColor: isOwn ? colors.accentPrimary : colors.bgSecondary,
        },
      ]}>
        {content ? (
          <Text style={{ color: isOwn ? colors.textInverse : colors.textPrimary, lineHeight: 22 }}>
            {content}
          </Text>
        ) : null}
        {/* Inline media attachments */}
        {attachments && attachments.length > 0 && mediaBaseUrl && (
          <View style={styles.attachmentContainer}>
            {attachments.map((att, idx) => {
              const url = `${mediaBaseUrl}${att.cid}`;
              if (att.mime_type.startsWith('image/')) {
                return (
                  <TouchableOpacity key={idx} onPress={() => setViewerImage(url)} activeOpacity={0.8}>
                    <Image
                      source={{ uri: url }}
                      style={styles.inlineImage}
                      resizeMode="cover"
                    />
                  </TouchableOpacity>
                );
              }
              return (
                <View key={idx} style={[styles.fileChip, { backgroundColor: colors.bgTertiary }]}>
                  <Text style={{ color: colors.textPrimary, fontSize: fontSize.xs }}>
                    📎 {att.filename || att.cid.slice(0, 12)}
                  </Text>
                </View>
              );
            })}
          </View>
        )}
      </View>

      {/* Reaction badges */}
      {activeReactions.length > 0 && (
        <View style={styles.reactionRow}>
          {activeReactions.map(([emoji, count]) => (
            <TouchableOpacity
              key={emoji}
              style={[styles.reactionBadge, { backgroundColor: colors.bgTertiary }]}
              onPress={() => onReact?.(message, emoji)}
            >
              <Text style={styles.reactionEmoji}>{emoji}</Text>
              <Text style={[styles.reactionCount, { color: colors.textSecondary }]}>{count}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity
            style={[styles.reactionBadge, { backgroundColor: colors.bgTertiary }]}
            onPress={() => setReactPickerOpen(true)}
          >
            <Text style={[styles.reactionAdd, { color: colors.textSecondary }]}>+</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Timestamp + edited indicator */}
      <View style={[styles.metaRow, isOwn && styles.metaRowOwn]}>
        {message.edited && (
          <Text style={[styles.editedLabel, { color: colors.textSecondary }]}>
            {t('chat_edited')} ·{' '}
          </Text>
        )}
        <Text style={[styles.time, { color: colors.textSecondary }]}>
          {new Date(message.timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>

      {/* Action menu bottom sheet */}
      <Modal visible={menuOpen} transparent animationType="slide" onRequestClose={() => setMenuOpen(false)}>
        <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={() => setMenuOpen(false)}>
          <View style={[styles.sheetPanel, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
            {onReply && (
              <TouchableOpacity style={[styles.sheetItem, { borderBottomColor: colors.border }]} onPress={() => handleMenuAction('reply')}>
                <Text style={[styles.sheetItemText, { color: colors.textPrimary }]}>↩ {t('chat_reply')}</Text>
              </TouchableOpacity>
            )}
            {onReact && (
              <TouchableOpacity style={[styles.sheetItem, { borderBottomColor: colors.border }]} onPress={() => handleMenuAction('react')}>
                <Text style={[styles.sheetItemText, { color: colors.textPrimary }]}>😀 {t('chat_react')}</Text>
              </TouchableOpacity>
            )}
            {canEdit && (
              <TouchableOpacity style={[styles.sheetItem, { borderBottomColor: colors.border }]} onPress={() => handleMenuAction('edit')}>
                <Text style={[styles.sheetItemText, { color: colors.textPrimary }]}>✎ {t('chat_edit')}</Text>
              </TouchableOpacity>
            )}
            {canDelete && (
              <TouchableOpacity style={[styles.sheetItem, { borderBottomColor: colors.border }]} onPress={() => handleMenuAction('delete')}>
                <Text style={[styles.sheetItemText, { color: colors.error }]}>✕ {t('chat_delete')}</Text>
              </TouchableOpacity>
            )}
            {onTip && (
              <TouchableOpacity style={[styles.sheetItem, { borderBottomColor: colors.border }]} onPress={() => handleMenuAction('tip')}>
                <Text style={[styles.sheetItemText, { color: colors.textPrimary }]}>💰 {t('chat_tip')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={styles.sheetItem} onPress={() => setMenuOpen(false)}>
              <Text style={[styles.sheetItemText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Reaction picker bottom sheet */}
      <Modal visible={reactPickerOpen} transparent animationType="slide" onRequestClose={() => setReactPickerOpen(false)}>
        <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={() => setReactPickerOpen(false)}>
          <View style={[styles.sheetPanel, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
            <View style={styles.reactGrid}>
              {CHAT_REACTIONS.map((emoji) => (
                <TouchableOpacity key={emoji} style={[styles.reactBtn, { backgroundColor: colors.bgTertiary }]} onPress={() => handleReact(emoji)}>
                  <Text style={styles.reactEmoji}>{emoji}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <TouchableOpacity style={styles.sheetItem} onPress={() => setReactPickerOpen(false)}>
              <Text style={[styles.sheetItemText, { color: colors.textSecondary }]}>{t('cancel')}</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Full-screen image viewer */}
      {viewerImage && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setViewerImage(null)}>
          <TouchableOpacity style={styles.imageViewerOverlay} activeOpacity={1} onPress={() => setViewerImage(null)}>
            <Image source={{ uri: viewerImage }} style={styles.imageViewerFull} resizeMode="contain" />
            <Text style={styles.imageViewerClose}>✕</Text>
          </TouchableOpacity>
        </Modal>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingVertical: 2,
    maxWidth: '85%',
    alignSelf: 'flex-start',
  },
  containerOwn: {
    alignSelf: 'flex-end',
  },
  author: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    marginBottom: 2,
  },
  replyBar: {
    borderLeftWidth: 3,
    paddingLeft: spacing.sm,
    paddingVertical: 2,
    marginBottom: 4,
    borderRadius: radius.sm,
  },
  replyAuthor: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  replyPreview: {
    fontSize: fontSize.xs,
  },
  bubble: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
  },
  attachmentContainer: {
    marginTop: spacing.xs,
    gap: spacing.xs,
  },
  inlineImage: {
    width: 220,
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    marginTop: spacing.xs,
  },
  fileChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'flex-end',
  },
  sheetPanel: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.xl,
  },
  sheetItem: {
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetItemText: {
    fontSize: fontSize.md,
    fontWeight: '500',
  },
  reactGrid: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  reactBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.lg,
    justifyContent: 'center',
    alignItems: 'center',
  },
  reactEmoji: {
    fontSize: 28,
  },
  imageViewerOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageViewerFull: {
    width: Dimensions.get('window').width,
    height: Dimensions.get('window').height * 0.8,
  },
  imageViewerClose: {
    position: 'absolute',
    top: 50,
    right: 20,
    color: '#fff',
    fontSize: 28,
    fontWeight: '600',
  },
  deletedBubble: {
    opacity: 0.6,
  },
  deletedText: {
    fontStyle: 'italic',
    fontSize: fontSize.sm,
  },
  reactionRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    marginTop: 4,
  },
  reactionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.sm,
    gap: 3,
  },
  reactionEmoji: {
    fontSize: 14,
  },
  reactionCount: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  reactionAdd: {
    fontSize: fontSize.sm,
    fontWeight: '600',
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 2,
  },
  metaRowOwn: {
    justifyContent: 'flex-end',
  },
  editedLabel: {
    fontSize: 10,
    fontStyle: 'italic',
  },
  time: {
    fontSize: 10,
  },
});
