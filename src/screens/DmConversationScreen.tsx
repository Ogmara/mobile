/**
 * DM Conversation — message view with a single peer.
 *
 * Per spec 03-l2-node.md section 4.2 (GET /api/v1/dm/:address/messages).
 * Note: E2E encryption is not yet implemented — messages are sent as
 * signed envelopes but content is not encrypted client-side yet.
 */

import React, { useEffect, useState, useCallback } from 'react';
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
import { decodePayload } from '../lib/payloadDecoder';
import { normalizeEnvelopes, normalizeEnvelope } from '../lib/envelopeNormalizer';
import { debugLog } from '../lib/debug';
import type { Envelope } from '@ogmara/sdk';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { DmStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<DmStackParamList, 'DmConversation'>;

export default function DmConversationScreen({ route }: Props) {
  const { address: peerAddress, displayName } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress, onWsEvent } = useConnection();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Envelope[]>([]);

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
      setMessages(data.messages);
    }
  }, [data]);

  // Listen for real-time DMs from this peer
  useEffect(() => {
    const unsub = onWsEvent((event) => {
      if (event.type === 'dm' && event.envelope) {
        const env = normalizeEnvelope(event.envelope);
        if (env.author === peerAddress) {
          setMessages((prev) => {
            if (prev.some((m) => m.msg_id === env.msg_id)) return prev;
            return [env, ...prev];
          });
        }
      }
    });
    return unsub;
  }, [onWsEvent, peerAddress]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !client || !signer || !myAddress) return;
    const text = input.trim();
    try {
      // TODO: build proper DirectMessage envelope with E2E encryption.
      // For now, send as a channel message to channel 0 (DM placeholder).
      // The node's DM endpoint expects an encrypted envelope which we
      // can't build yet without the key exchange protocol.
      await client.sendMessage(0, `[DM to ${peerAddress.slice(0, 12)}] ${text}`);
      debugLog('info', `DM sent to ${peerAddress.slice(0, 12)}`);

      // Optimistically add to local state
      const localMsg: Envelope = {
        version: 1,
        msg_type: 5,
        msg_id: `dm-${Date.now()}`,
        author: myAddress,
        timestamp: Date.now(),
        lamport_ts: 0,
        payload: text,
        signature: '',
        relay_path: [],
      };
      setMessages((prev) => [localMsg, ...prev]);
      setInput('');
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `DM send failed: ${msg}`);
      Alert.alert('Send failed', msg.slice(0, 150));
    }
  }, [input, client, signer, myAddress, peerAddress]);

  const renderMessage = ({ item }: { item: Envelope }) => {
    const isOwn = item.author === myAddress;
    // Decode payload — could be msgpack bytes or plain text (optimistic)
    const decoded = decodePayload(item.payload);
    const content = decoded?.content
      ? String(decoded.content)
      : typeof item.payload === 'string'
        ? item.payload
        : '';

    return (
      <View style={[styles.msgRow, isOwn ? styles.msgOwn : styles.msgPeer]}>
        <View
          style={[
            styles.bubble,
            { backgroundColor: isOwn ? colors.accentPrimary : colors.bgSecondary },
          ]}
        >
          <Text style={{ color: isOwn ? colors.textInverse : colors.textPrimary }}>
            {content}
          </Text>
        </View>
        <Text style={[styles.time, { color: colors.textSecondary }]}>
          {new Date(item.timestamp).toLocaleTimeString()}
        </Text>
      </View>
    );
  };

  const peerLabel = displayName || peerAddress.slice(0, 16) + '...';

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
        data={messages}
        keyExtractor={(item, idx) => item.msg_id || `dm-${idx}`}
        renderItem={renderMessage}
        inverted
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: colors.textSecondary }}>Start a conversation</Text>
          </View>
        }
      />
      <View style={[styles.inputBar, { backgroundColor: colors.bgSecondary, borderTopColor: colors.border }]}>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder={t('chat_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={input}
          onChangeText={setInput}
          maxLength={4000}
          multiline
        />
        <TouchableOpacity
          style={[styles.sendBtn, { backgroundColor: input.trim() ? colors.accentPrimary : colors.textSecondary }]}
          onPress={handleSend}
          disabled={!input.trim()}
        >
          <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
            {t('chat_send')}
          </Text>
        </TouchableOpacity>
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
  msgRow: { marginBottom: spacing.sm },
  msgOwn: { alignItems: 'flex-end' },
  msgPeer: { alignItems: 'flex-start' },
  bubble: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    maxWidth: '80%',
  },
  time: { fontSize: fontSize.xs, marginTop: spacing.xs },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
    borderTopWidth: 1,
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
});
