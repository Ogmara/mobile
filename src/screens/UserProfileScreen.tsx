/**
 * User Profile — display a user's profile with follow/DM actions.
 *
 * Shows address, avatar initial, and action buttons.
 * Tries to load profile from node, falls back to address-only display
 * when the /users/:address endpoint is not deployed yet.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import { debugLog } from '../lib/debug';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SharedStackParams } from '../navigation/types';

type Props = NativeStackScreenProps<SharedStackParams, 'UserProfile'>;

export default function UserProfileScreen({ route, navigation }: Props) {
  const { address: profileAddress } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, address: myAddress, signer } = useConnection();
  const [copied, setCopied] = useState(false);
  const [following, setFollowing] = useState(false);

  // Try to load profile — gracefully handle 404
  const { data } = useApi(
    async () => {
      if (!client) return null;
      try {
        return await client.getUserProfile(profileAddress);
      } catch {
        return null; // endpoint may not exist yet
      }
    },
    [profileAddress, client],
  );

  const isOwnProfile = myAddress === profileAddress;
  const displayName = data?.user?.display_name || null;
  const bio = data?.user?.bio || null;

  const handleCopyAddress = async () => {
    await Clipboard.setStringAsync(profileAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleFollow = async () => {
    if (!client || !signer) return;
    try {
      await client.follow(profileAddress);
      setFollowing(true);
    } catch (e) {
      debugLog('warn', `Follow failed: ${e instanceof Error ? e.message : e}`);
      Alert.alert('Error', 'Could not follow user');
    }
  };

  const handleDm = () => {
    navigation.navigate('DmConversation' as any, { address: profileAddress, displayName });
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Avatar */}
      <View style={[styles.avatarCircle, { backgroundColor: colors.accentPrimary }]}>
        <Text style={[styles.avatarText, { color: colors.textInverse }]}>
          {(displayName || profileAddress)[0]?.toUpperCase() || '?'}
        </Text>
      </View>

      {/* Display name */}
      <Text style={[styles.displayName, { color: colors.textPrimary }]}>
        {displayName || profileAddress.slice(0, 20) + '...'}
      </Text>

      {/* Address (tappable to copy) */}
      <TouchableOpacity onPress={handleCopyAddress}>
        <Text style={[styles.address, { color: colors.textSecondary }]}>
          {copied ? 'Copied!' : profileAddress}
        </Text>
      </TouchableOpacity>

      {/* Bio */}
      {bio && (
        <Text style={[styles.bio, { color: colors.textPrimary }]}>{bio}</Text>
      )}

      {/* Stats (if available from API) */}
      {data && (
        <View style={styles.statsRow}>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {data.follower_count ?? 0}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
              {t('profile_followers')}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {data.following_count ?? 0}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
              {t('profile_following')}
            </Text>
          </View>
          <View style={styles.stat}>
            <Text style={[styles.statValue, { color: colors.textPrimary }]}>
              {data.post_count ?? 0}
            </Text>
            <Text style={[styles.statLabel, { color: colors.textSecondary }]}>
              {t('profile_posts')}
            </Text>
          </View>
        </View>
      )}

      {/* Action buttons */}
      {!isOwnProfile && signer && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: following ? colors.success : colors.accentPrimary }]}
            onPress={handleFollow}
            disabled={following}
          >
            <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
              {following ? t('profile_following') : t('profile_follow')}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.actionBtn, { backgroundColor: colors.accentSecondary }]}
            onPress={handleDm}
          >
            <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
              {t('profile_send_dm')}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* Own profile indicator */}
      {isOwnProfile && (
        <Text style={[styles.ownLabel, { color: colors.textSecondary }]}>
          This is your profile
        </Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
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
  address: { fontSize: fontSize.xs, textAlign: 'center', marginTop: spacing.xs, paddingHorizontal: spacing.lg },
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
  ownLabel: {
    textAlign: 'center',
    marginTop: spacing.lg,
    fontSize: fontSize.sm,
  },
});
