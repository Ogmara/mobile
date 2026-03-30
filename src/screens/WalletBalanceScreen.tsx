/**
 * Wallet Balance — displays KLV and token balances from the Klever blockchain.
 *
 * Fetches account data from the Klever API (testnet or mainnet based on
 * debug settings). Shows available balance, frozen balance, and all tokens.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import {
  fetchAccountData,
  formatTokenAmount,
  type TokenBalance,
} from '../lib/klever';

export default function WalletBalanceScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { address } = useConnection();

  const { data, loading, error, refreshing, onRefresh } = useApi(
    async () => {
      if (!address) return null;
      return fetchAccountData(address);
    },
    [address],
  );

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

  const [addressCopied, setAddressCopied] = useState(false);

  const handleCopyAddress = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 2000);
  };

  const klvBalance = data ? formatTokenAmount(data.balance, 6) : '0';
  const klvFrozen = data ? formatTokenAmount(data.frozenBalance, 6) : '0';
  const tokens = data ? Object.values(data.assets).filter((a) => a.assetId !== 'KLV') : [];

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* KLV main balance card */}
      <View style={[styles.balanceCard, { backgroundColor: colors.accentPrimary }]}>
        <Text style={[styles.balanceLabel, { color: colors.textInverse }]}>KLV Balance</Text>
        <Text style={[styles.balanceAmount, { color: colors.textInverse }]}>{klvBalance}</Text>
        {data && data.frozenBalance > 0 && (
          <Text style={[styles.frozenText, { color: colors.textInverse }]}>
            Frozen: {klvFrozen} KLV
          </Text>
        )}
        <TouchableOpacity onPress={handleCopyAddress} activeOpacity={0.7}>
          <Text style={[styles.addressText, { color: colors.textInverse }]} numberOfLines={1}>
            {addressCopied ? 'Copied!' : address}
          </Text>
        </TouchableOpacity>
      </View>

      {error && (
        <View style={[styles.errorBanner, { backgroundColor: colors.error }]}>
          <Text style={{ color: colors.textInverse, fontSize: fontSize.sm }}>
            {t('error_network')}
          </Text>
        </View>
      )}

      {/* Token list */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        Tokens
      </Text>
      <FlatList
        data={tokens}
        keyExtractor={(item) => item.assetId}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
          />
        }
        renderItem={({ item }: { item: TokenBalance }) => (
          <View style={[styles.tokenRow, { borderBottomColor: colors.border }]}>
            <View style={styles.tokenInfo}>
              <Text style={[styles.tokenName, { color: colors.textPrimary }]}>
                {item.assetName || item.assetId}
              </Text>
              <Text style={[styles.tokenId, { color: colors.textSecondary }]}>
                {item.assetId}
              </Text>
            </View>
            <Text style={[styles.tokenBalance, { color: colors.textPrimary }]}>
              {formatTokenAmount(item.balance, item.precision)}
            </Text>
          </View>
        )}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No additional tokens
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  balanceCard: {
    margin: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.lg,
    alignItems: 'center',
  },
  balanceLabel: { fontSize: fontSize.sm, fontWeight: '600', opacity: 0.8 },
  balanceAmount: { fontSize: 36, fontWeight: '700', marginVertical: spacing.sm },
  frozenText: { fontSize: fontSize.sm, opacity: 0.7 },
  addressText: { fontSize: fontSize.xs, opacity: 0.6, marginTop: spacing.sm },
  errorBanner: {
    marginHorizontal: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  sectionTitle: {
    fontSize: fontSize.sm,
    fontWeight: '600',
    textTransform: 'uppercase',
    marginHorizontal: spacing.md,
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  tokenRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tokenInfo: { flex: 1 },
  tokenName: { fontSize: fontSize.md, fontWeight: '600' },
  tokenId: { fontSize: fontSize.xs, marginTop: 2 },
  tokenBalance: { fontSize: fontSize.md, fontWeight: '600' },
  emptyText: { textAlign: 'center', padding: spacing.xl, fontSize: fontSize.sm },
});
