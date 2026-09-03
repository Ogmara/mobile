/**
 * Chat — channel list with navigation into message views.
 *
 * Fetches channels from the SDK, displays them grouped/ordered per the
 * user's channel organization (groups + custom order, synced cross-device
 * via SettingsSync — see lib/channelOrg.ts). Tapping a channel navigates to
 * ChannelMessagesScreen; long-pressing a row opens a context menu (move to
 * group, reorder, leave, delete).
 */

import React, { useCallback, useState, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  Image,
  SectionList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import { loadJoinedChannels, addJoinedChannel, removeJoinedChannel, isJoinedStorageInitialized } from '../lib/joinedChannels';
import {
  ensureChannelOrgLoaded, ensureCollapsedStateLoaded, getChannelOrg, resolveChannelLayout,
  createGroup, renameGroup, deleteGroup, moveGroup, moveChannel, assignChannel, clearPlacement,
  resetToAlphabetical, isGroupCollapsed, toggleGroupCollapsed, DEFAULT_CHANNEL_SLUG,
  type ChannelOrg,
} from '../lib/channelOrg';
import QuickMenu from '../components/QuickMenu';
import PromptModal from '../components/PromptModal';
import ConfirmModal from '../components/ConfirmModal';
import type { Channel } from '@ogmara/sdk';
import type { ChatStackParamList } from '../navigation/types';
import { showAlert } from '../components/AlertHost';

type NavProp = NativeStackNavigationProp<ChatStackParamList, 'ChannelList'>;

interface MenuItem {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  onPress: () => void;
  danger?: boolean;
}

type Section = { key: string; groupId: string | null; title: string; data: Channel[] };

export default function ChatScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, status, signer, address: myAddress } = useConnection();
  const navigation = useNavigation<NavProp>();

  const { data, refreshing, onRefresh } = useApi(
    async () => {
      if (!client) return { channels: [], total: 0, page: 1 };
      return client.listChannels();
    },
    [client, signer],
  );

  // Refresh when tab gains focus (connection may have established since first render)
  useFocusEffect(
    useCallback(() => {
      if (client) onRefresh();
    }, [client, onRefresh]),
  );

  // --- Joined-channel tracking (AsyncStorage via lib/joinedChannels) ---
  const [joinedIds, setJoinedIds] = useState<Set<number>>(new Set());

  // Load joined IDs and sync with API channel list
  useEffect(() => {
    if (!data?.channels?.length) return;
    (async () => {
      const initialized = await isJoinedStorageInitialized();
      if (initialized) {
        // Already initialized — load stored IDs, auto-add private channels
        const stored = await loadJoinedChannels();
        for (const ch of data.channels) {
          if (ch.channel_type === 2 && !stored.has(ch.channel_id)) {
            await addJoinedChannel(ch.channel_id);
            stored.add(ch.channel_id);
          }
        }
        setJoinedIds(new Set(stored));
      } else {
        // First-time: only seed the default "ogmara" channel.
        // If default channel not found, don't persist so seeding retries next load.
        const defaultCh = data.channels.find((ch: Channel) => ch.slug === DEFAULT_CHANNEL_SLUG);
        if (defaultCh) {
          await addJoinedChannel(defaultCh.channel_id);
          setJoinedIds(new Set([defaultCh.channel_id]));
        }
      }
    })();
  }, [data]);

  // Filter: show only default channel + joined channels
  const channels = useMemo(() => {
    const all = data?.channels ?? [];
    if (!signer) {
      // Not authenticated: only default channel
      return all.filter((ch) => ch.slug === DEFAULT_CHANNEL_SLUG);
    }
    return all.filter((ch) =>
      ch.slug === DEFAULT_CHANNEL_SLUG || joinedIds.has(ch.channel_id),
    );
  }, [data, joinedIds, signer]);

  // Fetch unread counts
  const [unreadMap, setUnreadMap] = useState<Record<number, number>>({});
  useEffect(() => {
    if (!client || !signer) return;
    client.getUnreadCounts().then((resp: any) => {
      const counts: Record<number, number> = {};
      if (resp?.channels) {
        for (const ch of resp.channels) {
          if (ch.unread_count > 0) counts[ch.channel_id] = ch.unread_count;
        }
      }
      setUnreadMap(counts);
    }).catch(() => {});
  }, [client, signer, data]);

  // --- Channel organization (groups + custom order, synced cross-device) ---
  const [org, setOrg] = useState<ChannelOrg>(getChannelOrg());
  const [collapseTick, setCollapseTick] = useState(0);

  useEffect(() => {
    (async () => {
      await ensureChannelOrgLoaded();
      await ensureCollapsedStateLoaded();
      setOrg(getChannelOrg());
      setCollapseTick((v) => v + 1);
    })();
  }, []);

  const refreshOrg = useCallback(() => {
    setOrg(getChannelOrg());
    setCollapseTick((v) => v + 1);
  }, []);

  const layout = useMemo(() => resolveChannelLayout(channels, org), [channels, org]);

  const sections = useMemo<Section[]>(() => {
    const list: Section[] = layout.groups.map((rg) => ({
      key: `g-${rg.group.id}`,
      groupId: rg.group.id,
      title: rg.group.name,
      data: isGroupCollapsed(rg.group.id) ? [] : rg.channels,
    }));
    if (layout.ungrouped.length > 0) {
      list.push({
        key: 'ungrouped',
        groupId: null,
        // No header at all when there are no groups yet — matches the plain,
        // un-customized list every user starts with.
        title: layout.groups.length > 0 ? t('sidebar_ungrouped') : '',
        data: layout.ungrouped,
      });
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- collapseTick forces recompute of collapsed sections
  }, [layout, collapseTick, t]);

  const getBucketOrder = useCallback((channelId: number): number[] => {
    for (const rg of layout.groups) {
      if (rg.channels.some((c) => c.channel_id === channelId)) return rg.channels.map((c) => c.channel_id);
    }
    if (layout.ungrouped.some((c) => c.channel_id === channelId)) return layout.ungrouped.map((c) => c.channel_id);
    return [];
  }, [layout]);

  // --- Themed confirm dialog (replaces native Alert.alert for confirmations) ---
  const [confirmState, setConfirmState] = useState<{
    title: string; message: string; confirmLabel: string; danger?: boolean; onConfirm: () => void;
  } | null>(null);

  // --- Leave / delete ---

  const handleLeaveChannel = useCallback((ch: Channel) => {
    setConfirmState({
      title: t('channel_leave'),
      message: t('channel_leave_confirm'),
      confirmLabel: t('channel_leave'),
      danger: true,
      onConfirm: async () => {
        if (!client) return;
        try {
          await client.leaveChannel(ch.channel_id);
          await removeJoinedChannel(ch.channel_id);
          clearPlacement(ch.channel_id);
          refreshOrg();
          onRefresh();
        } catch (e) {
          showAlert(t('error_generic'), e instanceof Error ? e.message : '');
        }
      },
    });
  }, [client, t, refreshOrg, onRefresh]);

  const handleDeleteChannel = useCallback((ch: Channel) => {
    setConfirmState({
      title: t('channel_delete'),
      message: t('channel_delete_confirm'),
      confirmLabel: t('chat_delete'),
      danger: true,
      onConfirm: async () => {
        if (!client) return;
        try {
          await client.deleteChannel(ch.channel_id);
          await removeJoinedChannel(ch.channel_id);
          clearPlacement(ch.channel_id);
          refreshOrg();
          onRefresh();
        } catch (e) {
          showAlert(t('error_generic'), e instanceof Error ? e.message : '');
        }
      },
    });
  }, [client, t, refreshOrg, onRefresh]);

  // --- Row long-press context menu (main + "move to group" submenu) ---
  const [channelMenuChannel, setChannelMenuChannel] = useState<Channel | null>(null);
  const [channelMenuVisible, setChannelMenuVisible] = useState(false);
  const [channelMenuMode, setChannelMenuMode] = useState<'main' | 'moveToGroup'>('main');

  const openChannelMenu = useCallback((ch: Channel) => {
    setChannelMenuChannel(ch);
    setChannelMenuMode('main');
    setChannelMenuVisible(true);
  }, []);

  const channelMenuItems = useMemo<MenuItem[]>(() => {
    const ch = channelMenuChannel;
    if (!ch) return [];
    if (channelMenuMode === 'moveToGroup') {
      const items: MenuItem[] = [
        { icon: 'apps-outline', label: t('sidebar_ungrouped'), onPress: () => { assignChannel(ch.channel_id, null); refreshOrg(); } },
      ];
      for (const g of org.groups) {
        items.push({ icon: 'folder-outline', label: g.name, onPress: () => { assignChannel(ch.channel_id, g.id); refreshOrg(); } });
      }
      items.push({
        icon: 'add-outline',
        label: t('sidebar_new_group'),
        onPress: () => {
          const id = createGroup(t('sidebar_new_group_default'));
          if (id) {
            assignChannel(ch.channel_id, id);
            refreshOrg();
            setRenamePrompt({ groupId: id, initial: t('sidebar_new_group_default') });
          }
        },
      });
      return items;
    }
    const bucket = getBucketOrder(ch.channel_id);
    const idx = bucket.indexOf(ch.channel_id);
    const items: MenuItem[] = [
      { icon: 'folder-outline', label: t('sidebar_move_to_group'), onPress: () => { setChannelMenuMode('moveToGroup'); setChannelMenuVisible(true); } },
    ];
    if (idx > 0) {
      items.push({ icon: 'arrow-up-outline', label: t('sidebar_move_up'), onPress: () => { moveChannel(ch.channel_id, bucket, 'up'); refreshOrg(); } });
    }
    if (idx >= 0 && idx < bucket.length - 1) {
      items.push({ icon: 'arrow-down-outline', label: t('sidebar_move_down'), onPress: () => { moveChannel(ch.channel_id, bucket, 'down'); refreshOrg(); } });
    }
    items.push({ icon: 'exit-outline', label: t('channel_leave'), danger: true, onPress: () => handleLeaveChannel(ch) });
    if (ch.creator === myAddress) {
      items.push({ icon: 'trash-outline', label: t('channel_delete'), danger: true, onPress: () => handleDeleteChannel(ch) });
    }
    return items;
  }, [channelMenuChannel, channelMenuMode, org, myAddress, getBucketOrder, refreshOrg, handleLeaveChannel, handleDeleteChannel, t]);

  // --- Group "..." menu (rename / move up-down / delete) ---
  const [groupMenuGroup, setGroupMenuGroup] = useState<{ id: string; name: string } | null>(null);
  const [groupMenuVisible, setGroupMenuVisible] = useState(false);
  const [renamePrompt, setRenamePrompt] = useState<{ groupId: string; initial: string } | null>(null);
  const [createGroupPrompt, setCreateGroupPrompt] = useState(false);

  const groupMenuItems = useMemo<MenuItem[]>(() => {
    const g = groupMenuGroup;
    if (!g) return [];
    const idx = org.groups.findIndex((x) => x.id === g.id);
    const items: MenuItem[] = [
      { icon: 'pencil-outline', label: t('sidebar_rename_group'), onPress: () => setRenamePrompt({ groupId: g.id, initial: g.name }) },
    ];
    if (idx > 0) items.push({ icon: 'arrow-up-outline', label: t('sidebar_move_up'), onPress: () => { moveGroup(g.id, 'up'); refreshOrg(); } });
    if (idx >= 0 && idx < org.groups.length - 1) {
      items.push({ icon: 'arrow-down-outline', label: t('sidebar_move_down'), onPress: () => { moveGroup(g.id, 'down'); refreshOrg(); } });
    }
    items.push({
      icon: 'trash-outline',
      label: t('channel_delete'),
      danger: true,
      onPress: () => {
        setConfirmState({
          title: t('sidebar_group_options'),
          message: t('sidebar_delete_group_confirm'),
          confirmLabel: t('chat_delete'),
          danger: true,
          onConfirm: () => { deleteGroup(g.id); refreshOrg(); },
        });
      },
    });
    return items;
  }, [groupMenuGroup, org, refreshOrg, t]);

  const renderChannel = ({ item }: { item: Channel }) => (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.border }]}
      onPress={() =>
        navigation.navigate('ChannelMessages', {
          channelId: item.channel_id,
          channelName: item.display_name || item.slug,
        })
      }
      onLongPress={() => openChannelMenu(item)}
      activeOpacity={0.7}
    >
      {item.logo_cid && client ? (
        <Image
          source={{ uri: client.getMediaUrl(item.logo_cid) }}
          style={styles.badge}
        />
      ) : (
        <View style={[styles.badge, { backgroundColor: colors.accentSecondary }]}>
          <Text style={[styles.badgeText, { color: colors.textInverse }]}>
            {(item.display_name || item.slug || '#').slice(0, 1).toUpperCase()}
          </Text>
        </View>
      )}
      <View style={styles.rowContent}>
        <Text style={[styles.channelName, { color: colors.textPrimary }]}>
          {item.display_name || item.slug}
        </Text>
        {item.description && (
          <Text style={[styles.description, { color: colors.textSecondary }]} numberOfLines={1}>
            {item.description}
          </Text>
        )}
      </View>
      <View style={styles.rowRight}>
        {unreadMap[item.channel_id] > 0 && (
          <View style={[styles.unreadBadge, { backgroundColor: colors.accentPrimary }]}>
            <Text style={{ color: colors.textInverse, fontSize: 10, fontWeight: '700' }}>
              {unreadMap[item.channel_id] > 99 ? '99+' : unreadMap[item.channel_id]}
            </Text>
          </View>
        )}
        {item.member_count !== undefined && (
          <Text style={[styles.memberCount, { color: colors.textSecondary }]}>
            {item.member_count} {t('channel_members').toLowerCase()}
          </Text>
        )}
      </View>
    </TouchableOpacity>
  );

  const renderSectionHeader = ({ section }: { section: Section }) => {
    if (!section.title) return null;
    const collapsed = section.groupId ? isGroupCollapsed(section.groupId) : false;
    return (
      <View style={[styles.sectionHeader, { backgroundColor: colors.bgPrimary, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          style={styles.sectionHeaderLeft}
          onPress={() => { if (section.groupId) { toggleGroupCollapsed(section.groupId); refreshOrg(); } }}
          disabled={!section.groupId}
          activeOpacity={0.7}
        >
          {section.groupId && (
            <Ionicons name={collapsed ? 'chevron-forward' : 'chevron-down'} size={16} color={colors.textSecondary} />
          )}
          <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{section.title}</Text>
        </TouchableOpacity>
        {section.groupId && (
          <TouchableOpacity
            onPress={() => { setGroupMenuGroup({ id: section.groupId!, name: section.title }); setGroupMenuVisible(true); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Ionicons name="ellipsis-horizontal" size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        )}
      </View>
    );
  };

  const defaultChannelHeader = (
    <>
      {layout.defaultChannel && renderChannel({ item: layout.defaultChannel })}
      {org.groups.length > 0 || channels.length > 1 ? (
        <View style={[styles.toolbar, { borderBottomColor: colors.border }]}>
          <TouchableOpacity onPress={() => setCreateGroupPrompt(true)}>
            <Text style={[styles.toolbarBtn, { color: colors.accentPrimary }]}>+ {t('sidebar_new_group')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => { resetToAlphabetical(); refreshOrg(); }}>
            <Text style={[styles.toolbarBtn, { color: colors.accentPrimary }]}>{t('sidebar_sort_az')}</Text>
          </TouchableOpacity>
        </View>
      ) : null}
    </>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <SectionList
        sections={sections}
        keyExtractor={(item) => item.channel_id.toString()}
        renderItem={renderChannel}
        renderSectionHeader={renderSectionHeader}
        ListHeaderComponent={defaultChannelHeader}
        stickySectionHeadersEnabled={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
          />
        }
        contentContainerStyle={channels.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {status === 'disconnected' ? t('status_disconnected') : t('chat_no_channel')}
            </Text>
          </View>
        }
      />

      <QuickMenu
        visible={channelMenuVisible}
        onClose={() => setChannelMenuVisible(false)}
        items={channelMenuItems}
        anchor="bottom"
      />
      <QuickMenu
        visible={groupMenuVisible}
        onClose={() => setGroupMenuVisible(false)}
        items={groupMenuItems}
        anchor="bottom"
      />
      <PromptModal
        visible={!!renamePrompt}
        title={t('sidebar_group_options')}
        initialValue={renamePrompt?.initial ?? ''}
        maxLength={32}
        onSubmit={(name) => { if (renamePrompt) renameGroup(renamePrompt.groupId, name); refreshOrg(); }}
        onClose={() => setRenamePrompt(null)}
      />
      <PromptModal
        visible={createGroupPrompt}
        title={t('sidebar_new_group')}
        initialValue={t('sidebar_new_group_default')}
        maxLength={32}
        onSubmit={(name) => { createGroup(name); refreshOrg(); }}
        onClose={() => setCreateGroupPrompt(false)}
      />
      <ConfirmModal
        visible={!!confirmState}
        title={confirmState?.title ?? ''}
        message={confirmState?.message ?? ''}
        confirmLabel={confirmState?.confirmLabel ?? ''}
        danger={confirmState?.danger}
        onConfirm={() => confirmState?.onConfirm()}
        onClose={() => setConfirmState(null)}
      />
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.accentPrimary }]}
        onPress={() => navigation.navigate('CreateChannel')}
      >
        <Text style={[styles.fabText, { color: colors.textInverse }]}>+</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 120 },
  emptyText: { fontSize: fontSize.md, textAlign: 'center', paddingHorizontal: spacing.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: { fontSize: fontSize.lg, fontWeight: '700' },
  rowContent: { flex: 1, marginLeft: spacing.md },
  channelName: { fontSize: fontSize.md, fontWeight: '600' },
  description: { fontSize: fontSize.sm, marginTop: spacing.xs },
  rowRight: { alignItems: 'flex-end', gap: spacing.xs },
  unreadBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 6,
  },
  memberCount: { fontSize: fontSize.sm },
  // Rendered LAST in the container, not first: `elevation` raises the FAB in
  // Android's DRAW order but not its TOUCH order, so as an earlier sibling it
  // painted above the channel list while the list swallowed every tap.
  fab: { position: 'absolute', right: spacing.lg, bottom: spacing.lg, width: 56, height: 56, borderRadius: radius.full, justifyContent: 'center', alignItems: 'center', elevation: 4, zIndex: 10 },
  fabText: { fontSize: fontSize.xl, fontWeight: '600' },
  toolbar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  toolbarBtn: { fontSize: fontSize.sm, fontWeight: '600' },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sectionHeaderLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs, flex: 1 },
  sectionTitle: { fontSize: fontSize.sm, fontWeight: '700', textTransform: 'uppercase' },
});
