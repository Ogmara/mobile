/**
 * Wallet hub — "Portfolio Hero" layout.
 *
 * Hero card (total fiat + KLV + address copy) → Send / Receive / Manage actions →
 * asset list (icon + amount + USD value + 7-day sparkline + per-asset send) →
 * recent transactions. Management (export key, on-chain register, disconnect) is
 * inline behind the Manage action. Fiat/icons/sparklines from the keyless
 * bitcoin.me feed; tx history + balances from the Klever API.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, RefreshControl, StyleSheet, ActivityIndicator,
  TouchableOpacity, TextInput, Alert, Modal, Linking, Image,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import { fetchAccountData, formatTokenAmount, fetchAssetMeta } from '../lib/klever';
import { sendTransfer, registerUser, getExplorerTxUrl, getExplorerAddressUrl, getExplorerStakingUrl } from '../lib/kleverTx';
import { vaultExportKey } from '../lib/vault';
import { loadPrices, loadForex, fiatValue, formatFiat, SUPPORTED_CURRENCIES, type Currency, type TokenPrice } from '../lib/prices';
import { fetchRecentTransactions, type TxSummary } from '../lib/txHistory';
import { getSetting, setSetting } from '../lib/settings';
import Sparkline from '../components/Sparkline';
import Gradient from '../components/Gradient';
import { debugLog } from '../lib/debug';
import type { MoreStackParamList } from '../navigation/types';
import { showAlert } from '../components/AlertHost';
import Button from '../components/Button';

interface Asset { assetId: string; name: string; atomic: number; frozen: number; precision: number }

/** Whole-token amount from atomic units. */
function toWhole(atomic: number, precision: number): number {
  return precision === 0 ? atomic : atomic / Math.pow(10, precision);
}

/** Label, glyph and accent for an activity row, by native Klever contract type. */
function txAppearance(tx: TxSummary, t: (k: string) => string, colors: any): { label: string; glyph: string; color: string } {
  switch (tx.contractType) {
    case 4: return { label: t('tx_staked'), glyph: '🔒', color: colors.accentPrimary };
    case 5: return { label: t('tx_unstaked'), glyph: '🔓', color: colors.warning };
    case 6: return { label: t('tx_delegated'), glyph: '➜', color: colors.accentPrimary };
    case 7: return { label: t('tx_undelegated'), glyph: '↩', color: colors.warning };
    case 8: return { label: t('tx_withdrew'), glyph: '↓', color: colors.success };
    case 9: return { label: t('tx_claimed'), glyph: '★', color: colors.success };
    case 63: return { label: t('tx_contract'), glyph: '⚙', color: colors.bgTertiary };
    default:
      return tx.direction === 'in'
        ? { label: t('wallet_received'), glyph: '↓', color: colors.success }
        : { label: t('wallet_sent'), glyph: '↑', color: colors.dm };
  }
}

