/**
 * DM Conversation — message view with a single peer.
 *
 * Features: real-time updates via WebSocket, message edit/delete/react,
 * date grouping, author grouping, optimistic updates.
 * Per spec 03-l2-node.md section 4.2 (GET /api/v1/dm/:address/messages).
 */

import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
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
  AppState,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import { decodePayload } from '../lib/payloadDecoder';
import { normalizeEnvelopes, normalizeEnvelope } from '../lib/envelopeNormalizer';
import { debugLog } from '../lib/debug';
import { e2eAvailable } from '../lib/cryptoEnv';
import {
  buildEncryptedDm,
  buildEncryptedDmEditEnvelope,
  decryptDmMessage,
  coverPeerDevices,
  type DmDisplay,
} from '../lib/dmCrypto';
import { chatErrorKey } from '../lib/chatErrors';
import { encryptAndUploadFile, base64ToBytes, MAX_ENCRYPTED_MEDIA_BYTES } from '../lib/mediaCrypto';
import MessageBubble, { CHAT_REACTIONS, type ReplyContext } from '../components/MessageBubble';
import type { Envelope, MediaDescriptor } from '@ogmara/sdk';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DmStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<DmStackParamList, 'DmConversation'>;

const EDIT_WINDOW_MS = 30 * 60 * 1000;
const GROUP_WINDOW_MS = 2 * 60 * 1000;
const MAX_LOCAL_MESSAGES = 200;

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

/** Cache key for a decrypted DM — includes the edit timestamp so an edit re-decrypts. */
function dmCacheId(m: { msg_id: unknown; last_edited_at?: number }): string {
  return `${msgIdToHex(m.msg_id)}:${m.last_edited_at ?? ''}`;
}

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
  _decodedContent?: string;
  /** P5: optimistic encrypted-media descriptors for a locally-sent DM. */
  _decodedEncryptedMedia?: MediaDescriptor[];
};

type ListItem =
  | { type: 'date'; label: string; key: string }
  | { type: 'message'; envelope: ExtendedEnvelope; isGrouped: boolean; key: string };

