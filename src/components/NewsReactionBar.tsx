/**
 * NewsReactionBar — compact reaction control for news posts.
 *
 * Collapsed by default: renders only the reactions that somebody has actually
 * used (count > 0), plus a single trigger. Rendering all five emoji on every
 * card unconditionally implied five reactions existed when the real count was
 * usually zero, and cost a row of visual noise per post.
 *
 * Matches the behaviour web and desktop already had via their `ReactionPicker`
 * — this brings mobile to parity rather than inventing a third pattern.
 *
 * The chooser expands INLINE rather than floating above the trigger the way the
 * web popup does: these cards render inside a FlatList, where an absolutely
 * positioned overlay is liable to be clipped by an ancestor's bounds.
 */

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { spacing, fontSize, radius } from '../theme';

/**
 * 13%-alpha version of a hex token, for chip fills. React Native has no
 * `color-mix`, and the palette is plain hex, so append an alpha byte.
 * Non-`#rrggbb` input is returned untouched rather than corrupted.
 */
function tint(hex: string): string {
  return /^#[0-9a-fA-F]{6}$/.test(hex) ? `${hex}22` : hex;
}

/** The five reactions offered on a news post. Mirrors web's `NEWS_REACTIONS`. */
export const NEWS_REACTIONS = ['👍', '👎', '❤️', '🔥', '😂'] as const;

interface Props {
  counts: Record<string, number>;
  onReact: (emoji: string) => void;
  colors: {
    bgTertiary: string;
    accentPrimary: string;
    textInverse: string;
    textSecondary: string;
    border: string;
  };
}

export default function NewsReactionBar({ counts, onReact, colors }: Props) {
  const [expanded, setExpanded] = useState(false);

  const active = NEWS_REACTIONS.filter((e) => (counts[e] ?? 0) > 0);

  const pick = (emoji: string) => {
    setExpanded(false);
    onReact(emoji);
  };

  if (expanded) {
    return (
      <View style={styles.row}>
        {NEWS_REACTIONS.map((emoji) => (
          <TouchableOpacity
            key={emoji}
            style={[styles.chip, { backgroundColor: colors.bgTertiary, borderColor: colors.border }]}
            onPress={() => pick(emoji)}
            accessibilityLabel={`React ${emoji}`}
          >
            <Text style={styles.emoji}>{emoji}</Text>
          </TouchableOpacity>
        ))}
        <TouchableOpacity
          style={[styles.chip, { backgroundColor: colors.bgTertiary, borderColor: colors.border }]}
          onPress={() => setExpanded(false)}
          accessibilityLabel="Close reactions"
        >
          <Text style={[styles.trigger, { color: colors.textSecondary }]}>×</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      {active.map((emoji) => (
        <TouchableOpacity
          key={emoji}
          // Tinted chip rather than a solid accent block: a reaction is a
          // count, not a call to action, and a saturated fill made it compete
          // with the post's own content for attention.
          style={[styles.chip, { backgroundColor: tint(colors.accentPrimary), borderColor: colors.accentPrimary }]}
          onPress={() => onReact(emoji)}
          accessibilityLabel={`React ${emoji}`}
        >
          <Text style={styles.emoji}>{emoji}</Text>
          <Text style={[styles.count, { color: colors.accentPrimary }]}>{counts[emoji]}</Text>
        </TouchableOpacity>
      ))}
      <TouchableOpacity
        style={[styles.chip, { backgroundColor: colors.bgTertiary, borderColor: colors.border }]}
        onPress={() => setExpanded(true)}
        accessibilityLabel="Add reaction"
      >
        {active.length > 0 ? (
          <Text style={[styles.trigger, { color: colors.textSecondary }]}>+</Text>
        ) : (
          // Muted thumbs-up as the zero-state affordance, same as web.
          <Text style={[styles.emoji, styles.emojiMuted]}>👍</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    flexWrap: 'wrap',
    gap: spacing.xs,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 5,
    // Pill, matching Button/SegmentedControl's rounded language rather than
    // the old near-square radius.sm.
    borderRadius: radius.full,
    borderWidth: 1,
    gap: 4,
  },
  emoji: { fontSize: fontSize.md },
  emojiMuted: { opacity: 0.5 },
  count: { fontSize: fontSize.xs, fontWeight: '600' },
  trigger: { fontSize: fontSize.md, fontWeight: '600' },
});
