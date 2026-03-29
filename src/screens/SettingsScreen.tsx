/**
 * Settings — user preferences.
 *
 * Includes theme, language, default start screen, node URL,
 * wallet management, and notification preferences.
 * All settings stored locally per spec 06-frontend.md section 4.1.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius, type ThemeMode } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { getStartScreen, setStartScreen, setSetting, type StartScreen } from '../lib/settings';
import { isLockEnabled, hasPinSetup, isBiometricAvailable, isBiometricEnabled, setBiometricEnabled, getBiometricType } from '../lib/appLock';
import { LANGUAGES, type LanguageCode } from '../i18n/init';
import type { MoreStackParamList } from '../navigation/types';

type NavProp = NativeStackNavigationProp<MoreStackParamList, 'Settings'>;

export default function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const { colors, mode, setMode } = useTheme();
  const { address, status, peers } = useConnection();
  const navigation = useNavigation<NavProp>();
  const [startScreen, setStartScreenState] = useState<StartScreen>('news');
  const [pinEnabled, setPinEnabled] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioType, setBioType] = useState<string | null>(null);

  useEffect(() => {
    getStartScreen().then(setStartScreenState);
    hasPinSetup().then(setPinEnabled);
    isBiometricAvailable().then(setBioAvailable);
    isBiometricEnabled().then(setBioEnabled);
    getBiometricType().then(setBioType);
  }, []);

  const handleStartScreen = (screen: StartScreen) => {
    setStartScreenState(screen);
    setStartScreen(screen);
  };

  const handleTheme = (newMode: ThemeMode) => {
    setMode(newMode);
  };

  const handleLanguage = (lang: LanguageCode) => {
    i18n.changeLanguage(lang);
    setSetting('lang', lang);
  };

  const themeOptions: { key: ThemeMode; label: string }[] = [
    { key: 'light', label: t('settings_theme_light') },
    { key: 'dark', label: t('settings_theme_dark') },
    { key: 'system', label: t('settings_theme_system') },
  ];

  const startOptions: { key: StartScreen; label: string }[] = [
    { key: 'news', label: t('settings_start_news') },
    { key: 'chat', label: t('settings_start_chat') },
    { key: 'channels', label: t('settings_start_channels') },
  ];

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      contentContainerStyle={styles.content}
    >
      {/* Default Start Screen */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_start_screen')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        {startOptions.map((opt) => (
          <TouchableOpacity
            key={opt.key}
            style={styles.row}
            onPress={() => handleStartScreen(opt.key)}
          >
            <Text style={[styles.rowText, { color: colors.textPrimary }]}>
              {opt.label}
            </Text>
            {startScreen === opt.key && (
              <Text style={{ color: colors.accentPrimary, fontSize: fontSize.lg }}>
                {'\u2713'}
              </Text>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Theme */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_theme')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        {themeOptions.map((opt) => (
          <TouchableOpacity
            key={opt.key}
            style={styles.row}
            onPress={() => handleTheme(opt.key)}
          >
            <Text style={[styles.rowText, { color: colors.textPrimary }]}>
              {opt.label}
            </Text>
            {mode === opt.key && (
              <Text style={{ color: colors.accentPrimary, fontSize: fontSize.lg }}>
                {'\u2713'}
              </Text>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Language */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_language')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        {LANGUAGES.map((lang) => (
          <TouchableOpacity
            key={lang}
            style={styles.row}
            onPress={() => handleLanguage(lang)}
          >
            <Text style={[styles.rowText, { color: colors.textPrimary }]}>
              {lang.toUpperCase()}
            </Text>
            {i18n.language === lang && (
              <Text style={{ color: colors.accentPrimary, fontSize: fontSize.lg }}>
                {'\u2713'}
              </Text>
            )}
          </TouchableOpacity>
        ))}
      </View>

      {/* Security — PIN & Biometric */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        Security
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <TouchableOpacity
          style={styles.row}
          onPress={() => {
            // Both enable and disable go through PinSetup
            // (disable requires PIN verification inside the screen)
            navigation.navigate('PinSetup');
          }}
        >
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('wallet_pin_setup')}
          </Text>
          <Text style={{ color: pinEnabled ? colors.success : colors.textSecondary }}>
            {pinEnabled ? 'ON' : 'OFF'}
          </Text>
        </TouchableOpacity>
        {bioAvailable && pinEnabled && (
          <TouchableOpacity
            style={styles.row}
            onPress={() => {
              const next = !bioEnabled;
              setBiometricEnabled(next).then(() => setBioEnabled(next));
            }}
          >
            <Text style={[styles.rowText, { color: colors.textPrimary }]}>
              {bioType || 'Biometric'} unlock
            </Text>
            <Text style={{ color: bioEnabled ? colors.success : colors.textSecondary }}>
              {bioEnabled ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Wallet */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_wallet')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <TouchableOpacity style={styles.row} onPress={() => navigation.navigate('Wallet')}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {address ? address.slice(0, 16) + '...' : t('wallet_connect')}
          </Text>
          <Text style={{ color: address ? colors.success : colors.textSecondary }}>
            {address ? t('wallet_connected') : '\u203A'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Connection */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('status_connected')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <View style={styles.row}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t(`status_${status}`)}
          </Text>
          <Text style={{ color: status === 'connected' ? colors.success : colors.warning }}>
            {status === 'connected' ? t('status_peers', { count: peers }) : ''}
          </Text>
        </View>
      </View>

      {/* About */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_about')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <View style={styles.row}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('settings_version')}
          </Text>
          <Text style={{ color: colors.textSecondary }}>0.4.2</Text>
        </View>
        <TouchableOpacity
          style={styles.row}
          onPress={() => navigation.navigate('DebugLogs')}
        >
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            Debug Logs
          </Text>
          <Text style={{ color: colors.textSecondary }}>{'\u203A'}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.md, paddingBottom: spacing.xl * 2 },
  sectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
    marginLeft: spacing.sm,
  },
  card: {
    borderRadius: radius.lg,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  rowText: { fontSize: fontSize.md },
});
