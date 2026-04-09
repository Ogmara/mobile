/**
 * TipDialog — modal for sending KLV tips to message authors.
 *
 * Shows amount input, optional note, recipient address, and
 * confirmation before broadcasting the transaction.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Modal,
  Alert,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { sendTip, getExplorerTxUrl } from '../lib/kleverTx';
import { debugLog } from '../lib/debug';

interface Props {
  visible: boolean;
  recipientAddress: string;
  onClose: () => void;
}

export default function TipDialog({ visible, recipientAddress, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async () => {
    const klvAmount = parseFloat(amount);
    if (!klvAmount || klvAmount <= 0) {
      Alert.alert(t('error_generic'), t('tip_amount_required'));
      return;
    }
    if (klvAmount > 1_000_000) {
      Alert.alert(t('error_generic'), t('tip_amount_too_large'));
      return;
    }

    setSending(true);
    try {
      const txHash = await sendTip(recipientAddress, klvAmount, note.trim() || undefined);
      const explorerUrl = await getExplorerTxUrl(txHash);
      Alert.alert(
        t('tip_sent'),
        `${klvAmount} KLV → ${recipientAddress.slice(0, 12)}...`,
        [
          { text: t('tip_view_tx'), onPress: () => Linking.openURL(explorerUrl) },
          { text: t('done'), style: 'cancel' },
        ],
      );
      setAmount('');
      setNote('');
      onClose();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Tip failed: ${msg}`);
      Alert.alert(t('tip_failed'), msg.slice(0, 200));
    } finally {
      setSending(false);
    }
  }, [amount, note, recipientAddress, onClose, t]);

  const handleClose = () => {
    if (!sending) {
      setAmount('');
      setNote('');
      onClose();
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={handleClose}>
      <TouchableOpacity style={styles.overlay} activeOpacity={1} onPress={handleClose}>
        <View style={[styles.dialog, { backgroundColor: colors.bgSecondary }]} onStartShouldSetResponder={() => true}>
          <Text style={[styles.title, { color: colors.textPrimary }]}>{t('tip_title')}</Text>
          <Text style={[styles.recipient, { color: colors.textSecondary }]}>
            {t('tip_to')} {recipientAddress.slice(0, 20)}...
          </Text>

          <Text style={[styles.label, { color: colors.textSecondary }]}>{t('tip_amount_label')}</Text>
          <TextInput
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
            placeholder="0.00"
            placeholderTextColor={colors.textSecondary}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            maxLength={12}
            autoFocus
          />

          <Text style={[styles.label, { color: colors.textSecondary }]}>{t('tip_note_label')}</Text>
          <TextInput
            style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
            placeholder={t('tip_note_placeholder')}
            placeholderTextColor={colors.textSecondary}
            value={note}
            onChangeText={setNote}
            maxLength={128}
          />

          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.cancelBtn, { borderColor: colors.border }]}
              onPress={handleClose}
              disabled={sending}
            >
              <Text style={{ color: colors.textPrimary }}>{t('cancel')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.sendBtn, { backgroundColor: sending ? colors.textSecondary : colors.accentPrimary }]}
              onPress={handleSend}
              disabled={sending || !amount.trim()}
            >
              {sending ? (
                <ActivityIndicator size="small" color={colors.textInverse} />
              ) : (
                <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{t('tip_send')}</Text>
              )}
            </TouchableOpacity>
          </View>
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
    padding: spacing.lg,
  },
  dialog: {
    width: '100%',
    maxWidth: 400,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.xs },
  recipient: { fontSize: fontSize.xs, marginBottom: spacing.md },
  label: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.xs },
  input: {
    padding: spacing.md,
    borderRadius: radius.md,
    fontSize: fontSize.md,
    marginBottom: spacing.md,
  },
  actions: {
    flexDirection: 'row',
    gap: spacing.md,
    marginTop: spacing.sm,
  },
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
  },
  sendBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
});
