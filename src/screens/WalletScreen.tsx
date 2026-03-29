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
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';

const HEX_REGEX = /^[0-9a-fA-F]{64}$/;

export default function WalletScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { address, signer, setWallet, generateWallet } = useConnection();
  const [importKey, setImportKey] = useState('');
  const [showImport, setShowImport] = useState(false);

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

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.error }]}
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
});
