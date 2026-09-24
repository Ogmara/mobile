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

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View,
  Text,
  Image,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  Platform,
  Modal,
  Dimensions,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import type { Envelope, MediaDescriptor } from '@ogmara/sdk';
import { loadDecryptedMedia } from '../lib/mediaCrypto';
import { shareFileFromUri } from '../lib/fileShare';
import { ImageViewerModal } from './ImageViewerModal';
import ConfirmModal from './ConfirmModal';
import FormattedText from './FormattedText';
import VerifiedBadge from './VerifiedBadge';
import BotBadge from './BotBadge';
import MessageButtons from './MessageButtons';
import { useUserDisplay } from '../hooks/useUserDisplay';
import type { PayloadButtonRow } from '../lib/payloadDecoder';

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

// Real envelopes carry `payload` as bytes. Callers may also pass a
// locally-constructed optimistic message with a plain content string in
// `payload` instead (see ChannelMessagesScreen/DmConversationScreen's
// `ExtendedEnvelope`); this component doesn't read `.payload` itself, only
// the caller-supplied `content` prop, so it accepts either shape.
type BubbleMessage = Omit<Envelope, 'payload'> & {
  payload: Envelope['payload'] | string;
  deleted?: boolean;
  edited?: boolean;
  last_edited_at?: number;
  reactions?: Record<string, number>;
};

interface Props {
  message: BubbleMessage;
  content: string;
  isOwn: boolean;
  authorLabel: string;
  attachments?: MessageAttachment[];
  /** P5 encrypted-media descriptors (carry per-file keys); decrypted on render. */
  encryptedMedia?: MediaDescriptor[];
  /** Base URL for media (e.g., "https://node.ogmara.org/api/v1/media/") */
  mediaBaseUrl?: string;
  replyContext?: ReplyContext | null;
  onReply?: (msg: BubbleMessage) => void;
  onEdit?: (msg: BubbleMessage) => void;
  onDelete?: (msg: BubbleMessage) => void;
  onReact?: (msg: BubbleMessage, emoji: string) => void;
  onTip?: (msg: BubbleMessage) => void;
  onAuthorPress?: (address: string) => void;
  onReplyPress?: (msgId: string) => void;
  /** Hide author + avatar for grouped consecutive messages */
  isGrouped?: boolean;
  /**
   * Interactive buttons attached to this message (protocol §3.3). Omitted
   * (or `onPressButton` omitted) entirely by the caller when the viewer
   * isn't allowed to post in this channel — see `ChannelMessagesScreen`'s
   * `canPostHere` (protocol §3.6's runtime posting policy — web/desktop gate
   * their composer on the equivalent check; mobile's composer does not, only
   * this button gate does) so a tap can't trigger an encrypted channel's
   * epoch-key establishment as a side effect for a user who could never
   * actually post there.
   */
  buttons?: PayloadButtonRow[];
  /**
   * Hex `msg_id` for the button origin, pre-computed by the caller via the
   * same `msgIdToHex()` used everywhere else in `ChannelMessagesScreen`
   * (handles `Uint8Array`/`number[]` shapes, not just `string`) — rather
   * than this component re-deriving it from `message.msg_id` with a weaker
   * `typeof === 'string'` guard.
   */
  buttonMsgId?: string;
  /**
   * The channel THIS message belongs to. NOT read from `message.channel_id`
   * — the SDK's `Envelope` type never actually carries that field (it lives
   * inside the msgpack `payload`, not the envelope; `ChannelMessagesScreen`
   * itself only ever reads it via `decoded?.channel_id`, never off the raw
   * envelope). The screen already knows its own `channelId` authoritatively
   * from the route, so it's passed down explicitly rather than trusted from
   * `message` — an `?? 0` fallback there would silently send every press to
   * channel 0, and in an encrypted channel, mint and publish a fresh epoch
   * key scoped to channel 0 as a side effect.
   */
  channelId?: number;
  onPressButton?: (
    origin: { channelId: number; msgId: string; author: string },
    command: string,
  ) => Promise<void>;
}

/**
 * Renders one P5 encrypted attachment: fetches the ciphertext, decrypts it (off the
 * render path), and shows the plaintext via a `data:` URI. Placeholder while decrypting,
 * "🔒 encrypted attachment" fallback on failure.
 */
function EncryptedAttachment({
  descriptor,
  mediaBaseUrl,
  onOpenImage,
}: {
  descriptor: MediaDescriptor;
  mediaBaseUrl: string;
  onOpenImage: (uri: string) => void;
}) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setState('loading');
    setUri(null);
    loadDecryptedMedia(descriptor, mediaBaseUrl)
      .then((res) => {
        if (cancelled) return;
        if (res) { setUri(res.uri); setState('ready'); }
        else setState('error');
      })
      .catch(() => { if (!cancelled) setState('error'); });
    return () => { cancelled = true; };
  }, [descriptor, mediaBaseUrl]);

  const isImage = descriptor.mime.startsWith('image/');

  if (state === 'loading') {
    return (
      <View style={[styles.encPlaceholder, { backgroundColor: colors.bgTertiary }]}>
        <ActivityIndicator color={colors.textSecondary} />
        <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 4 }}>
          {t('e2e_decrypting')}
        </Text>
      </View>
    );
  }
  if (state === 'error' || !uri) {
    return (
      <View style={[styles.fileChip, { backgroundColor: colors.bgTertiary }]}>
        <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs }}>
          🔒 {t('e2e_attachment')}
        </Text>
      </View>
    );
  }
  if (isImage) {
    return (
      <TouchableOpacity onPress={() => onOpenImage(uri)} activeOpacity={0.8}>
        <Image source={{ uri }} style={styles.inlineImage} resizeMode="cover" />
      </TouchableOpacity>
    );
  }
  const fileName = descriptor.name || `${descriptor.cid.slice(0, 12)}.bin`;
  return (
    <TouchableOpacity
      style={[styles.fileChip, { backgroundColor: colors.bgTertiary }]}
      onPress={() => { void shareFileFromUri(uri, fileName); }}
    >
      <Text style={{ color: colors.textPrimary, fontSize: fontSize.xs }}>
        🔒 {fileName}
      </Text>
    </TouchableOpacity>
  );
}

