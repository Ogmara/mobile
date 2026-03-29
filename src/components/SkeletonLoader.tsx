/**
 * Skeleton loader — animated placeholder while content loads.
 *
 * Renders pulsing grey bars that mimic the shape of real content.
 * Used in feeds, profiles, and detail screens.
 */

import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';
import { useTheme, spacing, radius } from '../theme';

interface Props {
  /** Number of skeleton rows to render (default: 3). */
  rows?: number;
  /** Whether to show a circular avatar placeholder (default: false). */
  avatar?: boolean;
}

export default function SkeletonLoader({ rows = 3, avatar = false }: Props) {
  const { colors } = useTheme();
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
      ]),
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  const barColor = colors.bgTertiary;

  return (
    <View style={styles.container}>
      {Array.from({ length: rows }).map((_, i) => (
        <Animated.View key={i} style={[styles.row, { opacity }]}>
          {avatar && (
            <View style={[styles.avatar, { backgroundColor: barColor }]} />
          )}
          <View style={styles.lines}>
            <View style={[styles.line, styles.lineShort, { backgroundColor: barColor }]} />
            <View style={[styles.line, styles.lineLong, { backgroundColor: barColor }]} />
            {i % 2 === 0 && (
              <View style={[styles.line, styles.lineMedium, { backgroundColor: barColor }]} />
            )}
          </View>
        </Animated.View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: spacing.md },
  row: {
    flexDirection: 'row',
    marginBottom: spacing.lg,
    alignItems: 'flex-start',
  },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: radius.full,
    marginRight: spacing.md,
  },
  lines: { flex: 1 },
  line: { height: 12, borderRadius: radius.sm, marginBottom: spacing.sm },
  lineShort: { width: '40%' },
  lineMedium: { width: '70%' },
  lineLong: { width: '90%' },
});
