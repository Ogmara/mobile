/**
 * PIN Setup — create or change the app lock PIN.
 *
 * Two-step flow: enter new PIN → confirm PIN.
 * Per spec 05-clients.md section 5.6.1.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { setupPin } from '../lib/appLock';

const PIN_LENGTH = 6;

export default function PinSetupScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const navigation = useNavigation();
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [firstPin, setFirstPin] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');

  const handleDigit = (digit: string) => {
    if (pin.length >= PIN_LENGTH) return;
    const newPin = pin + digit;
    setPin(newPin);
    setError('');

    if (newPin.length === PIN_LENGTH) {
      if (step === 'enter') {
        setFirstPin(newPin);
        setPin('');
        setStep('confirm');
      } else {
        // Confirm step — check match
        if (newPin === firstPin) {
          setupPin(newPin)
            .then(() => {
              Alert.alert(t('done'), '', [{ text: 'OK', onPress: () => navigation.goBack() }]);
            })
            .catch(() => setError(t('error_generic')));
        } else {
          setPin('');
          setStep('enter');
          setFirstPin('');
          setError('PINs did not match. Try again.');
        }
      }
    }
  };

  const handleBackspace = () => {
    setPin((p) => p.slice(0, -1));
  };

  const title = step === 'enter' ? t('wallet_pin_setup') : 'Confirm PIN';

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

      {error ? <Text style={[styles.error, { color: colors.error }]}>{error}</Text> : null}

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
              disabled={!key}
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
