/**
 * DM Conversation — encrypted message view with a single peer.
 *
 * Messages are E2E encrypted (client decrypts locally).
 * Per spec 03-l2-node.md section 4.2 (GET /api/v1/dm/:address/messages).
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
import type { DmStackParamList } from '../navigation/types';
import { isValidKleverAddress } from '../lib/validation';

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
      if (!client || !signer || !isValidKleverAddress(peerAddress)) {
        return { messages: [], has_more: false };
      }
      return client.getDmMessages(peerAddress);
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
      if (event.type === 'dm') {
        if (event.envelope.author === peerAddress) {
          setMessages((prev) => [event.envelope, ...prev]);
        }
      }
    });
    return unsub;
  }, [onWsEvent, peerAddress]);

  const handleSend = useCallback(async () => {
    if (!input.trim() || !client || !signer || !myAddress) return;
    const text = input.trim();
    try {
      const result = await client.sendDm(peerAddress, text);
      // Optimistically add to local state so the user sees their message
      const localMsg: Envelope = {
        version: 1,
        msg_type: 0x05, // DirectMessage
        msg_id: result.msg_id,
        author: myAddress,
        timestamp: Date.now(),
        lamport_ts: 0,
        payload: text,
        signature: '',
        relay_path: [],
      };
      setMessages((prev) => [localMsg, ...prev]);
      setInput('');
    } catch {
      // TODO: show error toast
    }
  }, [input, client, signer, myAddress, peerAddress]);

  const renderMessage = ({ item }: { item: Envelope }) => {
    const isOwn = item.author === myAddress;
    return (
      <View style={[styles.msgRow, isOwn ? styles.msgOwn : styles.msgPeer]}>
        <View
          style={[
            styles.bubble,
            {
              backgroundColor: isOwn ? colors.accentPrimary : colors.bgSecondary,
            },
          ]}
        >
          <Text style={{ color: isOwn ? colors.textInverse : colors.textPrimary }}>
            {item.payload}
          </Text>
        </View>
        <Text style={[styles.time, { color: colors.textSecondary }]}>
          {new Date(item.timestamp).toLocaleTimeString()}
        </Text>
      </View>
    );
  };

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
          style={[styles.sendBtn, { backgroundColor: colors.dm }]}
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
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
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
