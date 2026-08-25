/**
 * AlertHost — app-wide themed replacement for React Native's `Alert.alert`.
 *
 * `Alert.alert` renders the bare native OS dialog: system font, system colours,
 * ALL-CAPS buttons, no relation to the app's theme. `InfoModal`, `ConfirmModal`
 * and `PromptModal` already exist for the cases a screen can model as local
 * state, but the app still had ~90 `Alert.alert` calls, and converting each into
 * its own `useState` + JSX would have meant a large, error-prone edit per screen.
 *
 * So this keeps the ergonomics that made `Alert.alert` spread in the first
 * place: an imperative one-liner, callable from anywhere including non-component
 * code, with the same `(title, message, buttons)` shape. The difference is that
 * it renders through the app's theme.
 *
 * Usage:
 *   import { showAlert } from '../components/AlertHost';
 *   showAlert(t('error_generic'), msg);
 *   showAlert('Claim rewards', 'Submitted.', [
 *     { text: 'View transaction', onPress: openTx },
 *     { text: t('done'), style: 'cancel' },
 *   ]);
 *
 * `<AlertHost />` must be mounted once, inside ThemeProvider (see App.tsx).
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Modal } from 'react-native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import i18n from '../i18n/init';
import {
  resolveButtons,
  backdropButtonFor,
  shouldStack,
  type AlertButton,
} from '../lib/alertButtons';

export type { AlertButton };

interface AlertRequest {
  title: string;
  message?: string;
  buttons: AlertButton[];
}

type Listener = (request: AlertRequest) => void;

let listener: Listener | null = null;

/**
 * Queue holding alerts raised before the host mounted (or during a remount).
 * Without it, an alert fired from app startup — a failed restore, an early
 * network error — would be silently dropped, which `Alert.alert` never did.
 */
const pending: AlertRequest[] = [];

/**
 * Show a themed alert. Drop-in for `Alert.alert(title, message, buttons)`.
 *
 * With no buttons, renders a single dismiss button, matching `Alert.alert`'s
 * own default.
 */
export function showAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
): void {
  const request: AlertRequest = {
    title,
    message,
    // i18n directly, not the `t` hook: showAlert is callable from non-component
    // code, which is the whole point of the imperative API.
    buttons: resolveButtons(buttons, i18n.t('done')),
  };
  if (listener) listener(request);
  else pending.push(request);
}

export default function AlertHost() {
  const { colors } = useTheme();
  const [request, setRequest] = useState<AlertRequest | null>(null);

  useEffect(() => {
    listener = (next) => setRequest(next);
    // Flush anything raised before mount.
    if (pending.length > 0) {
      const first = pending.shift()!;
      setRequest(first);
    }
    return () => {
      listener = null;
    };
  }, []);

  const dismiss = (button?: AlertButton) => {
    setRequest(null);
    // Run the handler after the modal closes so a callback that opens another
    // alert (or navigates) isn't racing this one's teardown.
    if (button?.onPress) setTimeout(button.onPress, 0);
    // Show the next queued alert, if any.
    if (pending.length > 0) {
      const next = pending.shift()!;
      setTimeout(() => setRequest(next), 0);
    }
  };

  if (!request) return null;

  const { title, message, buttons } = request;
  const backdropButton = backdropButtonFor(buttons);
  const stacked = shouldStack(buttons);

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => dismiss(backdropButton)}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => dismiss(backdropButton)}>
        <View
          style={[styles.dialog, { backgroundColor: colors.bgSecondary }]}
          onStartShouldSetResponder={() => true}
        >
          {title ? <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text> : null}
          {message ? (
            <Text style={[styles.message, { color: colors.textSecondary }]}>{message}</Text>
          ) : null}
          <View style={[styles.actions, stacked && styles.actionsStacked]}>
            {buttons.map((button, i) => {
              const isCancel = button.style === 'cancel';
              const isDestructive = button.style === 'destructive';
              return (
                <TouchableOpacity
                  key={`${button.text}-${i}`}
                  style={[
                    styles.btn,
                    stacked && styles.btnStacked,
                    isCancel
                      ? { borderColor: colors.border, borderWidth: 1 }
                      : { backgroundColor: isDestructive ? colors.error : colors.accentPrimary },
                  ]}
                  onPress={() => dismiss(button)}
                >
                  <Text
                    style={[
                      styles.btnText,
                      { color: isCancel ? colors.textPrimary : colors.textInverse },
                    ]}
                  >
                    {button.text}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.sm },
  message: { fontSize: fontSize.md, lineHeight: 22, marginBottom: spacing.lg },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm },
  actionsStacked: { flexDirection: 'column-reverse', alignItems: 'stretch' },
  btn: {
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  btnStacked: { paddingVertical: spacing.md },
  btnText: { fontWeight: '600' },
});
