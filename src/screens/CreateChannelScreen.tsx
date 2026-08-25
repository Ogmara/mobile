/**
 * Create Channel — UI for creating a new chat channel.
 *
 * Supports three types:
 * - Public (type 0): discoverable, everyone can read and write
 * - Read-Public (type 1): discoverable, everyone reads, only admins write
 * - Private (type 2): L2-only, invitation-based, channel ID from Keccak-256
 *
 * Uses SDK client.createChannel() for clean API interaction.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import KeyboardAwareView from '../components/KeyboardAwareView';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { keccak_256 } from '@noble/hashes/sha3';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { debugLog } from '../lib/debug';
import { createChannelOnChain, getChannelIdFromTx } from '../lib/kleverTx';
import { addJoinedChannel } from '../lib/joinedChannels';
import { showAlert } from '../components/AlertHost';

export default function CreateChannelScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  // walletAddress, not address: for external/delegated wallets (K5) `address` is
  // the ogd1... device key, while the private-channel ID must be derived from the
  // klv1... on-chain identity — that is what web and desktop hash, and what the
  // protocol treats as the creator. Getting this wrong would give the same
  // channel a different ID on mobile than on every other client.
  const { client, signer, walletAddress, address } = useConnection();
  const creatorAddress = walletAddress || address;
  const navigation = useNavigation();
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [channelType, setChannelType] = useState<0 | 1 | 2>(0);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');

  const handleCreate = async () => {
    const trimmedSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    if (!trimmedSlug) {
      showAlert(t('error_generic'), t('channel_slug_required'));
      return;
    }
    if (!client || !signer || !creatorAddress) {
      showAlert(t('error_generic'), t('wallet_connect'));
      return;
    }

    setCreating(true);
    try {
      // The L2 ChannelCreate envelope carries a channel_id that the node
      // requires; it is NOT assigned by the node. Where it comes from depends
      // on the channel type, and must match web/desktop exactly or the same
      // channel would get different IDs on different clients.
      let channelId: number;

      if (channelType === 2) {
        // Private channels are L2-only — no SC call, no fee. The ID is derived
        // locally from Keccak-256(creator + slug + timestamp), truncated to u64
        // (per protocol spec).
        setStatus(t('channel_create_deriving'));
        const ts = Date.now();
        const hash = keccak_256(new TextEncoder().encode(creatorAddress + trimmedSlug + ts));
        const view = new DataView(hash.buffer, hash.byteOffset, hash.byteLength);
        channelId = Number(view.getBigUint64(0) % BigInt(Number.MAX_SAFE_INTEGER));
      } else {
        // Public / Read-Public are registered on-chain; the SC assigns the ID.
        setStatus(t('channel_create_onchain'));
        const txHash = await createChannelOnChain(trimmedSlug, channelType);
        setStatus(t('channel_create_confirming'));
        channelId = await getChannelIdFromTx(txHash, trimmedSlug);
      }

      setStatus(t('channel_create_publishing'));
      await client.createChannel({
        channelId,
        slug: trimmedSlug,
        channelType,
        displayName: displayName.trim() || undefined,
        description: description.trim() || undefined,
        // P4: all new channels are E2E-encrypted (forced on, no toggle), matching
        // web and desktop. Omitting this would let the node fall back to
        // type-based defaults and leave mobile-created public channels plaintext.
        encryptionEnabled: true,
      });

      await addJoinedChannel(channelId).catch(() => {});

      showAlert(t('channel_created'), `#${trimmedSlug}`, [
        { text: t('done'), onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Channel creation failed: ${msg}`);
      showAlert(t('channel_create_failed'), msg.slice(0, 200));
    } finally {
      setCreating(false);
      setStatus('');
    }
  };

  const typeOptions: { value: 0 | 1 | 2; label: string }[] = [
    { value: 0, label: t('channel_type_public') },
    { value: 1, label: t('channel_type_read_public') },
    { value: 2, label: t('channel_type_private') },
  ];

  return (
    <KeyboardAwareView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>{t('channel_create')}</Text>

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('channel_slug_label')}</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder="my-channel"
          placeholderTextColor={colors.textSecondary}
          value={slug}
          onChangeText={setSlug}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('channel_name_label')}</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder={t('channel_name_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={64}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('channel_desc_label')}</Text>
        <TextInput
          style={[styles.input, styles.textArea, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder={t('channel_desc_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={256}
          textAlignVertical="top"
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('channel_type_label')}</Text>
        <View style={styles.typeRow}>
          {typeOptions.map((opt) => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.typeBtn, { backgroundColor: channelType === opt.value ? colors.accentPrimary : colors.bgSecondary }]}
              onPress={() => setChannelType(opt.value)}
            >
              <Text style={{ color: channelType === opt.value ? colors.textInverse : colors.textPrimary, fontWeight: '600', fontSize: fontSize.sm }}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {channelType === 2 && (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            {t('channel_private_hint')}
          </Text>
        )}

        <TouchableOpacity
          style={[styles.createBtn, { backgroundColor: creating ? colors.textSecondary : colors.accentPrimary }]}
          onPress={handleCreate}
          disabled={creating}
        >
          <Text style={[styles.createBtnText, { color: colors.textInverse }]}>
            {creating ? t('loading') : t('channel_create')}
          </Text>
        </TouchableOpacity>

        {/* On-chain creation waits on TX confirmation, which can take tens of
            seconds — without a progress line it reads as a hung button. */}
        {creating && status !== '' && (
          <Text style={[styles.status, { color: colors.textSecondary }]}>{status}</Text>
        )}
      </ScrollView>
    </KeyboardAwareView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg },
  heading: { fontSize: fontSize.xl, fontWeight: '700', marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.xs, marginTop: spacing.md },
  input: { padding: spacing.md, borderRadius: radius.md, fontSize: fontSize.md },
  textArea: { minHeight: 80 },
  typeRow: { flexDirection: 'row', gap: spacing.sm },
  typeBtn: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  hint: { fontSize: fontSize.xs, marginTop: spacing.sm, fontStyle: 'italic' },
  createBtn: { marginTop: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  createBtnText: { fontSize: fontSize.md, fontWeight: '600' },
  status: { fontSize: fontSize.sm, marginTop: spacing.md, textAlign: 'center' },
});
