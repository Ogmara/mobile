/**
 * Lock Screen — PIN entry + biometric prompt.
 *
 * Shown when the app is locked (on launch, after background timeout).
 * Supports PIN entry with cooldown after 5 failures, and biometric
 * as a quick unlock alternative. Per spec 05-clients.md section 5.6.
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import {
  verifyPin,
  getFailedAttempts,
  getCooldownSeconds,
  getRemainingCooldown,
  isBiometricEnabled,
  authenticateBiometric,
  needsIterationMigration,
} from '../lib/appLock';
import { vaultUnlockWithPin } from '../lib/vault';

const MAX_BIOMETRIC_ATTEMPTS = 3;

interface Props {
  onUnlock: () => void;
}

const PIN_LENGTH = 6;
const DOTS = Array.from({ length: PIN_LENGTH });

export default function LockScreen({ onUnlock }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [checking, setChecking] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [bioAttempts, setBioAttempts] = useState(0);

  // Check for existing cooldown and attempt biometric on mount
  useEffect(() => {
    getRemainingCooldown().then((cd) => {
      if (cd > 0) setCooldown(cd);
    });
    tryBiometric();
  }, []);

  // Cooldown timer
  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown((c) => Math.max(0, c - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const tryBiometric = async () => {
    if (bioAttempts >= MAX_BIOMETRIC_ATTEMPTS) return;
    const enabled = await isBiometricEnabled();
    if (!enabled) return;
    const success = await authenticateBiometric(t('wallet_biometric_prompt'));
    if (success) {
      onUnlock();
    } else {
      setBioAttempts((prev) => prev + 1);
    }
  };

  // Auto-verify when PIN is complete
  useEffect(() => {
    if (pin.length === PIN_LENGTH) {
      handleVerify();
    }
  }, [pin]);

  const handleVerify = async () => {
    if (checking || cooldown > 0) return;
    setChecking(true);
    setError('');

    // Check if this will be a slow legacy migration
    const willMigrate = await needsIterationMigration();
    if (willMigrate) setMigrating(true);

    const pinKey = await verifyPin(pin);
    if (pinKey) {
      // PIN correct — decrypt vault with the derived key
      await vaultUnlockWithPin(pinKey);
      onUnlock();
    } else {
      setPin('');
      const attempts = await getFailedAttempts();
      const cd = getCooldownSeconds(attempts);
      if (cd > 0) {
        setCooldown(cd);
        setError(t('error_generic'));
      } else {
        setError(t('error_generic'));
      }
    }
    setChecking(false);
    setMigrating(false);
  };

  const handleDigit = (digit: string) => {
    if (pin.length >= PIN_LENGTH || cooldown > 0) return;
    setPin((p) => p + digit);
    setError('');
  };

  const handleBackspace = () => {
    setPin((p) => p.slice(0, -1));
  };

  if (checking) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator color={colors.accentPrimary} size="large" />
        <Text style={[styles.checkingText, { color: colors.textSecondary }]}>
          {migrating ? 'Upgrading security... (one-time, please wait)' : 'Verifying PIN...'}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>
        {t('wallet_pin_enter')}
      </Text>

      {/* PIN dots */}
      <View style={styles.dotsRow}>
        {DOTS.map((_, i) => (
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
          {`Locked for ${cooldown}s`}
        </Text>
      ) : null}

      {/* Number pad */}
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
              <Text style={[styles.padText, { color: colors.textPrimary }]}>
                {key}
              </Text>
            </TouchableOpacity>
          ),
        )}
      </View>

      {/* Biometric retry (disabled after 3 failures per spec 5.6.2) */}
      {bioAttempts < MAX_BIOMETRIC_ATTEMPTS && (
        <TouchableOpacity onPress={tryBiometric} style={styles.biometricBtn}>
          <Text style={[styles.biometricText, { color: colors.accentPrimary }]}>
            {t('wallet_biometric_prompt')}
          </Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  title: { fontSize: fontSize.xl, fontWeight: '700', marginBottom: spacing.xl },
  dotsRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.lg },
  dot: {
    width: 16,
    height: 16,
    borderRadius: radius.full,
    borderWidth: 2,
  },
  error: { fontSize: fontSize.sm, marginBottom: spacing.md, textAlign: 'center' },
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
  checkingText: { fontSize: fontSize.md, marginTop: spacing.lg },
  biometricBtn: { marginTop: spacing.xl },
  biometricText: { fontSize: fontSize.sm },
});
