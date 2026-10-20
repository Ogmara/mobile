/**
 * Channel Admin — channel settings and moderation.
 *
 * Sections: Info (edit name/desc), Moderators (add/remove),
 * Members (kick/ban), Bans (unban), Pins (unpin).
 * Accessible via settings icon in channel header.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Share,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import { buildPrivateChannelInviteUrl } from '@ogmara/sdk';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { debugLog } from '../lib/debug';
import { removeJoinedChannel } from '../lib/joinedChannels';
import { clearPlacement } from '../lib/channelOrg';
import { clearCachedMessages } from '../lib/messageCache';
import { buildChannelInviteUrl } from '../lib/share';
import {
  isInviteGatedChannel, INVITE_TTL_OPTIONS, DEFAULT_INVITE_TTL_OPTION_MS, inviteTtlFromPicker,
} from '../lib/privateInvite';
import { formatDateTime } from '../lib/datetime';
import SegmentedControl from '../components/SegmentedControl';
import ConfirmModal from '../components/ConfirmModal';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChatStackParamList } from '../navigation/types';
import { showAlert } from '../components/AlertHost';
import Button from '../components/Button';

type Props = NativeStackScreenProps<ChatStackParamList, 'ChannelAdmin'>;

/** Validate Klever bech32 address format */
function isValidAddress(addr: string): boolean {
  return /^klv1[a-z0-9]{58}$/.test(addr);
}

/**
 * The last personal invite created on this screen (Private only), TAGGED with
 * the account and channel it was made for so it never shows for another one.
 */
interface CreatedInvite {
  wallet: string;
  channelId: number;
  address: string;
  link: string;
  expiresAt: number;
}

interface ChannelMember {
  address: string;
  role: string;
}

interface ChannelBan {
  address: string;
  reason?: string;
}

interface PinnedMessage {
  msg_id: string;
}

