/**
 * Add an account — create a fresh wallet or import an existing private key.
 *
 * Both paths add the account and switch to it. Nothing about the CURRENT
 * account is touched: this is additive, unlike the old flow where getting a
 * second wallet meant disconnecting the first.
 */
import { useCallback, useState } from 'react';
import { View, Text, TextInput, StyleSheet, ScrollView } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { showAlert } from '../components/AlertHost';
import Button from '../components/Button';
import SegmentedControl from '../components/SegmentedControl';
import KeyboardAwareView from '../components/KeyboardAwareView';

export default function AddAccountScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const nav = useNavigation<any>();
  const { addAccount, createAccount, refreshAccounts } = useConnection();
  const [mode, setMode] = useState<'create' | 'import'>('create');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);

  const done = useCallback(() => {
    void refreshAccounts();
    nav.goBack();
  }, [nav, refreshAccounts]);

  const onCreate = useCallback(async () => {
    setBusy(true);
    try {
      // ADDITIVE create — never `generateWallet`, which is the
      // single-wallet onboarding path and overwrites the existing account.
      await createAccount();
      done();
    } catch (e) {
      showAlert(t('accounts_add_failed'), e instanceof Error ? e.message.slice(0, 200) : '');
    } finally {
      setBusy(false);
    }
  }, [createAccount, done, t]);

  const onImport = useCallback(async () => {
    const hex = key.trim().replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      showAlert(t('accounts_import_invalid'));
      return;
    }
    setBusy(true);
    try {
      await addAccount(hex);
      setKey('');
      done();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      showAlert(
        t('accounts_add_failed'),
        msg === 'ACCOUNT_LIMIT' ? t('accounts_limit_reached') : msg.slice(0, 200),
      );
    } finally {
      setBusy(false);
    }
  }, [key, addAccount, done, t]);

  return (
    <KeyboardAwareView style={{ flex: 1, backgroundColor: colors.bgPrimary }}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <SegmentedControl
          segments={[
            { value: 'create', label: t('accounts_create') },
            { value: 'import', label: t('accounts_import') },
          ]}
          value={mode}
          onChange={setMode}
        />

        {mode === 'create' ? (
          <>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              {t('accounts_create_hint')}
            </Text>
            <Button label={t('accounts_create')} onPress={onCreate} loading={busy} fullWidth />
          </>
        ) : (
          <>
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              {t('accounts_import_hint')}
            </Text>
            <TextInput
              value={key}
              onChangeText={setKey}
              placeholder={t('accounts_import_placeholder')}
              placeholderTextColor={colors.textSecondary}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              style={[styles.input, {
                color: colors.textPrimary,
                borderColor: colors.border,
                backgroundColor: colors.bgSecondary,
              }]}
            />
            <Button
              label={t('accounts_import')}
              onPress={onImport}
              loading={busy}
              disabled={!key.trim()}
              fullWidth
            />
          </>
        )}
      </ScrollView>
    </KeyboardAwareView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md, gap: spacing.md },
  hint: { fontSize: fontSize.sm, lineHeight: 20 },
  input: {
    borderWidth: 1, borderRadius: radius.md, padding: spacing.md,
    fontSize: fontSize.md, fontFamily: 'monospace',
  },
});
