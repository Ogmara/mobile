/**
 * InfoModal — themed single-message dialog with one OK/dismiss button.
 *
 * React Native's `Alert.alert` renders as the bare native OS dialog and
 * ignores the app's theme entirely. This is the info/error counterpart to
 * ConfirmModal (confirm/cancel) and PromptModal (text input) — for the very
 * common case of "tell the user something went wrong / succeeded" with no
 * second action.
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import Button from './Button';

interface Props {
  visible: boolean;
  title?: string;
  message: string;
  onClose: () => void;
}

export default function InfoModal({ visible, title, message, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={[styles.dialog, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
          {title ? <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text> : null}
          <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>
          <Button label={t('done')} onPress={onClose} style={styles.okBtn} />
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.sm },
  message: { fontSize: fontSize.md, marginBottom: spacing.lg },
  okBtn: { alignSelf: 'flex-end' },
});
