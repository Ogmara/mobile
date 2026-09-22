/**
 * MessageButtons — renders the interactive button row(s) attached to a
 * message (protocol §3.3, frontend spec §6.1.3).
 *
 * Simpler than web/desktop's version here: no composer-position/caret-
 * geometry logic needed, just a row/grid of `Button` presses under the
 * message. Uses the established `Button.tsx` idiom (`size="xs"`, added for
 * this) rather than a hand-rolled `TouchableOpacity`.
 *
 * No hover exists on touch, so unlike web/desktop's tooltip-before +
 * persistent-confirmation-after disclosure, this relies solely on the
 * "immediately after" branch of frontend spec §6.1.3's MUST (show the
 * literal command before OR immediately after pressing) — a non-auto-
 * clearing "Sent: <command>" line, matching web/desktop's own touch-device
 * fallback, which already covers the no-hover case there too. A bespoke
 * long-press-preview "before" mechanism was considered and skipped: it
 * would be new, unaudited interaction code for a MUST this already
 * satisfies via the after-branch alone.
 */

import React, { useState, useRef } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize } from '../theme';
import { safeText } from '../lib/sanitize';
import { chatErrorKey } from '../lib/chatErrors';
import Button from './Button';
import type { PayloadButtonRow } from '../lib/payloadDecoder';

interface ButtonOrigin {
  channelId: number;
  msgId: string;
  author: string;
}

interface Props {
  rows: PayloadButtonRow[];
  /** The message THESE buttons are attached to — becomes `origin` on press. */
  channelId: number;
  msgId: string;
  author: string;
  /**
   * Sends the press: signs and broadcasts a message whose content is
   * `command`, replying to `origin`. The caller (`ChannelMessagesScreen`)
   * owns this because it alone knows whether the channel is encrypted —
   * spec §6.1.3: "Private and encrypted channels. Buttons work there
   * unchanged" — only `content` is ever sealed, so a press there needs the
   * channel's epoch key, which this component has no access to. Reject to
   * report a failure; the error's `message` is shown here (sanitized).
   */
  onPress: (origin: ButtonOrigin, command: string) => Promise<void>;
}

export default function MessageButtons({ rows, channelId, msgId, author, onPress }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // Keyed by "rowIndex-buttonIndex" — each button tracks its OWN in-flight
  // state independently (spec: "the tapped button shows a disabled/loading
  // state", not the whole row).
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  // Deliberately NOT auto-cleared on a timer: since the press itself is
  // suppressed from the feed (spec §6.1.3), this is the only artifact that
  // ever shows the user what they signed and broadcast. It clears when a
  // new press starts.
  const [sentCommand, setSentCommand] = useState<string | null>(null);
  // Belt-and-suspenders alongside the `pendingKeys` state (which also
  // disables the button visually): a `useRef` is mutated synchronously, so
  // two taps arriving in the same event-loop tick before React re-renders
  // `disabled` can't both pass the guard the way two reads of `pendingKeys`
  // (a `useState` closure value) theoretically could.
  const inFlightKeys = useRef<Set<string>>(new Set());

  if (!rows.some((r) => r.buttons.length > 0)) return null;

  const press = async (command: string, key: string) => {
    if (inFlightKeys.current.has(key)) return;
    inFlightKeys.current.add(key);
    setPendingKeys((prev) => new Set(prev).add(key));
    setError(null);
    setSentCommand(null);
    try {
      await onPress({ channelId, msgId, author }, command);
      setSentCommand(command);
    } catch (e) {
      const raw = e instanceof Error ? e.message : '';
      const mapped = chatErrorKey(raw);
      setError(mapped ? t(mapped) : (safeText(raw).slice(0, 150) || t('message_button_send_failed')));
    } finally {
      inFlightKeys.current.delete(key);
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  return (
    // Claims the responder for any touch that starts here, matching the
    // existing idiom in `MessageBubble.tsx`'s own bottom-sheet panels — a
    // DISABLED `Button` (in-flight press) returns `false` from its own
    // `onStartShouldSetResponder`, which would otherwise fall through to the
    // outer message row's `onLongPress` (opens the reply/react/edit/delete
    // menu) instead of just being inert.
    <View style={styles.container} onStartShouldSetResponder={() => true}>
      {rows.map((row, ri) => (
        row.buttons.length > 0 ? (
          <View key={ri} style={styles.row}>
            {row.buttons.map((button, bi) => {
              const key = `${ri}-${bi}`;
              // Render-time re-sanitization, on top of `payloadDecoder.ts`'s
              // decode-time `safeText()` pass — spec §6.1.3 asks for the
              // strip to happen "at render time" specifically, as defense in
              // depth for any future callsite that decodes a payload
              // without going through that helper.
              const label = safeText(button.label);
              const command = safeText(button.command);
              return (
                <Button
                  key={bi}
                  label={label}
                  onPress={() => { void press(command, key); }}
                  size="xs"
                  variant="secondary"
                  loading={pendingKeys.has(key)}
                  disabled={pendingKeys.has(key)}
                />
              );
            })}
          </View>
        ) : null
      ))}
      {sentCommand ? (
        <Text style={[styles.sent, { color: colors.textSecondary }]}>
          {t('message_button_sent')} <Text style={styles.mono}>{safeText(sentCommand)}</Text>
        </Text>
      ) : null}
      {error ? (
        <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { marginTop: spacing.xs, gap: spacing.xs },
  // A wider gap than the container's own `spacing.xs` — extra separation
  // between adjacent immediate-send-no-confirmation targets (see `Button`'s
  // `xs`-size comment).
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  sent: { fontSize: fontSize.xs },
  mono: { fontFamily: 'monospace' },
  error: { fontSize: fontSize.xs },
});
