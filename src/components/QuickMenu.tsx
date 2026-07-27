/**
 * QuickMenu — burger menu overlay with quick navigation links.
 *
 * Accessible from a header button on every tab. Provides fast access to:
 * Followed (feed), Bookmarks, Addressbook (contacts), Wallet/Balance.
 */

import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Modal,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, spacing, fontSize, radius } from '../theme';

interface MenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  items: MenuItem[];
  /** 'top-right' (default) anchors under a header button; 'bottom' renders as
   *  a bottom action sheet, for per-row long-press context menus. */
  anchor?: 'top-right' | 'bottom';
}

export default function QuickMenu({ visible, onClose, items, anchor = 'top-right' }: Props) {
  const { colors } = useTheme();
  const bottom = anchor === 'bottom';

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <TouchableOpacity
        style={[styles.overlay, bottom && styles.overlayBottom]}
        activeOpacity={1}
        onPress={onClose}
      >
        <View style={[styles.menu, bottom && styles.menuBottom, { backgroundColor: colors.bgSecondary }]}>
          {items.map((item, idx) => (
            <TouchableOpacity
              key={idx}
              style={[styles.menuItem, idx < items.length - 1 && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border }]}
              onPress={() => { onClose(); item.onPress(); }}
              activeOpacity={0.7}
            >
              <Ionicons name={item.icon} size={20} color={item.danger ? colors.error : colors.accentPrimary} />
              <Text style={[styles.menuLabel, { color: item.danger ? colors.error : colors.textPrimary }]}>{item.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.3)',
    justifyContent: 'flex-start',
    alignItems: 'flex-end',
    paddingTop: 56,
    paddingRight: spacing.md,
  },
  overlayBottom: {
    justifyContent: 'flex-end',
    alignItems: 'stretch',
    paddingTop: 0,
    paddingRight: 0,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.lg,
  },
  menu: {
    borderRadius: radius.lg,
    minWidth: 200,
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
  },
  menuBottom: {
    minWidth: undefined,
    borderRadius: radius.lg,
  },
  menuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  menuLabel: { fontSize: fontSize.md, fontWeight: '500' },
});
