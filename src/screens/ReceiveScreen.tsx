/**
 * Receive — show the wallet address as a scannable QR plus copy / share.
 */

import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Share } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import QrCode from '../components/QrCode';
import Button from '../components/Button';

export default function ReceiveScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { address } = useConnection();
  const [copied, setCopied] = useState(false);

  if (!address) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.textSecondary }}>{t('wallet_connect')}</Text>
      </View>
    );
  }

  const copy = async () => {
    await Clipboard.setStringAsync(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const share = () => { Share.share({ message: address }).catch(() => {}); };

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <Text style={[styles.title, { color: colors.textPrimary }]}>{t('wallet_receive')}</Text>
      <Text style={[styles.subtitle, { color: colors.textSecondary }]}>{t('wallet_receive_hint')}</Text>

      <View style={styles.qrWrap}>
        <QrCode value={address} size={300} />
      </View>

      <View style={[styles.addrBox, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.addr, { color: colors.textPrimary }]} selectable>{address}</Text>
      </View>

      <View style={styles.actions}>
        <Button
          label={copied ? t('channel_invite_link_copied') : t('wallet_copy_address')}
          onPress={copy}
          fullWidth
        />
        <Button
          label={t('channel_share_invite')}
          variant="secondary"
          onPress={share}
          fullWidth
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', padding: spacing.lg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  title: { fontSize: fontSize.xl, fontWeight: '700', marginTop: spacing.md },
  subtitle: { fontSize: fontSize.sm, marginTop: spacing.xs, marginBottom: spacing.lg, textAlign: 'center' },
  qrWrap: { backgroundColor: '#FFFFFF', padding: spacing.sm, borderRadius: radius.lg },
  addrBox: { marginTop: spacing.lg, padding: spacing.md, borderRadius: radius.md, alignSelf: 'stretch' },
  addr: { fontSize: fontSize.sm, textAlign: 'center', fontFamily: 'monospace' },
  actions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg, alignSelf: 'stretch' },
});
