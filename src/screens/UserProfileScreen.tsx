/**
 * User Profile — display a user's profile, posts, and follow actions.
 *
 * Reachable from channel messages, news feed, DMs, and search.
 */

import React from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SharedStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<SharedStackParams, 'UserProfile'>;

export default function UserProfileScreen({ route }: Props) {
  const { address: profileAddress } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, address: myAddress, signer } = useConnection();

  const { data, loading, error } = useApi(
    async () => {
      if (!client) throw new Error('Not connected');
      return client.getUserProfile(profileAddress);
    },
    [profileAddress, client],
  );

  const isOwnProfile = myAddress === profileAddress;

  const handleFollow = async () => {
    if (!client || !signer) return;
    try {
      await client.follow(profileAddress);
    } catch {}
  };

  if (loading) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <ActivityIndicator color={colors.accentPrimary} size="large" />
      </View>
    );
  }

  if (error || !data) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.error }}>{error || t('error_not_found')}</Text>
      </View>
    );
  }

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Avatar placeholder */}
      <View style={[styles.avatarCircle, { backgroundColor: colors.accentSecondary }]}>
        <Text style={[styles.avatarText, { color: colors.textInverse }]}>
          {(data.user.display_name || profileAddress)[0].toUpperCase()}
        </Text>
      </View>

      <Text style={[styles.displayName, { color: colors.textPrimary }]}>
        {data.user.display_name || profileAddress.slice(0, 16) + '...'}
      </Text>

      <Text style={[styles.address, { color: colors.textSecondary }]}>
        {profileAddress}
      </Text>

      {data.user.bio && (
        <Text style={[styles.bio, { color: colors.textPrimary }]}>{data.user.bio}</Text>
      )}

      {/* Stats row */}
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.textPrimary }]}>
            {data.follower_count}
          </Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
            {t('profile_followers')}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.textPrimary }]}>
            {data.following_count}
          </Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
            {t('profile_following')}
          </Text>
        </View>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.textPrimary }]}>
            {data.post_count}
          </Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
            {t('profile_posts')}
          </Text>
        </View>
      </View>

      {/* Action buttons */}
      {!isOwnProfile && signer && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.accentPrimary }]}
            onPress={handleFollow}
          >
            <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
              {t('profile_follow')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.dm }]}
          >
            <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
              {t('profile_send_dm')}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  avatarCircle: {
    width: 80,
    height: 80,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    alignSelf: 'center',
    marginTop: spacing.xl,
  },
  avatarText: { fontSize: fontSize.xxl, fontWeight: '700' },
  displayName: {
    fontSize: fontSize.xl,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: spacing.md,
  },
  address: { fontSize: fontSize.xs, textAlign: 'center', marginTop: spacing.xs },
  bio: { fontSize: fontSize.md, textAlign: 'center', marginTop: spacing.md, paddingHorizontal: spacing.xl },
  statsRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.lg,
    gap: spacing.xl,
  },
  stat: { alignItems: 'center' },
  statValue: { fontSize: fontSize.lg, fontWeight: '700' },
  statLabel: { fontSize: fontSize.xs, marginTop: spacing.xs },
  actions: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.lg,
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  actionBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
});
