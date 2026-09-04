/**
 * Settings — user preferences and profile management.
 *
 * Sections: Profile, Start Screen, Theme, Language, Security, Wallet,
 * Connection, About.
 * All settings stored locally per spec 06-frontend.md section 4.1.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Image,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius, type ThemeMode } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { getStartScreen, setStartScreen, setSetting, getSetting, type StartScreen } from '../lib/settings';
import { debugLog } from '../lib/debug';
import {
  hasPinSetup,
  isBiometricAvailable,
  isBiometricEnabled,
  setBiometricEnabled,
  getBiometricModalities,
  authenticateBiometric,
  getLockTimeout,
  setLockTimeout,
} from '../lib/appLock';
import { LANGUAGES, type LanguageCode } from '../i18n/init';
import type { MoreStackParamList } from '../navigation/types';
import NodeSelector from '../components/NodeSelector';
import { uploadSettings, downloadSettings } from '../lib/settingsSync';
import { e2eAvailable } from '../lib/cryptoEnv';
import { backupNow, tryRestoreKeyVault } from '../lib/keyVault';
import { e2eSelfCheck } from '../lib/dmCrypto';
import Constants from 'expo-constants';
import { showAlert } from '../components/AlertHost';

/** Real installed version, from app.json via the native build. A hardcoded
 *  string here had drifted to 0.11.1 while the app was at 0.34.0, which made
 *  a stale install impossible to spot from inside the app. */
const APP_VERSION: string = Constants.expoConfig?.version ?? 'unknown';


const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  de: 'Deutsch',
  es: 'Español',
  pt: 'Português',
  ja: '日本語',
  zh: '中文',
  ru: 'Русский',
};

type NavProp = NativeStackNavigationProp<MoreStackParamList, 'Settings'>;