/** Darken a hex colour by `amount` (0..1) for a gradient end-stop. */
function darken(hex: string, amount: number): string {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  const f = 1 - amount;
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

export default function WalletBalanceScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { address, signer, setWallet } = useConnection();
  const navigation = useNavigation<NativeStackNavigationProp<MoreStackParamList>>();

  const { data, loading, refreshing, onRefresh } = useApi(
    async () => (address ? fetchAccountData(address) : null),
    [address],
  );

  const [prices, setPrices] = useState<Record<string, TokenPrice>>({});
  const [txs, setTxs] = useState<TxSummary[]>([]);
  const [sendDialog, setSendDialog] = useState<{ assetId: string; precision: number } | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [logos, setLogos] = useState<Record<string, string>>({}); // assetId → Klever logo URL
  const [currency, setCurrency] = useState<Currency>('usd');
  const [forex, setForex] = useState<Record<string, number>>({ usd: 1 });
  const [currencyPicker, setCurrencyPicker] = useState(false);
  const [hidden, setHidden] = useState(false); // tap balance to hide amounts

  useEffect(() => {
    getSetting('currency').then((c) => { if (c && SUPPORTED_CURRENCIES.includes(c as Currency)) setCurrency(c as Currency); }).catch(() => {});
    loadForex().then(setForex).catch(() => {});
  }, []);
  const pickCurrency = (c: Currency) => { setCurrency(c); setCurrencyPicker(false); setSetting('currency', c).catch(() => {}); };
  /** Format a USD value in the chosen currency, or ••• when hidden. */
  const money = (usd: number) => (hidden ? '••••' : formatFiat(usd, currency, forex[currency] ?? 1));

  useEffect(() => { loadPrices().then(setPrices).catch(() => {}); }, [data]);
  useEffect(() => {
    if (address) fetchRecentTransactions(address, 15).then(setTxs).catch(() => {});
  }, [address, data]);
  // Fetch Klever asset logos for non-KLV tokens (bitcoin.me only lists traded tokens).
  useEffect(() => {
    const ids = data ? Object.keys(data.assets).filter((id) => id !== 'KLV') : [];
    ids.forEach((id) => {
      if (logos[id] !== undefined) return;
      fetchAssetMeta(id).then((m) => { if (m?.logo) setLogos((p) => ({ ...p, [id]: m.logo })); }).catch(() => {});
    });
  }, [data]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = useCallback(async () => {
    if (!sendDialog || !sendTo.trim() || !sendAmount.trim()) return;
    const recipient = sendTo.trim();
    if (!recipient.startsWith('klv1') || recipient.length < 40) {
      showAlert(t('error_generic'), 'Invalid Klever address'); return;
    }
    const amountFloat = parseFloat(sendAmount);
    if (!amountFloat || amountFloat <= 0) { showAlert(t('error_generic'), t('tip_amount_required')); return; }
    const atomicAmount = Math.round(amountFloat * Math.pow(10, sendDialog.precision));
    setSending(true);
    try {
      const txHash = await sendTransfer(recipient, sendDialog.assetId, atomicAmount);
      const url = await getExplorerTxUrl(txHash);
      showAlert(t('transfer_sent'), `${amountFloat} ${sendDialog.assetId}`, [
        { text: t('tip_view_tx'), onPress: () => Linking.openURL(url) },
        { text: t('done'), style: 'cancel' },
      ]);
      setSendDialog(null); setSendTo(''); setSendAmount(''); onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Transfer failed: ${msg}`);
      showAlert(t('transfer_failed'), msg.slice(0, 200));
    } finally { setSending(false); }
  }, [sendDialog, sendTo, sendAmount, onRefresh, t]);

  const copyAddress = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    showAlert(t('wallet_copy_address'), t('channel_invite_link_copied'));
  };

  const handleRegister = useCallback(() => {
    if (!signer) return;
    showAlert(t('register_title'), t('register_confirm'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('register_proceed'),
        onPress: async () => {
          setBusy(true);
          try {
            const txHash = await registerUser(signer.publicKeyHex);
            const url = await getExplorerTxUrl(txHash);
            showAlert(t('register_success'), t('register_tx_sent'), [
              { text: t('tip_view_tx'), onPress: () => Linking.openURL(url) },
              { text: t('done'), style: 'cancel' },
            ]);
          } catch (e) {
            showAlert(t('register_failed'), e instanceof Error ? e.message.slice(0, 200) : '');
          } finally { setBusy(false); }
        },
      },
    ]);
  }, [signer, t]);

  const handleExport = useCallback(() => {
    showAlert(t('wallet_export_key'), t('wallet_export_warning'), [
      { text: t('cancel'), style: 'cancel' },
      {
        text: t('wallet_export_reveal'),
        style: 'destructive',
        onPress: async () => {
          try {
            const key = await vaultExportKey();
            if (!key) { showAlert(t('error_generic'), 'Could not export key.'); return; }
            showAlert(t('wallet_export_key'), key, [
              { text: t('wallet_copy_address'), onPress: () => Clipboard.setStringAsync(key) },
              { text: t('done'), style: 'cancel' },
            ]);
          } catch {
            showAlert(t('error_generic'), 'Could not export key.');
          }
        },
      },
    ]);
  }, [t]);

  const handleDisconnect = useCallback(() => {
    showAlert(t('wallet_disconnect'), t('wallet_disconnect_confirm'), [
      { text: t('cancel'), style: 'cancel' },
      { text: t('wallet_disconnect'), style: 'destructive', onPress: () => { setManageOpen(false); setWallet(null); } },
    ]);
  }, [setWallet, t]);

  if (!address) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.textSecondary }}>{t('wallet_connect')}</Text>
      </View>
    );
  }
  if (loading && !data) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator color={colors.accentPrimary} size="large" />
      </View>
    );
  }

  // Build asset list: KLV first, then other tokens.
  const assets: Asset[] = [];
  if (data) {
    assets.push({ assetId: 'KLV', name: 'Klever', atomic: data.balance, frozen: data.frozenBalance || 0, precision: 6 });
    for (const a of Object.values(data.assets)) {
      if (a.assetId !== 'KLV') assets.push({ assetId: a.assetId, name: a.assetName || a.assetId, atomic: a.balance, frozen: a.frozenBalance || 0, precision: a.precision });
    }
  }
  // Total holdings = available + staked (frozen); the hero total includes staked so it sums correctly.
  const totalUsd = assets.reduce((sum, a) => {
    const p = prices[a.assetId];
    return sum + (p ? fiatValue(toWhole(a.atomic + a.frozen, a.precision), p.usd) : 0);
  }, 0);
  const totalStakedUsd = assets.reduce((sum, a) => {
    const p = prices[a.assetId];
    return sum + (p && a.frozen > 0 ? fiatValue(toWhole(a.frozen, a.precision), p.usd) : 0);
  }, 0);
  // Portfolio 24h change %, value-weighted across priced holdings.
  const change24h = (() => {
    let valued = 0, weighted = 0;
    for (const a of assets) {
      const p = prices[a.assetId];
      if (!p) continue;
      const v = fiatValue(toWhole(a.atomic + a.frozen, a.precision), p.usd);
      valued += v; weighted += v * (p.change24h || 0);
    }
    return valued > 0 ? weighted / valued : 0;
  })();

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accentPrimary} />}
    >
      {/* Hero — minimal premium: subtle dark gradient + accent top-glow */}
      <Gradient colors={[darken(colors.accentPrimary, 0.62), colors.bgPrimary]} style={styles.hero}>
        <View style={styles.heroGlow} />
        <View style={styles.heroTopRow}>
          <Text style={[styles.heroLabel, { color: colors.textSecondary }]}>{t('wallet_total_balance')}</Text>
          <TouchableOpacity style={[styles.curChip, { borderColor: colors.border }]} onPress={() => setCurrencyPicker(true)}>
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '600' }}>{currency.toUpperCase()} ▾</Text>
          </TouchableOpacity>
        </View>
        <TouchableOpacity activeOpacity={0.8} onPress={() => setHidden((h) => !h)} style={styles.heroBalRow}>
          <Text style={[styles.heroFiat, { color: colors.textPrimary }]}>{money(totalUsd)}</Text>
          {!hidden && Math.abs(change24h) >= 0.01 && (
            <Text style={[styles.heroChange, { color: change24h >= 0 ? colors.success : colors.error }]}>
              {change24h >= 0 ? '▲' : '▼'} {Math.abs(change24h).toFixed(1)}%
            </Text>
          )}
          <Ionicons name={hidden ? 'eye-off-outline' : 'eye-outline'} size={15} color={colors.textSecondary} style={{ marginLeft: 8 }} />
        </TouchableOpacity>
        <Text style={[styles.heroKlv, { color: colors.textSecondary }]}>
          {data ? formatTokenAmount(data.balance, 6) : '0'} KLV
        </Text>
        {totalStakedUsd > 0 && (
          <Text style={[styles.heroStaked, { color: colors.accentSecondary }]}>
            🔒 {t('wallet_incl_staked', { amount: money(totalStakedUsd) })}
          </Text>
        )}
        <TouchableOpacity onPress={copyAddress} activeOpacity={0.7} style={styles.heroAddrRow}>
          <Text style={[styles.heroAddr, { color: colors.textSecondary }]} numberOfLines={1}>
            {address.slice(0, 12)}…{address.slice(-6)}
          </Text>
          <Ionicons name="copy-outline" size={13} color={colors.textSecondary} style={{ marginLeft: 6 }} />
        </TouchableOpacity>
      </Gradient>

      {/* Actions — ghost pills */}
      <View style={styles.actions}>
        <GhostPill color={colors} label={t('transfer_send')} icon="arrow-up" onPress={() => setSendDialog({ assetId: 'KLV', precision: 6 })} />
        <GhostPill color={colors} label={t('wallet_receive')} icon="qr-code" onPress={() => navigation.navigate('Receive')} />
        <GhostPill color={colors} label={t('wallet_manage')} icon="settings-sharp" onPress={() => setManageOpen(true)} />
      </View>

      {/* Assets */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{t('wallet_assets')}</Text>
      {assets.map((a) => {
        const p = prices[a.assetId];
        const usd = p ? fiatValue(toWhole(a.atomic + a.frozen, a.precision), p.usd) : 0;
        const sym = a.assetId.split('-')[0];
        return (
          <View key={a.assetId} style={[styles.row, { borderBottomColor: colors.border }]}>
            <TouchableOpacity
              style={styles.rowTap}
              activeOpacity={0.7}
              onPress={() => navigation.navigate('TokenDetail', { assetId: a.assetId, name: a.name, precision: a.precision })}
            >
              {(p?.iconUrl || logos[a.assetId]) ? (
                <Image source={{ uri: p?.iconUrl || logos[a.assetId] }} style={styles.icon} />
              ) : (
                <View style={[styles.icon, styles.iconFallback, { backgroundColor: colors.accentSecondary }]}>
                  <Text style={{ color: colors.textInverse, fontWeight: '700' }}>{a.assetId.slice(0, 1)}</Text>
                </View>
              )}
              <View style={styles.rowMid}>
                <Text style={[styles.assetName, { color: colors.textPrimary }]} numberOfLines={1}>{a.name}</Text>
                <Text style={[styles.assetSub, { color: colors.textSecondary }]}>
                  {formatTokenAmount(a.atomic, a.precision)} {sym}
                </Text>
                {a.frozen > 0 && (
                  <Text style={[styles.assetStaked, { color: colors.accentSecondary }]}>
                    🔒 {formatTokenAmount(a.frozen, a.precision)} {t('wallet_staked')}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
            {p?.sparkline?.length ? <Sparkline data={p.sparkline} /> : <View style={{ width: 64 }} />}
            <View style={styles.rowRight}>
              <Text style={[styles.assetUsd, { color: colors.textPrimary }]}>{usd > 0 ? money(usd) : '—'}</Text>
              <TouchableOpacity onPress={() => setSendDialog({ assetId: a.assetId, precision: a.precision })}>
                <Text style={[styles.sendLink, { color: colors.accentPrimary }]}>{t('transfer_send')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        );
      })}

      {/* Recent transactions */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{t('wallet_activity')}</Text>
      {txs.length === 0 ? (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('wallet_no_activity')}</Text>
      ) : (
        txs.map((tx) => {
          const a = txAppearance(tx, t, colors);
          return (
          <TouchableOpacity
            key={tx.hash}
            style={[styles.row, { borderBottomColor: colors.border }]}
            onPress={async () => Linking.openURL(await getExplorerTxUrl(tx.hash))}
          >
            <View style={[styles.icon, styles.iconFallback]}>
              <Text style={{ color: a.color, fontWeight: '700', fontSize: 22 }}>{a.glyph}</Text>
            </View>
            <View style={styles.rowMid}>
              <Text style={[styles.assetName, { color: colors.textPrimary }]}>{a.label}</Text>
              <Text style={[styles.assetSub, { color: colors.textSecondary }]} numberOfLines={1}>
                {tx.counterparty ? `${tx.counterparty.slice(0, 14)}…` : tx.kind}
                {tx.timestamp ? ` · ${new Date(tx.timestamp).toLocaleDateString()}` : ''}
              </Text>
            </View>
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.lg }}>›</Text>
          </TouchableOpacity>
          );
        })
      )}

      <View style={{ height: spacing.xl }} />

      {/* Send dialog */}
      {sendDialog && (
        <Modal visible transparent animationType="fade" onRequestClose={() => !sending && setSendDialog(null)}>
          <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => !sending && setSendDialog(null)}>
            <View style={[styles.dialog, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
              <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>{t('transfer_send')} {sendDialog.assetId}</Text>
              <TextInput
                style={[styles.dialogInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
                placeholder={t('transfer_recipient')} placeholderTextColor={colors.textSecondary}
                value={sendTo} onChangeText={setSendTo} autoCapitalize="none" autoCorrect={false}
              />
              <TextInput
                style={[styles.dialogInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
                placeholder={t('tip_amount_label')} placeholderTextColor={colors.textSecondary}
                value={sendAmount} onChangeText={setSendAmount} keyboardType="decimal-pad"
              />
              <View style={styles.dialogActions}>
                <Button
                  label={t('cancel')}
                  variant="secondary"
                  onPress={() => { setSendDialog(null); setSendTo(''); setSendAmount(''); }}
                  disabled={sending}
                  style={styles.dialogBtn}
                />
                <Button
                  label={t('transfer_send')}
                  onPress={handleSend}
                  loading={sending}
                  disabled={!sendTo.trim() || !sendAmount.trim()}
                  style={styles.dialogBtn}
                />
              </View>
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {/* Manage sheet */}
      {currencyPicker && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setCurrencyPicker(false)}>
          <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={() => setCurrencyPicker(false)}>
            <View style={[styles.sheet, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
              <Text style={[styles.dialogTitle, { color: colors.textPrimary, paddingHorizontal: spacing.lg }]}>{t('wallet_currency')}</Text>
              {SUPPORTED_CURRENCIES.map((c) => (
                <ManageItem key={c} color={colors} label={c.toUpperCase() + (c === currency ? '  ✓' : '')} onPress={() => pickCurrency(c)} />
              ))}
            </View>
          </TouchableOpacity>
        </Modal>
      )}

      {manageOpen && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setManageOpen(false)}>
          <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={() => setManageOpen(false)}>
            <View style={[styles.sheet, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
              <Text style={[styles.dialogTitle, { color: colors.textPrimary, paddingHorizontal: spacing.lg }]}>{t('wallet_manage')}</Text>
              <ManageItem color={colors} label={t('wallet_staking_overview')} onPress={async () => { setManageOpen(false); Linking.openURL(await getExplorerStakingUrl(address)); }} />
              <ManageItem color={colors} label={t('wallet_view_explorer')} onPress={async () => { setManageOpen(false); Linking.openURL(await getExplorerAddressUrl(address)); }} />
              <ManageItem color={colors} label={t('register_button')} onPress={() => { setManageOpen(false); handleRegister(); }} disabled={busy} />
              <ManageItem color={colors} label={t('wallet_export_key')} onPress={() => { setManageOpen(false); handleExport(); }} />
              <ManageItem color={colors} label={t('wallet_disconnect')} danger onPress={handleDisconnect} />
              <ManageItem color={colors} label={t('cancel')} muted onPress={() => setManageOpen(false)} />
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </ScrollView>
  );
}

function GhostPill({ color, label, icon, onPress }: { color: any; label: string; icon: React.ComponentProps<typeof Ionicons>['name']; onPress: () => void }) {
  return (
    <TouchableOpacity style={[styles.ghostPill, { borderColor: color.border }]} onPress={onPress} activeOpacity={0.7}>
      <Ionicons name={icon} size={18} color={color.accentPrimary} />
      <Text style={[styles.ghostLabel, { color: color.accentPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ManageItem({ color, label, onPress, danger, muted, disabled }: { color: any; label: string; onPress: () => void; danger?: boolean; muted?: boolean; disabled?: boolean }) {
  return (
    <TouchableOpacity style={[styles.manageItem, { borderTopColor: color.border }]} onPress={onPress} disabled={disabled}>
      <Text style={{ color: danger ? color.error : muted ? color.textSecondary : color.textPrimary, fontSize: fontSize.md, fontWeight: '500', textAlign: 'center' }}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  hero: {
    margin: spacing.md, padding: spacing.lg, borderRadius: radius.lg,
    overflow: 'hidden', // clip the gradient bands + top-glow to the rounded corners
    borderWidth: StyleSheet.hairlineWidth, borderColor: '#1F2C3A',
  },
  heroGlow: { position: 'absolute', top: 0, left: 0, right: 0, height: 2, backgroundColor: 'rgba(106,178,242,0.55)' },
  heroTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  heroLabel: { fontSize: fontSize.sm, letterSpacing: 0.5, textTransform: 'uppercase' },
  curChip: { borderWidth: 1, borderRadius: radius.full, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  heroBalRow: { flexDirection: 'row', alignItems: 'baseline', marginTop: spacing.xs },
  heroFiat: { fontSize: 42, fontWeight: '800', letterSpacing: -1 },
  heroChange: { fontSize: fontSize.sm, fontWeight: '700', marginLeft: spacing.sm },
  heroKlv: { fontSize: fontSize.md, marginTop: 2, fontWeight: '600' },
  heroAddrRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.md },
  heroAddr: { fontSize: fontSize.xs },
  heroStaked: { fontSize: fontSize.xs, marginTop: 4 },
  assetStaked: { fontSize: fontSize.xs, marginTop: 2 },
  actions: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.md, marginBottom: spacing.md },
  ghostPill: {
    flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
    borderWidth: 1.5, borderRadius: radius.full, paddingVertical: spacing.sm,
  },
  ghostLabel: { fontSize: fontSize.sm, fontWeight: '600' },
  sectionTitle: { fontSize: fontSize.sm, fontWeight: '600', textTransform: 'uppercase', marginHorizontal: spacing.md, marginTop: spacing.md, marginBottom: spacing.xs },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, gap: spacing.sm },
  rowTap: { flexDirection: 'row', alignItems: 'center', flex: 1, gap: spacing.sm },
  icon: { width: 40, height: 40, borderRadius: radius.full },
  iconFallback: { justifyContent: 'center', alignItems: 'center' },
  rowMid: { flex: 1 },
  assetName: { fontSize: fontSize.md, fontWeight: '600' },
  assetSub: { fontSize: fontSize.xs, marginTop: 2 },
  rowRight: { alignItems: 'flex-end', gap: 2, minWidth: 64 },
  assetUsd: { fontSize: fontSize.sm, fontWeight: '600' },
  sendLink: { fontSize: fontSize.xs, fontWeight: '600' },
  empty: { textAlign: 'center', padding: spacing.lg, fontSize: fontSize.sm },
  overlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', padding: spacing.lg },
  dialog: { borderRadius: radius.lg, padding: spacing.lg },
  dialogTitle: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.md },
  dialogInput: { padding: spacing.md, borderRadius: radius.md, fontSize: fontSize.md, marginBottom: spacing.md },
  dialogActions: { flexDirection: 'row', gap: spacing.md },
  dialogBtn: { flex: 1 },
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingTop: spacing.md, paddingBottom: spacing.xl },
  manageItem: { paddingVertical: spacing.md, paddingHorizontal: spacing.lg, borderTopWidth: StyleSheet.hairlineWidth },
});
