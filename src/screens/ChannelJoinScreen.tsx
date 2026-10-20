/**
 * Channel Join — landing screen for a join link (`#/join/{id}?node=…[&inv=…]`).
 *
 * Tries the current node first. If the channel isn't here but a host hint
 * names a node where it lives (the link's `?node=`, else the anchor node inside
 * the link's invite, else that of the wallet's pending invite — spec 05 §8.4
 * step 4), previews it from there and, on join, FEDERATES it to the user's home
 * node (replicate + subscribe) rather than switching nodes.
 *
 * Private channels are INVITE-GATED (spec 05 §8.4, spec 06 §6.5, l2-node
 * 0.140.0+): the join needs the joiner's own signed `ChannelInvite`, taken from
 * the personal link's `inv=` parameter or from the newest pending
 * `channel_invite` notification (`findPendingInvite`). Without a usable invite
 * NO Join action is rendered — only the invite-only text and copy-my-address.
 * An account already KNOWN to be in the channel (creator, or in its own joined
 * set) gets "open channel" instead of that dead end; unknown membership falls
 * back to the gate. The client decodes invites for display only; the node
 * verifies them. Public / ReadPublic joins are unchanged (permissionless).
 */

import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import {
  OgmaraClient, validateNodeUrl, decodeInviteFromUrl, decodeChannelInvite,
  INVITE_EXPIRY_MARGIN_MS, INVITE_FUTURE_TOLERANCE_MS,
  type ChannelDetailResponse,
} from '@ogmara/sdk';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { addJoinedChannelFor, loadJoinedChannels } from '../lib/joinedChannels';
import { debugLog } from '../lib/debug';
import { isSameAccount } from '../lib/accountGuard';
import { formatDateTime } from '../lib/datetime';
import {
  evaluateInvite, resolveJoinInvite, isJoinableInvite, isMemberState, isPrivateJoinRejection,
  isInviteGatedChannel, isKnownPrivateMember, isPreviewCreator, isTransientFederateError,
  type InviteCandidate, type InviteEvalContext,
} from '../lib/privateInvite';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChatStackParamList } from '../navigation/types';
import Button from '../components/Button';

type Props = NativeStackScreenProps<ChatStackParamList, 'ChannelJoin'>;

/**
 * Everything the async lookup found, TAGGED with the (wallet, channel) it was
 * fetched for. A result for another key is ignored at render — a lookup that
 * outlived an account or channel change must never drive this screen.
 */
interface Lookup {
  wallet: string | null;
  channelId: number;
  detail: ChannelDetailResponse | null;
  crossNodeHost: string | null;
  notFound: boolean;
  pending: InviteCandidate | null;
  member: boolean;
}

/** Coarse clock so an invite that expires while the screen is open loses its Join. */
const EXPIRY_TICK_MS = 30_000;

const hostLabel = (url: string): string => {
  try { return new URL(url).hostname; } catch { return url; }
};

/** Decode the `inv=` link parameter. UNVERIFIED, display/attach only. */
function candidateFromLink(param: unknown): InviteCandidate | null {
  if (typeof param !== 'string' || !param) return null;
  const bytes = decodeInviteFromUrl(param);
  if (!bytes) return null;
  const decoded = decodeChannelInvite(bytes);
  return decoded ? { decoded, bytes } : null;
}