export default function ChannelAdminScreen({ route, navigation }: Props) {
  const { channelId, channelName } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress, nodeUrl } = useConnection();

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const [members, setMembers] = useState<ChannelMember[]>([]);
  const [bans, setBans] = useState<ChannelBan[]>([]);
  const [pins, setPins] = useState<PinnedMessage[]>([]);

  // Edit info state
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [saving, setSaving] = useState(false);

  // Add moderator state
  const [modAddress, setModAddress] = useState('');

  // Invite state
  const [inviteAddress, setInviteAddress] = useState('');
  // Validity of a Private-channel invite (spec 06 §6.5: 1h / 24h / 7d / 14d, default 7d).
  const [inviteTtlMs, setInviteTtlMs] = useState<number>(DEFAULT_INVITE_TTL_OPTION_MS);
  const [inviting, setInviting] = useState(false);
  const [lastInvite, setLastInvite] = useState<CreatedInvite | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // Themed confirm dialog (replaces native Alert.alert for confirmations)
  const [confirmState, setConfirmState] = useState<{
    title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void;
  } | null>(null);

  const myRole = members.find((m) => m.address === myAddress)?.role ?? 'member';
  const isOwner = detail?.channel?.creator === myAddress;
  const isMod = myRole === 'moderator' || isOwner;
  // Fail-closed: until the record POSITIVELY says Public/ReadPublic, treat the
  // channel as private — so the bare (non-granting) share link never shows for
  // a private channel while its record is loading or failed to load.
  const isPrivate = isInviteGatedChannel(detail?.channel?.channel_type, channelId);
  // Inviting waits for the record: whether a validity + personal link apply
  // depends on the channel type.
  const channelTypeKnown = !!detail?.channel;
  const currentLastInvite = lastInvite && lastInvite.wallet === myAddress && lastInvite.channelId === channelId
    ? lastInvite : null;

  const fetchAll = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    try {
      const [detailResp, membersResp, bansResp, pinsResp] = await Promise.all([
        client.getChannelDetail(channelId).catch(() => null),
        client.getChannelMembers(channelId, { limit: 200 }).catch(() => ({ members: [] })),
        client.getChannelBans(channelId).catch(() => ({ bans: [] })),
        client.getChannelPins(channelId).catch(() => ({ pinned_messages: [] })),
      ]);
      if (detailResp) {
        setDetail(detailResp);
        setEditName(detailResp.channel?.display_name || '');
        setEditDesc(detailResp.channel?.description || '');
      }
      setMembers(membersResp.members || []);
      setBans(bansResp.bans || []);
      setPins(pinsResp.pinned_messages || []);
    } finally {
      setRefreshing(false);
      setLoading(false);
    }
  }, [client, channelId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  // ── Actions ──

  const handleSaveInfo = useCallback(async () => {
    if (!client || !isMod) return;
    setSaving(true);
    try {
      await client.updateChannel({
        channelId,
        displayName: editName.trim() || undefined,
        description: editDesc.trim() || undefined,
      });
      showAlert(t('save'), t('channel_info_saved'));
    } catch (e) {
      showAlert(t('error_generic'), e instanceof Error ? e.message : '');
    } finally {
      setSaving(false);
    }
  }, [client, channelId, editName, editDesc, isMod, t]);

  const handleAddMod = useCallback(async () => {
    if (!client || !modAddress.trim() || !isOwner) return;
    if (!isValidAddress(modAddress.trim())) {
      showAlert(t('error_generic'), 'Invalid Klever address format');
      return;
    }
    try {
      // Same permission set web/desktop grant from their equivalent
      // "add moderator by address" form: moderation powers, but not content
      // deletion or channel-info editing. ModeratorPermissions has no optional
      // fields, so all six must be stated.
      await client.addModerator(channelId, modAddress.trim(), {
        can_mute: true, can_kick: true, can_ban: true,
        can_pin: true, can_edit_info: false, can_delete_msgs: false,
      });
      setModAddress('');
      fetchAll();
    } catch (e) {
      showAlert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [client, channelId, modAddress, isOwner, fetchAll, t]);

  const handleRemoveMod = useCallback(async (address: string) => {
    if (!client || !isOwner) return;
    try {
      await client.removeModerator(channelId, address);
      fetchAll();
    } catch (e) {
      showAlert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [client, channelId, isOwner, fetchAll, t]);

  const handleKick = useCallback((address: string) => {
    if (!client || !isMod) return;
    setConfirmState({
      title: t('channel_kick'),
      message: `${address.slice(0, 16)}...?`,
      confirmLabel: t('channel_kick'),
      danger: true,
      onConfirm: async () => {
        try {
          await client.kickUser(channelId, address);
          fetchAll();
        } catch (e) {
          showAlert(t('error_generic'), e instanceof Error ? e.message : '');
        }
      },
    });
  }, [client, channelId, isMod, fetchAll, t]);

  const handleBan = useCallback((address: string) => {
    if (!client || !isMod) return;
    setConfirmState({
      title: t('channel_ban'),
      message: `${address.slice(0, 16)}...?`,
      confirmLabel: t('channel_ban'),
      danger: true,
      onConfirm: async () => {
        try {
          await client.banUser(channelId, address);
          fetchAll();
        } catch (e) {
          showAlert(t('error_generic'), e instanceof Error ? e.message : '');
        }
      },
    });
  }, [client, channelId, isMod, fetchAll, t]);

  const handleUnban = useCallback(async (address: string) => {
    if (!client || !isMod) return;
    try {
      await client.unbanUser(channelId, address);
      fetchAll();
    } catch (e) {
      showAlert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [client, channelId, isMod, fetchAll, t]);

  const handleUnpin = useCallback(async (msgId: string) => {
    if (!client || !isMod) return;
    try {
      await client.unpinMessage(channelId, msgId);
      fetchAll();
    } catch (e) {
      showAlert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [client, channelId, isMod, fetchAll, t]);

  const handleShareInvite = useCallback(async () => {
    // Public / ReadPublic only: anyone may join, so a plain link is enough. A
    // Private channel has NO bare link (it never granted access) — its only
    // link is the personal one created by inviting an address below.
    if (isPrivate) return;
    const url = buildChannelInviteUrl(channelId);
    if (!url) return;
    try {
      await Share.share({ message: url, url });
    } catch (e) {
      debugLog('warn', `Share invite failed: ${e instanceof Error ? e.message : ''}`);
    }
  }, [channelId, isPrivate]);

  const handleInvite = useCallback(async () => {
    const target = inviteAddress.trim();
    if (!client || !target || !isMod || inviting || !channelTypeKnown || !myAddress) return;
    if (!isValidAddress(target)) {
      showAlert(t('error_generic'), 'Invalid Klever address format');
      return;
    }
    // Snapshot whether this is a private invite BEFORE the await, so the result
    // is interpreted for the channel type the user acted on.
    const privateInvite = isPrivate;
    const me = myAddress;
    setInviting(true);
    setLastInvite(null);
    setLinkCopied(false);
    try {
      // The SDK signs `expires_at = now + ttl`, bundles the moderator grant when
      // the caller isn't the creator, and aborts if the account changes mid-call.
      // Validity applies to Private invites; Public ones keep the SDK default.
      const ttlMs = privateInvite ? inviteTtlFromPicker(inviteTtlMs) : undefined;
      const res = await client.inviteUser(channelId, target, ttlMs !== undefined ? { ttlMs } : undefined);
      setInviteAddress('');
      if (privateInvite) {
        try {
          // This (the inviter's) node is the invitee's federation host hint.
          const link = buildPrivateChannelInviteUrl(channelId, res.inviteEnvelope, nodeUrl);
          setLastInvite({ wallet: me, channelId, address: target, link, expiresAt: res.expiresAt });
        } catch (e) {
          // The invite itself was sent (notification); only the link failed.
          debugLog('warn', `Personal invite link failed: ${e instanceof Error ? e.message : ''}`);
        }
      }
      showAlert(t('channel_invite'), t('channel_invite_sent'));
    } catch (e) {
      showAlert(t('error_generic'), e instanceof Error ? e.message : '');
    } finally {
      setInviting(false);
    }
  }, [client, channelId, inviteAddress, inviteTtlMs, isMod, isPrivate, inviting, channelTypeKnown, myAddress, nodeUrl, t]);

  const handleCopyPersonalLink = useCallback(async () => {
    if (!currentLastInvite) return;
    try {
      await Clipboard.setStringAsync(currentLastInvite.link);
      setLinkCopied(true);
    } catch (e) {
      showAlert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [currentLastInvite, t]);

  const handleLeaveChannel = useCallback(() => {
    if (!client) return;
    setConfirmState({
      title: t('channel_leave'),
      message: t('channel_leave_confirm'),
      confirmLabel: t('channel_leave'),
      danger: true,
      onConfirm: async () => {
        try {
          await client.leaveChannel(channelId);
          await removeJoinedChannel(channelId).catch(() => {});
          clearPlacement(channelId);
          navigation.popToTop();
          // ChannelMessagesScreen for THIS channel is mounted directly
          // underneath (this screen is pushed from it) — `popToTop()`
          // unmounts it, and its own debounced persist effect flushes on
          // unmount. Deferred one tick so that flush lands first; clearing
          // before it would otherwise be immediately undone by the flush
          // re-writing the just-left channel's last-seen snapshot.
          setTimeout(() => { clearCachedMessages('ch', channelId, nodeUrl).catch(() => {}); }, 0);
        } catch (e) {
          showAlert(t('error_generic'), e instanceof Error ? e.message : '');
        }
      },
    });
  }, [client, channelId, navigation, t, nodeUrl]);

  const handleDeleteChannel = useCallback(() => {
    if (!client || !isOwner) return;
    setConfirmState({
      title: t('channel_delete'),
      message: t('channel_delete_confirm'),
      confirmLabel: t('chat_delete'),
      danger: true,
      onConfirm: async () => {
        try {
          await client.deleteChannel(channelId);
          // Drop the now-deleted channel from the local joined set so the
          // channel list reflects the deletion immediately, then return to
          // the list root rather than the (now-gone) channel screen.
          await removeJoinedChannel(channelId).catch(() => {});
          clearPlacement(channelId);
          navigation.popToTop();
          // See handleLeaveChannel above for why this is deferred.
          setTimeout(() => { clearCachedMessages('ch', channelId, nodeUrl).catch(() => {}); }, 0);
        } catch (e) {
          showAlert(t('error_generic'), e instanceof Error ? e.message : '');
        }
      },
    });
  }, [client, channelId, isOwner, navigation, t, nodeUrl]);

  // Show spinner while loading initial data
  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator size="large" color={colors.accentPrimary} />
      </View>
    );
  }

  if (!isMod) {
    return (
      <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>#{channelName}</Text>
        <Text style={{ color: colors.textSecondary, paddingHorizontal: spacing.md, marginBottom: spacing.lg }}>
          {t('channel_admin_no_access')}
        </Text>
        <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
          <TouchableOpacity
            style={[styles.dangerBtn, { borderColor: colors.error }]}
            onPress={handleLeaveChannel}
          >
            <Text style={{ color: colors.error, fontWeight: '600' }}>{t('channel_leave')}</Text>
          </TouchableOpacity>
        </View>
        <ConfirmModal
          visible={!!confirmState}
          title={confirmState?.title ?? ''}
          message={confirmState?.message ?? ''}
          confirmLabel={confirmState?.confirmLabel ?? ''}
          danger={confirmState?.danger}
          onConfirm={() => confirmState?.onConfirm()}
          onClose={() => setConfirmState(null)}
        />
      </View>
    );
  }

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={fetchAll} tintColor={colors.accentPrimary} />}
    >
      <Text style={[styles.heading, { color: colors.textPrimary }]}>#{channelName}</Text>
      {detail?.channel?.encryption_enabled && (
        <Text style={{ color: colors.textSecondary, fontSize: fontSize.xs, paddingHorizontal: spacing.md, marginBottom: spacing.sm }}>
          {detail?.channel?.channel_type === 2
            ? t('e2e_encrypted_badge')
            : t('channel_public_encrypted_detail')}
        </Text>
      )}

      {/* ── Edit Info ── */}
      <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('channel_edit_info')}</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder={t('channel_name_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={editName}
          onChangeText={setEditName}
          maxLength={64}
        />
        <TextInput
          style={[styles.input, styles.textArea, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder={t('channel_desc_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={editDesc}
          onChangeText={setEditDesc}
          multiline
          maxLength={256}
        />
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: saving ? colors.textSecondary : colors.accentPrimary }]}
          onPress={handleSaveInfo}
          disabled={saving}
        >
          <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{t('save')}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Moderators ── */}
      <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('channel_moderators')}</Text>
        {members.filter((m) => m.role === 'moderator').map((mod) => (
          <View key={mod.address} style={styles.memberRow}>
            <Text style={[styles.memberAddr, { color: colors.textPrimary }]}>{mod.address.slice(0, 20)}...</Text>
            {isOwner && (
              <TouchableOpacity onPress={() => handleRemoveMod(mod.address)}>
                <Text style={{ color: colors.error, fontWeight: '600' }}>✕</Text>
              </TouchableOpacity>
            )}
          </View>
        ))}
        {isOwner && (
          <View style={styles.addRow}>
            <TextInput
              style={[styles.addInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder="klv1..."
              placeholderTextColor={colors.textSecondary}
              value={modAddress}
              onChangeText={setModAddress}
              autoCapitalize="none"
            />
            <Button label="+" onPress={handleAddMod} style={styles.addBtn} />
          </View>
        )}
      </View>

      {/* ── Members ── */}
      <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
          {t('channel_members')} ({members.length})
        </Text>
        {members.slice(0, 50).map((member) => (
          <View key={member.address} style={styles.memberRow}>
            <Text style={[styles.memberAddr, { color: colors.textPrimary }]}>
              {member.address.slice(0, 20)}...
              {member.role !== 'member' && ` (${member.role})`}
            </Text>
            {isMod && member.address !== myAddress && member.role === 'member' && (
              <View style={styles.memberActions}>
                <TouchableOpacity onPress={() => handleKick(member.address)}>
                  <Text style={{ color: colors.warning, fontSize: fontSize.xs }}>{t('channel_kick')}</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => handleBan(member.address)}>
                  <Text style={{ color: colors.error, fontSize: fontSize.xs }}>{t('channel_ban')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        ))}
      </View>

      {/* ── Bans ── */}
      {bans.length > 0 && (
        <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
            {t('channel_bans')} ({bans.length})
          </Text>
          {bans.map((ban: any) => (
            <View key={ban.address} style={styles.memberRow}>
              <Text style={[styles.memberAddr, { color: colors.textPrimary }]}>{ban.address.slice(0, 20)}...</Text>
              <TouchableOpacity onPress={() => handleUnban(ban.address)}>
                <Text style={{ color: colors.accentPrimary, fontWeight: '600' }}>{t('channel_unban')}</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* ── Pins ── */}
      {pins.length > 0 && (
        <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
          <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>
            📌 {t('channel_pins')} ({pins.length})
          </Text>
          {pins.map((pin: any) => (
            <View key={pin.msg_id} style={styles.memberRow}>
              <Text style={[styles.memberAddr, { color: colors.textPrimary }]} numberOfLines={1}>
                {pin.msg_id?.slice(0, 16)}...
              </Text>
              <TouchableOpacity onPress={() => handleUnpin(pin.msg_id)}>
                <Text style={{ color: colors.warning, fontWeight: '600' }}>{t('channel_unpin')}</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* ── Invite ──
          Address-based invite (ChannelInvite, protocol spec §3.9): only
          creator/moderators may send one — the node rejects it from a plain
          member (router.rs ChannelInvite arm). For a Private channel it is the
          ONLY way in (protocol §3.9.1): the invitee's join must carry it. */}
      {(!isPrivate || isMod) && (
      <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('channel_invite')}</Text>
        {!isPrivate && (
          <Button
            label={t('channel_share_invite')}
            onPress={handleShareInvite}
            fullWidth
            style={styles.actionBtn}
          />
        )}
        {/* Invite by address. For a PRIVATE channel this is load-bearing: a
            URL alone can't grant access (protocol spec §3.9/§5.5.4), so the
            target address must be explicitly invited before it can send
            ChannelJoin. For a PUBLIC channel anyone can already self-join
            freely, so this grants no access — but ChannelInvite still
            generates a channel_invite notification (l2-node 0.128.0+)
            addressed to the invitee, which is how a service/bot discovers
            "a channel owner wants me here" and joins on its own, with no
            confirmation step on its side. Shown for every channel type for
            that reason. */}
        {isMod && isPrivate && (
          <View style={styles.ttlBlock}>
            <Text style={[styles.ttlLabel, { color: colors.textSecondary }]}>{t('channel_invite_validity')}</Text>
            <SegmentedControl<string>
              segments={INVITE_TTL_OPTIONS.map((o) => ({ value: String(o.ms), label: t(o.key) }))}
              value={String(inviteTtlMs)}
              onChange={(v) => setInviteTtlMs(inviteTtlFromPicker(v))}
            />
          </View>
        )}
        {isMod && (
          <View style={styles.addRow}>
            <TextInput
              style={[styles.addInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder="klv1..."
              placeholderTextColor={colors.textSecondary}
              value={inviteAddress}
              onChangeText={setInviteAddress}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <Button
              label={t('channel_invite')}
              onPress={handleInvite}
              loading={inviting}
              disabled={inviting || !channelTypeKnown || !inviteAddress.trim()}
              style={styles.addBtn}
            />
          </View>
        )}
        {isMod && isPrivate && currentLastInvite && (
          <View style={styles.ttlBlock}>
            <Text style={[styles.ttlLabel, { color: colors.textSecondary }]} numberOfLines={2}>
              {currentLastInvite.address.slice(0, 16)}... · {t('channel_invite_valid_until', { date: formatDateTime(currentLastInvite.expiresAt) })}
            </Text>
            <Button
              variant="secondary"
              label={linkCopied ? t('channel_invite_link_copied') : t('channel_invite_copy_personal_link')}
              onPress={handleCopyPersonalLink}
              fullWidth
            />
          </View>
        )}
      </View>
      )}

      {/* ── Danger Zone ── */}
      {isOwner && (
        <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
          <TouchableOpacity
            style={[styles.dangerBtn, { borderColor: colors.error }]}
            onPress={handleDeleteChannel}
          >
            <Text style={{ color: colors.error, fontWeight: '600' }}>{t('channel_delete')}</Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ height: spacing.xl }} />
      <ConfirmModal
        visible={!!confirmState}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        confirmLabel={confirmState?.confirmLabel ?? ''}
        danger={confirmState?.danger}
        onConfirm={() => confirmState?.onConfirm()}
        onClose={() => setConfirmState(null)}
      />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  heading: { fontSize: fontSize.xl, fontWeight: '700', padding: spacing.md },
  section: {
    marginHorizontal: spacing.md,
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
  },
  sectionTitle: { fontSize: fontSize.md, fontWeight: '700', marginBottom: spacing.sm },
  input: { padding: spacing.md, borderRadius: radius.md, fontSize: fontSize.md, marginBottom: spacing.sm },
  textArea: { minHeight: 60 },
  actionBtn: { marginBottom: spacing.sm },
  memberRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.15)',
  },
  memberAddr: { fontSize: fontSize.sm, flex: 1 },
  memberActions: { flexDirection: 'row', gap: spacing.md },
  addRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
  addInput: { flex: 1, padding: spacing.sm, borderRadius: radius.md, fontSize: fontSize.sm },
  addBtn: { minWidth: 52 },
  ttlBlock: { marginTop: spacing.sm, gap: spacing.xs },
  ttlLabel: { fontSize: fontSize.xs },
  dangerBtn: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
  },
});
