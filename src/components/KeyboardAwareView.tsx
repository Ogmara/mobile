/**
 * KeyboardAwareView — container that lifts its content clear of the on-screen
 * keyboard.
 *
 * Replaces React Native's `KeyboardAvoidingView`, which does not work in this
 * app. The project builds with `edgeToEdgeEnabled=true` (see
 * `android/gradle.properties`), and in edge-to-edge mode Android no longer
 * resizes the window for the IME — the app draws behind it. The manifest's
 * `android:windowSoftInputMode="adjustResize"` is therefore inert, and
 * `KeyboardAvoidingView`'s Android `behavior="height"` path, which derives its
 * adjustment from that window resize, computes nothing. The result was an input
 * bar sitting underneath the keyboard on every screen you can type on.
 *
 * This measures the keyboard directly from `Keyboard` events, which report the
 * correct height in edge-to-edge, and applies it as bottom padding.
 *
 * Deliberately pads by the keyboard height ALONE, not by the safe-area inset:
 * with the keyboard closed the padding is exactly 0, so layout is byte-for-byte
 * what it was before. That keeps this fix to the reported bug and rules out
 * double-padding on screens that sit inside the tab navigator (whose tab bar
 * already applies its own inset).
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Keyboard,
  Platform,
  type ViewStyle,
  type StyleProp,
} from 'react-native';

/**
 * Current on-screen keyboard height in px, or 0 when hidden.
 *
 * iOS uses the `will` events so the padding animates in step with the system
 * keyboard slide; Android only fires the `did` events reliably.
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';

    const showSub = Keyboard.addListener(showEvent, (e) => {
      setHeight(e.endCoordinates?.height ?? 0);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setHeight(0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  return height;
}

interface Props {
  style?: StyleProp<ViewStyle>;
  children: React.ReactNode;
  /**
   * Subtracted from the applied padding. For a screen whose content already
   * ends above the keyboard by some fixed amount. Clamped at 0.
   */
  offset?: number;
}

export default function KeyboardAwareView({ style, children, offset = 0 }: Props) {
  const keyboardHeight = useKeyboardHeight();
  const paddingBottom = Math.max(keyboardHeight - offset, 0);

  return <View style={[style, { paddingBottom }]}>{children}</View>;
}
