/**
 * Message Bubble — renders a single chat message with long-press menu.
 *
 * Actions on long-press: Reply, React, Edit (own), Delete (own), Tip.
 * Per spec 06-frontend.md section 6.1.
 */

import React, { useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActionSheetIOS, Platform, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import type { Envelope } from '@ogmara/sdk';

interface Props {
  message: Envelope;
  isOwn: boolean;
  onReply?: (msg: Envelope) => void;
  onTip?: (msg: Envelope) => void;
  onDelete?: (msg: Envelope) => void;
  onAuthorPress?: (address: string) => void;
}

export default function MessageBubble({ message, isOwn, onReply, onTip, onDelete, onAuthorPress }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const handleLongPress = useCallback(() => {
    const options: string[] = [t('chat_reply'), t('chat_tip')];
    if (isOwn) {
      options.push(t('chat_delete'));
    }
    options.push(t('cancel'));
    const cancelIndex = options.length - 1;
    const destructiveIndex = isOwn ? options.indexOf(t('chat_delete')) : undefined;

    if (Platform.OS === 'ios') {
      ActionSheetIOS.showActionSheetWithOptions(
        { options, cancelButtonIndex: cancelIndex, destructiveButtonIndex: destructiveIndex },
        (index) => {
          if (index === 0) onReply?.(message);
          else if (index === 1) onTip?.(message);
          else if (isOwn && index === 2) onDelete?.(message);
        },
      );
    } else {
      // Android fallback — simple alert with buttons
      const buttons = [
        { text: t('chat_reply'), onPress: () => onReply?.(message) },
        { text: t('chat_tip'), onPress: () => onTip?.(message) },
      ];
      if (isOwn) {
        buttons.push({ text: t('chat_delete'), onPress: () => onDelete?.(message) });
      }
      buttons.push({ text: t('cancel'), onPress: () => {} });
      Alert.alert('', '', buttons);
    }
  }, [message, isOwn, onReply, onTip, onDelete, t]);

  return (
    <TouchableOpacity
      onLongPress={handleLongPress}
      delayLongPress={400}
      activeOpacity={0.8}
      style={styles.container}
    >
      <TouchableOpacity onPress={() => onAuthorPress?.(message.author)}>
        <Text style={[styles.author, { color: colors.accentPrimary }]}>
          {message.author.slice(0, 12)}...
        </Text>
      </TouchableOpacity>
      <Text style={[styles.content, { color: colors.textPrimary }]}>
        {message.payload}
      </Text>
      <Text style={[styles.time, { color: colors.textSecondary }]}>
        {new Date(message.timestamp).toLocaleTimeString()}
      </Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { paddingVertical: spacing.sm },
  author: { fontSize: fontSize.sm, fontWeight: '600' },
  content: { fontSize: fontSize.md, marginTop: spacing.xs, lineHeight: 22 },
  time: { fontSize: fontSize.xs, marginTop: spacing.xs },
});
