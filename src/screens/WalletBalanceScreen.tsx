/**
 * Wallet Balance — displays KLV and token balances from the Klever blockchain.
 *
 * Fetches account data from the Klever API (testnet or mainnet based on
 * debug settings). Shows available balance, frozen balance, and all tokens.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  ActivityIndicator,
  TouchableOpacity,
  TextInput,
  Alert,
  Modal,
  Linking,
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
import { sendTransfer, getExplorerTxUrl } from '../lib/kleverTx';
import { debugLog } from '../lib/debug';

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

  const [addressCopied, setAddressCopied] = useState(false);
  const [sendDialog, setSendDialog] = useState<{ assetId: string; precision: number } | null>(null);
  const [sendTo, setSendTo] = useState('');
  const [sendAmount, setSendAmount] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    if (!sendDialog || !sendTo.trim() || !sendAmount.trim()) return;
    const recipient = sendTo.trim();
    if (!recipient.startsWith('klv1') || recipient.length < 40) {
      Alert.alert(t('error_generic'), 'Invalid Klever address');
      return;
    }
    const amountFloat = parseFloat(sendAmount);
    if (!amountFloat || amountFloat <= 0) {
      Alert.alert(t('error_generic'), t('tip_amount_required'));
      return;
    }
    const atomicAmount = Math.round(amountFloat * Math.pow(10, sendDialog.precision));

    setSending(true);
    try {
      const txHash = await sendTransfer(recipient, sendDialog.assetId, atomicAmount);
      const url = await getExplorerTxUrl(txHash);
      Alert.alert(
        t('transfer_sent'),
        `${amountFloat} ${sendDialog.assetId}`,
        [
          { text: t('tip_view_tx'), onPress: () => Linking.openURL(url) },
          { text: t('done'), style: 'cancel' },
        ],
      );
      setSendDialog(null);
      setSendTo('');
      setSendAmount('');
      onRefresh();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Transfer failed: ${msg}`);
      Alert.alert(t('transfer_failed'), msg.slice(0, 200));
    } finally {
      setSending(false);
    }
  }, [sendDialog, sendTo, sendAmount, onRefresh, t]);

  const handleCopyAddress = async () => {
    if (!address) return;
    await Clipboard.setStringAsync(address);
    setAddressCopied(true);
    setTimeout(() => setAddressCopied(false), 2000);
  };

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
            {addressCopied ? t('tip_sent') : address}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.sendCardBtn, { backgroundColor: 'rgba(255,255,255,0.2)' }]}
          onPress={() => setSendDialog({ assetId: 'KLV', precision: 6 })}
        >
          <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{t('transfer_send')}</Text>
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
            <View style={styles.tokenRight}>
              <Text style={[styles.tokenBalance, { color: colors.textPrimary }]}>
                {formatTokenAmount(item.balance, item.precision)}
              </Text>
              <TouchableOpacity
                style={[styles.sendRowBtn, { backgroundColor: colors.accentPrimary }]}
                onPress={() => setSendDialog({ assetId: item.assetId, precision: item.precision })}
              >
                <Text style={{ color: colors.textInverse, fontSize: fontSize.xs, fontWeight: '600' }}>{t('transfer_send')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        )}
        ListEmptyComponent={
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            {t('wallet_no_tokens')}
          </Text>
        }
      />

      {/* Send Dialog */}
      {sendDialog && (
        <Modal visible transparent animationType="fade" onRequestClose={() => !sending && setSendDialog(null)}>
          <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={() => !sending && setSendDialog(null)}>
            <View style={[styles.dialog, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
              <Text style={[styles.dialogTitle, { color: colors.textPrimary }]}>
                {t('transfer_send')} {sendDialog.assetId}
              </Text>
              <TextInput
                style={[styles.dialogInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
                placeholder={t('transfer_recipient')}
                placeholderTextColor={colors.textSecondary}
                value={sendTo}
                onChangeText={setSendTo}
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TextInput
                style={[styles.dialogInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
                placeholder={t('tip_amount_label')}
                placeholderTextColor={colors.textSecondary}
                value={sendAmount}
                onChangeText={setSendAmount}
                keyboardType="decimal-pad"
              />
              <View style={styles.dialogActions}>
                <TouchableOpacity
                  style={[styles.dialogBtn, { borderColor: colors.border, borderWidth: 1 }]}
                  onPress={() => { setSendDialog(null); setSendTo(''); setSendAmount(''); }}
                  disabled={sending}
                >
                  <Text style={{ color: colors.textPrimary }}>{t('cancel')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.dialogBtn, { backgroundColor: sending ? colors.textSecondary : colors.accentPrimary }]}
                  onPress={handleSend}
                  disabled={sending || !sendTo.trim() || !sendAmount.trim()}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color={colors.textInverse} />
                  ) : (
                    <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{t('transfer_send')}</Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          </TouchableOpacity>
        </Modal>
      )}
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
  sendCardBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  tokenRight: { alignItems: 'flex-end', gap: spacing.xs },
  sendRowBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    padding: spacing.lg,
  },
  dialog: {
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  dialogTitle: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.md },
  dialogInput: {
    padding: spacing.md,
    borderRadius: radius.md,
    fontSize: fontSize.md,
    marginBottom: spacing.md,
  },
  dialogActions: { flexDirection: 'row', gap: spacing.md },
  dialogBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  emptyText: { textAlign: 'center', padding: spacing.xl, fontSize: fontSize.sm },
});
