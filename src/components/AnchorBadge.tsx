/**
 * AnchorBadge — visual trust badge for nodes that anchor L2 state on-chain.
 *
 * Uses Ionicons checkmark-circle for consistent rendering.
 * "active" nodes show a larger icon; "verified" a smaller one; "none" renders null.
 */

import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { fontSize } from '../theme';

interface Props {
  level: 'active' | 'verified' | 'none';
  showLabel?: boolean;
  size?: number;
}

export default function AnchorBadge({ level, showLabel = false, size }: Props) {
  const { t } = useTranslation();

  if (level === 'none') return null;

  const iconSize = size ?? (level === 'active' ? 16 : 14);
  const color = '#22c55e';

  return (
    <View style={styles.container}>
      <Ionicons name="checkmark-circle" size={iconSize} color={color} />
      {showLabel && (
        <Text style={[styles.label, { color }]}>
          {level === 'active' ? t('anchor_active') : t('anchor_verified')}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
  },
  label: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
});