export default function SettingsScreen() {
  const { t, i18n } = useTranslation();
  const { colors, mode, setMode } = useTheme();
  const { client, signer, address, status, nodeUrl, peers } = useConnection();
  const navigation = useNavigation<NavProp>();
  const [startScreen, setStartScreenState] = useState<StartScreen>('news');
  const [pinEnabled, setPinEnabled] = useState(false);
  const [bioAvailable, setBioAvailable] = useState(false);
  const [bioEnabled, setBioEnabled] = useState(false);
  const [bioModalities, setBioModalities] = useState<string[]>([]);
  const [lockTimeout, setLockTimeoutState] = useState(300);
  const [langPickerOpen, setLangPickerOpen] = useState(false);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [lockPickerOpen, setLockPickerOpen] = useState(false);
  const [nodeSelectorOpen, setNodeSelectorOpen] = useState(false);
  const [fontSizeSetting, setFontSizeSetting] = useState<string>('medium');
  const [compactLayout, setCompactLayout] = useState(false);
  const [mediaAutoload, setMediaAutoload] = useState<string>('always');
  const [syncing, setSyncing] = useState(false);

  // Profile state
  const [displayName, setDisplayName] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  /** Avatar resolved from the node profile's `avatar_cid` — same fallback as
   *  EditProfileScreen, for the same reason: an imported account, a reinstall,
   *  or a picture uploaded from another device has no local `avatarLocalUri`. */
  const [remoteAvatarUrl, setRemoteAvatarUrl] = useState<string | null>(null);

  useEffect(() => {
    getStartScreen().then(setStartScreenState);
    getSetting('fontSize').then((v) => { if (v) setFontSizeSetting(v); });
    getSetting('compactLayout').then((v) => { if (v === 'true') setCompactLayout(true); });
    getSetting('mediaAutoload').then((v) => { if (v) setMediaAutoload(v); });
  }, []);

  // Reload on focus (not just mount) so returning from Edit Profile shows a
  // just-changed name/avatar immediately instead of only after next launch,
  // and resolve the avatar from the node when this device has no local copy —
  // same fallback as EditProfileScreen, for the same reason (imported account
  // or a picture uploaded from another device). One `cancelled` flag guards
  // every write: without it, a fast account switch could let a stale pre-switch
  // read resolve after the new account's and flash the wrong name/avatar.
  useFocusEffect(
    React.useCallback(() => {
      let cancelled = false;
      // Clear immediately — the fallbacks below only ever SET a resolved
      // value, never clear one, so without this an account with no avatar
      // would keep showing whatever account switched away FROM last had.
      setRemoteAvatarUrl(null);
      getSetting('displayName').then((n) => { if (!cancelled) setDisplayName(n || ''); });
      getSetting('avatarLocalUri').then((u) => { if (!cancelled) setAvatarUri(u || null); });
      getSetting('avatarCid').then((cid) => {
        if (!cancelled && cid && client) setRemoteAvatarUrl(client.getMediaUrl(cid));
      });
      if (client && address) {
        client.getUserProfile(address).then((resp: any) => {
          const cid = resp?.user?.avatar_cid;
          if (!cancelled && cid) setRemoteAvatarUrl(client.getMediaUrl(cid));
        }).catch(() => {});
      }
      return () => { cancelled = true; };
    }, [client, address]),
  );

  // Refresh security state every time screen gains focus (e.g., after PinSetup)
  useFocusEffect(
    React.useCallback(() => {
      hasPinSetup().then(setPinEnabled);
      isBiometricAvailable().then(setBioAvailable);
      isBiometricEnabled().then(setBioEnabled);
      getBiometricModalities().then(setBioModalities);
      getLockTimeout().then(setLockTimeoutState);
    }, []),
  );

  /** Auto-lock delay options, in seconds. `0` locks on every return to foreground. */
  const lockTimeoutOptions: { seconds: number; label: string }[] = [
    { seconds: 0, label: t('security_autolock_immediately') },
    { seconds: 60, label: t('security_autolock_minutes', { count: 1 }) },
    { seconds: 300, label: t('security_autolock_minutes', { count: 5 }) },
    { seconds: 900, label: t('security_autolock_minutes', { count: 15 }) },
    { seconds: 3600, label: t('security_autolock_hour') },
  ];
  const lockTimeoutLabel =
    lockTimeoutOptions.find((o) => o.seconds === lockTimeout)?.label ??
    t('security_autolock_minutes', { count: Math.round(lockTimeout / 60) });

  const handleLockTimeout = async (seconds: number) => {
    const prev = lockTimeout;
    setLockTimeoutState(seconds);
    setLockPickerOpen(false);
    try {
      await setLockTimeout(seconds);
    } catch {
      // The store rejected the write — don't leave the UI showing a value that
      // was never persisted.
      setLockTimeoutState(prev);
      showAlert(t('error_generic'), '');
    }
  };

  const handleBiometricToggle = async () => {
    try {
      if (bioEnabled) {
        await setBiometricEnabled(false);
        setBioEnabled(false);
        return;
      }
      // Prove the sensor actually works before we promise the user it will —
      // enabling without a live check is exactly why this looked broken before.
      const ok = await authenticateBiometric(
        t('wallet_biometric_prompt'),
        t('biometric_use_pin'),
      );
      if (!ok) return;
      await setBiometricEnabled(true);
      setBioEnabled(true);
    } catch {
      showAlert(t('error_generic'), '');
    }
  };

  const handlePinRow = () => {
    if (!pinEnabled) {
      navigation.navigate('PinSetup');
      return;
    }
    // A set PIN can be changed or turned off — the old row navigated straight
    // to setup (which doubled as "change"), so keep both paths reachable.
    showAlert(t('settings_security'), t('security_pin_manage'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('security_pin_change'), onPress: () => navigation.navigate('PinSetup') },
      {
        text: t('security_pin_disable_action'),
        style: 'destructive',
        onPress: () => navigation.navigate('PinSetup', { mode: 'disable' }),
      },
    ]);
  };

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
    setLangPickerOpen(false);
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
      {/* User Profile */}
      {address && (
        <>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            {t('nav_profile')}
          </Text>
          <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
            {/* Avatar */}
            <View style={styles.profileRow}>
              <TouchableOpacity
                style={[styles.avatar, { backgroundColor: colors.accentPrimary }]}
                onPress={() => navigation.navigate('EditProfile')}
                activeOpacity={0.6}
              >
                {avatarUri || remoteAvatarUrl ? (
                  <Image
                    source={{ uri: (avatarUri || remoteAvatarUrl) as string }}
                    style={styles.avatarImage}
                    // A local picker-cache URI can be evicted by the OS, and a
                    // node media URL can 404 — drop whichever one just failed
                    // so this falls through instead of showing a blank circle.
                    onError={() => (avatarUri ? setAvatarUri(null) : setRemoteAvatarUrl(null))}
                  />
                ) : (
                  <Text style={[styles.avatarText, { color: colors.textInverse }]}>
                    {(displayName || address)[0]?.toUpperCase() || 'O'}
                  </Text>
                )}
              </TouchableOpacity>
              <View style={styles.profileInfo}>
                <Text style={[styles.profileName, { color: colors.textPrimary }]}>
                  {displayName || address.slice(0, 16) + '...'}
                </Text>
                <Text style={[styles.profileAddr, { color: colors.textSecondary }]} numberOfLines={1}>
                  {address}
                </Text>
              </View>
            </View>
            {/* Edit + Balance row */}
            <View style={styles.profileActions}>
              <TouchableOpacity
                style={styles.profileActionBtn}
                onPress={() => navigation.navigate('EditProfile')}
              >
                <Text style={[styles.rowText, { color: colors.accentPrimary }]}>
                  {t('chat_edit')}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.profileActionBtn}
                onPress={() => navigation.navigate('WalletBalance')}
              >
                <Text style={[styles.rowText, { color: colors.accentPrimary }]}>
                  Balance
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </>
      )}

      {/* Preferences — compact dropdowns */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        Preferences
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        {/* Start Screen */}
        <TouchableOpacity style={styles.row} onPress={() => setStartPickerOpen(true)}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('settings_start_screen')}
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            {startOptions.find((o) => o.key === startScreen)?.label} {'\u25BE'}
          </Text>
        </TouchableOpacity>
        {/* Theme */}
        <TouchableOpacity style={styles.row} onPress={() => setThemePickerOpen(true)}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('settings_theme')}
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            {themeOptions.find((o) => o.key === mode)?.label} {'\u25BE'}
          </Text>
        </TouchableOpacity>
        {/* Language */}
        <TouchableOpacity style={styles.row} onPress={() => setLangPickerOpen(true)}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('settings_language')}
          </Text>
          <Text style={{ color: colors.textSecondary }}>
            {LANGUAGE_NAMES[i18n.language] || i18n.language} {'\u25BE'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Start Screen picker modal */}
      <Modal visible={startPickerOpen} transparent animationType="fade" onRequestClose={() => setStartPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setStartPickerOpen(false)}>
          <View style={[styles.modalContent, { backgroundColor: colors.bgSecondary }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {t('settings_start_screen')}
            </Text>
            {startOptions.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.modalRow, { borderBottomColor: colors.border }]}
                onPress={() => { handleStartScreen(opt.key); setStartPickerOpen(false); }}
              >
                <Text style={[styles.rowText, { color: colors.textPrimary }]}>{opt.label}</Text>
                {startScreen === opt.key && (
                  <Text style={{ color: colors.accentPrimary, fontSize: fontSize.lg }}>{'\u2713'}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Theme picker modal */}
      <Modal visible={themePickerOpen} transparent animationType="fade" onRequestClose={() => setThemePickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setThemePickerOpen(false)}>
          <View style={[styles.modalContent, { backgroundColor: colors.bgSecondary }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {t('settings_theme')}
            </Text>
            {themeOptions.map((opt) => (
              <TouchableOpacity
                key={opt.key}
                style={[styles.modalRow, { borderBottomColor: colors.border }]}
                onPress={() => { handleTheme(opt.key); setThemePickerOpen(false); }}
              >
                <Text style={[styles.rowText, { color: colors.textPrimary }]}>{opt.label}</Text>
                {mode === opt.key && (
                  <Text style={{ color: colors.accentPrimary, fontSize: fontSize.lg }}>{'\u2713'}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Language picker modal */}
      <Modal visible={langPickerOpen} transparent animationType="fade" onRequestClose={() => setLangPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setLangPickerOpen(false)}>
          <View style={[styles.modalContent, { backgroundColor: colors.bgSecondary }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {t('settings_language')}
            </Text>
            {LANGUAGES.map((lang) => (
              <TouchableOpacity
                key={lang}
                style={[styles.modalRow, { borderBottomColor: colors.border }]}
                onPress={() => handleLanguage(lang)}
              >
                <Text style={[styles.rowText, { color: colors.textPrimary }]}>{LANGUAGE_NAMES[lang]}</Text>
                {i18n.language === lang && (
                  <Text style={{ color: colors.accentPrimary, fontSize: fontSize.lg }}>{'\u2713'}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Appearance */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_appearance')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        {/* Font Size */}
        <View style={styles.row}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('settings_font_size')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.xs }}>
            {(['small', 'medium', 'large'] as const).map((size) => (
              <TouchableOpacity
                key={size}
                style={[
                  styles.sizeBtn,
                  { backgroundColor: fontSizeSetting === size ? colors.accentPrimary : colors.bgTertiary },
                ]}
                onPress={() => {
                  setFontSizeSetting(size);
                  setSetting('fontSize', size);
                }}
              >
                <Text style={{
                  color: fontSizeSetting === size ? colors.textInverse : colors.textPrimary,
                  fontSize: size === 'small' ? 11 : size === 'large' ? 15 : 13,
                  fontWeight: '600',
                }}>
                  A
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Compact Layout */}
        <TouchableOpacity
          style={styles.row}
          onPress={() => {
            const next = !compactLayout;
            setCompactLayout(next);
            setSetting('compactLayout', next ? 'true' : 'false');
          }}
        >
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('settings_compact')}
          </Text>
          <Text style={{ color: compactLayout ? colors.success : colors.textSecondary }}>
            {compactLayout ? 'ON' : 'OFF'}
          </Text>
        </TouchableOpacity>

        {/* Media Auto-load */}
        <View style={styles.row}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('settings_media_autoload')}
          </Text>
          <View style={{ flexDirection: 'row', gap: spacing.xs }}>
            {(['always', 'wifi', 'never'] as const).map((opt) => (
              <TouchableOpacity
                key={opt}
                style={[
                  styles.sizeBtn,
                  { backgroundColor: mediaAutoload === opt ? colors.accentPrimary : colors.bgTertiary },
                ]}
                onPress={() => {
                  setMediaAutoload(opt);
                  setSetting('mediaAutoload', opt);
                }}
              >
                <Text style={{
                  color: mediaAutoload === opt ? colors.textInverse : colors.textPrimary,
                  fontSize: fontSize.xs,
                  fontWeight: '600',
                }}>
                  {t(`settings_media_${opt}`)}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      </View>

      {/* Settings Sync */}
      {signer && (
        <>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            {t('settings_sync')}
          </Text>
          <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                setSyncing(true);
                try {
                  await uploadSettings();
                  showAlert(t('settings_sync'), t('sync_upload_success'));
                } catch (e) {
                  showAlert(t('error_generic'), e instanceof Error ? e.message : '');
                } finally { setSyncing(false); }
              }}
              disabled={syncing}
            >
              <Text style={[styles.rowText, { color: colors.textPrimary }]}>
                {t('sync_upload')}
              </Text>
              <Text style={{ color: colors.accentPrimary }}>↑</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                setSyncing(true);
                try {
                  const applied = await downloadSettings();
                  if (applied) {
                    // Reload settings into local state
                    getSetting('fontSize').then((v) => { if (v) setFontSizeSetting(v); });
                    getSetting('compactLayout').then((v) => { if (v === 'true') setCompactLayout(true); });
                    getSetting('mediaAutoload').then((v) => { if (v) setMediaAutoload(v); });
                    showAlert(t('settings_sync'), t('sync_download_success'));
                  } else {
                    showAlert(t('settings_sync'), t('sync_no_data'));
                  }
                } catch (e) {
                  showAlert(t('error_generic'), e instanceof Error ? e.message : '');
                } finally { setSyncing(false); }
              }}
              disabled={syncing}
            >
              <Text style={[styles.rowText, { color: colors.textPrimary }]}>
                {t('sync_download')}
              </Text>
              <Text style={{ color: colors.accentPrimary }}>↓</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Encryption & Key Backup (E2E P3) — built-in wallets only */}
      {signer && e2eAvailable() && (
        <>
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
            {t('e2e_section')}
          </Text>
          <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                try {
                  await backupNow();
                  showAlert(t('e2e_section'), t('e2e_backup_done'));
                } catch (e) {
                  showAlert(t('error_generic'), e instanceof Error ? e.message : '');
                }
              }}
            >
              <Text style={[styles.rowText, { color: colors.textPrimary }]}>{t('e2e_backup_now')}</Text>
              <Text style={{ color: colors.accentPrimary }}>↑</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.row}
              onPress={() => {
                tryRestoreKeyVault();
                showAlert(t('e2e_section'), t('e2e_restore_done'));
              }}
            >
              <Text style={[styles.rowText, { color: colors.textPrimary }]}>{t('e2e_restore')}</Text>
              <Text style={{ color: colors.accentPrimary }}>↓</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.row}
              onPress={async () => {
                try {
                  const report = await e2eSelfCheck();
                  showAlert(t('e2e_self_check'), String(report.bindingVerdict ?? report.error ?? ''));
                } catch (e) {
                  showAlert(t('error_generic'), e instanceof Error ? e.message : '');
                }
              }}
            >
              <Text style={[styles.rowText, { color: colors.textPrimary }]}>{t('e2e_self_check')}</Text>
              <Text style={{ color: colors.textSecondary }}>🔒</Text>
            </TouchableOpacity>
          </View>
        </>
      )}

      {/* Security — PIN & Biometric */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_security')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <TouchableOpacity style={styles.row} onPress={handlePinRow}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('wallet_pin_setup')}
          </Text>
          <Text style={{ color: pinEnabled ? colors.success : colors.textSecondary }}>
            {pinEnabled ? 'ON' : 'OFF'}
          </Text>
        </TouchableOpacity>
        {bioAvailable && pinEnabled && (
          <TouchableOpacity style={styles.row} onPress={handleBiometricToggle}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.rowText, { color: colors.textPrimary }]}>
                {t('security_biometric_unlock')}
              </Text>
              {bioModalities.length > 0 && (
                <Text style={[styles.rowHint, { color: colors.textSecondary }]}>
                  {t('security_biometric_available', {
                    methods: bioModalities.map((m) => t(`biometric_type_${m}`)).join(', '),
                  })}
                </Text>
              )}
            </View>
            <Text style={{ color: bioEnabled ? colors.success : colors.textSecondary }}>
              {bioEnabled ? 'ON' : 'OFF'}
            </Text>
          </TouchableOpacity>
        )}
        {pinEnabled && (
          <TouchableOpacity style={styles.row} onPress={() => setLockPickerOpen(true)}>
            <Text style={[styles.rowText, { color: colors.textPrimary }]}>
              {t('security_autolock')}
            </Text>
            <Text style={{ color: colors.textSecondary }}>
              {lockTimeoutLabel} {'\u25BE'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Auto-lock delay picker modal */}
      <Modal visible={lockPickerOpen} transparent animationType="fade" onRequestClose={() => setLockPickerOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setLockPickerOpen(false)}>
          <View style={[styles.modalContent, { backgroundColor: colors.bgSecondary }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>
              {t('security_autolock')}
            </Text>
            {lockTimeoutOptions.map((opt) => (
              <TouchableOpacity
                key={opt.seconds}
                style={[styles.modalRow, { borderBottomColor: colors.border }]}
                onPress={() => handleLockTimeout(opt.seconds)}
              >
                <Text style={[styles.rowText, { color: colors.textPrimary }]}>{opt.label}</Text>
                {lockTimeout === opt.seconds && (
                  <Text style={{ color: colors.accentPrimary, fontSize: fontSize.lg }}>{'\u2713'}</Text>
                )}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* Wallet */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_wallet')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <TouchableOpacity style={styles.row} onPress={() => navigation.navigate(address ? 'WalletBalance' : 'Wallet')}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {address ? address.slice(0, 16) + '...' : t('wallet_connect')}
          </Text>
          <Text style={{ color: address ? colors.success : colors.textSecondary }}>
            {address ? t('wallet_connected') : '\u203A'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Connection — tap to open node selector */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_node_url')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <TouchableOpacity style={styles.row} onPress={() => setNodeSelectorOpen(true)}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.rowText, { color: colors.textPrimary }]}>
              {status === 'connected'
                ? `Connected to ${nodeUrl.replace(/^https?:\/\//, '')}`
                : t(`status_${status}`)}
            </Text>
          </View>
          <Text style={{ color: status === 'connected' ? colors.success : colors.warning }}>
            {status === 'connected' ? t('status_peers', { count: peers }) : ''} {'\u25BE'}
          </Text>
        </TouchableOpacity>
      </View>

      <NodeSelector visible={nodeSelectorOpen} onClose={() => setNodeSelectorOpen(false)} />

      {/* About */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_about')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <View style={styles.row}>
          <Text style={[styles.rowText, { color: colors.textPrimary }]}>
            {t('settings_version')}
          </Text>
          <Text style={{ color: colors.textSecondary }}>{APP_VERSION}</Text>
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
  rowHint: { fontSize: fontSize.xs, marginTop: 2 },
  sizeBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
    minWidth: 32,
    alignItems: 'center',
  },
  // Profile
  profileRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { fontSize: fontSize.xl, fontWeight: '700' },
  avatarImage: { width: 56, height: 56, borderRadius: radius.full },
  profileInfo: { flex: 1, marginLeft: spacing.md },
  profileName: { fontSize: fontSize.lg, fontWeight: '600' },
  profileAddr: { fontSize: fontSize.xs, marginTop: spacing.xs },
  profileActions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  profileActionBtn: {},
  // Language modal
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '80%',
    borderRadius: radius.lg,
    paddingVertical: spacing.md,
  },
  modalTitle: {
    fontSize: fontSize.lg,
    fontWeight: '700',
    textAlign: 'center',
    marginBottom: spacing.md,
  },
  modalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
});
