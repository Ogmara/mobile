/**
 * PromptModal — single-line text input dialog (create/rename by name).
 *
 * Alert.prompt is iOS-only in React Native, so anywhere the app needs a
 * cross-platform "name this" prompt (e.g. channel group create/rename) uses
 * this instead. Modeled on TipDialog's Modal + TextInput chrome.
 */

import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';

interface Props {
  visible: boolean;
  title: string;
  initialValue?: string;
  maxLength?: number;
  onSubmit: (value: string) => void;
  onClose: () => void;
}

export default function PromptModal({ visible, title, initialValue = '', maxLength = 32, onSubmit, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (visible) setValue(initialValue);
  }, [visible, initialValue]);

  const handleSubmit = () => {
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View style={[styles.dialog, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>
          <TextInput
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
            value={value}
            onChangeText={setValue}
            maxLength={maxLength}
            autoFocus
            onSubmitEditing={handleSubmit}
          />
          <View style={styles.actions}>
            <TouchableOpacity style={[styles.cancelBtn, { borderColor: colors.border }]} onPress={onClose}>
              <Text style={{ color: colors.textPrimary }}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.confirmBtn, { backgroundColor: colors.accentPrimary }]}
              onPress={handleSubmit}
              disabled={!value.trim()}
            >
              <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{t('save')}</Text>
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
  title: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.md },
  input: {
    padding: spacing.md,
    borderRadius: radius.md,
    fontSize: fontSize.md,
    marginBottom: spacing.md,
  },
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
