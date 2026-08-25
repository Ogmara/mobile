/**
 * SegmentedControl — pill-style two-or-more-way switch.
 *
 * Replaces the hand-rolled feed toggle, which rendered the active option as a
 * full-bleed accent rectangle inside a plain container. Two hard-edged blue
 * blocks read as unstyled system tabs rather than as one control.
 *
 * The modern form is a single rounded track with an inset pill marking the
 * selection: the track carries the shape, the pill only moves within it. Same
 * pattern the wallet's bordered controls use, so the app reads as one design.
 */

import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme, spacing, fontSize, radius } from '../theme';

export interface Segment<T extends string> {
  value: T;
  label: string;
}

interface Props<T extends string> {
  segments: Segment<T>[];
  value: T;
  onChange: (value: T) => void;
}

export default function SegmentedControl<T extends string>({
  segments,
  value,
  onChange,
}: Props<T>) {
  const { colors } = useTheme();

  return (
    <View style={[styles.track, { backgroundColor: colors.bgTertiary }]}>
      {segments.map((segment) => {
        const active = segment.value === value;
        return (
          <TouchableOpacity
            key={segment.value}
            style={[styles.segment, active && { backgroundColor: colors.accentPrimary }]}
            onPress={() => onChange(segment.value)}
            activeOpacity={0.85}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text
              style={[
                styles.label,
                { color: active ? colors.textInverse : colors.textSecondary },
              ]}
              numberOfLines={1}
            >
              {segment.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    flexDirection: 'row',
    borderRadius: radius.full,
    // Inset so the active pill floats inside the track instead of filling it
    // edge to edge — this padding is what makes it read as one control.
    padding: 3,
    gap: 3,
  },
  segment: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: { fontWeight: '600', fontSize: fontSize.sm },
});
