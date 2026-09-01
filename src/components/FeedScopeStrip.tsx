/**
 * FeedScopeStrip — the News Feed scope selector: All / Following plus every
 * followed-topic group, in one horizontally-scrollable pill row.
 *
 * Replaces the fixed-width All/Following `SegmentedControl` once the user has
 * topic groups (or a non-empty Followed Topics union): the two built-in scopes
 * become the first pills and the groups follow, scrolling off-screen to the
 * right when there are more than fit. A trailing "🔥 Topics" pill opens the
 * full Topics screen (manage groups + Hot Topics).
 */

import React from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme, spacing, fontSize, radius } from '../theme';

export interface ScopePill {
  /** 'all' | 'following' | 'followed' | a group id. */
  key: string;
  label: string;
  /** Leading glyph (emoji), optional. */
  icon?: string;
}

interface Props {
  pills: ScopePill[];
  activeKey: string;
  onSelect: (key: string) => void;
  /** Tapped the trailing "Topics" affordance. */
  onManage: () => void;
  manageLabel: string;
}

export default function FeedScopeStrip({ pills, activeKey, onSelect, onManage, manageLabel }: Props) {
  const { colors } = useTheme();

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.strip}
      contentContainerStyle={styles.content}
    >
      {pills.map((p) => {
        const active = p.key === activeKey;
        return (
          <TouchableOpacity
            key={p.key}
            style={[
              styles.pill,
              { backgroundColor: active ? colors.accentPrimary : colors.bgTertiary },
            ]}
            onPress={() => onSelect(p.key)}
            activeOpacity={0.85}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
          >
            <Text
              style={[styles.label, { color: active ? colors.textInverse : colors.textSecondary }]}
              numberOfLines={1}
            >
              {p.icon ? `${p.icon} ` : ''}
              {p.label}
            </Text>
          </TouchableOpacity>
        );
      })}
      <TouchableOpacity
        style={[styles.pill, styles.managePill, { borderColor: colors.border }]}
        onPress={onManage}
        activeOpacity={0.7}
      >
        <Text style={[styles.label, { color: colors.accentPrimary }]} numberOfLines={1}>
          🔥 {manageLabel}
        </Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  strip: { flexGrow: 0, marginTop: spacing.sm, marginBottom: spacing.xs },
  content: { paddingHorizontal: spacing.md, alignItems: 'center' },
  pill: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    marginRight: spacing.xs,
    maxWidth: 200,
  },
  managePill: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth },
  label: { fontWeight: '600', fontSize: fontSize.sm },
});
