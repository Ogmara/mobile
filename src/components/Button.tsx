/**
 * Button — the app's single button primitive.
 *
 * Before this, every screen hand-rolled its own `TouchableOpacity` + local
 * `styles.somethingBtn`: roughly thirty different definitions, so the same
 * logical action looked different depending on which screen you were on. The
 * wallet's bordered buttons read as designed; the flat solid-accent blocks
 * elsewhere ("Claim rewards", "Stake", segmented tabs) read as unstyled system
 * defaults, because a full-bleed accent rectangle with no border, no radius
 * scale and no press state is what an unstyled control looks like.
 *
 * Variants:
 * - `primary`   — filled accent. The one obvious action on a screen.
 * - `secondary` — transparent + hairline border. The wallet's Send/Receive/
 *                 Undelegate look, and the right default for anything that
 *                 isn't the single primary action.
 * - `danger`    — filled error. Destructive and irreversible only.
 * - `ghost`     — text only, no chrome. Inline/tertiary actions.
 *
 * Sizes map to fixed heights so a row of buttons lines up regardless of label
 * length or variant.
 */

import React from 'react';
import {
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  View,
  type StyleProp,
  type ViewStyle,
  type TextStyle,
} from 'react-native';
import { useTheme, spacing, fontSize, radius } from '../theme';

export type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';
export type ButtonSize = 'sm' | 'md' | 'lg';

interface Props {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  disabled?: boolean;
  /** Shows a spinner in place of the label and blocks presses. */
  loading?: boolean;
  /** Stretch to the container's width. */
  fullWidth?: boolean;
  /** Leading glyph (emoji or icon char), rendered before the label. */
  icon?: string;
  style?: StyleProp<ViewStyle>;
  textStyle?: StyleProp<TextStyle>;
  accessibilityLabel?: string;
}

const HEIGHTS: Record<ButtonSize, number> = { sm: 36, md: 44, lg: 52 };
const FONTS: Record<ButtonSize, number> = {
  sm: fontSize.sm,
  md: fontSize.md,
  lg: fontSize.md,
};

export default function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled = false,
  loading = false,
  fullWidth = false,
  icon,
  style,
  textStyle,
  accessibilityLabel,
}: Props) {
  const { colors } = useTheme();
  const inactive = disabled || loading;

  const container: ViewStyle = (() => {
    switch (variant) {
      case 'secondary':
        return { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.border };
      case 'danger':
        return { backgroundColor: colors.error };
      case 'ghost':
        return { backgroundColor: 'transparent' };
      case 'primary':
      default:
        return { backgroundColor: colors.accentPrimary };
    }
  })();

  const labelColor = (() => {
    switch (variant) {
      case 'secondary':
        return colors.textPrimary;
      case 'ghost':
        return colors.accentPrimary;
      default:
        return colors.textInverse;
    }
  })();

  return (
    <TouchableOpacity
      style={[
        styles.base,
        { height: HEIGHTS[size], paddingHorizontal: size === 'sm' ? spacing.md : spacing.lg },
        container,
        fullWidth && styles.fullWidth,
        // Dim rather than swapping in a grey fill: a disabled button should read
        // as the same button, unavailable — not as a different one.
        inactive && styles.inactive,
        style,
      ]}
      onPress={onPress}
      disabled={inactive}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityState={{ disabled: inactive, busy: loading }}
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {loading ? (
        <ActivityIndicator size="small" color={labelColor} />
      ) : (
        <View style={styles.row}>
          {icon ? (
            <Text style={[styles.label, { color: labelColor, fontSize: FONTS[size] }]}>{icon}</Text>
          ) : null}
          <Text
            style={[styles.label, { color: labelColor, fontSize: FONTS[size] }, textStyle]}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  base: {
    borderRadius: radius.lg,
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullWidth: { alignSelf: 'stretch', width: '100%' },
  inactive: { opacity: 0.45 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  label: { fontWeight: '600' },
});
