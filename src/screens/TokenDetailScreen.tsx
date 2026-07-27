/**
 * Token detail — staking / delegation / rewards hub for a single asset.
 *
 * Lets the user stake (freeze) an asset, claim staking/delegation rewards, and — for
 * KLV — delegate a bucket to a validator, undelegate, unstake (unfreeze), and withdraw
 * matured funds. All actions are native Klever contracts via `kleverTx`.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View, Text, ScrollView, RefreshControl, StyleSheet, ActivityIndicator,
  TouchableOpacity, TextInput, Alert, Modal, Linking, Image,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import {
  fetchAccountData, fetchAssetRewards, fetchValidators, fetchAssetMeta, formatTokenAmount, isBucketStaked,
  type StakeBucket, type Validator,
} from '../lib/klever';
import {
  freezeAsset, unfreezeBucket, delegateBucket, undelegateBucket, withdrawAsset, claimRewards,
  getExplorerTxUrl,
} from '../lib/kleverTx';
import { loadPrices, fiatValue, formatUsd, type TokenPrice } from '../lib/prices';
import { debugLog } from '../lib/debug';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { MoreStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<MoreStackParamList, 'TokenDetail'>;

const toWhole = (atomic: number, p: number) => (p === 0 ? atomic : atomic / Math.pow(10, p));

export default function TokenDetailScreen({ route }: Props) {
  const { assetId, name, precision } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { address } = useConnection();
  const isKlv = assetId === 'KLV';

  const { data, loading, refreshing, onRefresh } = useApi(
    async () => {
      if (!address) return null;
      const [acct, rewards] = await Promise.all([
        fetchAccountData(address),
        fetchAssetRewards(address, assetId),
      ]);
      return { acct, rewards };
    },
    [address, assetId],
  );

  const [price, setPrice] = useState<TokenPrice | null>(null);
  const [logo, setLogo] = useState<string>('');
  const [validators, setValidators] = useState<Validator[]>([]);
  const [stakeInput, setStakeInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [pickFor, setPickFor] = useState<string | null>(null); // bucketId awaiting validator pick

  useEffect(() => { loadPrices().then((p) => setPrice(p[assetId] ?? null)).catch(() => {}); }, [assetId]);
  useEffect(() => { fetchAssetMeta(assetId).then((m) => { if (m?.logo) setLogo(m.logo); }).catch(() => {}); }, [assetId]);
  useEffect(() => { if (isKlv) fetchValidators().then(setValidators).catch(() => {}); }, [isKlv]);

  const iconUrl = price?.iconUrl || logo;

  const asset = data?.acct?.assets?.[assetId];
  const available = isKlv ? (data?.acct?.balance ?? 0) : (asset?.balance ?? 0);
  const unfrozen = asset?.unfrozenBalance ?? (isKlv ? 0 : 0);
  const buckets: StakeBucket[] = asset?.buckets ?? [];
  const rewards = data?.rewards ?? { stakingRewards: 0, allowance: 0 };
  const claimable = rewards.stakingRewards + rewards.allowance;

  /** Run a tx, show explorer link on success, refresh. */
  const runTx = useCallback(async (fn: () => Promise<string>, successTitle: string) => {
    setBusy(true);
    try {
      const hash = await fn();
      const url = await getExplorerTxUrl(hash);
      Alert.alert(successTitle, t('stake_submitted'), [
        { text: t('tip_view_tx'), onPress: () => Linking.openURL(url) },
        { text: t('done'), style: 'cancel' },
      ]);
      setTimeout(onRefresh, 1500); // give the chain a moment
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Staking tx failed: ${msg}`);
      Alert.alert(t('transfer_failed'), msg.slice(0, 220));
    } finally { setBusy(false); }
  }, [onRefresh, t]);

  const doStake = useCallback(() => {
    const amt = parseFloat(stakeInput);
    if (!amt || amt <= 0) { Alert.alert(t('error_generic'), t('tip_amount_required')); return; }
    const atomic = Math.round(amt * Math.pow(10, precision));
    if (atomic > available) { Alert.alert(t('error_generic'), t('stake_insufficient')); return; }
    setStakeInput('');
    runTx(() => freezeAsset(assetId, atomic), t('stake_action'));
  }, [stakeInput, available, precision, assetId, runTx, t]);

  if (!address) {
    return <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}><Text style={{ color: colors.textSecondary }}>{t('wallet_connect')}</Text></View>;
  }
  if (loading && !data) {
    return <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}><ActivityIndicator size="large" color={colors.accentPrimary} /></View>;
  }

  const fiat = (atomic: number) => (price ? formatUsd(fiatValue(toWhole(atomic, precision), price.usd)) : '');

  const bucketStatus = (b: StakeBucket): string => {
    if (!isBucketStaked(b)) return t('stake_unfreezing');
    if (b.delegation) return t('stake_delegated_to', { name: b.validatorName || b.delegation.slice(0, 12) + '…' });
    return t('stake_staked');
  };

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accentPrimary} />}
    >
      {/* Header */}
      <View style={styles.header}>
        {iconUrl ? (
          <Image source={{ uri: iconUrl }} style={styles.icon} />
        ) : (
          <View style={[styles.icon, styles.iconFallback, { backgroundColor: colors.accentSecondary }]}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 20 }}>{assetId.slice(0, 1)}</Text>
          </View>
        )}
        <Text style={[styles.name, { color: colors.textPrimary }]}>{name}</Text>
        <Text style={[styles.avail, { color: colors.textSecondary }]}>
          {formatTokenAmount(available, precision)} {assetId.split('-')[0]} {price ? `· ${fiat(available)}` : ''}
        </Text>
      </View>

      {/* Rewards */}
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.cardLabel, { color: colors.textSecondary }]}>{t('stake_rewards')}</Text>
        <Text style={[styles.cardValue, { color: colors.textPrimary }]}>
          {formatTokenAmount(claimable, precision)} {assetId.split('-')[0]}
        </Text>
        <TouchableOpacity
          style={[styles.primaryBtn, { backgroundColor: claimable > 0 && !busy ? colors.accentPrimary : colors.textSecondary }]}
          onPress={() => runTx(() => claimRewards(assetId), t('stake_claim'))}
          disabled={claimable <= 0 || busy}
        >
          <Text style={{ color: '#fff', fontWeight: '700' }}>{t('stake_claim')}</Text>
        </TouchableOpacity>
      </View>

      {/* Stake */}
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.cardLabel, { color: colors.textSecondary }]}>{t('stake_action')}</Text>
        <View style={styles.stakeRow}>
          <TextInput
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
            placeholder={`${t('stake_amount')} (${assetId.split('-')[0]})`}
            placeholderTextColor={colors.textSecondary}
            value={stakeInput}
            onChangeText={setStakeInput}
            keyboardType="decimal-pad"
          />
          <TouchableOpacity
            style={[styles.primaryBtn, styles.stakeBtn, { backgroundColor: busy ? colors.textSecondary : colors.accentPrimary }]}
            onPress={doStake}
            disabled={busy}
          >
            {busy ? <ActivityIndicator size="small" color="#fff" /> : <Text style={{ color: '#fff', fontWeight: '700' }}>{t('stake_action')}</Text>}
          </TouchableOpacity>
        </View>
        <Text style={[styles.hint, { color: colors.textSecondary }]}>
          {t('stake_available_to_stake', { amount: `${formatTokenAmount(available, precision)} ${assetId.split('-')[0]}` })}
        </Text>
      </View>

      {/* Withdraw matured */}
      {unfrozen > 0 && (
        <TouchableOpacity
          style={[styles.card, styles.withdrawCard, { backgroundColor: colors.bgSecondary, borderColor: colors.accentPrimary }]}
          onPress={() => runTx(() => withdrawAsset(assetId), t('stake_withdraw'))}
          disabled={busy}
        >
          <Text style={{ color: colors.accentPrimary, fontWeight: '700' }}>
            {t('stake_withdraw')} · {formatTokenAmount(unfrozen, precision)} {assetId.split('-')[0]}
          </Text>
        </TouchableOpacity>
      )}

      {/* Buckets */}
      <Text style={[styles.section, { color: colors.textSecondary }]}>{t('stake_your_stake')}</Text>
      {buckets.length === 0 ? (
        <Text style={[styles.empty, { color: colors.textSecondary }]}>{t('stake_no_buckets')}</Text>
      ) : (
        buckets.map((b) => {
          const staked = isBucketStaked(b);
          return (
            <View key={b.id} style={[styles.bucket, { borderBottomColor: colors.border }]}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.bucketAmount, { color: colors.textPrimary }]}>
                  {formatTokenAmount(b.balance, precision)} {assetId.split('-')[0]}
                </Text>
                <Text style={[styles.bucketStatus, { color: b.delegation ? colors.success : colors.textSecondary }]}>
                  {bucketStatus(b)}
                </Text>
              </View>
              <View style={styles.bucketActions}>
                {staked && b.delegation && (
                  <BucketBtn color={colors} label={t('stake_undelegate')} onPress={() => runTx(() => undelegateBucket(b.id), t('stake_undelegate'))} disabled={busy} />
                )}
                {staked && !b.delegation && isKlv && (
                  <BucketBtn color={colors} label={t('stake_delegate')} primary onPress={() => setPickFor(b.id)} disabled={busy} />
                )}
                {staked && !b.delegation && (
                  <BucketBtn color={colors} label={t('stake_unstake')} onPress={() =>
                    Alert.alert(t('stake_unstake'), t('stake_confirm_unstake'), [
                      { text: t('cancel'), style: 'cancel' },
                      { text: t('stake_unstake'), style: 'destructive', onPress: () => runTx(() => unfreezeBucket(assetId, b.id), t('stake_unstake')) },
                    ])
                  } disabled={busy} />
                )}
              </View>
            </View>
          );
        })
      )}

      <View style={{ height: spacing.xl }} />

      {/* Validator picker */}
      {pickFor && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setPickFor(null)}>
          <TouchableOpacity style={styles.sheetOverlay} activeOpacity={1} onPress={() => setPickFor(null)}>
            <View style={[styles.sheet, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>{t('stake_select_validator')}</Text>
              <ScrollView style={{ maxHeight: 420 }}>
                {validators.length === 0 ? (
                  <ActivityIndicator color={colors.accentPrimary} style={{ padding: spacing.lg }} />
                ) : validators.map((v) => (
                  <TouchableOpacity
                    key={v.address}
                    style={[styles.valRow, { borderBottomColor: colors.border }]}
                    onPress={() => { const bucket = pickFor; setPickFor(null); if (bucket) runTx(() => delegateBucket(bucket, v.address), t('stake_delegate')); }}
                  >
                    {v.logo ? <Image source={{ uri: v.logo }} style={styles.valLogo} /> : <View style={[styles.valLogo, styles.iconFallback, { backgroundColor: colors.accentSecondary }]}><Text style={{ color: '#fff', fontWeight: '700' }}>{v.name.slice(0, 1)}</Text></View>}
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.valName, { color: colors.textPrimary }]} numberOfLines={1}>{v.name}</Text>
                      <Text style={[styles.valSub, { color: colors.textSecondary }]}>
                        {t('stake_commission', { pct: (v.commission / 100).toFixed(1) })} · {formatTokenAmount(v.totalStake, 6)} KLV
                      </Text>
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
              <TouchableOpacity style={styles.cancelRow} onPress={() => setPickFor(null)}>
                <Text style={{ color: colors.textSecondary, textAlign: 'center', fontWeight: '600' }}>{t('cancel')}</Text>
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
    </ScrollView>
  );
}

function BucketBtn({ color, label, onPress, primary, disabled }: { color: any; label: string; onPress: () => void; primary?: boolean; disabled?: boolean }) {
  return (
    <TouchableOpacity
      style={[styles.bucketBtn, { backgroundColor: primary ? color.accentPrimary : 'transparent', borderColor: color.border, borderWidth: primary ? 0 : 1 }]}
      onPress={onPress}
      disabled={disabled}
    >
      <Text style={{ color: primary ? '#fff' : color.textPrimary, fontSize: fontSize.xs, fontWeight: '600' }}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  header: { alignItems: 'center', paddingVertical: spacing.lg },
  icon: { width: 56, height: 56, borderRadius: radius.full },
  iconFallback: { justifyContent: 'center', alignItems: 'center' },
  name: { fontSize: fontSize.xl, fontWeight: '700', marginTop: spacing.sm },
  avail: { fontSize: fontSize.sm, marginTop: 2 },
  card: { marginHorizontal: spacing.md, marginBottom: spacing.md, padding: spacing.md, borderRadius: radius.lg },
  cardLabel: { fontSize: fontSize.sm, fontWeight: '600', textTransform: 'uppercase' },
  cardValue: { fontSize: fontSize.xl, fontWeight: '700', marginVertical: spacing.sm },
  primaryBtn: { paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: radius.md, alignItems: 'center' },
  stakeRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm, alignItems: 'center' },
  input: { flex: 1, padding: spacing.md, borderRadius: radius.md, fontSize: fontSize.md },
  stakeBtn: { justifyContent: 'center', minWidth: 90 },
  hint: { fontSize: fontSize.xs, marginTop: spacing.sm },
  withdrawCard: { borderWidth: 1, alignItems: 'center' },
  section: { fontSize: fontSize.sm, fontWeight: '600', textTransform: 'uppercase', marginHorizontal: spacing.md, marginBottom: spacing.xs },
  empty: { textAlign: 'center', padding: spacing.lg, fontSize: fontSize.sm },
  bucket: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: spacing.md, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  bucketAmount: { fontSize: fontSize.md, fontWeight: '600' },
  bucketStatus: { fontSize: fontSize.xs, marginTop: 2 },
  bucketActions: { flexDirection: 'row', gap: spacing.xs },
  bucketBtn: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm },
  sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, paddingTop: spacing.md, paddingBottom: spacing.lg },
  sheetTitle: { fontSize: fontSize.lg, fontWeight: '700', paddingHorizontal: spacing.lg, marginBottom: spacing.sm },
  valRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth },
  valLogo: { width: 36, height: 36, borderRadius: radius.full },
  valName: { fontSize: fontSize.md, fontWeight: '600' },
  valSub: { fontSize: fontSize.xs, marginTop: 2 },
  cancelRow: { paddingVertical: spacing.md, marginTop: spacing.xs },
});
