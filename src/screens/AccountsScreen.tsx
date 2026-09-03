/**
 * Accounts — hold several wallets on this device and switch between them.
 *
 * Switching is NOT a sign-out: each account's preferences, channels, topic
 * follows and contacts stay on the device under its own namespace and come
 * back when it is selected again. Removing an account is the destructive
 * action, and is gated behind an explicit key-export confirmation because
 * losing a private key is unrecoverable.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { showAlert } from '../components/AlertHost';
import Button from '../components/Button';
import QuickMenu from '../components/QuickMenu';
import type { AccountEntry } from '../lib/vaultAccounts';
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

  /**
   * Returns whether the switch actually happened. Callers chain on this — the
   * profile editor edits whoever is ACTIVE, so navigating there after a failed
   * switch would edit the wrong account's profile.
   */
  const onSwitch = useCallback(async (addr: string): Promise<boolean> => {
    if (addr === walletAddress || busy) return false;
    setBusy(addr);
    try {
      await switchAccount(addr);
      return true;
    } catch (e) {
      showAlert(t('accounts_switch_failed'), e instanceof Error ? e.message.slice(0, 200) : '');
      return false;
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

  /**
   * Which account's action sheet is open.
   *
   * Tapping a row opens this rather than switching outright: with the profile
   * editor reachable only from here, a row needs to offer more than one verb,
   * and "switch" stays the first item so it is still a two-tap action.
   */
  const [menuFor, setMenuFor] = useState<AccountEntry | null>(null);

  const menuItems = useMemo(() => {
    if (!menuFor) return [];
    const acc = menuFor;
    const isActive = acc.a === walletAddress;
    const locked = acc.source === 'k5-delegation';
    const items: { icon: any; label: string; onPress: () => void; danger?: boolean }[] = [];
    if (!isActive && !locked) {
      items.push({
        icon: 'swap-horizontal-outline',
        label: t('accounts_switch_to'),
        onPress: () => { setMenuFor(null); onSwitch(acc.a); },
      });
    }
    if (!locked) {
      items.push({
        icon: 'person-circle-outline',
        label: t('accounts_edit_profile'),
        onPress: () => {
          setMenuFor(null);
          // The profile update is signed by the ACTIVE account, so editing a
          // different one means switching to it first — otherwise the edit
          // would silently be written against whoever is currently signed in.
          if (isActive) {
            nav.navigate('EditProfile');
          } else {
            onSwitch(acc.a).then((ok) => { if (ok) nav.navigate('EditProfile'); });
          }
        },
      });
    }
    items.push({
      icon: 'trash-outline',
      label: t('accounts_remove'),
      danger: true,
      onPress: () => { setMenuFor(null); onRemove(acc.a); },
    });
    return items;
  }, [menuFor, walletAddress, onSwitch, onRemove, nav, t]);

  return (
    <ScrollView style={{ backgroundColor: colors.bgPrimary }} contentContainerStyle={styles.content}>
      <QuickMenu
        visible={menuFor !== null}
        onClose={() => setMenuFor(null)}
        items={menuItems}
        anchor="bottom"
      />
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
              onPress={() => setMenuFor(acc)}
              disabled={locked || busy !== null}
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
              onPress={() => setMenuFor(acc)}
              disabled={locked || busy !== null}
              accessibilityLabel={t('accounts_actions')}
              style={styles.removeBtn}
            >
              <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
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