export default function MessageBubble({
  message,
  content,
  isOwn,
  authorLabel,
  attachments,
  encryptedMedia,
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
  buttons,
  buttonMsgId,
  channelId,
  onPressButton,
}: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { verified: authorVerified, isBot: authorIsBot } = useUserDisplay(
    isOwn ? undefined : message.author,
  );
  const [viewerImage, setViewerImage] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [reactPickerOpen, setReactPickerOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

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
        setDeleteConfirmOpen(true);
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
        <TouchableOpacity
          style={styles.authorRow}
          onPress={() => onAuthorPress?.(message.author)}
        >
          <Text style={[styles.author, { color: colors.accentPrimary }]}>
            {authorLabel}
          </Text>
          <VerifiedBadge verified={authorVerified} size={12} />
          {/* Beside the verified badge, never merged with it: verified is paid
              and on-chain, bot is free and self-declared. Shown for every bot,
              verified or not — an unverified bot is the one most worth
              labelling. */}
          <BotBadge isBot={authorIsBot} />
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

      {/* Message bubble — Modern style: tighter tail corner on the sending side */}
      <View style={[
        styles.bubble,
        isOwn
          ? { backgroundColor: colors.accentPrimary, borderBottomRightRadius: radius.sm }
          : { backgroundColor: colors.bgSecondary, borderBottomLeftRadius: radius.sm },
      ]}>
        {content ? (
          <FormattedText
            content={content}
            color={isOwn ? colors.textInverse : colors.textPrimary}
          />
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
              const fileName = att.filename || `${att.cid.slice(0, 12)}.bin`;
              return (
                <TouchableOpacity
                  key={idx}
                  style={[styles.fileChip, { backgroundColor: colors.bgTertiary }]}
                  onPress={() => { void shareFileFromUri(url, fileName); }}
                >
                  <Text style={{ color: colors.textPrimary, fontSize: fontSize.xs }}>
                    📎 {fileName}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
        {/* P5 encrypted attachments — fetched + decrypted before display */}
        {encryptedMedia && encryptedMedia.length > 0 && mediaBaseUrl && (
          <View style={styles.attachmentContainer}>
            {encryptedMedia.map((m, idx) => (
              <EncryptedAttachment
                key={`${m.cid}-${idx}`}
                descriptor={m}
                mediaBaseUrl={mediaBaseUrl}
                onOpenImage={setViewerImage}
              />
            ))}
          </View>
        )}
      </View>

      {/* Interactive buttons (protocol §3.3) — channel messages only, never
          DMs (this component's other caller, `DmConversationScreen`, never
          passes `channelId`/`buttons`/`onPressButton`). */}
      {buttons && buttons.length > 0 && onPressButton && channelId !== undefined && buttonMsgId && (
        <MessageButtons
          rows={buttons}
          channelId={channelId}
          msgId={buttonMsgId}
          author={message.author}
          onPress={onPressButton}
        />
      )}

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

      {/* Full-screen image viewer — pinch/double-tap zoom + save to device */}
      <ImageViewerModal uri={viewerImage} onClose={() => setViewerImage(null)} />

      <ConfirmModal
        visible={deleteConfirmOpen}
        title={t('chat_delete')}
        message={t('confirm_delete')}
        confirmLabel={t('chat_delete')}
        danger
        onConfirm={() => onDelete?.(message)}
        onClose={() => setDeleteConfirmOpen(false)}
      />
    </TouchableOpacity>
  );
}

// A fixed inline-image width (previously 220) doesn't grow with the bubble's
// percentage-based maxWidth — a View shrinks to fit its widest child, so a
// hardcoded-width image silently caps the WHOLE bubble at that width
// regardless of how much room `container.maxWidth` actually allows,
// noticeably cramped for wide content like bot-posted charts (app is
// portrait-locked per app.json, so a static Dimensions read is fine — no
// rotation to react to).
const MAX_INLINE_IMAGE_WIDTH = Dimensions.get('window').width * 0.9 - spacing.md * 2;

const styles = StyleSheet.create({
  container: {
    paddingVertical: 2,
    maxWidth: '90%',
    alignSelf: 'flex-start',
  },
  containerOwn: {
    alignSelf: 'flex-end',
  },
  authorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 2,
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
    width: MAX_INLINE_IMAGE_WIDTH,
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    marginTop: spacing.xs,
  },
  fileChip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  encPlaceholder: {
    width: 220,
    aspectRatio: 4 / 3,
    borderRadius: radius.md,
    marginTop: spacing.xs,
    justifyContent: 'center',
    alignItems: 'center',
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