export default function DmConversationScreen({ route, navigation }: Props) {
  const { address: peerAddress, displayName } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress, onWsEvent } = useConnection();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ExtendedEnvelope[]>([]);
  const [editingMsg, setEditingMsg] = useState<{ msgId: string; content: string } | null>(null);
  // P5: encrypted attachments pending send (descriptors hold per-file keys).
  const [pendingEncryptedMedia, setPendingEncryptedMedia] = useState<MediaDescriptor[]>([]);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<TextInput>(null);

  // Async decryption cache: `${msgIdHex}:${last_edited_at}` → display outcome. Decoding
  // is async (key fetch/unwrap), so it can't happen inline in the render path.
  const [decoded, setDecoded] = useState<Map<string, DmDisplay>>(new Map());
  const decodedRef = useRef(decoded);
  useEffect(() => { decodedRef.current = decoded; }, [decoded]);
  // Bumped on foreground resume to retry any messages still 'waiting' for a key.
  const [decodeTick, setDecodeTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') setDecodeTick((x) => x + 1); });
    return () => sub.remove();
  }, []);

  const { data } = useApi(
    async () => {
      if (!client || !signer) return { messages: [], has_more: false };
      try {
        const resp = await client.getDmMessages(peerAddress);
        return { ...resp, messages: normalizeEnvelopes(resp.messages) };
      } catch {
        return { messages: [], has_more: false };
      }
    },
    [peerAddress, client, signer],
  );

  useEffect(() => {
    if (data?.messages) {
      setMessages(data.messages as ExtendedEnvelope[]);
    }
  }, [data]);

  // Mark DM read on enter
  useEffect(() => {
    if (client && signer) {
      client.markDmRead(peerAddress).catch(() => {});
    }
  }, [client, signer, peerAddress]);

  // Listen for real-time DMs from/to this peer (including edit/delete)
  useEffect(() => {
    const unsub = onWsEvent((event) => {
      if (event.type === 'dm' && event.envelope) {
        const env = normalizeEnvelope(event.envelope) as ExtendedEnvelope;

        // Only process messages from/to this peer
        if (env.author !== peerAddress && env.author !== myAddress) return;

        const msgType = (env as any).msg_type;
        // Handle DM edit
        if (msgType === 'DirectMessageEdit' || msgType === 6) {
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
        // Handle DM delete
        if (msgType === 'DirectMessageDelete' || msgType === 7) {
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
        // Handle DM reaction
        if (msgType === 'DirectMessageReaction' || msgType === 8) {
          const targetId = (env as any).target_msg_id || env.msg_id;
          const reactionDecoded = decodePayload(env.payload);
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

        // New DM — deduplicate and add
        setMessages((prev) => {
          if (prev.some((m) => msgIdToHex(m.msg_id) === msgIdToHex(env.msg_id))) return prev;
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
          client?.markDmRead(peerAddress).catch(() => {});
        }
        // A peer device may have joined after my key was established — wrap my key to
        // any new device so they can decrypt without a reload (no-op if none missing).
        void coverPeerDevices(peerAddress).catch(() => {});
      }
    });
    return unsub;
  }, [onWsEvent, peerAddress, myAddress, client, signer]);

  // Decrypt messages asynchronously into `decoded`. Re-runs when messages change or on
  // foreground resume (retries 'waiting' entries once a key/vault restore lands). Skips
  // already-resolved messages so a new incoming message doesn't re-AEAD the whole list.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const results: Array<[string, DmDisplay]> = [];
      for (const m of messages) {
        const id = dmCacheId(m);
        if (m._optimistic) {
          const optText = typeof m.payload === 'string' ? m.payload : '';
          results.push([id, m._decodedEncryptedMedia
            ? { kind: 'text', text: optText, media: m._decodedEncryptedMedia }
            : { kind: 'plain', text: optText }]);
          continue;
        }
        const ex = decodedRef.current.get(id);
        if (ex && ex.kind !== 'waiting') continue; // already resolved
        const d = await decryptDmMessage(m.payload as never, m.author);
        if (cancelled) return;
        results.push([id, d]);
      }
      if (cancelled || results.length === 0) return;
      setDecoded((prev) => {
        const next = new Map(prev);
        for (const [id, d] of results) {
          const ex = next.get(id);
          if (ex && ex.kind !== 'waiting' && d.kind === 'waiting') continue; // never downgrade
          next.set(id, d);
        }
        return next;
      });
    })();
    return () => { cancelled = true; };
  }, [messages, decodeTick]);

  // Build list items with date separators and author grouping.
  // O(n) optimistic dedup via Set.
  const listItems = useMemo((): ListItem[] => {
    const realMsgKeys = new Set<string>();
    for (const m of messages) {
      if (!m._optimistic) {
        const bucket = Math.floor(new Date(m.timestamp).getTime() / 10000);
        realMsgKeys.add(`${m.author}|${bucket}`);
      }
    }

    const filtered = messages.filter((m) => {
      if (!m._optimistic) return true;
      const bucket = Math.floor(new Date(m.timestamp).getTime() / 10000);
      return !realMsgKeys.has(`${m.author}|${bucket}`);
    });

    const sorted = filtered.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

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
        key: msgIdToHex(msg.msg_id) || `dm-${msg.timestamp}`,
      });

      lastAuthor = msg.author;
      lastTimestamp = msgTime;
    }

    return items.reverse();
  }, [messages, t]);

  // ── Message Actions ──

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if ((!text && pendingEncryptedMedia.length === 0) || !client || !signer || !myAddress) return;

    // DMs are end-to-end encrypted; only built-in wallets can sign the key envelopes.
    if (!e2eAvailable()) {
      Alert.alert(t('chat_send'), t('e2e_builtin_only'));
      return;
    }

    // Edit mode — send an encrypted DirectMessageEdit envelope.
    if (editingMsg) {
      try {
        const env = await buildEncryptedDmEditEnvelope(peerAddress, editingMsg.msgId, text);
        await client.sendDm(peerAddress, env);
        setMessages((prev) => prev.map((m) =>
          msgIdToHex(m.msg_id) === editingMsg.msgId
            ? { ...m, payload: text, edited: true, last_edited_at: Date.now() }
            : m,
        ));
        setEditingMsg(null);
        setInput('');
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        debugLog('warn', `DM edit failed: ${msg}`);
        Alert.alert(t('chat_edit'), msg.slice(0, 150));
      }
      return;
    }

    try {
      const sentMedia = [...pendingEncryptedMedia];
      const env = await buildEncryptedDm(peerAddress, text, undefined, sentMedia.length > 0 ? sentMedia : undefined);
      await client.sendDm(peerAddress, env);
      debugLog('info', `Encrypted DM sent to ${peerAddress.slice(0, 12)}`);

      const localMsg: ExtendedEnvelope = {
        version: 1,
        msg_type: 5,
        msg_id: `dm-${Date.now()}`,
        author: myAddress,
        timestamp: Date.now(),
        lamport_ts: 0,
        payload: text,
        signature: '',
        relay_path: [],
        _optimistic: true,
        _decodedEncryptedMedia: sentMedia.length > 0 ? sentMedia : undefined,
      };
      setMessages((prev) => {
        const next = [localMsg, ...prev];
        return next.length > MAX_LOCAL_MESSAGES ? next.slice(0, MAX_LOCAL_MESSAGES) : next;
      });
      setInput('');
      setPendingEncryptedMedia([]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `DM send failed: ${msg}`);
      if (msg.includes('RECIPIENT_NO_ENC_KEYS')) {
        Alert.alert(t('chat_send'), t('e2e_recipient_no_keys'));
      } else {
        Alert.alert(t('chat_send'), msg.slice(0, 150));
      }
    }
  }, [input, client, signer, myAddress, peerAddress, editingMsg, t, pendingEncryptedMedia]);

  const handlePickMedia = useCallback(async () => {
    if (!client || !signer || uploading) return;
    // DMs are always encrypted → read bytes (base64) and encrypt BEFORE upload (P5).
    if (!e2eAvailable()) {
      Alert.alert(t('chat_send'), t('e2e_builtin_only'));
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: false,
      quality: 0.8,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    if (asset.fileSize && asset.fileSize > MAX_ENCRYPTED_MEDIA_BYTES) {
      Alert.alert(t('error_generic'), 'File too large (max 50MB)');
      return;
    }
    setUploading(true);
    try {
      if (!asset.base64) throw new Error('could not read file bytes for encryption');
      const bytes = base64ToBytes(asset.base64);
      const descriptor = await encryptAndUploadFile({
        bytes,
        mime: asset.mimeType ?? 'application/octet-stream',
        name: asset.fileName ?? `file-${Date.now()}`,
      });
      setPendingEncryptedMedia((prev) => [...prev, descriptor]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `DM media upload failed: ${msg}`);
      const friendly = msg === 'FILE_TOO_LARGE' ? 'File too large (max 50MB)'
        : msg.includes('404') ? t('news_upload_unavailable')
          : msg.slice(0, 150);
      Alert.alert(t('error_generic'), friendly);
    } finally {
      setUploading(false);
    }
  }, [client, signer, uploading, t]);

  const handleEdit = useCallback((msg: ExtendedEnvelope) => {
    // Ownership guard
    if (msg.author !== myAddress) return;
    const d = decodedRef.current.get(dmCacheId(msg));
    const content = d && (d.kind === 'text' || d.kind === 'plain') ? d.text : '';
    setEditingMsg({ msgId: msgIdToHex(msg.msg_id), content });
    setInput(content);
    inputRef.current?.focus();
  }, [myAddress]);

  const handleDelete = useCallback(async (msg: Envelope) => {
    // Ownership guard
    if (!client || msg.author !== myAddress) return;
    try {
      await client.deleteDm(peerAddress, msgIdToHex(msg.msg_id));
      setMessages((prev) => prev.map((m) =>
        msgIdToHex(m.msg_id) === msgIdToHex(msg.msg_id)
          ? { ...m, deleted: true }
          : m,
      ));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : '';
      debugLog('warn', `DM delete failed: ${errMsg}`);
      const key = chatErrorKey(errMsg);
      Alert.alert(t('chat_delete'), key ? t(key) : errMsg.slice(0, 150));
    }
  }, [client, peerAddress, myAddress, t]);

  const handleReact = useCallback(async (msg: Envelope, emoji: string) => {
    if (!client) return;
    // Validate emoji against allowlist
    if (!CHAT_REACTIONS.includes(emoji)) return;
    try {
      await client.reactToDm(peerAddress, msgIdToHex(msg.msg_id), emoji);
      setMessages((prev) => prev.map((m) => {
        if (msgIdToHex(m.msg_id) !== msgIdToHex(msg.msg_id)) return m;
        const reactions = { ...(m.reactions || {}) };
        reactions[emoji] = (reactions[emoji] || 0) + 1;
        return { ...m, reactions };
      }));
    } catch (e) {
      debugLog('warn', `DM react failed: ${e instanceof Error ? e.message : ''}`);
    }
  }, [client, peerAddress]);

  const cancelEdit = useCallback(() => {
    setEditingMsg(null);
    setInput('');
  }, []);

  // ── Render ──

  const peerLabel = useMemo(() => displayName || peerAddress.slice(0, 16) + '...', [displayName, peerAddress]);

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
    const disp = decoded.get(dmCacheId(envelope));
    const content = !disp ? ''
      : disp.kind === 'waiting' ? t('e2e_waiting')
        : disp.kind === 'error' ? t('e2e_cant_decrypt')
          : disp.text;
    const encryptedMedia = disp && disp.kind === 'text' ? disp.media : undefined;
    const authorLabel = isOwn ? t('chat_you') : peerLabel;
    const nodeUrl = (client as any)?.nodeUrl || '';

    return (
      <MessageBubble
        message={envelope}
        content={content}
        isOwn={isOwn}
        authorLabel={authorLabel}
        encryptedMedia={encryptedMedia}
        mediaBaseUrl={nodeUrl ? `${nodeUrl}/api/v1/media/` : undefined}
        isGrouped={isGrouped}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onReact={handleReact}
        onAuthorPress={handleAuthorPress}
      />
    );
  }, [myAddress, colors, peerLabel, decoded, client, handleEdit, handleDelete, handleReact, handleAuthorPress, t]);

  const keyExtractor = useCallback((item: ListItem) => item.key, []);

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 60}
    >
      {/* Peer header */}
      <View style={[styles.header, { backgroundColor: colors.bgSecondary, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>{peerLabel}</Text>
      </View>

      <FlatList
        data={listItems}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        inverted
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: colors.textSecondary }}>{t('chat_start_conversation')}</Text>
          </View>
        }
      />

      <View style={{ backgroundColor: colors.bgSecondary, borderTopWidth: 1, borderTopColor: colors.border }}>
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

        {/* Encrypted attachment preview (P5) */}
        {pendingEncryptedMedia.length > 0 && (
          <View style={[styles.attachPreview, { borderBottomColor: colors.border }]}>
            {pendingEncryptedMedia.map((m, i) => (
              <View key={i} style={[styles.attachChip, { backgroundColor: colors.bgTertiary }]}>
                <Text style={{ color: colors.textPrimary, fontSize: fontSize.xs }} numberOfLines={1}>
                  🔒 {m.name || m.cid.slice(0, 12)}
                </Text>
                <TouchableOpacity onPress={() => setPendingEncryptedMedia((p) => p.filter((_, j) => j !== i))}>
                  <Text style={{ color: colors.error, fontSize: fontSize.sm }}>✕</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        )}

        {/* Input bar */}
        <View style={styles.inputBar}>
          {!editingMsg && (
            <TouchableOpacity
              style={[styles.attachBtn, { backgroundColor: colors.bgTertiary }]}
              onPress={handlePickMedia}
              disabled={uploading}
            >
              <Text style={{ color: uploading ? colors.textSecondary : colors.textPrimary, fontSize: fontSize.lg }}>
                {uploading ? '…' : '📎'}
              </Text>
            </TouchableOpacity>
          )}
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
            style={[styles.sendBtn, { backgroundColor: (input.trim() || pendingEncryptedMedia.length > 0) ? colors.accentPrimary : colors.textSecondary }]}
            onPress={handleSend}
            disabled={!input.trim() && pendingEncryptedMedia.length === 0}
          >
            <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
              {editingMsg ? t('save') : t('chat_send')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTitle: { fontSize: fontSize.lg, fontWeight: '700' },
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
  contextContent: { flex: 1 },
  contextLabel: { fontSize: fontSize.xs, fontWeight: '600' },
  contextPreview: { fontSize: fontSize.xs },
  contextClose: { padding: spacing.sm },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
  },
  input: {
    flex: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    maxHeight: 100,
  },
  sendBtn: {
    marginLeft: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    justifyContent: 'center',
  },
  attachBtn: {
    marginRight: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    justifyContent: 'center',
    alignItems: 'center',
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
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    maxWidth: 180,
  },
});
