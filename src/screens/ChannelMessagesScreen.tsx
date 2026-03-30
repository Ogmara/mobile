/**
 * Channel Messages — message view for a specific channel.
 *
 * Shows messages in chronological order with pull-to-load-more
 * and real-time updates via WebSocket.
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
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { Envelope } from '@ogmara/sdk';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChatStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<ChatStackParamList, 'ChannelMessages'>;

export default function ChannelMessagesScreen({ route }: Props) {
  const { channelId, channelName } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, onWsEvent } = useConnection();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Envelope[]>([]);
  const [replyTo, setReplyTo] = useState<Envelope | null>(null);

  const { data, loading } = useApi(
    async () => {
      if (!client) return { messages: [], has_more: false };
      return client.getChannelMessages(channelId);
    },
    [channelId, client],
  );

  // Seed messages from initial fetch
  useEffect(() => {
    if (data?.messages) {
      setMessages(data.messages);
    }
  }, [data]);

  // Listen for real-time messages on this channel only
  useEffect(() => {
    const unsub = onWsEvent((event) => {
      if (event.type === 'message') {
        // Only append messages for the current channel
        try {
          const payload = JSON.parse(event.envelope.payload);
          if (payload.channel_id === channelId) {
            setMessages((prev) => [event.envelope, ...prev]);
          }
        } catch {
          // If payload isn't JSON, skip
        }
      }
    });
    return unsub;
  }, [onWsEvent, channelId]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !client || !signer) return;
    try {
      await client.sendMessage(channelId, input.trim());
      setInput('');
      setReplyTo(null);
    } catch {
      // TODO: show error toast
    }
  }, [input, client, signer, channelId]);

  const renderMessage = ({ item }: { item: Envelope }) => (
    <View style={[styles.msgRow, { backgroundColor: colors.bgPrimary }]}>
      <Text style={[styles.msgAuthor, { color: colors.accentPrimary }]}>
        {item.author.slice(0, 12)}...
      </Text>
      <Text style={{ color: colors.textPrimary }}>{item.payload}</Text>
      <Text style={[styles.msgTime, { color: colors.textSecondary }]}>
        {new Date(item.timestamp).toLocaleTimeString()}
      </Text>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <FlatList
        data={messages}
        keyExtractor={(item) => item.msg_id}
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

      {/* Reply indicator */}
      {replyTo && (
        <View style={[styles.replyBar, { backgroundColor: colors.bgTertiary, borderTopColor: colors.border }]}>
          <View style={styles.replyContent}>
            <Text style={[styles.replyLabel, { color: colors.accentPrimary }]}>
              {t('channel_reply_to')} {replyTo.author.slice(0, 12)}...
            </Text>
          </View>
          <TouchableOpacity onPress={() => setReplyTo(null)}>
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.lg }}>✕</Text>
          </TouchableOpacity>
        </View>
      )}

      {signer && (
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
            style={[styles.sendBtn, { backgroundColor: colors.accentPrimary }]}
            onPress={handleSend}
            disabled={!input.trim()}
          >
            <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
              {t('chat_send')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60 },
  msgRow: { paddingVertical: spacing.sm },
  msgAuthor: { fontSize: fontSize.sm, fontWeight: '600' },
  msgTime: { fontSize: fontSize.xs, marginTop: spacing.xs },
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderTopWidth: 1,
  },
  replyContent: { flex: 1 },
  replyLabel: { fontSize: fontSize.sm, fontWeight: '600' },
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
