/**
 * EmojiPicker — compact emoji grid modal for inserting into text inputs.
 *
 * Shows categorized emoji grid. Tapping an emoji calls onSelect.
 * Matches desktop emoji set from desktop/src/components/EmojiPicker.tsx.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
  ScrollView,
} from 'react-native';
import { useTheme, spacing, fontSize, radius } from '../theme';

const EMOJI_GROUPS: { label: string; emojis: string[] }[] = [
  { label: 'Smileys', emojis: ['😀','😂','🤣','😊','😍','🥰','😎','🤔','😢','😭','😤','🤯','🥳','😴','🤮','🤡','👻','💀'] },
  { label: 'Gestures', emojis: ['👍','👎','👏','🙏','🤝','✌️','🤞','💪','👋','🖐️','✋','🫶'] },
  { label: 'Hearts', emojis: ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','💔','❤️‍🔥','💕','💖'] },
  { label: 'Objects', emojis: ['🔥','⭐','✨','💎','🎉','🎊','🏆','🎯','💡','📎','🔗','🔔'] },
  { label: 'Nature', emojis: ['☀️','🌙','⛈️','🌈','🌊','🌸','🍀','🐱','🐶','🦄','🐸','🦋'] },
  { label: 'Food', emojis: ['🍕','🍔','🍟','🌮','🍣','🍦','🎂','🍺','☕','🧃','🍷','🥂'] },
  { label: 'Flags', emojis: ['🏴‍☠️','🏁','🚩','🏳️‍🌈'] },
];

interface Props {
  visible: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}

export default function EmojiPicker({ visible, onSelect, onClose }: Props) {
  const { colors } = useTheme();
  const [activeGroup, setActiveGroup] = useState(0);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={onClose}>
        <View
          style={[styles.panel, { backgroundColor: colors.bgSecondary }]}
          onStartShouldSetResponder={() => true}
        >
          {/* Category tabs */}
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabBar}>
            {EMOJI_GROUPS.map((group, idx) => (
              <TouchableOpacity
                key={group.label}
                style={[styles.tab, activeGroup === idx && { backgroundColor: colors.accentPrimary }]}
                onPress={() => setActiveGroup(idx)}
              >
                <Text style={{
                  color: activeGroup === idx ? colors.textInverse : colors.textSecondary,
                  fontSize: fontSize.xs,
                  fontWeight: '600',
                }}>
                  {group.emojis[0]} {group.label}
                </Text>
              </TouchableOpacity>
            ))}
          </ScrollView>

          {/* Emoji grid */}
          <View style={styles.grid}>
            {EMOJI_GROUPS[activeGroup].emojis.map((emoji) => (
              <TouchableOpacity
                key={emoji}
                style={[styles.emojiBtn, { backgroundColor: colors.bgTertiary }]}
                onPress={() => { onSelect(emoji); onClose(); }}
              >
                <Text style={styles.emojiText}>{emoji}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  panel: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    paddingBottom: spacing.xl,
    maxHeight: 300,
  },
  tabBar: {
    flexDirection: 'row',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
  },
  tab: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    marginRight: spacing.xs,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    padding: spacing.sm,
    gap: spacing.xs,
  },
  emojiBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  emojiText: {
    fontSize: 24,
  },
});
