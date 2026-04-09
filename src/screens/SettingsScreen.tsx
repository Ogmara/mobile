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
  TextInput,
  Modal,
  Alert,
  Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useTranslation } from 'react-i18next';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius, type ThemeMode } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { getStartScreen, setStartScreen, setSetting, getSetting, type StartScreen } from '../lib/settings';
import { debugLog } from '../lib/debug';
import { setCachedUser } from '../lib/userCache';
import { isLockEnabled, hasPinSetup, isBiometricAvailable, isBiometricEnabled, setBiometricEnabled, getBiometricType } from '../lib/appLock';
import { LANGUAGES, type LanguageCode } from '../i18n/init';
import type { MoreStackParamList } from '../navigation/types';
import NodeSelector from '../components/NodeSelector';
import { uploadSettings, downloadSettings } from '../lib/settingsSync';

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
  const [bioType, setBioType] = useState<string | null>(null);
  const [langPickerOpen, setLangPickerOpen] = useState(false);
  const [startPickerOpen, setStartPickerOpen] = useState(false);
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [nodeSelectorOpen, setNodeSelectorOpen] = useState(false);
  const [fontSizeSetting, setFontSizeSetting] = useState<string>('medium');
  const [compactLayout, setCompactLayout] = useState(false);
  const [mediaAutoload, setMediaAutoload] = useState<string>('always');
  const [syncing, setSyncing] = useState(false);

  // Profile state
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);

  useEffect(() => {
    getStartScreen().then(setStartScreenState);
    getSetting('displayName').then((n) => { if (n) setDisplayName(n); });
    getSetting('bio').then((b) => { if (b) setBio(b); });
    getSetting('avatarLocalUri').then((u) => { if (u) setAvatarUri(u); });
    getSetting('fontSize').then((v) => { if (v) setFontSizeSetting(v); });
    getSetting('compactLayout').then((v) => { if (v === 'true') setCompactLayout(true); });
    getSetting('mediaAutoload').then((v) => { if (v) setMediaAutoload(v); });
  }, []);

  // Refresh security state every time screen gains focus (e.g., after PinSetup)
  useFocusEffect(
    React.useCallback(() => {
      hasPinSetup().then(setPinEnabled);
      isBiometricAvailable().then(setBioAvailable);
      isBiometricEnabled().then(setBioEnabled);
      getBiometricType().then(setBioType);
    }, []),
  );

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

  const handleSaveProfile = async () => {
    if (!client || !signer) {
      Alert.alert(t('error_generic'), t('wallet_connect'));
      return;
    }
    try {
      await client.updateProfile({
        display_name: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
      });
      // Save display name and bio locally
      if (displayName.trim()) {
        await setSetting('displayName', displayName.trim());
      }
      if (bio.trim()) {
        await setSetting('bio', bio.trim());
      }
      // Cache own profile for user display hook
      if (address) {
        await setCachedUser(address, {
          displayName: displayName.trim() || null,
          bio: bio.trim() || null,
        });
      }
      setEditingProfile(false);
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    }
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
                onPress={editingProfile ? async () => {
                  const result = await ImagePicker.launchImageLibraryAsync({
                    mediaTypes: ['images'],
                    allowsEditing: true,
                    aspect: [1, 1],
                    quality: 0.7,
                  });
                  if (!result.canceled && result.assets[0]) {
                    setAvatarUri(result.assets[0].uri);
                    await setSetting('avatarLocalUri', result.assets[0].uri);
                  }
                } : undefined}
                disabled={!editingProfile}
                activeOpacity={editingProfile ? 0.6 : 1}
              >
                {avatarUri ? (
                  <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
                ) : (
                  <Text style={[styles.avatarText, { color: colors.textInverse }]}>
                    {(displayName || address)[0]?.toUpperCase() || 'O'}
                  </Text>
                )}
                {editingProfile && (
                  <View style={styles.avatarEditBadge}>
                    <Text style={{ color: '#fff', fontSize: 10 }}>Edit</Text>
                  </View>
                )}
              </TouchableOpacity>
              <View style={styles.profileInfo}>
                {editingProfile ? (
                  <TextInput
                    style={[styles.profileInput, { color: colors.textPrimary, borderBottomColor: colors.accentPrimary }]}
                    placeholder="Username"
                    placeholderTextColor={colors.textSecondary}
                    value={displayName}
                    onChangeText={setDisplayName}
                    maxLength={50}
                    autoFocus
                  />
                ) : (
                  <Text style={[styles.profileName, { color: colors.textPrimary }]}>
                    {displayName || address.slice(0, 16) + '...'}
                  </Text>
                )}
                <Text style={[styles.profileAddr, { color: colors.textSecondary }]} numberOfLines={1}>
                  {address}
                </Text>
              </View>
            </View>
            {/* Bio */}
            {editingProfile && (
              <TextInput
                style={[styles.bioInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
                placeholder={t('profile_bio')}
                placeholderTextColor={colors.textSecondary}
                value={bio}
                onChangeText={setBio}
                maxLength={200}
                multiline
                numberOfLines={3}
              />
            )}
            {/* Edit + Balance row */}
            <View style={styles.profileActions}>
              <TouchableOpacity
                style={styles.profileActionBtn}
                onPress={() => {
                  if (editingProfile) {
                    handleSaveProfile();
                  } else {
                    setEditingProfile(true);
                  }
                }}
              >
                <Text style={[styles.rowText, { color: colors.accentPrimary }]}>
                  {editingProfile ? t('save') : t('chat_edit')}
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
                  Alert.alert(t('settings_sync'), t('sync_upload_success'));
                } catch (e) {
                  Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
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
                    Alert.alert(t('settings_sync'), t('sync_download_success'));
                  } else {
                    Alert.alert(t('settings_sync'), t('sync_no_data'));
                  }
                } catch (e) {
                  Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
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

      {/* Security — PIN & Biometric */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('settings_security')}
      </Text>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <TouchableOpacity
          style={styles.row}
          onPress={() => navigation.navigate('PinSetup')}
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
          <Text style={{ color: colors.textSecondary }}>0.11.1</Text>
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
  avatarEditBadge: { position: 'absolute', bottom: 0, right: 0, backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 8, paddingHorizontal: 4, paddingVertical: 1 },
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
  profileInput: {
    fontSize: fontSize.lg,
    fontWeight: '600',
    borderBottomWidth: 2,
    paddingVertical: spacing.xs,
  },
  bioInput: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    fontSize: fontSize.sm,
    minHeight: 60,
    textAlignVertical: 'top',
  },
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
