/**
 * FormatToolbar — floating toolbar for text formatting in compose inputs.
 *
 * Shown when the user selects text. Applies Markdown formatting markers
 * around the selected text range.
 */

import React from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';

interface Props {
  onFormat: (format: 'bold' | 'italic' | 'underline' | 'code' | 'strikethrough') => void;
  visible: boolean;
}

const FORMAT_OPTIONS = [
  { key: 'bold' as const, label: 'B', style: { fontWeight: '800' as const } },
  { key: 'italic' as const, label: 'I', style: { fontStyle: 'italic' as const } },
  { key: 'underline' as const, label: 'U', style: { textDecorationLine: 'underline' as const } },
  { key: 'code' as const, label: '<>', style: { fontFamily: 'monospace' } },
  { key: 'strikethrough' as const, label: 'S', style: { textDecorationLine: 'line-through' as const } },
];

export default function FormatToolbar({ onFormat, visible }: Props) {
  const { colors } = useTheme();

  if (!visible) return null;

  return (
    <View style={[styles.toolbar, { backgroundColor: colors.bgSecondary, borderColor: colors.border }]}>
      {FORMAT_OPTIONS.map((opt) => (
        <TouchableOpacity
          key={opt.key}
          style={styles.btn}
          onPress={() => onFormat(opt.key)}
        >
          <Text style={[styles.btnText, { color: colors.textPrimary }, opt.style]}>
            {opt.label}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderTopWidth: 1,
    gap: spacing.xs,
  },
  btn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    minWidth: 32,
    alignItems: 'center',
  },
  btnText: {
    fontSize: fontSize.md,
    fontWeight: '600',
  },
});
