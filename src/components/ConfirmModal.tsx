/**
 * ConfirmModal — themed "are you sure?" dialog (Cancel / Confirm).
 *
 * React Native's `Alert.alert` renders as the bare native OS dialog and
 * ignores the app's theme entirely. This is the confirm-dialog counterpart
 * to PromptModal, used wherever a destructive/consequential action (leave,
 * delete, kick, ban) needs a themed confirmation instead.
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

interface Props {
  visible: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  /** Red confirm button for destructive actions (leave/kick/ban/delete). */
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export default function ConfirmModal({ visible, title, message, confirmLabel, danger, onConfirm, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={[styles.dialog, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
          <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>
          <View style={styles.actions}>
            <TouchableOpacity style={[styles.cancelBtn, { borderColor: colors.border }]} onPress={onClose}>
              <Text style={{ color: colors.textPrimary }}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmBtn, { backgroundColor: danger ? colors.error : colors.accentPrimary }]}
              onPress={() => { onClose(); onConfirm(); }}
            >
              <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{confirmLabel}</Text>
            </TouchableOpacity>
          </View>
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
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
  },
  confirmBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
});
