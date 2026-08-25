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
  Alert,
  ScrollView,
  RefreshControl,
  ActivityIndicator,
  Share,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { debugLog } from '../lib/debug';
import { removeJoinedChannel } from '../lib/joinedChannels';
import { clearPlacement } from '../lib/channelOrg';
import { buildChannelInviteUrl } from '../lib/share';
import ConfirmModal from '../components/ConfirmModal';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChatStackParamList } from '../navigation/types';

type Props = NativeStackScreenProps<ChatStackParamList, 'ChannelAdmin'>;

/** Validate Klever bech32 address format */
function isValidAddress(addr: string): boolean {
  return /^klv1[a-z0-9]{58}$/.test(addr);
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

  // Themed confirm dialog (replaces native Alert.alert for confirmations)
  const [confirmState, setConfirmState] = useState<{
    title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void;
  } | null>(null);

  const myRole = members.find((m) => m.address === myAddress)?.role ?? 'member';
  const isOwner = detail?.channel?.creator === myAddress;
  const isMod = myRole === 'moderator' || isOwner;

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
      Alert.alert(t('save'), t('channel_info_saved'));
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    } finally {
      setSaving(false);
    }
  }, [client, channelId, editName, editDesc, isMod, t]);

  const handleAddMod = useCallback(async () => {
    if (!client || !modAddress.trim() || !isOwner) return;
    if (!isValidAddress(modAddress.trim())) {
      Alert.alert(t('error_generic'), 'Invalid Klever address format');
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
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [client, channelId, modAddress, isOwner, fetchAll, t]);

  const handleRemoveMod = useCallback(async (address: string) => {
    if (!client || !isOwner) return;
    try {
      await client.removeModerator(channelId, address);
      fetchAll();
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
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
          Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
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
          Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
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
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [client, channelId, isMod, fetchAll, t]);

  const handleUnpin = useCallback(async (msgId: string) => {
    if (!client || !isMod) return;
    try {
      await client.unpinMessage(channelId, msgId);
      fetchAll();
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [client, channelId, isMod, fetchAll, t]);

  const handleShareInvite = useCallback(async () => {
    // Private channels are host-scoped — embed the home node so the recipient can
    // federate from there. Public channels share a plain link (no host hint needed).
    const isPrivate = detail?.channel?.channel_type === 2;
    const url = buildChannelInviteUrl(channelId, isPrivate ? nodeUrl : undefined);
    if (!url) return;
    try {
      await Share.share({ message: url, url });
    } catch (e) {
      debugLog('warn', `Share invite failed: ${e instanceof Error ? e.message : ''}`);
    }
  }, [channelId, detail, nodeUrl]);

  const handleInvite = useCallback(async () => {
    if (!client || !inviteAddress.trim() || !isMod) return;
    if (!isValidAddress(inviteAddress.trim())) {
      Alert.alert(t('error_generic'), 'Invalid Klever address format');
      return;
    }
    try {
      await client.inviteUser(channelId, inviteAddress.trim());
      setInviteAddress('');
      Alert.alert(t('channel_invite'), t('channel_invite_sent'));
    } catch (e) {
      Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
    }
  }, [client, channelId, inviteAddress, isMod, t]);

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
        } catch (e) {
          Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
        }
      },
    });
  }, [client, channelId, navigation, t]);

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
        } catch (e) {
          Alert.alert(t('error_generic'), e instanceof Error ? e.message : '');
        }
      },
    });
  }, [client, channelId, isOwner, navigation, t]);

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
            <TouchableOpacity
              style={[styles.addBtn, { backgroundColor: colors.accentPrimary }]}
              onPress={handleAddMod}
            >
              <Text style={{ color: colors.textInverse, fontWeight: '600' }}>+</Text>
            </TouchableOpacity>
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

      {/* ── Invite ── */}
      <View style={[styles.section, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.sectionTitle, { color: colors.textPrimary }]}>{t('channel_invite')}</Text>
        <TouchableOpacity
          style={[styles.actionBtn, { backgroundColor: colors.accentPrimary, marginBottom: spacing.sm }]}
          onPress={handleShareInvite}
        >
          <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{t('channel_share_invite')}</Text>
        </TouchableOpacity>
        <View style={styles.addRow}>
          <TextInput
            style={[styles.addInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
            placeholder="klv1..."
            placeholderTextColor={colors.textSecondary}
            value={inviteAddress}
            onChangeText={setInviteAddress}
            autoCapitalize="none"
          />
          <TouchableOpacity
            style={[styles.addBtn, { backgroundColor: colors.accentPrimary }]}
            onPress={handleInvite}
          >
            <Text style={{ color: colors.textInverse, fontWeight: '600' }}>{t('channel_invite')}</Text>
          </TouchableOpacity>
        </View>
      </View>

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
  actionBtn: {
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
  },
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
  addBtn: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderRadius: radius.md, justifyContent: 'center' },
  dangerBtn: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
    borderWidth: 1,
  },
});
