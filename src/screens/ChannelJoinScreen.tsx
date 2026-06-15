/**
 * Channel Join — landing screen for an invite link (`#/join/{id}?node=…`).
 *
 * Tries the current node first. If the channel isn't here but the link carries a
 * `?node=` host hint (private channels are host-scoped), previews it from that host and,
 * on join, FEDERATES it to the user's home node (replicate + subscribe) rather than
 * switching nodes — mirroring the desktop ChannelJoinView flow.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { OgmaraClient, validateNodeUrl } from '@ogmara/sdk';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { addJoinedChannel } from '../lib/joinedChannels';
import { debugLog } from '../lib/debug';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChatStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<ChatStackParamList, 'ChannelJoin'>;

const hostLabel = (url: string): string => {
  try { return new URL(url).hostname; } catch { return url; }
};

export default function ChannelJoinScreen({ route, navigation }: Props) {
  // Deep links deliver params as strings; coerce so signed join envelopes encode a u64.
  const channelId = Number(route.params.channelId);
  const { node } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, nodeUrl, walletAddress } = useConnection();

  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<any>(null);
  const [crossNodeHost, setCrossNodeHost] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!client) return;
      try {
        const d = await client.getChannelDetail(channelId);
        if (!cancelled) { setDetail(d); setLoading(false); }
        return;
      } catch {
        // Not on the current node — try the host hint from the invite link.
        if (node && validateNodeUrl(node) && node !== nodeUrl) {
          try {
            const d = await new OgmaraClient({ nodeUrl: node, timeout: 15000 }).getChannelDetail(channelId);
            if (!cancelled) { setDetail(d); setCrossNodeHost(node); setLoading(false); }
            return;
          } catch { /* host unreachable / gone */ }
        }
        if (!cancelled) { setNotFound(true); setLoading(false); }
      }
    })();
    return () => { cancelled = true; };
  }, [client, channelId, node, nodeUrl]);

  const channelName = detail?.channel?.display_name || detail?.channel?.slug || `#${channelId}`;
  const isPrivate = detail?.channel?.channel_type === 2;
  const memberCount = detail?.member_count ?? detail?.channel?.member_count ?? 0;

  const handleJoin = async () => {
    if (!client) return;
    if (!walletAddress) { navigation.navigate('UserProfile', { address: '' }); return; }
    setJoining(true);
    setError('');
    try {
      // Cross-node: federate the channel to THIS (home) node first, then announce join.
      if (crossNodeHost) {
        await client.federateChannel(channelId, crossNodeHost);
      } else if (isPrivate && node && validateNodeUrl(node) && node !== nodeUrl) {
        // On-node but invite names a host — re-federate to refresh metadata (best-effort).
        try { await client.federateChannel(channelId, node); } catch { /* best-effort */ }
      }
      try {
        await client.joinChannel(channelId);
      } catch {
        if (isPrivate) throw new Error(t('channel_federate_failed'));
      }
      await addJoinedChannel(channelId).catch(() => {});
      navigation.replace('ChannelMessages', { channelId, channelName });
    } catch (e) {
      debugLog('warn', `Channel join failed: ${e instanceof Error ? e.message : ''}`);
      setError(e instanceof Error ? e.message : t('channel_federate_failed'));
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator size="large" color={colors.accentPrimary} />
      </View>
    );
  }

  if (notFound) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{t('channel_not_found')}</Text>
          <Text style={[styles.desc, { color: colors.textSecondary }]}>{t('channel_not_found_desc')}</Text>
          <TouchableOpacity
            style={[styles.btn, { backgroundColor: colors.accentPrimary }]}
            onPress={() => navigation.popToTop()}
          >
            <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{t('cancel')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.name, { color: colors.textPrimary }]}>
          {isPrivate ? '🔒 ' : '# '}{channelName}
        </Text>
        {!!detail?.channel?.description && (
          <Text style={[styles.desc, { color: colors.textSecondary }]}>{detail.channel.description}</Text>
        )}
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          {memberCount} {t('channel_members')}
        </Text>
        {crossNodeHost ? (
          <Text style={[styles.hint, { color: colors.textSecondary, backgroundColor: colors.bgTertiary }]}>
            {t('channel_on_other_node', { node: hostLabel(crossNodeHost) })}
          </Text>
        ) : isPrivate ? (
          <Text style={[styles.hint, { color: colors.textSecondary, backgroundColor: colors.bgTertiary }]}>
            {t('channel_private_invite_link')}
          </Text>
        ) : null}

        <TouchableOpacity
          style={[styles.btn, { backgroundColor: joining ? colors.textSecondary : colors.accentPrimary }]}
          onPress={handleJoin}
          disabled={joining}
        >
          <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
            {joining ? t('loading') : t('channel_join')}
          </Text>
        </TouchableOpacity>
        {!!error && <Text style={[styles.error, { color: colors.error }]}>{error}</Text>}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
  card: {
    width: '100%',
    maxWidth: 400,
    padding: spacing.xl,
    borderRadius: radius.lg,
    alignItems: 'center',
  },
  name: { fontSize: fontSize.xl, fontWeight: '700', marginBottom: spacing.sm, textAlign: 'center' },
  desc: { fontSize: fontSize.md, marginBottom: spacing.md, textAlign: 'center' },
  meta: { fontSize: fontSize.sm, marginBottom: spacing.lg },
  hint: {
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.md,
    textAlign: 'center',
  },
  btn: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.md,
    alignItems: 'center',
    alignSelf: 'stretch',
  },
  error: { marginTop: spacing.md, fontSize: fontSize.sm, textAlign: 'center' },
});
