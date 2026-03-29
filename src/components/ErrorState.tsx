/**
 * Error state — displayed when a data fetch fails.
 *
 * Shows error message with a retry button.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';

interface Props {
  message?: string;
  onRetry?: () => void;
}

export default function ErrorState({ message, onRetry }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <View style={styles.container}>
      <Text style={[styles.message, { color: colors.error }]}>
        {message || t('error_generic')}
      </Text>
      {onRetry && (
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.accentPrimary }]}
          onPress={onRetry}
        >
          <Text style={[styles.btnText, { color: colors.textInverse }]}>
            {t('pull_to_refresh')}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.xl },
  message: { fontSize: fontSize.md, textAlign: 'center', marginBottom: spacing.lg },
  btn: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderRadius: radius.md },
  btnText: { fontSize: fontSize.md, fontWeight: '600' },
});
