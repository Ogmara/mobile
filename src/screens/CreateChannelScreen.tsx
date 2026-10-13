/**
 * Create Channel — UI for creating a new chat channel.
 *
 * Supports three types:
 * - Public (type 0): discoverable, everyone can read and write
 * - Read-Public (type 1): discoverable, everyone reads, only admins write
 * - Private (type 2): L2-only, invitation-based — channel_id is derived by
 *   `OgmaraClient.createChannel` itself (security fix, l2-node 0.139.0: the
 *   derivation must use the resolved WALLET identity, verified node-side —
 *   centralized in the SDK rather than duplicated here, which is what
 *   previously made it possible to accidentally hash the wrong address).
 *
 * Uses SDK client.createChannel() for clean API interaction.
 */

import React, { useRef, useState } from 'react';
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
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { debugLog } from '../lib/debug';
import { createChannelOnChain, getChannelIdFromTx } from '../lib/kleverTx';
import { addJoinedChannelFor } from '../lib/joinedChannels';
import { isSameAccount } from '../lib/accountGuard';
import { showAlert } from '../components/AlertHost';
import Button from '../components/Button';
import SegmentedControl from '../components/SegmentedControl';

export default function CreateChannelScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address, walletAddress } = useConnection();
  // Wallet mirrored during render. NOTE: App.tsx remounts the whole tree keyed
  // on `walletAddress`, so after a switch THIS (old) instance never re-renders
  // and this ref keeps the OLD wallet — it does not by itself detect a switch.
  // The guard is effectively carried by `client.address`, which
  // `withSigner` changes IN PLACE on the shared client object (see
  // lib/accountGuard.ts). Kept as a cheap second signal for any in-place
  // wallet change that doesn't remount.
  const walletAddressRef = useRef(walletAddress);
  walletAddressRef.current = walletAddress;
  const navigation = useNavigation();
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [channelType, setChannelType] = useState<0 | 1 | 2>(0);
  const [creating, setCreating] = useState(false);
  const [status, setStatus] = useState('');

  const handleCreate = async () => {
    // `_` removed from the allowed charset: validation.rs rejects it
    // outright for a channel slug, so keeping it here just meant a
    // user-visible "invalid slug" failure after already submitting — now
    // matches web/desktop's charset exactly.
    const trimmedSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
    if (!trimmedSlug) {
      showAlert(t('error_generic'), t('channel_slug_required'));
      return;
    }
    // `walletAddress` / `client.address` are required up front so the
    // account-switch guard below can never abort AFTER the on-chain step for
    // a reason that was already true before it.
    if (!client || !signer || !address || !walletAddress || !client.address) {
      showAlert(t('error_generic'), t('wallet_connect'));
      return;
    }

    // Account-switch guard (lib/accountGuard.ts): the on-chain registration
    // and its confirmation poll are long awaits, and `withSigner` mutates
    // THIS client on a switch — without the re-checks below, the L2
    // ChannelCreate would be signed as the NEW account (and the channel
    // added to its joined set) for a channel the OLD account registered.
    const start = { wallet: walletAddress, signer: client.address };
    const stillSame = () => isSameAccount(start, { wallet: walletAddressRef.current, signer: client.address });

    setCreating(true);
    try {
      // The L2 ChannelCreate envelope carries a channel_id. For Public/
      // Read-Public it's SC-assigned (fetched below); for Private,
      // `client.createChannel` derives it itself when omitted — see the
      // file-level doc comment for why that's no longer done here.
      let channelId: number | undefined;

      if (channelType !== 2) {
        // Public / Read-Public are registered on-chain; the SC assigns the ID.
        setStatus(t('channel_create_onchain'));
        const txHash = await createChannelOnChain(trimmedSlug, channelType);
        setStatus(t('channel_create_confirming'));
        channelId = await getChannelIdFromTx(txHash, trimmedSlug);
      } else {
        setStatus(t('channel_create_deriving'));
      }

      if (!stillSame()) {
        // Never sign the L2 ChannelCreate as the account switched TO — but
        // tell the user: for Public/Read-Public the previous account has
        // already registered (and paid for) the channel on-chain.
        debugLog('warn', 'Channel creation aborted: account switched mid-flow');
        showAlert(
          t('channel_create_interrupted'),
          t(channelType !== 2 ? 'channel_create_interrupted_onchain' : 'channel_create_interrupted_private'),
        );
        return;
      }
      setStatus(t('channel_create_publishing'));
      const resp = await client.createChannel({
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

      // Explicit account, not the active scope (see addJoinedChannelFor), so
      // this is correct even if a switch lands now: the channel was created
      // by — and belongs in the joined set of — the starting account.
      await addJoinedChannelFor(start.wallet!, resp.channel_id).catch(() => {});
      // Created successfully under the starting account; if the user has
      // since switched, don't pop a success dialog over the other account.
      if (!stillSame()) return;

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
          {/* Three mutually-exclusive options is a segmented control, not three
              buttons — same control the news feed's All/Following uses. */}
          <SegmentedControl
            segments={typeOptions.map((opt) => ({ value: String(opt.value), label: opt.label }))}
            value={String(channelType)}
            onChange={(v) => setChannelType(Number(v) as 0 | 1 | 2)}
          />
        </View>

        {channelType === 2 && (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            {t('channel_private_hint')}
          </Text>
        )}

        <Button
          label={t('channel_create')}
          onPress={handleCreate}
          loading={creating}
          fullWidth
          size="lg"
          style={styles.createBtn}
        />

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
  typeRow: { marginTop: spacing.xs },
  hint: { fontSize: fontSize.xs, marginTop: spacing.sm, fontStyle: 'italic' },
  createBtn: { marginTop: spacing.xl },
  status: { fontSize: fontSize.sm, marginTop: spacing.md, textAlign: 'center' },
});
