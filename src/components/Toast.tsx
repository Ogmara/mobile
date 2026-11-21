/**
 * Toast — a short, non-blocking confirmation line ("Link copied!") pinned to
 * the bottom of its parent. For feedback that must not interrupt the user the
 * way `showAlert` does. Themed from the active colour tokens.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Text, View, StyleSheet } from 'react-native';
import { useTheme, spacing, fontSize, radius } from '../theme';

/** Toast state for one screen: `[message, show]`. A new message replaces the
 *  current one and restarts the timer; the timer is cleared on unmount. */
export function useToast(durationMs = 2500): [string | null, (message: string) => void] {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const show = useCallback((next: string) => {
    if (timer.current) clearTimeout(timer.current);
    setMessage(next);
    timer.current = setTimeout(() => { timer.current = null; setMessage(null); }, durationMs);
  }, [durationMs]);
  return [message, show];
}

/** Renders `message` (nothing when null). Place as the last child of a
 *  container that fills the screen. */
export default function Toast({ message, bottom = spacing.xl }: { message: string | null; bottom?: number }) {
  const { colors } = useTheme();
  if (!message) return null;
  return (
    <View pointerEvents="none" style={[styles.wrap, { bottom }]}>
      <View
        style={[styles.toast, { backgroundColor: colors.bgTertiary, borderColor: colors.border }]}
        accessibilityLiveRegion="polite"
        accessibilityRole="alert"
      >
        <Text style={{ color: colors.textPrimary, fontSize: fontSize.sm }}>{message}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: spacing.md, right: spacing.md, alignItems: 'center' },
  toast: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    maxWidth: '100%',
  },
});
