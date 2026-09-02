/**
 * Accounts — hold several wallets on this device and switch between them.
 *
 * Switching is NOT a sign-out: each account's preferences, channels, topic
 * follows and contacts stay on the device under its own namespace and come
 * back when it is selected again. Removing an account is the destructive
 * action, and is gated behind an explicit key-export confirmation because
 * losing a private key is unrecoverable.
 */
import { useCallback, useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { showAlert } from '../components/AlertHost';
import Button from '../components/Button';
import { scopedGetFor } from '../lib/walletScope';
import { vaultExportKeyFor } from '../lib/vault';

export default function AccountsScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const nav = useNavigation<any>();
  const { accounts, walletAddress, refreshAccounts, switchAccount, removeAccount } = useConnection();
  const [busy, setBusy] = useState<string | null>(null);
  /** Per-account display names, read across namespaces without switching. */
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => { void refreshAccounts(); }, [refreshAccounts]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Record<string, string> = {};
      for (const a of accounts) {
        const n = await scopedGetFor(a.a, 'ogmara.display_name');
        if (n) out[a.a] = n;
      }
      if (!cancelled) setNames(out);
    })();
    return () => { cancelled = true; };
  }, [accounts]);

  const onSwitch = useCallback(async (addr: string) => {
    if (addr === walletAddress || busy) return;
    setBusy(addr);
    try {
      await switchAccount(addr);
    } catch (e) {
      showAlert(t('accounts_switch_failed'), e instanceof Error ? e.message.slice(0, 200) : '');
    } finally {
      setBusy(null);
    }
  }, [walletAddress, busy, switchAccount, t]);

  /** Perform the removal, reporting failure rather than swallowing it. */
  const confirmRemoval = useCallback(async (addr: string) => {
    setBusy(addr);
    try {
      await removeAccount(addr);
    } catch (e) {
      showAlert(t('accounts_remove'), e instanceof Error ? e.message.slice(0, 200) : '');
    } finally {
      setBusy(null);
    }
  }, [removeAccount, t]);

  const onRemove = useCallback((addr: string) => {
    // Two steps, deliberately. The key is unrecoverable once removed, so the
    // export is offered first rather than buried in a warning.
    showAlert(t('accounts_remove'), t('accounts_remove_export_first'), [
      { text: t('cancel'), style: 'cancel' },
      {
        // For someone who already has a backup, forcing a private key onto the
        // system clipboard would be a worse exposure than the one it prevents.
        text: t('accounts_remove_have_backup'),
        style: 'destructive',
        onPress: () => confirmRemoval(addr),
      },
      {
        text: t('accounts_export_key'),
        onPress: async () => {
          const key = await vaultExportKeyFor(addr);
          if (!key) { showAlert(t('accounts_export_unavailable')); return; }
          await Clipboard.setStringAsync(key);
          // Clear it again on a timer, mirroring WalletScreen's reveal/copy
          // handling — a raw private key must not linger in the clipboard (or
          // in the keyboard's clipboard history) indefinitely.
          setTimeout(() => { void Clipboard.setStringAsync(''); }, 60_000);
          showAlert(t('accounts_export_copied'), t('accounts_remove_confirm'), [
            { text: t('cancel'), style: 'cancel' },
            { text: t('accounts_remove'), style: 'destructive', onPress: () => confirmRemoval(addr) },
          ]);
        },
      },
    ]);
  }, [confirmRemoval, t]);

  return (
    <ScrollView style={{ backgroundColor: colors.bgPrimary }} contentContainerStyle={styles.content}>
      <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('accounts_hint')}</Text>

      {accounts.map((acc) => {
        const active = acc.a === walletAddress;
        // A K5 delegation's indexed address is the local device key, not the
        // wallet identity — switching or removing it would destroy the
        // delegation and orphan its data. Shown, but not actionable.
        const locked = acc.source === 'k5-delegation';
        return (
          <View key={acc.a} style={[styles.row, { borderColor: colors.border, backgroundColor: colors.bgSecondary }]}>
            <TouchableOpacity
              style={styles.rowMain}
              onPress={() => onSwitch(acc.a)}
              disabled={active || locked || busy !== null}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Ionicons
                name={active ? 'radio-button-on' : 'radio-button-off'}
                size={20}
                color={active ? colors.accentPrimary : colors.textSecondary}
              />
              <View style={styles.rowText}>
                <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
                  {acc.label || names[acc.a] || t('accounts_unnamed')}
                </Text>
                <Text style={[styles.addr, { color: colors.textSecondary }]} numberOfLines={1}>
                  {acc.a.slice(0, 12)}…{acc.a.slice(-6)}
                  {locked ? ` · ${t('accounts_k5_locked')}` : ''}
                </Text>
              </View>
              {busy === acc.a && <ActivityIndicator size="small" color={colors.accentPrimary} />}
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => onRemove(acc.a)}
              disabled={locked || busy !== null}
              accessibilityLabel={t('accounts_remove')}
              style={styles.removeBtn}
            >
              <Ionicons name="trash-outline" size={18} color={colors.error} />
            </TouchableOpacity>
          </View>
        );
      })}

      {accounts.length === 0 && (
        <Text style={[styles.hint, { color: colors.textSecondary }]}>{t('accounts_empty')}</Text>
      )}

      <Button
        label={t('accounts_add')}
        onPress={() => nav.navigate('AddAccount')}
        fullWidth
        style={{ marginTop: spacing.lg }}
        disabled={busy !== null}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: spacing.md },
  hint: { fontSize: fontSize.sm, marginBottom: spacing.md, lineHeight: 20 },
  row: {
    flexDirection: 'row', alignItems: 'center', borderWidth: 1,
    borderRadius: radius.md, marginBottom: spacing.sm, paddingRight: spacing.sm,
  },
  rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: spacing.sm, padding: spacing.md },
  rowText: { flex: 1 },
  name: { fontSize: fontSize.md, fontWeight: '600' },
  addr: { fontSize: fontSize.xs, marginTop: 2 },
  removeBtn: { padding: spacing.sm },
});
