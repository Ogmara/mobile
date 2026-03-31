/**
 * Channel Messages — message view for a specific channel.
 *
 * Shows messages in chronological order with real-time updates via WebSocket.
 * Decodes MessagePack payloads to show human-readable text.
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
import { decodeChatMessage } from '../lib/payloadDecoder';
import { normalizeEnvelopes, normalizeEnvelope } from '../lib/envelopeNormalizer';
import { debugLog } from '../lib/debug';
import type { Envelope } from '@ogmara/sdk';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChatStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<ChatStackParamList, 'ChannelMessages'>;

export default function ChannelMessagesScreen({ route }: Props) {
  const { channelId, channelName } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress, onWsEvent } = useConnection();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Envelope[]>([]);

  const { data } = useApi(
    async () => {
      if (!client) return { messages: [], has_more: false };
      const resp = await client.getChannelMessages(channelId);
      return { ...resp, messages: normalizeEnvelopes(resp.messages) };
    },
    [channelId, client],
  );

  // Seed messages from initial fetch
  useEffect(() => {
    if (data?.messages) {
      setMessages(data.messages);
    }
  }, [data]);

  // Listen for real-time messages on this channel
  useEffect(() => {
    const unsub = onWsEvent((event) => {
      if (event.type === 'message' && event.envelope) {
        const env = normalizeEnvelope(event.envelope);
        const decoded = decodeChatMessage(env.payload);
        if (decoded && decoded.channel_id === channelId) {
          setMessages((prev) => {
            // Avoid duplicates
            if (prev.some((m) => m.msg_id === env.msg_id)) return prev;
            return [env, ...prev];
          });
        }
      }
    });
    return unsub;
  }, [onWsEvent, channelId]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !client || !signer) return;
    try {
      const result = await client.sendMessage(channelId, input.trim());
      setInput('');

      // Optimistically add the sent message to the list
      const optimistic: Envelope = {
        version: 1,
        msg_type: 1,
        msg_id: result.msg_id,
        author: myAddress || '',
        timestamp: Date.now(),
        lamport_ts: 0,
        payload: input.trim(), // display as plain text for own message
        signature: '',
        relay_path: [],
      };
      setMessages((prev) => [optimistic, ...prev]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Send failed: ${msg}`);
      Alert.alert('Send failed', msg.slice(0, 150));
    }
  }, [input, client, signer, channelId, myAddress]);

  const renderMessage = ({ item }: { item: Envelope }) => {
    // Decode msgpack payload or use plain text (optimistic sends)
    const decoded = decodeChatMessage(item.payload);
    const content = decoded?.content || (typeof item.payload === 'string' ? item.payload : '');
    const isOwn = item.author === myAddress;

    return (
      <View style={[styles.msgRow, isOwn && styles.msgRowOwn]}>
        {!isOwn && (
          <Text style={[styles.msgAuthor, { color: colors.accentPrimary }]}>
            {item.author.slice(0, 12)}...
          </Text>
        )}
        <View style={[
          styles.msgBubble,
          {
            backgroundColor: isOwn ? colors.accentPrimary : colors.bgSecondary,
            alignSelf: isOwn ? 'flex-end' : 'flex-start',
          },
        ]}>
          <Text style={{ color: isOwn ? colors.textInverse : colors.textPrimary }}>
            {content}
          </Text>
        </View>
        <Text style={[styles.msgTime, { color: colors.textSecondary, textAlign: isOwn ? 'right' : 'left' }]}>
          {new Date(item.timestamp).toLocaleTimeString()}
        </Text>
      </View>
    );
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      behavior="padding"
      keyboardVerticalOffset={Platform.OS === 'ios' ? 90 : 100}
    >
      {/* Channel header */}
      <View style={[styles.header, { backgroundColor: colors.bgSecondary, borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.textPrimary }]}>#{channelName}</Text>
      </View>

      <FlatList
        data={messages}
        keyExtractor={(item, idx) => item.msg_id || `msg-${idx}`}
        renderItem={renderMessage}
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
      ) : (
        <View style={[styles.inputBar, { backgroundColor: colors.bgSecondary, borderTopColor: colors.border }]}>
          <Text style={{ color: colors.textSecondary, padding: spacing.md }}>
            {t('wallet_connect')}
          </Text>
        </View>
      )}
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
  msgRow: { paddingVertical: spacing.xs, maxWidth: '85%' },
  msgRowOwn: { alignSelf: 'flex-end' },
  msgAuthor: { fontSize: fontSize.xs, fontWeight: '600', marginBottom: 2 },
  msgBubble: {
    padding: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.lg,
  },
  msgTime: { fontSize: 10, marginTop: 2 },
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
