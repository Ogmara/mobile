/**
 * PIN Setup — create, change, or turn off the app lock PIN.
 *
 * Default flow is two-step: enter new PIN → confirm PIN (spec 05-clients.md
 * 5.6.1). Navigated with `{ mode: 'disable' }` it is a single-step flow that
 * re-enters the current PIN and removes it.
 *
 * The PIN is a UI gate only — it does not encrypt the vault key (see
 * `lib/vault.ts`), so `removePin` cannot strand a wallet: it only clears the
 * `ogmara.app_lock.*` SecureStore entries.
 *
 * The disable flow shares the same `failed_attempts` / `cooldown_until` state as
 * `LockScreen`, so it honours the same escalating cooldown — otherwise a few
 * mistyped disable attempts would silently arm a lockout that only shows up at
 * the next real unlock.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { setupPin, removePin, getRemainingCooldown } from '../lib/appLock';
import { showAlert } from '../components/AlertHost';
import type { MoreStackParamList } from '../navigation/types';

const PIN_LENGTH = 6;

export default function PinSetupScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const navigation = useNavigation();
  const route = useRoute<RouteProp<MoreStackParamList, 'PinSetup'>>();
  const mode = route.params?.mode ?? 'setup';
  const disabling = mode === 'disable';

  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [firstPin, setFirstPin] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  // Pick up a cooldown already armed by earlier failures (here or at LockScreen).
  useEffect(() => {
    if (!disabling) return;
    getRemainingCooldown().then((cd) => { if (cd > 0) setCooldown(cd); });
  }, [disabling]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const handleDisable = (enteredPin: string) => {
    setSaving(true);
    removePin(enteredPin)
      .then((ok) => {
        setSaving(false);
        if (ok) {
          showAlert(t('done'), '', [{ text: 'OK', onPress: () => navigation.goBack() }]);
        } else {
          setPin('');
          setError(t('security_pin_wrong'));
          // A wrong entry may have just armed / escalated the shared cooldown.
          getRemainingCooldown().then((cd) => { if (cd > 0) setCooldown(cd); });
        }
      })
      .catch(() => {
        setSaving(false);
        setPin('');
        setError(t('error_generic'));
      });
  };

  const handleDigit = (digit: string) => {
    if (pin.length >= PIN_LENGTH || cooldown > 0) return;
    const newPin = pin + digit;
    setPin(newPin);
    setError('');

    if (newPin.length !== PIN_LENGTH) return;

    if (disabling) {
      handleDisable(newPin);
      return;
    }

    if (step === 'enter') {
      setFirstPin(newPin);
      setPin('');
      setStep('confirm');
    } else {
      // Confirm step — check match
      if (newPin === firstPin) {
        setSaving(true);
        setupPin(newPin)
          .then(() => {
            setSaving(false);
            showAlert(t('done'), '', [{ text: 'OK', onPress: () => navigation.goBack() }]);
          })
          .catch(() => { setSaving(false); setError(t('error_generic')); });
      } else {
        setPin('');
        setStep('enter');
        setFirstPin('');
        setError(t('pin_mismatch'));
      }
    }
  };

  const handleBackspace = () => {
    setPin((p) => p.slice(0, -1));
  };

  const title = disabling
    ? t('security_pin_disable_title')
    : step === 'enter'
      ? t('wallet_pin_setup')
      : t('pin_confirm_title');

  if (saving) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator color={colors.accentPrimary} size="large" />
        <Text style={[styles.savingText, { color: colors.textSecondary }]}>
          {disabling ? t('security_pin_disable_title') : t('pin_securing')}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{title}</Text>

      <View style={styles.dotsRow}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i < pin.length ? colors.accentPrimary : 'transparent',
                borderColor: colors.border,
              },
            ]}
          />
        ))}
      </View>

      {error ? (
        <Text style={[styles.error, { color: colors.error }]}>{error}</Text>
      ) : cooldown > 0 ? (
        <Text style={[styles.error, { color: colors.warning }]}>
          {t('security_pin_locked', { count: cooldown })}
        </Text>
      ) : null}

      <View style={styles.pad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '\u232B'].map(
          (key) => (
            <TouchableOpacity
              key={key || 'empty'}
              style={[styles.padBtn, { backgroundColor: key ? colors.bgSecondary : 'transparent' }]}
              onPress={() => {
                if (key === '\u232B') handleBackspace();
                else if (key) handleDigit(key);
              }}
              disabled={!key || cooldown > 0}
              activeOpacity={0.6}
            >
              <Text style={[styles.padText, { color: colors.textPrimary }]}>{key}</Text>
            </TouchableOpacity>
          ),
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  title: { fontSize: fontSize.xl, fontWeight: '700', marginBottom: spacing.xl },
  dotsRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  dot: { width: 16, height: 16, borderRadius: radius.full, borderWidth: 2 },
  savingText: { fontSize: fontSize.md, marginTop: spacing.lg },
  error: { fontSize: fontSize.sm, marginBottom: spacing.md },
  pad: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    width: 260,
    gap: spacing.md,
  },
  padBtn: {
    width: 72,
    height: 72,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  padText: { fontSize: fontSize.xl, fontWeight: '600' },
});
