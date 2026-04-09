/**
 * Wallet — create, import, or manage the built-in wallet.
 *
 * Generates Ed25519 key pairs, stores private key in SecureStore,
 * and provides the WalletSigner to the connection context.
 * Per spec 05-clients.md section 4.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Alert,
  Platform,
  Linking,
  ActivityIndicator,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { MoreStackParamList } from '../navigation/types';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { vaultExportKey } from '../lib/vault';
import { registerUser, getExplorerTxUrl } from '../lib/kleverTx';
import { debugLog } from '../lib/debug';
import * as Clipboard from 'expo-clipboard';

const HEX_REGEX = /^[0-9a-fA-F]{64}$/;

export default function WalletScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList, 'Wallet'>>();
  const { address, signer, setWallet, generateWallet } = useConnection();
  const [importKey, setImportKey] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [registering, setRegistering] = useState(false);
  const hideTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear revealed key and clipboard on unmount (W2 audit fix)
  React.useEffect(() => {
    return () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      if (revealedKey) {
        Clipboard.setStringAsync('').catch(() => {});
      }
    };
  }, [revealedKey]);

  const handleCreate = async () => {
    try {
      await generateWallet();
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  };

  const handleImport = async () => {
    const key = importKey.trim();
    if (!HEX_REGEX.test(key)) {
      Alert.alert(t('error_generic'), 'Private key must be exactly 64 hex characters (0-9, a-f)');
      return;
    }
    try {
      await setWallet(key);
      setImportKey('');
      setShowImport(false);
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  };

  const handleRevealKey = () => {
    Alert.alert(
      'Reveal Private Key',
      'Your private key gives FULL ACCESS to your wallet and all funds.\n\n' +
      'NEVER share it with anyone.\n' +
      'NEVER enter it on a website.\n' +
      'NEVER send it in a message.\n\n' +
      'Anyone who has this key can steal your wallet.',
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: 'I understand, reveal key',
          style: 'destructive',
          onPress: async () => {
            const key = await vaultExportKey();
            if (key) {
              setRevealedKey(key);
              setCopied(false);
            } else {
              Alert.alert(t('error_generic'), 'Could not export key. PIN unlock may be required.');
            }
          },
        },
      ],
    );
  };

  const hideKey = () => {
    setRevealedKey(null);
    setCopied(false);
    Clipboard.setStringAsync('').catch(() => {}); // wipe clipboard (W1)
    if (hideTimerRef.current) { clearTimeout(hideTimerRef.current); hideTimerRef.current = null; }
  };

  const handleCopyKey = async () => {
    if (!revealedKey) return;
    await Clipboard.setStringAsync(revealedKey);
    setCopied(true);
    // Auto-hide key after 60 seconds and wipe clipboard
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(hideKey, 60000);
  };

  const handleDisconnect = () => {
    Alert.alert(
      t('wallet_disconnect'),
      t('confirm_delete'),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('wallet_disconnect'),
          style: 'destructive',
          onPress: () => setWallet(null),
        },
      ],
    );
  };

  const handleRegister = async () => {
    if (!signer) return;
    Alert.alert(
      t('register_title'),
      t('register_confirm'),
      [
        { text: t('cancel'), style: 'cancel' },
        {
          text: t('register_proceed'),
          onPress: async () => {
            setRegistering(true);
            try {
              const txHash = await registerUser(signer.publicKeyHex);
              const url = await getExplorerTxUrl(txHash);
              Alert.alert(
                t('register_success'),
                t('register_tx_sent'),
                [
                  { text: t('tip_view_tx'), onPress: () => Linking.openURL(url) },
                  { text: t('done'), style: 'cancel' },
                ],
              );
            } catch (e) {
              const msg = e instanceof Error ? e.message : '';
              debugLog('warn', `Registration failed: ${msg}`);
              Alert.alert(t('register_failed'), msg.slice(0, 200));
            } finally {
              setRegistering(false);
            }
          },
        },
      ],
    );
  };

  // Connected wallet view
  if (signer && address) {
    return (
      <ScrollView
        style={[styles.container, { backgroundColor: colors.bgPrimary }]}
        contentContainerStyle={styles.content}
      >
        <View style={[styles.avatarCircle, { backgroundColor: colors.accentPrimary }]}>
          <Text style={[styles.avatarText, { color: colors.textInverse }]}>
            {address[4]?.toUpperCase() || 'O'}
          </Text>
        </View>

        <Text style={[styles.label, { color: colors.textSecondary }]}>
          {t('wallet_connected')}
        </Text>

        <View style={[styles.addressBox, { backgroundColor: colors.bgSecondary }]}>
          <Text style={[styles.addressText, { color: colors.textPrimary }]} selectable>
            {address}
          </Text>
        </View>

        {/* Balance */}
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.accentPrimary }]}
          onPress={() => navigation.navigate('WalletBalance')}
        >
          <Text style={[styles.btnText, { color: colors.textInverse }]}>
            {t('wallet_view_balance')}
          </Text>
        </TouchableOpacity>

        {/* On-Chain Registration */}
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: registering ? colors.textSecondary : colors.accentSecondary }]}
          onPress={handleRegister}
          disabled={registering}
        >
          {registering ? (
            <ActivityIndicator size="small" color={colors.textInverse} />
          ) : (
            <Text style={[styles.btnText, { color: colors.textInverse }]}>
              {t('register_button')}
            </Text>
          )}
        </TouchableOpacity>

        {/* Reveal Private Key */}
        {!revealedKey ? (
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.warning }]}
            onPress={handleRevealKey}
          >
            <Text style={[styles.btnText, { color: colors.textInverse }]}>
              Reveal Private Key
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.revealSection}>
            <View style={[styles.warningBanner, { backgroundColor: colors.error }]}>
              <Text style={[styles.warningText, { color: colors.textInverse }]}>
                NEVER share this key with anyone!
              </Text>
            </View>
            <View style={[styles.keyBox, { backgroundColor: colors.bgTertiary, borderColor: colors.error }]}>
              <Text style={[styles.keyText, { color: colors.textPrimary }]} selectable>
                {revealedKey}
              </Text>
            </View>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: copied ? colors.success : colors.accentPrimary }]}
              onPress={handleCopyKey}
            >
              <Text style={[styles.btnText, { color: colors.textInverse }]}>
                {copied ? 'Copied!' : 'Copy to Clipboard'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, { backgroundColor: colors.bgSecondary, borderWidth: 1, borderColor: colors.border }]}
              onPress={hideKey}
            >
              <Text style={[styles.btnText, { color: colors.textPrimary }]}>
                Hide Key
              </Text>
            </TouchableOpacity>
          </View>
        )}

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.error, marginTop: spacing.xl }]}
          onPress={handleDisconnect}
        >
          <Text style={[styles.btnText, { color: colors.textInverse }]}>
            {t('wallet_disconnect')}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  // No wallet — create or import
  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      contentContainerStyle={styles.content}
    >
      <Text style={[styles.title, { color: colors.textPrimary }]}>
        {t('settings_wallet')}
      </Text>

      <TouchableOpacity
        style={[styles.btn, { backgroundColor: colors.accentPrimary }]}
        onPress={handleCreate}
      >
        <Text style={[styles.btnText, { color: colors.textInverse }]}>
          {t('wallet_create')}
        </Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={[styles.btn, { backgroundColor: colors.bgSecondary, borderWidth: 1, borderColor: colors.border }]}
        onPress={() => setShowImport(!showImport)}
      >
        <Text style={[styles.btnText, { color: colors.textPrimary }]}>
          {t('wallet_import')}
        </Text>
      </TouchableOpacity>

      {showImport && (
        <View style={styles.importSection}>
          <TextInput
            style={[styles.importInput, {
              color: colors.textPrimary,
              backgroundColor: colors.bgTertiary,
              borderColor: colors.border,
            }]}
            placeholder="64-character hex private key"
            placeholderTextColor={colors.textSecondary}
            value={importKey}
            onChangeText={setImportKey}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            maxLength={64}
          />
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.success }]}
            onPress={handleImport}
          >
            <Text style={[styles.btnText, { color: colors.textInverse }]}>
              {t('wallet_import')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg, alignItems: 'center' },
  title: { fontSize: fontSize.xl, fontWeight: '700', marginBottom: spacing.xl },
  avatarCircle: {
    width: 72,
    height: 72,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  avatarText: { fontSize: fontSize.xxl, fontWeight: '700' },
  label: { fontSize: fontSize.sm, marginBottom: spacing.md },
  addressBox: {
    width: '100%',
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.lg,
  },
  addressText: { fontSize: fontSize.xs, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' },
  btn: {
    width: '100%',
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    marginBottom: spacing.md,
  },
  btnText: { fontSize: fontSize.md, fontWeight: '600' },
  importSection: { width: '100%', marginTop: spacing.md },
  importInput: {
    width: '100%',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  revealSection: { width: '100%', marginTop: spacing.md },
  warningBanner: {
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.md,
    alignItems: 'center',
  },
  warningText: { fontSize: fontSize.sm, fontWeight: '700', textAlign: 'center' },
  keyBox: {
    width: '100%',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 2,
    marginBottom: spacing.md,
  },
  keyText: {
    fontSize: fontSize.xs,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 20,
  },
});
