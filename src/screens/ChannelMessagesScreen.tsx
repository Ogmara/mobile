/**
 * Channel Messages — message view for a specific channel.
 *
 * Features: real-time updates via WebSocket, message edit/delete/react/reply,
 * date grouping, author grouping, reactions display, optimistic updates.
 * Decodes MessagePack payloads to show human-readable text.
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import * as ImagePicker from 'expo-image-picker';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import { decodeChatMessage } from '../lib/payloadDecoder';
import { normalizeEnvelopes, normalizeEnvelope } from '../lib/envelopeNormalizer';
import { debugLog } from '../lib/debug';
import MessageBubble, { CHAT_REACTIONS, type ReplyContext } from '../components/MessageBubble';
import TipDialog from '../components/TipDialog';
import EmojiPicker from '../components/EmojiPicker';
import type { Envelope } from '@ogmara/sdk';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChatStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<ChatStackParamList, 'ChannelMessages'>;

/** 30-minute edit window */
const EDIT_WINDOW_MS = 30 * 60 * 1000;
/** Group consecutive messages from the same author within 2 minutes */
const GROUP_WINDOW_MS = 2 * 60 * 1000;
/** Max local messages to prevent unbounded memory */
const MAX_LOCAL_MESSAGES = 200;

/** Convert msg_id to consistent hex string */
function msgIdToHex(msgId: unknown): string {
  if (typeof msgId === 'string') return msgId;
  if (msgId instanceof Uint8Array) {
    return Array.from(msgId).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (Array.isArray(msgId)) {
    return (msgId as number[]).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return String(msgId);
}

/** Get a date label for message grouping (i18n-aware) */
function getDateLabel(timestamp: string | number, todayLabel: string, yesterdayLabel: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = today.getTime() - msgDay.getTime();
  if (diff === 0) return todayLabel;
  if (diff === 86400000) return yesterdayLabel;
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

type ExtendedEnvelope = Envelope & {
  deleted?: boolean;
  edited?: boolean;
  last_edited_at?: number;
  reactions?: Record<string, number>;
  _optimistic?: boolean;
  /** Cached decoded content to avoid re-decoding msgpack on every render */
  _decodedContent?: string;
  _decodedAttachments?: Array<{ cid: string; mime_type: string; filename?: string }>;
};

type ListItem =
  | { type: 'date'; label: string; key: string }
  | { type: 'message'; envelope: ExtendedEnvelope; isGrouped: boolean; key: string };

export default function ChannelMessagesScreen({ route, navigation }: Props) {
  // Ensure channelId is always a number (React Navigation may serialize as string)
  const channelId = Number(route.params.channelId);
  const { channelName } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress, onWsEvent } = useConnection();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ExtendedEnvelope[]>([]);
  const [editingMsg, setEditingMsg] = useState<{ msgId: string; content: string } | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyContext | null>(null);
  const inputRef = useRef<TextInput>(null);
  // Profile cache: address → display name
  const [profileNames, setProfileNames] = useState<Record<string, string>>({});
  const profileFetchedRef = useRef<Set<string>>(new Set());

  const { data } = useApi(
    async () => {
      if (!client) return { messages: [], has_more: false };
      const resp = await client.getChannelMessages(channelId, 200);
      return { ...resp, messages: normalizeEnvelopes(resp.messages) };
    },
    [channelId, client],
  );

  // Seed messages from initial fetch
  useEffect(() => {
    if (data?.messages) {
      setMessages(data.messages as ExtendedEnvelope[]);
    }
  }, [data]);

  // Resolve display names for message authors
  useEffect(() => {
    if (!client) return;
    const authors = new Set(messages.map((m) => m.author));
    for (const addr of authors) {
      if (profileFetchedRef.current.has(addr)) continue;
      profileFetchedRef.current.add(addr);
      client.getUserProfile(addr).then((resp: any) => {
        const name = resp?.user?.display_name;
        if (name) {
          setProfileNames((prev) => ({ ...prev, [addr]: name }));
        }
      }).catch(() => {});
    }
  }, [client, messages]);

  // Mark channel read on enter
  useEffect(() => {
    if (client && signer) {
      client.markChannelRead(channelId).catch(() => {});
    }
  }, [client, signer, channelId]);

  // Listen for real-time messages on this channel (including edit/delete)
  useEffect(() => {
    const unsub = onWsEvent((event) => {
      if (event.type === 'message' && event.envelope) {
        const env = normalizeEnvelope(event.envelope) as ExtendedEnvelope;
        const decoded = decodeChatMessage(env.payload);

        // Check if this message belongs to this channel
        const msgChannelId = decoded?.channel_id ?? (env as any).channel_id;
        if (msgChannelId !== channelId && String(msgChannelId) !== String(channelId)) return;

        // Handle edit/delete events by updating existing messages
        const msgType = (env as any).msg_type;
        if (msgType === 'ChatEdit' || msgType === 2) {
          const targetId = (env as any).target_msg_id || env.msg_id;
          if (targetId) {
            setMessages((prev) => prev.map((m) => {
              if (msgIdToHex(m.msg_id) === msgIdToHex(targetId)) {
                return { ...m, payload: env.payload, edited: true, last_edited_at: env.timestamp as number };
              }
              return m;
            }));
          }
          return;
        }
        if (msgType === 'ChatDelete' || msgType === 3) {
          const targetId = (env as any).target_msg_id || env.msg_id;
          if (targetId) {
            setMessages((prev) => prev.map((m) => {
              if (msgIdToHex(m.msg_id) === msgIdToHex(targetId)) {
                return { ...m, deleted: true };
              }
              return m;
            }));
          }
          return;
        }
        // Handle reaction events
        if (msgType === 'ChatReaction' || msgType === 4) {
          const targetId = (env as any).target_msg_id || env.msg_id;
          const reactionDecoded = decodeChatMessage(env.payload);
          const emoji = (reactionDecoded as any)?.emoji || (env as any).emoji;
          if (targetId && emoji) {
            setMessages((prev) => prev.map((m) => {
              if (msgIdToHex(m.msg_id) !== msgIdToHex(targetId)) return m;
              const reactions = { ...(m.reactions || {}) };
              reactions[emoji] = (reactions[emoji] || 0) + 1;
              return { ...m, reactions };
            }));
          }
          return;
        }

        // New message — deduplicate and add
        setMessages((prev) => {
          if (prev.some((m) => msgIdToHex(m.msg_id) === msgIdToHex(env.msg_id))) return prev;
          // Remove optimistic messages from same author with similar timestamp
          const filtered = prev.filter((m) => {
            if (!m._optimistic) return true;
            return !(m.author === env.author &&
              Math.abs(new Date(m.timestamp).getTime() - new Date(env.timestamp).getTime()) < 10000);
          });
          const next = [env, ...filtered];
          return next.length > MAX_LOCAL_MESSAGES ? next.slice(0, MAX_LOCAL_MESSAGES) : next;
        });

        // Mark read while viewing
        if (signer) {
          client?.markChannelRead(channelId).catch(() => {});
        }
      }
    });
    return unsub;
  }, [onWsEvent, channelId, client, signer]);

  // Build lookup map for reply context resolution
  const msgById = useMemo(() => {
    const map = new Map<string, ExtendedEnvelope>();
    for (const msg of messages) map.set(msgIdToHex(msg.msg_id), msg);
    return map;
  }, [messages]);

  /** Resolve reply context for a message */
  const resolveReply = useCallback((msg: ExtendedEnvelope): ReplyContext | null => {
    // Check server-provided reply preview
    if ((msg as any).reply_to_preview?.author) {
      const rtp = (msg as any).reply_to_preview;
      return {
        author: rtp.author,
        preview: rtp.content_preview || '...',
        msgId: msgIdToHex(rtp.msg_id),
      };
    }
    // Check decoded payload for reply_to
    const decoded = decodeChatMessage(msg.payload);
    if (!decoded?.reply_to) return null;
    const replyHex = msgIdToHex(decoded.reply_to);
    const original = msgById.get(replyHex);
    if (original) {
      const originalDecoded = decodeChatMessage(original.payload);
      const content = originalDecoded?.content || (typeof original.payload === 'string' ? original.payload : '');
      return {
        author: original.author,
        preview: content.length > 80 ? content.slice(0, 80) + '...' : content,
        msgId: replyHex,
      };
    }
    return { author: '...', preview: '(original message not loaded)', msgId: replyHex };
  }, [msgById]);

  // Sort messages chronologically and build list items with date separators + grouping.
  // O(n) optimistic dedup: build a Set of non-optimistic signatures first,
  // then filter optimistic messages that have a real counterpart.
  const listItems = useMemo((): ListItem[] => {
    // Build dedup set for O(n) optimistic filtering: "author|timestamp_bucket"
    const realMsgKeys = new Set<string>();
    for (const m of messages) {
      if (!m._optimistic) {
        // 10-second bucket for matching optimistic to confirmed messages
        const bucket = Math.floor(new Date(m.timestamp).getTime() / 10000);
        realMsgKeys.add(`${m.author}|${bucket}`);
      }
    }

    const filtered = messages.filter((m) => {
      if (!m._optimistic) return true;
      const bucket = Math.floor(new Date(m.timestamp).getTime() / 10000);
      return !realMsgKeys.has(`${m.author}|${bucket}`);
    });

    // Sort oldest-first for processing
    const sorted = filtered.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Cache decoded content + attachments to avoid re-decoding in renderItem
    for (const msg of sorted) {
      if (msg._decodedContent === undefined) {
        const decoded = decodeChatMessage(msg.payload);
        msg._decodedContent = decoded?.content || (typeof msg.payload === 'string' ? msg.payload : '');
        msg._decodedAttachments = (decoded as any)?.attachments;
      }
    }

    const items: ListItem[] = [];
    let lastDate = '';
    let lastAuthor = '';
    let lastTimestamp = 0;

    for (const msg of sorted) {
      const dateLabel = getDateLabel(msg.timestamp, t('chat_today'), t('chat_yesterday'));
      if (dateLabel !== lastDate) {
        items.push({ type: 'date', label: dateLabel, key: `date-${dateLabel}` });
        lastDate = dateLabel;
        lastAuthor = '';
        lastTimestamp = 0;
      }

      const msgTime = new Date(msg.timestamp).getTime();
      const isGrouped = msg.author === lastAuthor && (msgTime - lastTimestamp) < GROUP_WINDOW_MS;

      items.push({
        type: 'message',
        envelope: msg,
        isGrouped,
        key: msgIdToHex(msg.msg_id) || `msg-${msg.timestamp}`,
      });

      lastAuthor = msg.author;
      lastTimestamp = msgTime;
    }

    // Reverse for inverted FlatList (newest at top)
    return items.reverse();
  }, [messages, t]);

  // ── Message Actions ──

  const handleSend = useCallback(async () => {
    const text = input.trim();
    // Allow sending text, attachments, or both
    if ((!text && pendingAttachments.length === 0) || !client || !signer) return;

    // Route to edit handler when in edit mode
    if (editingMsg) {
      try {
        await client.editMessage(channelId, editingMsg.msgId, text);
        // Optimistic update — clear cached content so it re-decodes
        setMessages((prev) => prev.map((m) =>
          msgIdToHex(m.msg_id) === editingMsg.msgId
            ? { ...m, payload: text, edited: true, last_edited_at: Date.now(), _decodedContent: undefined }
            : m,
        ));
        setEditingMsg(null);
        setInput('');
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        debugLog('warn', `Edit failed: ${msg}`);
        Alert.alert(t('chat_edit'), msg.slice(0, 150));
      }
      return;
    }

    try {
      const options: any = {};
      if (replyTo) options.replyTo = replyTo.msgId;
      if (pendingAttachments.length > 0) options.attachments = pendingAttachments;
      const sentAttachments = [...pendingAttachments];
      const result = await client.sendMessage(channelId, text || '', options);
      setInput('');
      setReplyTo(null);
      setPendingAttachments([]);

      // Optimistically add the sent message with cached attachments
      const optimistic: ExtendedEnvelope = {
        version: 1,
        msg_type: 1,
        msg_id: result.msg_id || `local-${Date.now()}`,
        author: myAddress || '',
        timestamp: Date.now(),
        lamport_ts: 0,
        payload: text || '',
        signature: '',
        relay_path: [],
        _optimistic: true,
        _decodedContent: text || '',
        _decodedAttachments: sentAttachments.length > 0 ? sentAttachments : undefined,
      };
      setMessages((prev) => {
        const next = [optimistic, ...prev];
        return next.length > MAX_LOCAL_MESSAGES ? next.slice(0, MAX_LOCAL_MESSAGES) : next;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Send failed: ${msg}`);
      Alert.alert('Send failed', msg.slice(0, 150));
    }
  }, [input, client, signer, channelId, myAddress, editingMsg, replyTo, t]);

  const handleReply = useCallback((msg: ExtendedEnvelope) => {
    const content = msg._decodedContent || '';
    const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
    setReplyTo({
      msgId: msgIdToHex(msg.msg_id),
      author: msg.author.slice(0, 12) + '...',
      preview,
    });
    inputRef.current?.focus();
  }, []);

  const handleEdit = useCallback((msg: ExtendedEnvelope) => {
    // Ownership guard — only edit own messages
    if (msg.author !== myAddress) return;
    const content = msg._decodedContent || '';
    setEditingMsg({ msgId: msgIdToHex(msg.msg_id), content });
    setInput(content);
    setReplyTo(null);
    inputRef.current?.focus();
  }, [myAddress]);

  const handleDelete = useCallback(async (msg: Envelope) => {
    // Ownership guard — only delete own messages
    if (!client || msg.author !== myAddress) return;
    try {
      await client.deleteMessage(channelId, msgIdToHex(msg.msg_id));
      setMessages((prev) => prev.map((m) =>
        msgIdToHex(m.msg_id) === msgIdToHex(msg.msg_id)
          ? { ...m, deleted: true }
          : m,
      ));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : '';
      debugLog('warn', `Delete failed: ${errMsg}`);
    }
  }, [client, channelId, myAddress]);

  const handleReact = useCallback(async (msg: Envelope, emoji: string) => {
    if (!client) return;
    // Validate emoji against allowlist
    if (!CHAT_REACTIONS.includes(emoji)) return;
    try {
      await client.reactToMessage(channelId, msgIdToHex(msg.msg_id), emoji);
      setMessages((prev) => prev.map((m) => {
        if (msgIdToHex(m.msg_id) !== msgIdToHex(msg.msg_id)) return m;
        const reactions = { ...(m.reactions || {}) };
        reactions[emoji] = (reactions[emoji] || 0) + 1;
        return { ...m, reactions };
      }));
    } catch (e) {
      debugLog('warn', `React failed: ${e instanceof Error ? e.message : ''}`);
    }
  }, [client, channelId]);

  const cancelEdit = useCallback(() => {
    setEditingMsg(null);
    setInput('');
  }, []);

  const cancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  // Tipping
  const [tipTarget, setTipTarget] = useState<string | null>(null);
  // Emoji picker
  const [showEmoji, setShowEmoji] = useState(false);
  // Media attachments for current message (must include size_bytes for SDK Attachment type)
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ cid: string; mime_type: string; size_bytes: number; filename: string }>>([]);
  const [uploading, setUploading] = useState(false);

  const handleTip = useCallback((msg: Envelope) => {
    if (msg.author === myAddress) return; // can't tip yourself
    setTipTarget(msg.author);
  }, [myAddress]);

  const handlePickMedia = useCallback(async () => {
    if (!client || !signer || uploading) return;
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: false,
      quality: 0.8,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (asset.fileSize && asset.fileSize > 50 * 1024 * 1024) {
      Alert.alert(t('error_generic'), 'File too large (max 50MB)');
      return;
    }
    setUploading(true);
    try {
      const filename = asset.fileName ?? `file-${Date.now()}`;
      const mimeType = asset.mimeType ?? 'application/octet-stream';

      // React Native FormData needs {uri, type, name} — not a Blob
      const formData = new FormData();
      formData.append('file', {
        uri: asset.uri,
        type: mimeType,
        name: filename,
      } as any);

      const headers = await signer.signRequest('POST', '/api/v1/media/upload');
      const nodeUrl = (client as any).nodeUrl || '';
      const resp = await fetch(`${nodeUrl}/api/v1/media/upload`, {
        method: 'POST',
        headers: { ...headers },
        body: formData,
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`Upload failed (${resp.status}): ${text.slice(0, 150)}`);
      }

      const uploadResp = await resp.json();
      setPendingAttachments((prev) => [...prev, {
        cid: uploadResp.cid,
        mime_type: mimeType,
        size_bytes: asset.fileSize || 0,
        filename,
      }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Media upload failed: ${msg}`);
      Alert.alert(t('error_generic'), msg.includes('404') ? t('news_upload_unavailable') : msg.slice(0, 150));
    } finally {
      setUploading(false);
    }
  }, [client, signer, uploading, t]);

  // ── Render ──

  const handleAuthorPress = useCallback((addr: string) => {
    navigation.navigate('UserProfile', { address: addr });
  }, [navigation]);

  const renderItem = useCallback(({ item }: { item: ListItem }) => {
    if (item.type === 'date') {
      return (
        <View style={styles.dateSeparator}>
          <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
          <Text style={[styles.dateLabel, { color: colors.textSecondary, backgroundColor: colors.bgPrimary }]}>
            {item.label}
          </Text>
          <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
        </View>
      );
    }

    const { envelope, isGrouped } = item;
    const isOwn = envelope.author === myAddress;
    // Use cached decoded content — avoids re-decoding msgpack on every render
    const content = envelope._decodedContent || '';
    const authorLabel = profileNames[envelope.author] || envelope.author.slice(0, 12) + '...';
    const replyContext = resolveReply(envelope);
    const nodeUrl = (client as any)?.nodeUrl || '';

    return (
      <MessageBubble
        message={envelope}
        content={content}
        isOwn={isOwn}
        authorLabel={authorLabel}
        attachments={envelope._decodedAttachments}
        mediaBaseUrl={nodeUrl ? `${nodeUrl}/api/v1/media/` : undefined}
        replyContext={replyContext}
        isGrouped={isGrouped}
        onReply={handleReply}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onReact={handleReact}
        onTip={handleTip}
        onAuthorPress={handleAuthorPress}
      />
    );
  }, [myAddress, colors, profileNames, client, resolveReply, handleReply, handleEdit, handleDelete, handleReact, handleTip, handleAuthorPress]);

  const keyExtractor = useCallback((item: ListItem) => item.key, []);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 100}
    >
      {/* Channel header */}
      <View style={[styles.header, { backgroundColor: colors.bgSecondary, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>#{channelName}</Text>
        {signer && (
          <TouchableOpacity
            onPress={() => navigation.navigate('ChannelAdmin', { channelId, channelName })}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.lg }}>⚙</Text>
          </TouchableOpacity>
        )}
      </View>

      <FlatList
        data={listItems}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        inverted
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: colors.textSecondary }}>
              {t('chat_no_messages')}
            </Text>
          </View>
        }
      />

      {signer ? (
        <View style={{ backgroundColor: colors.bgSecondary, borderTopWidth: 1, borderTopColor: colors.border }}>
          {/* Reply context bar */}
          {replyTo && (
            <View style={[styles.contextBar, { borderBottomColor: colors.border }]}>
              <View style={[styles.contextIndicator, { backgroundColor: colors.accentPrimary }]} />
              <View style={styles.contextContent}>
                <Text style={[styles.contextLabel, { color: colors.accentPrimary }]}>
                  {t('channel_reply_to')} {replyTo.author}
                </Text>
                <Text style={[styles.contextPreview, { color: colors.textSecondary }]} numberOfLines={1}>
                  {replyTo.preview}
                </Text>
              </View>
              <TouchableOpacity onPress={cancelReply} style={styles.contextClose}>
                <Text style={{ color: colors.textSecondary, fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Edit context bar */}
          {editingMsg && (
            <View style={[styles.contextBar, { borderBottomColor: colors.border }]}>
              <View style={[styles.contextIndicator, { backgroundColor: colors.warning }]} />
              <View style={styles.contextContent}>
                <Text style={[styles.contextLabel, { color: colors.warning }]}>
                  {t('chat_editing')}
                </Text>
                <Text style={[styles.contextPreview, { color: colors.textSecondary }]} numberOfLines={1}>
                  {editingMsg.content}
                </Text>
              </View>
              <TouchableOpacity onPress={cancelEdit} style={styles.contextClose}>
                <Text style={{ color: colors.textSecondary, fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Attachment preview */}
          {pendingAttachments.length > 0 && (
            <View style={[styles.attachPreview, { borderBottomColor: colors.border }]}>
              {pendingAttachments.map((att, i) => (
                <View key={i} style={[styles.attachChip, { backgroundColor: colors.bgTertiary }]}>
                  <Text style={{ color: colors.textPrimary, fontSize: fontSize.xs }} numberOfLines={1}>
                    📎 {att.filename}
                  </Text>
                  <TouchableOpacity onPress={() => setPendingAttachments((p) => p.filter((_, j) => j !== i))}>
                    <Text style={{ color: colors.error, fontSize: fontSize.sm }}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* Input bar */}
          <View style={styles.inputBar}>
            <TouchableOpacity
              onPress={handlePickMedia}
              style={styles.emojiBtn}
              disabled={uploading}
            >
              <Text style={{ fontSize: 20, opacity: uploading ? 0.4 : 1 }}>📎</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowEmoji(true)}
              style={styles.emojiBtn}
            >
              <Text style={{ fontSize: 22 }}>😀</Text>
            </TouchableOpacity>
            <TextInput
              ref={inputRef}
              style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder={t('chat_placeholder')}
              placeholderTextColor={colors.textSecondary}
              value={input}
              onChangeText={setInput}
              maxLength={4000}
              multiline
            />
            <TouchableOpacity
              style={[styles.sendBtn, { backgroundColor: (input.trim() || pendingAttachments.length > 0) ? colors.accentPrimary : colors.textSecondary }]}
              onPress={handleSend}
              disabled={!input.trim() && pendingAttachments.length === 0}
            >
              <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
                {editingMsg ? t('save') : t('chat_send')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={[styles.inputBar, { backgroundColor: colors.bgSecondary, borderTopWidth: 1, borderTopColor: colors.border }]}>
          <Text style={{ color: colors.textSecondary, padding: spacing.md }}>
            {t('wallet_connect')}
          </Text>
        </View>
      )}
      <EmojiPicker
        visible={showEmoji}
        onSelect={(emoji) => setInput((prev) => prev + emoji)}
        onClose={() => setShowEmoji(false)}
      />
      {tipTarget && (
        <TipDialog
          visible={!!tipTarget}
          recipientAddress={tipTarget}
          onClose={() => setTipTarget(null)}
        />
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: fontSize.lg, fontWeight: '700', flex: 1 },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60 },
  dateSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  dateLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dateLabel: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    paddingHorizontal: spacing.sm,
  },
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contextIndicator: {
    width: 3,
    height: '100%',
    borderRadius: 2,
    marginRight: spacing.sm,
    minHeight: 32,
  },
  contextContent: {
    flex: 1,
  },
  contextLabel: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  contextPreview: {
    fontSize: fontSize.xs,
  },
  contextClose: {
    padding: spacing.sm,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
  },
  emojiBtn: {
    justifyContent: 'center',
    paddingRight: spacing.xs,
    paddingBottom: spacing.xs,
  },
  attachPreview: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  input: {
    flex: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    minHeight: 44,
    maxHeight: 100,
  },
  sendBtn: {
    marginLeft: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    justifyContent: 'center',
  },
});