export default function ChannelJoinScreen({ route, navigation }: Props) {
  // Deep links deliver params as strings; coerce so signed join envelopes encode a u64.
  const channelId = Number(route.params.channelId);
  const { node, inv } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, nodeUrl, walletAddress } = useConnection();
  // Wallet mirrored during render. NOTE: App.tsx remounts the whole tree keyed
  // on `walletAddress`, so after a switch THIS (old) instance never re-renders
  // and this ref keeps the OLD wallet — it does not by itself detect a switch.
  // The guard is effectively carried by `client.address`, which
  // `withSigner` changes IN PLACE on the shared client object (see
  // lib/accountGuard.ts). Kept as a cheap second signal for any in-place
  // wallet change that doesn't remount.
  const walletAddressRef = useRef(walletAddress);
  walletAddressRef.current = walletAddress;

  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState('');
  // The node rejected the join/federate for lack of a valid invite proof.
  const [proofRejected, setProofRejected] = useState(false);
  const [addressCopied, setAddressCopied] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), EXPIRY_TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Decoded once per `inv` value (pure).
  const linkInviteRef = useRef<{ inv: unknown; cand: InviteCandidate | null } | null>(null);
  if (!linkInviteRef.current || linkInviteRef.current.inv !== inv) {
    linkInviteRef.current = { inv, cand: candidateFromLink(inv) };
  }
  const linkInvite = linkInviteRef.current.cand;

  useEffect(() => {
    let cancelled = false;
    // Everything below belongs to the account this run started as.
    const startWallet = walletAddress ?? null;
    const startSigner = client?.address;
    const sameAccount = () => isSameAccount(
      { wallet: startWallet, signer: startSigner },
      { wallet: walletAddressRef.current, signer: client?.address },
    );
    setLookup(null);
    setProofRejected(false);
    setError('');
    (async () => {
      if (!client) return;
      const usableHost = (h: string | undefined | null): h is string =>
        !!h && h !== nodeUrl && !!validateNodeUrl(h);

      /** Preview from the first reachable foreign host hint. */
      const tryHosts = async (hosts: (string | undefined | null)[]) => {
        const seen = new Set<string>();
        for (const h of hosts) {
          if (!usableHost(h) || seen.has(h)) continue;
          seen.add(h);
          try {
            const fd = await new OgmaraClient({ nodeUrl: h, timeout: 15000 }).getChannelDetail(channelId);
            return { detail: fd, host: h };
          } catch { /* host unreachable / gone — try the next hint */ }
          if (cancelled) return null;
        }
        return null;
      };

      let detail: ChannelDetailResponse | null = null;
      let crossNodeHost: string | null = null;
      try {
        detail = await client.getChannelDetail(channelId);
      } catch {
        const linkAnchor = linkInvite && linkInvite.decoded.channelId === channelId
          ? linkInvite.decoded.anchorNode : undefined;
        const found = await tryHosts([node, linkAnchor]);
        if (found) { detail = found.detail; crossNodeHost = found.host; }
      }
      if (cancelled) return;

      const gated = isInviteGatedChannel(detail?.channel?.channel_type, channelId);

      // Membership — positive evidence only, for THIS account. `creator` is
      // trusted only from the HOME node's own record: a cross-node preview
      // comes from a host named by the link and could claim anyone as creator.
      let member = false;
      if (gated && startWallet) {
        const homeCreator = crossNodeHost ? null : (detail?.channel?.creator ?? null);
        let joinedLocally: boolean | null = null;
        if (homeCreator !== startWallet) {
          const joined = await loadJoinedChannels().catch(() => null);
          if (cancelled || !sameAccount()) return;
          joinedLocally = joined ? joined.has(channelId) : null;
        }
        member = isKnownPrivateMember(startWallet, { creator: homeCreator, joinedLocally });
      }

      // Pending invite: private (or still unknown) channel, authenticated
      // account, and the link didn't already supply a joinable one.
      let pending: InviteCandidate | null = null;
      if (gated && !member && startWallet && startSigner) {
        const linkJoinable = isJoinableInvite(evaluateInvite(linkInvite, {
          channelId, wallet: startWallet, now: Date.now(),
          expiryMarginMs: INVITE_EXPIRY_MARGIN_MS, futureToleranceMs: INVITE_FUTURE_TOLERANCE_MS,
        }));
        if (!linkJoinable || !detail) {
          try {
            const p = await client.findPendingInvite(channelId);
            if (p) pending = { decoded: p, bytes: p.invite };
          } catch (e) {
            debugLog('warn', `findPendingInvite failed: ${e instanceof Error ? e.message : ''}`);
          }
          if (cancelled || !sameAccount()) return;
        }
      }

      // Still unknown everywhere? The pending invite's anchor node is the last hint.
      if (!detail) {
        const found = await tryHosts([pending?.decoded.anchorNode]);
        if (cancelled) return;
        if (found) { detail = found.detail; crossNodeHost = found.host; }
      }
      if (cancelled || !sameAccount()) return;
      setLookup({
        wallet: startWallet, channelId, detail, crossNodeHost,
        notFound: !detail, pending, member,
      });
    })();
    return () => { cancelled = true; };
    // `linkInvite` is derived from `inv`, which is a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, channelId, node, inv, nodeUrl, walletAddress]);

  // Ignore a lookup made for another account / channel (stale carry-over).
  const current = lookup && lookup.wallet === (walletAddress ?? null) && lookup.channelId === channelId
    ? lookup : null;
  const detail = current?.detail ?? null;
  const crossNodeHost = current?.crossNodeHost ?? null;

  const channelName = detail?.channel?.display_name || detail?.channel?.slug || `#${channelId}`;
  // Fail-closed: anything not POSITIVELY Public/ReadPublic takes the invite path.
  const gated = isInviteGatedChannel(detail?.channel?.channel_type, channelId);
  const memberCount = detail?.member_count ?? detail?.channel?.member_count ?? 0;

  const evalCtx = (at: number): InviteEvalContext => ({
    channelId,
    wallet: walletAddress ?? null,
    now: at,
    expiryMarginMs: INVITE_EXPIRY_MARGIN_MS,
    futureToleranceMs: INVITE_FUTURE_TOLERANCE_MS,
    creator: detail?.channel?.creator ?? null,
    moderators: detail?.moderators ?? null,
    // Fail closed: only positive evidence (creator, or this account's own
    // joined set — `isKnownPrivateMember`) yields 'member'.
    membership: current?.member ? 'member' : 'unknown',
  });
  const inviteState = resolveJoinInvite(linkInvite, current?.pending ?? null, evalCtx(now));

  const handleCopyMyAddress = async () => {
    if (!walletAddress) return;
    try {
      await Clipboard.setStringAsync(walletAddress);
      setAddressCopied(true);
      setTimeout(() => setAddressCopied(false), 2000);
    } catch (e) {
      debugLog('warn', `Copy address failed: ${e instanceof Error ? e.message : ''}`);
    }
  };

  const handleJoin = async () => {
    if (!client || !current) return;
    // No signing key either counts as "no wallet": the account guard below
    // needs a non-empty snapshot, and the join can't be signed without one.
    if (!walletAddress || !client.address) { navigation.navigate('UserProfile', { address: '' }); return; }
    // `withSigner` mutates THIS client object on an account switch and the
    // remount doesn't stop this closure, so after every await re-check that
    // the account (wallet + live signing key) is the one the join started as.
    // Otherwise a switch during the federate round-trip would sign the
    // private-channel ChannelJoin as the NEW account and add the channel to
    // its joined set. Aborts silently: the screen belongs to a stale account.
    const start = { wallet: walletAddress, signer: client.address };
    const stillSame = () => isSameAccount(start, { wallet: walletAddressRef.current, signer: client.address });

    // Private: re-evaluate the invite against the EXACT clock (the render one
    // ticks every 30 s) and send exactly those bytes to federate and join. A
    // known member re-federating from another host needs none — the node
    // accepts members/the creator idempotently.
    let invite: Uint8Array | undefined;
    if (gated) {
      const fresh = inviteState.candidate ? evaluateInvite(inviteState.candidate, evalCtx(Date.now())) : inviteState;
      if (isJoinableInvite(fresh) && fresh.candidate && fresh.candidate.decoded.targetUser === start.wallet) {
        invite = fresh.candidate.bytes;
      } else if (!current.member) {
        setNow(Date.now()); // re-render into the matching no-join state
        return;
      }
    }

    setJoining(true);
    setError('');
    setProofRejected(false);
    try {
      if (crossNodeHost) {
        // FEDERATE + join: the home node verifies the invite before fetching.
        await client.federateChannel(channelId, crossNodeHost, invite ? { invite } : undefined);
      } else if (gated) {
        // On this node already: a host hint re-federates to refresh metadata
        // and the gossip subscription (best-effort; the join is authoritative).
        const hint = [node, linkInvite?.decoded.anchorNode]
          .find((h) => !!h && h !== nodeUrl && validateNodeUrl(h));
        if (hint) {
          try { await client.federateChannel(channelId, hint, invite ? { invite } : undefined); } catch { /* best-effort */ }
        }
      }
      if (!stillSame()) return;
      try {
        await client.joinChannel(channelId, invite ? { invite } : undefined);
      } catch (e) {
        // Public: best-effort (still readable/added locally). Private on this
        // node: the join IS the membership — fatal. Private federated: the
        // federate above already recorded the verified membership.
        if (gated && !crossNodeHost) throw e;
      }
      if (!stillSame()) return;
      // Explicit account, not the active scope: a switch during this write's
      // own internal await must not redirect it into the new account.
      await addJoinedChannelFor(start.wallet, channelId).catch(() => {});
      if (!stillSame()) return;
      navigation.replace('ChannelMessages', { channelId, channelName });
    } catch (e) {
      if (!stillSame()) return;
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Channel join failed: ${msg}`);
      // Rate-limited / busy → retry hint; private "invite proof required" or
      // any 403 → invite-required state; anything else → the raw error.
      if (isTransientFederateError(e)) setError(t('channel_invite_busy_retry'));
      else if (isPrivateJoinRejection(e, gated)) setProofRejected(true);
      else setError(msg || t('channel_federate_failed'));
    } finally {
      setJoining(false);
    }
  };

  // The creator re-hosting their OWN private channel on this (fresh) home
  // node: no invite exists for oneself, and the node accepts a no-invite
  // federate of an unknown channel from the verified creator. The preview's
  // creator claim comes from a link-chosen host, so it only decides whether
  // to OFFER this action — the home node verifies, and a hostile host earns a
  // 403/502 mapped like any other error. Never membership evidence.
  const canHostAsCreator = gated && !!crossNodeHost && !current?.member
    && !isJoinableInvite(inviteState)
    && isPreviewCreator(walletAddress, detail?.channel?.creator, detail?.channel?.channel_id, channelId);

  const handleCreatorHost = async () => {
    if (!client || !current || !crossNodeHost) return;
    if (!walletAddress || !client.address) { navigation.navigate('UserProfile', { address: '' }); return; }
    // Same account guard as handleJoin: snapshot first, re-check after EVERY await.
    const start = { wallet: walletAddress, signer: client.address };
    const stillSame = () => isSameAccount(start, { wallet: walletAddressRef.current, signer: client.address });
    const host = crossNodeHost;
    setJoining(true);
    setError('');
    setProofRejected(false);
    try {
      // Federate WITHOUT an invite. The home node records the creator as a
      // member on success, so no separate ChannelJoin is needed.
      await client.federateChannel(channelId, host);
      if (!stillSame()) return;
      await addJoinedChannelFor(start.wallet, channelId).catch(() => {});
      if (!stillSame()) return;
      navigation.replace('ChannelMessages', { channelId, channelName });
    } catch (e) {
      if (!stillSame()) return;
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Creator federate failed: ${msg}`);
      if (isTransientFederateError(e)) setError(t('channel_invite_busy_retry'));
      else if (isPrivateJoinRejection(e, true)) setProofRejected(true);
      else setError(msg || t('channel_federate_failed'));
    } finally {
      setJoining(false);
    }
  };

  const handleOpen = () => navigation.replace('ChannelMessages', { channelId, channelName });

  if (!current) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator size="large" color={colors.accentPrimary} />
      </View>
    );
  }

  if (current.notFound) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
          <Text style={[styles.name, { color: colors.textPrimary }]}>{t('channel_not_found')}</Text>
          <Text style={[styles.desc, { color: colors.textSecondary }]}>{t('channel_not_found_desc')}</Text>
          <Button label={t('cancel')} onPress={() => navigation.popToTop()} style={styles.btn} />
        </View>
      </View>
    );
  }

  const hintStyle = [styles.hint, { color: colors.textSecondary, backgroundColor: colors.bgTertiary }];
  const joinButton = (
    <Button
      label={joining ? t('loading') : t('channel_join')}
      onPress={handleJoin}
      loading={joining}
      disabled={joining}
      style={styles.btn}
    />
  );

  /** Private-channel action area: exactly one of the spec 05 §8.4 states. */
  const renderPrivateActions = () => {
    if (!walletAddress) {
      return (
        <>
          <Text style={hintStyle}>{t('channel_private_invite_link')}</Text>
          <Button
            label={t('wallet_connect')}
            onPress={() => navigation.navigate('UserProfile', { address: '' })}
            style={styles.btn}
          />
        </>
      );
    }
    if (isMemberState(inviteState) && !proofRejected) {
      // Known member: on this node just open it; previewed from another host,
      // re-federate (no invite needed for a member) and open.
      return crossNodeHost ? joinButton : (
        <Button label={t('channel_open_channel')} onPress={handleOpen} style={styles.btn} />
      );
    }
    if (canHostAsCreator && !proofRejected) {
      return (
        <Button
          label={joining ? t('loading') : t('channel_invite_creator_host')}
          onPress={handleCreatorHost}
          loading={joining}
          disabled={joining}
          style={styles.btn}
        />
      );
    }
    if (!proofRejected && isJoinableInvite(inviteState)) {
      return (
        <>
          <Text style={hintStyle}>{t('channel_private_invite_link')}</Text>
          {inviteState.kind === 'inviter-unverifiable' && (
            <Text style={[styles.note, { color: colors.textSecondary }]}>{t('channel_invite_inviter_unverifiable')}</Text>
          )}
          {joinButton}
        </>
      );
    }
    // No Join: invite-only, with the reason when the invite says something.
    return (
      <View style={[styles.gate, { backgroundColor: colors.bgTertiary }]}>
        {!proofRejected && inviteState.kind === 'wrong-account' && (
          <Text style={[styles.status, { color: colors.textPrimary }]}>{t('channel_invite_wrong_account')}</Text>
        )}
        {!proofRejected && inviteState.kind === 'expired' && inviteState.candidate && (
          <Text style={[styles.status, { color: colors.textPrimary }]}>
            {t('channel_invite_expired', { date: formatDateTime(inviteState.candidate.decoded.expiresAt) })}
          </Text>
        )}
        <Text style={[styles.stateTitle, { color: colors.textPrimary }]}>{t('channel_invite_required')}</Text>
        <Text style={[styles.gateDesc, { color: colors.textSecondary }]} selectable>
          {t('channel_invite_required_desc', { address: walletAddress })}
        </Text>
        <Button
          variant="secondary"
          label={addressCopied ? t('channel_invite_address_copied') : t('channel_invite_copy_my_address')}
          onPress={handleCopyMyAddress}
          fullWidth
        />
      </View>
    );
  };

  return (
    <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
      <View style={[styles.card, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.name, { color: colors.textPrimary }]}>
          {gated ? '🔒 ' : '# '}{channelName}
        </Text>
        {!!detail?.channel?.description && (
          <Text style={[styles.desc, { color: colors.textSecondary }]}>{detail.channel.description}</Text>
        )}
        <Text style={[styles.meta, { color: colors.textSecondary }]}>
          {memberCount} {t('channel_members')}
        </Text>
        {crossNodeHost && (
          <Text style={hintStyle}>
            {t('channel_on_other_node', { node: hostLabel(crossNodeHost) })}
          </Text>
        )}

        {gated ? renderPrivateActions() : joinButton}
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
  note: { fontSize: fontSize.xs, marginBottom: spacing.sm, textAlign: 'center' },
  hint: {
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
    padding: spacing.sm,
    borderRadius: radius.md,
    textAlign: 'center',
  },
  gate: { width: '100%', padding: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  status: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.sm, textAlign: 'center' },
  stateTitle: { fontSize: fontSize.md, fontWeight: '600', marginBottom: spacing.xs, textAlign: 'center' },
  gateDesc: { fontSize: fontSize.sm, marginBottom: spacing.md, textAlign: 'center' },
  btn: { marginTop: spacing.lg },
  error: { marginTop: spacing.md, fontSize: fontSize.sm, textAlign: 'center' },
});
