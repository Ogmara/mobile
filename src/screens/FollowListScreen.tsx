/**
 * Follow List — followers and following tabs with profile resolution
 * and follow/unfollow toggle.
 *
 * Accessible from UserProfileScreen via tapping follower/following counts.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  RefreshControl,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useUserDisplay } from '../hooks/useUserDisplay';
import { debugLog } from '../lib/debug';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

type Props = NativeStackScreenProps<any, 'FollowList'>;

interface FollowEntry {
  address: string;
}

function FollowRow({
  address,
  isFollowing,
  isOwnAddress,
  onToggle,
  onPress,
  colors,
}: {
  address: string;
  isFollowing: boolean;
  isOwnAddress: boolean;
  onToggle?: () => void;
  onPress: () => void;
  colors: any;
}) {
  const { t } = useTranslation();
  const { displayName } = useUserDisplay(address);

  return (
    <TouchableOpacity
      style={[styles.row, { backgroundColor: colors.bgSecondary }]}
      onPress={onPress}
      activeOpacity={0.7}
    >
      <View style={[styles.avatar, { backgroundColor: colors.accentPrimary }]}>
        <Text style={{ color: colors.textInverse, fontSize: 12, fontWeight: '700' }}>
          {(displayName || address).slice(0, 2).toUpperCase()}
        </Text>
      </View>
      <View style={styles.info}>
        <Text style={[styles.name, { color: colors.textPrimary }]} numberOfLines={1}>
          {displayName || `${address.slice(0, 12)}...${address.slice(-4)}`}
        </Text>
        <Text style={[styles.addr, { color: colors.textSecondary }]} numberOfLines={1}>
          {address.slice(0, 16)}...
        </Text>
      </View>
      {!isOwnAddress && onToggle && (
        <TouchableOpacity
          style={[
            styles.followBtn,
            isFollowing
              ? { backgroundColor: colors.bgTertiary, borderWidth: 1, borderColor: colors.border }
              : { backgroundColor: colors.accentPrimary },
          ]}
          onPress={onToggle}
        >
          <Text style={{
            color: isFollowing ? colors.textPrimary : colors.textInverse,
            fontWeight: '600',
            fontSize: fontSize.xs,
          }}>
            {isFollowing ? t('profile_unfollow') : t('profile_follow')}
          </Text>
        </TouchableOpacity>
      )}
    </TouchableOpacity>
  );
}

export default function FollowListScreen({ route, navigation }: Props) {
  const { address: profileAddress, tab: initialTab } = route.params as { address: string; tab: 'followers' | 'following' };
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress } = useConnection();

  const [tab, setTab] = useState<'followers' | 'following'>(initialTab || 'followers');
  const [list, setList] = useState<string[]>([]);
  const [myFollowingSet, setMyFollowingSet] = useState<Set<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);

  const fetchList = useCallback(async () => {
    if (!client) return;
    setRefreshing(true);
    try {
      const resp = tab === 'followers'
        ? await client.getFollowers(profileAddress, { limit: 200 })
        : await client.getFollowing(profileAddress, { limit: 200 });
      setList((resp as any).followers ?? (resp as any).following ?? []);
    } catch (e) {
      debugLog('warn', `Fetch ${tab} failed: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setRefreshing(false);
    }
  }, [client, profileAddress, tab]);

  // Load own following set for toggle buttons
  useEffect(() => {
    if (!client || !myAddress) return;
    client.getFollowing(myAddress, { limit: 200 })
      .then((resp) => setMyFollowingSet(new Set((resp as any).following ?? [])))
      .catch(() => {});
  }, [client, myAddress]);

  useEffect(() => { fetchList(); }, [fetchList]);

  // Use ref to avoid stale closure — prevents double-follow on rapid taps
  const followingRef = useRef(myFollowingSet);
  followingRef.current = myFollowingSet;
  const [toggling, setToggling] = useState<Set<string>>(new Set());

  const handleToggle = useCallback(async (address: string) => {
    if (!client || !signer) return;
    if (toggling.has(address)) return; // debounce
    setToggling((prev) => new Set(prev).add(address));
    try {
      if (followingRef.current.has(address)) {
        await client.unfollow(address);
        setMyFollowingSet((prev) => { const next = new Set(prev); next.delete(address); return next; });
      } else {
        await client.follow(address);
        setMyFollowingSet((prev) => { const next = new Set(prev); next.add(address); return next; });
      }
    } catch (e) {
      debugLog('warn', `Follow toggle failed: ${e instanceof Error ? e.message : ''}`);
    } finally {
      setToggling((prev) => { const next = new Set(prev); next.delete(address); return next; });
    }
  }, [client, signer]);

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Tab switcher */}
      <View style={[styles.tabs, { backgroundColor: colors.bgSecondary }]}>
        <TouchableOpacity
          style={[styles.tab, tab === 'followers' && { backgroundColor: colors.accentPrimary }]}
          onPress={() => setTab('followers')}
        >
          <Text style={{ color: tab === 'followers' ? colors.textInverse : colors.textPrimary, fontWeight: '600' }}>
            {t('profile_followers')}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.tab, tab === 'following' && { backgroundColor: colors.accentPrimary }]}
          onPress={() => setTab('following')}
        >
          <Text style={{ color: tab === 'following' ? colors.textInverse : colors.textPrimary, fontWeight: '600' }}>
            {t('profile_following')}
          </Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={list}
        keyExtractor={(item) => item}
        renderItem={({ item }) => (
          <FollowRow
            address={item}
            isFollowing={myFollowingSet.has(item)}
            isOwnAddress={item === myAddress}
            onToggle={signer ? () => handleToggle(item) : undefined}
            onPress={() => navigation.navigate('UserProfile', { address: item })}
            colors={colors}
          />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={fetchList} tintColor={colors.accentPrimary} />
        }
        contentContainerStyle={list.length === 0 ? styles.emptyContainer : styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={{ color: colors.textSecondary }}>
              {tab === 'followers' ? t('profile_no_followers') : t('profile_no_following')}
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  tabs: {
    flexDirection: 'row',
    padding: spacing.sm,
    gap: spacing.xs,
  },
  tab: {
    flex: 1,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  list: { padding: spacing.md },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 80 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.lg,
    marginBottom: spacing.xs,
    gap: spacing.sm,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  info: { flex: 1, minWidth: 0 },
  name: { fontSize: fontSize.sm, fontWeight: '600' },
  addr: { fontSize: fontSize.xs },
  followBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
  },
});
