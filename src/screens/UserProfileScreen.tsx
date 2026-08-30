/**
 * User Profile — display user's profile, posts, and follow/DM actions.
 *
 * For own profile: loads from local settings (displayName, bio, avatar).
 * For other users: tries API, falls back to address-only display.
 * Shows the user's news posts filtered from the global feed.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Image,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { useTranslation } from 'react-i18next';
import { useFocusEffect } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import { decodeNewsPost } from '../lib/payloadDecoder';
import { normalizeEnvelopes } from '../lib/envelopeNormalizer';
import { getSetting } from '../lib/settings';
import { debugLog } from '../lib/debug';
import type { Envelope } from '@ogmara/sdk';
import { MSG_TYPE_NAME } from '@ogmara/sdk';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SharedStackParams } from '../navigation/types';
import { showAlert } from '../components/AlertHost';

type Props = NativeStackScreenProps<SharedStackParams, 'UserProfile'>;

export default function UserProfileScreen({ route, navigation }: Props) {
  const { address: profileAddress } = route.params;
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, address: myAddress, displayName: myName, signer } = useConnection();
  const [copied, setCopied] = useState(false);
  const [following, setFollowing] = useState(false);
  const [localBio, setLocalBio] = useState<string | null>(null);
  const [localAvatar, setLocalAvatar] = useState<string | null>(null);
  const [followerCount, setFollowerCount] = useState(0);
  const [followingCount, setFollowingCount] = useState(0);

  const isOwnProfile = myAddress === profileAddress;
  const [apiProfile, setApiProfile] = useState<{ display_name?: string; bio?: string; avatar_cid?: string } | null>(null);

  // Load local profile data for own profile, API data for others
  useFocusEffect(
    useCallback(() => {
      if (isOwnProfile) {
        getSetting('bio').then((b) => setLocalBio(b));
        getSetting('avatarLocalUri').then((u) => setLocalAvatar(u));
      }
      // Fetch API profile for display name / bio / avatar + counts
      if (client) {
        client.getUserProfile(profileAddress).then((resp: any) => {
          // Response is { user: { address, display_name, bio, avatar_cid }, follower_count, following_count }
          const user = resp?.user;
          if (user) setApiProfile(user);
          if (resp?.follower_count !== undefined) setFollowerCount(resp.follower_count);
          if (resp?.following_count !== undefined) setFollowingCount(resp.following_count);
        }).catch(() => {});
      }
    }, [isOwnProfile, client, profileAddress]),
  );

  // Check follow status
  useFocusEffect(
    useCallback(() => {
      if (!client) return;
      // Check if we're following this user
      if (myAddress && !isOwnProfile) {
        client.getFollowing(myAddress, { limit: 200 }).then((resp: any) => {
          const followingList: string[] = resp.following ?? [];
          setFollowing(followingList.includes(profileAddress));
        }).catch(() => {});
      }
    }, [client, profileAddress, myAddress, isOwnProfile]),
  );

  // Fetch user's posts from global feed (filter by author)
  const { data: postsData, onRefresh: refreshPosts } = useApi(
    async () => {
      if (!client) return { posts: [], total: 0 };
      try {
        // Try user-specific endpoint first
        const resp = await client.getUserPosts(profileAddress, { page: 1, limit: 20 });
        // `total` is the real post count (server-computed, independent of
        // the page `limit` above) — NOT posts.length, which is capped at 20.
        return { posts: normalizeEnvelopes(resp.posts), total: resp.total ?? resp.posts.length };
      } catch {
        // Fallback: filter global news feed by author. No real total is
        // available here — this only scans one page of the global feed, so
        // the count is a lower bound, same as the posts list itself.
        try {
          const resp = await client.listNews(1, 100);
          const all = normalizeEnvelopes(resp.posts);
          const userPosts = all.filter((p) => p.author === profileAddress);
          return { posts: userPosts, total: userPosts.length };
        } catch {
          return { posts: [], total: 0 };
        }
      }
    },
    [profileAddress, client],
  );

  useFocusEffect(
    useCallback(() => {
      if (client) refreshPosts();
    }, [client, refreshPosts]),
  );

  const userPosts = postsData?.posts ?? [];
  const userPostsTotal = postsData?.total ?? userPosts.length;
  const displayName = isOwnProfile
    ? (myName || apiProfile?.display_name || null)
    : (apiProfile?.display_name || null);
  const bio = isOwnProfile
    ? (localBio || apiProfile?.bio || null)
    : (apiProfile?.bio || null);
  const avatarUri = isOwnProfile
    ? (localAvatar || (apiProfile?.avatar_cid && client ? client.getMediaUrl(apiProfile.avatar_cid) : null))
    : (apiProfile?.avatar_cid && client ? client.getMediaUrl(apiProfile.avatar_cid) : null);

  const handleCopyAddress = async () => {
    await Clipboard.setStringAsync(profileAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleToggleFollow = async () => {
    if (!client || !signer) return;
    try {
      if (following) {
        await client.unfollow(profileAddress);
        setFollowing(false);
        setFollowerCount((c) => Math.max(0, c - 1));
      } else {
        await client.follow(profileAddress);
        setFollowing(true);
        setFollowerCount((c) => c + 1);
      }
    } catch (e) {
      debugLog('warn', `Follow toggle failed: ${e instanceof Error ? e.message : e}`);
      showAlert(t('error_generic'));
    }
  };

  const handleDm = () => {
    navigation.navigate('DmConversation' as any, { address: profileAddress, displayName });
  };

  const renderHeader = () => (
    <View>
      {/* Avatar */}
      <View style={styles.avatarContainer}>
        {avatarUri ? (
          <Image source={{ uri: avatarUri }} style={styles.avatarImage} />
        ) : (
          <View style={[styles.avatarCircle, { backgroundColor: colors.accentPrimary }]}>
            <Text style={[styles.avatarText, { color: colors.textInverse }]}>
              {(displayName || profileAddress)[0]?.toUpperCase() || '?'}
            </Text>
          </View>
        )}
      </View>

      {/* Name + address */}
      <Text style={[styles.displayName, { color: colors.textPrimary }]}>
        {displayName || profileAddress.slice(0, 20) + '...'}
      </Text>
      <TouchableOpacity onPress={handleCopyAddress}>
        <Text style={[styles.address, { color: colors.textSecondary }]}>
          {copied ? 'Copied!' : profileAddress}
        </Text>
      </TouchableOpacity>

      {bio && <Text style={[styles.bio, { color: colors.textPrimary }]}>{bio}</Text>}

      {/* Stats header — tappable followers/following */}
      <View style={styles.statsRow}>
        <View style={styles.stat}>
          <Text style={[styles.statValue, { color: colors.textPrimary }]}>{userPostsTotal}</Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('profile_posts')}</Text>
        </View>
        <TouchableOpacity
          style={styles.stat}
          onPress={() => navigation.navigate('FollowList' as any, { address: profileAddress, tab: 'followers' })}
        >
          <Text style={[styles.statValue, { color: colors.textPrimary }]}>{followerCount}</Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('profile_followers')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.stat}
          onPress={() => navigation.navigate('FollowList' as any, { address: profileAddress, tab: 'following' })}
        >
          <Text style={[styles.statValue, { color: colors.textPrimary }]}>{followingCount}</Text>
          <Text style={[styles.statLabel, { color: colors.textSecondary }]}>{t('profile_following')}</Text>
        </TouchableOpacity>
      </View>

      {/* Actions */}
      {!isOwnProfile && signer && (
        <View style={styles.actions}>
          <TouchableOpacity
            style={[styles.actionBtn, {
              backgroundColor: following ? colors.bgTertiary : colors.accentPrimary,
              borderWidth: following ? 1 : 0,
              borderColor: colors.border,
            }]}
            onPress={handleToggleFollow}
          >
            <Text style={{ color: following ? colors.textPrimary : colors.textInverse, fontWeight: '600' }}>
              {following ? t('profile_unfollow') : t('profile_follow')}
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

      {isOwnProfile && (
        <TouchableOpacity
          style={[styles.editBtn, { borderColor: colors.border }]}
          onPress={() => navigation.navigate('Settings' as any)}
        >
          <Text style={{ color: colors.accentPrimary, fontWeight: '600' }}>{t('profile_edit')}</Text>
        </TouchableOpacity>
      )}

      {/* Posts section header */}
      <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
        {t('profile_posts')} ({userPostsTotal})
      </Text>
    </View>
  );

  const renderPost = ({ item }: { item: Envelope }) => {
    // `Envelope.msg_type` is typed `number`, but the node's REST responses
    // serialize it as the Rust enum's variant NAME string — see
    // @ogmara/sdk's `isNewsEnvelope`/`MSG_TYPE_NAME` doc comments.
    const msgTypeName =
      typeof item.msg_type === 'number' ? MSG_TYPE_NAME[item.msg_type] : (item.msg_type as unknown as string);
    const isRepost = msgTypeName === 'NewsRepost';
    const decoded = isRepost ? null : decodeNewsPost(item.payload);
    const repostFields = item as unknown as {
      repost_comment?: string;
      original_available?: boolean;
      original_id?: string;
      original_author?: string;
      original_title?: string;
      original_content?: string;
      original_deleted?: boolean;
    };
    return (
      <TouchableOpacity
        style={[styles.postCard, { backgroundColor: colors.bgSecondary }]}
        onPress={() => navigation.navigate('NewsDetail' as any, { msgId: item.msg_id, post: item })}
        activeOpacity={0.7}
      >
        {isRepost ? (
          <>
            {repostFields.repost_comment ? (
              <Text style={[styles.postContent, { color: colors.textPrimary }]} numberOfLines={2}>
                {repostFields.repost_comment}
              </Text>
            ) : null}
            {repostFields.original_available ? (
              <View style={[styles.repostQuote, { borderColor: colors.border }]}>
                <Text style={[styles.repostQuoteAuthor, { color: colors.textSecondary }]}>
                  {repostFields.original_author ? `${repostFields.original_author.slice(0, 16)}...` : ''}
                </Text>
                {repostFields.original_deleted ? (
                  <Text style={{ color: colors.textSecondary, fontStyle: 'italic', fontSize: fontSize.sm }}>
                    {t('message_deleted')}
                  </Text>
                ) : (
                  <>
                    {repostFields.original_title ? (
                      <Text style={[styles.repostQuoteTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                        {repostFields.original_title}
                      </Text>
                    ) : null}
                    <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm }} numberOfLines={2}>
                      {repostFields.original_content}
                    </Text>
                  </>
                )}
              </View>
            ) : (
              <Text style={{ color: colors.textSecondary, fontStyle: 'italic', fontSize: fontSize.sm }}>
                {t('news_original_unavailable')}
              </Text>
            )}
          </>
        ) : (
          <>
            {decoded?.title ? (
              <Text style={[styles.postTitle, { color: colors.textPrimary }]} numberOfLines={1}>
                {decoded.title}
              </Text>
            ) : null}
            <Text style={[styles.postContent, { color: colors.textPrimary }]} numberOfLines={2}>
              {decoded?.content || ''}
            </Text>
          </>
        )}
        <Text style={[styles.postTime, { color: colors.textSecondary }]}>
          {new Date(item.timestamp).toLocaleDateString()}
        </Text>
      </TouchableOpacity>
    );
  };

  return (
    <FlatList
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      data={userPosts}
      keyExtractor={(item) => item.msg_id}
      renderItem={renderPost}
      ListHeaderComponent={renderHeader}
      contentContainerStyle={styles.content}
      ListEmptyComponent={
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          {t('news_no_posts')}
        </Text>
      }
    />
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { paddingBottom: spacing.xl * 2 },
  avatarContainer: { alignItems: 'center', marginTop: spacing.xl },
  avatarCircle: {
    width: 80, height: 80, borderRadius: radius.full,
    justifyContent: 'center', alignItems: 'center',
  },
  avatarImage: { width: 80, height: 80, borderRadius: radius.full },
  avatarText: { fontSize: fontSize.xxl, fontWeight: '700' },
  displayName: { fontSize: fontSize.xl, fontWeight: '700', textAlign: 'center', marginTop: spacing.md },
  address: { fontSize: fontSize.xs, textAlign: 'center', marginTop: spacing.xs, paddingHorizontal: spacing.lg },
  bio: { fontSize: fontSize.md, textAlign: 'center', marginTop: spacing.md, paddingHorizontal: spacing.xl },
  statsRow: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg, gap: spacing.xl },
  stat: { alignItems: 'center' },
  statValue: { fontSize: fontSize.lg, fontWeight: '700' },
  statLabel: { fontSize: fontSize.xs, marginTop: spacing.xs },
  actions: { flexDirection: 'row', justifyContent: 'center', marginTop: spacing.lg, gap: spacing.md, paddingHorizontal: spacing.lg },
  actionBtn: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  editBtn: { alignSelf: 'center', marginTop: spacing.lg, paddingHorizontal: spacing.xl, paddingVertical: spacing.sm, borderRadius: radius.md, borderWidth: 1 },
  sectionTitle: { fontSize: fontSize.sm, fontWeight: '600', textTransform: 'uppercase', marginHorizontal: spacing.md, marginTop: spacing.xl, marginBottom: spacing.sm },
  postCard: { marginHorizontal: spacing.md, marginBottom: spacing.sm, padding: spacing.md, borderRadius: radius.lg },
  postTitle: { fontSize: fontSize.md, fontWeight: '700', marginBottom: spacing.xs },
  postContent: { fontSize: fontSize.sm, lineHeight: 20, marginBottom: spacing.xs },
  postTime: { fontSize: fontSize.xs },
  repostQuote: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: radius.md,
    padding: spacing.sm,
    marginBottom: spacing.xs,
  },
  repostQuoteAuthor: { fontSize: fontSize.xs, marginBottom: 2 },
  repostQuoteTitle: { fontSize: fontSize.md, fontWeight: '600', marginBottom: 2 },
  emptyText: { textAlign: 'center', padding: spacing.xl, fontSize: fontSize.sm },
});
