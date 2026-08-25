/**
 * Pure button-resolution rules for the themed alert host.
 *
 * Extracted from `components/AlertHost.tsx` so it can be unit-tested: the test
 * runner is `node --test` over plain TS, which cannot resolve a module that
 * imports `react-native`.
 */

export interface AlertButton {
  text: string;
  onPress?: () => void;
  /** `cancel` renders as the muted/outline button; `destructive` renders red. */
  style?: 'default' | 'cancel' | 'destructive';
}

/**
 * Fill in the implicit single dismiss button, matching `Alert.alert`'s own
 * behaviour when called with no button array.
 */
export function resolveButtons(
  buttons: AlertButton[] | undefined,
  defaultLabel: string,
): AlertButton[] {
  if (buttons && buttons.length > 0) return buttons;
  return [{ text: defaultLabel, style: 'cancel' }];
}

/**
 * Which button (if any) a backdrop tap should activate.
 *
 * Only an explicit `cancel` button qualifies. Deliberately does NOT fall back to
 * "the last button": that would let a tap outside the dialog silently run an
 * action the user never chose — confirming an unstake, deleting a channel — and
 * the native dialog never behaved that way. When there is no cancel button the
 * backdrop just closes the dialog.
 */
export function backdropButtonFor(buttons: AlertButton[]): AlertButton | undefined {
  return buttons.find((b) => b.style === 'cancel');
}

/** Stack buttons vertically once a row would get cramped. */
export function shouldStack(buttons: AlertButton[]): boolean {
  return buttons.length > 2;
}
