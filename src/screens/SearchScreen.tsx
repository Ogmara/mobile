/**
 * Search — find news by tags, channels by name, users by address.
 *
 * Searches tag-based news and channels from the L2 node.
 * Typing a klv1 address navigates directly to the user profile.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { decodeNewsPost } from '../lib/payloadDecoder';
import { normalizeEnvelopes } from '../lib/envelopeNormalizer';
import { debugLog } from '../lib/debug';
import type { Envelope, Channel } from '@ogmara/sdk';
import type { SearchStackParamList } from '../navigation/types';

type NavProp = NativeStackNavigationProp<SearchStackParamList, 'SearchHome'>;

type SearchResult =
  | { type: 'post'; data: Envelope }
  | { type: 'channel'; data: Channel };

export default function SearchScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client } = useConnection();
  const navigation = useNavigation<NavProp>();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = useCallback(async () => {
    const q = query.trim().toLowerCase();
    if (!q || !client) return;

    // If it looks like a klv address, go directly to profile
    if (q.startsWith('klv1') && q.length > 20) {
      navigation.navigate('UserProfile', { address: q });
      return;
    }

    setLoading(true);
    setSearched(true);
    const found: SearchResult[] = [];

    try {
      // Search news by tag
      const tag = q.startsWith('#') ? q.slice(1) : q;
      const newsResp = await client.listNews(1, 20, tag);
      const posts = normalizeEnvelopes(newsResp.posts);
      for (const p of posts) {
        found.push({ type: 'post', data: p });
      }
    } catch (e) {
      debugLog('warn', `News tag search failed: ${e}`);
    }

    try {
      // Search channels by name/slug match
      const chResp = await client.listChannels(1, 50);
      for (const ch of chResp.channels) {
        if (
          ch.slug.toLowerCase().includes(q) ||
          (ch.display_name && ch.display_name.toLowerCase().includes(q))
        ) {
          found.push({ type: 'channel', data: ch });
        }
      }
    } catch (e) {
      debugLog('warn', `Channel search failed: ${e}`);
    }

    setResults(found);
    setLoading(false);
  }, [query, client, navigation]);

  const renderResult = ({ item }: { item: SearchResult }) => {
    if (item.type === 'channel') {
      const ch = item.data;
      return (
        <TouchableOpacity
          style={[styles.row, { borderBottomColor: colors.border }]}
          onPress={() => navigation.navigate('ChannelMessages', { channelId: ch.channel_id, channelName: ch.display_name || ch.slug })}
        >
          <View style={[styles.badge, { backgroundColor: colors.accentPrimary }]}>
            <Text style={[styles.badgeText, { color: colors.textInverse }]}>#</Text>
          </View>
          <View style={styles.rowContent}>
            <Text style={[styles.rowTitle, { color: colors.textPrimary }]}>
              {ch.display_name || ch.slug}
            </Text>
            <Text style={[styles.rowSub, { color: colors.textSecondary }]}>Channel</Text>
          </View>
        </TouchableOpacity>
      );
    }

    const post = item.data;
    const decoded = decodeNewsPost(post.payload);
    return (
      <TouchableOpacity
        style={[styles.row, { borderBottomColor: colors.border }]}
        onPress={() => navigation.navigate('NewsDetail', { msgId: post.msg_id, post })}
      >
        <View style={[styles.badge, { backgroundColor: colors.accentSecondary }]}>
          <Text style={[styles.badgeText, { color: colors.textInverse }]}>N</Text>
        </View>
        <View style={styles.rowContent}>
          <Text style={[styles.rowTitle, { color: colors.textPrimary }]} numberOfLines={1}>
            {decoded?.title || 'Post'}
          </Text>
          <Text style={[styles.rowSub, { color: colors.textSecondary }]} numberOfLines={1}>
            {decoded?.content?.slice(0, 60) || post.author.slice(0, 20)}
          </Text>
        </View>
      </TouchableOpacity>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <View style={[styles.searchBar, { backgroundColor: colors.bgTertiary }]}>
        <TextInput
          style={[styles.input, { color: colors.textPrimary }]}
          placeholder="Search by tag, channel, or klv1 address..."
          placeholderTextColor={colors.textSecondary}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={handleSearch}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          maxLength={256}
        />
      </View>

      {loading ? (
        <ActivityIndicator color={colors.accentPrimary} style={{ marginTop: spacing.xl }} />
      ) : searched && results.length === 0 ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No results found
          </Text>
        </View>
      ) : !searched ? (
        <View style={styles.empty}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Search for tags, channels, or enter a klv1 address
          </Text>
        </View>
      ) : (
        <FlatList
          data={results}
          keyExtractor={(item, idx) =>
            item.type === 'channel' ? `ch-${item.data.channel_id}` : `p-${item.data.msg_id}-${idx}`
          }
          renderItem={renderResult}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  searchBar: {
    margin: spacing.md,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
  },
  input: { height: 44, fontSize: fontSize.md },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: spacing.lg },
  emptyText: { fontSize: fontSize.md, textAlign: 'center' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  badge: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    justifyContent: 'center',
    alignItems: 'center',
  },
  badgeText: { fontSize: fontSize.lg, fontWeight: '700' },
  rowContent: { flex: 1, marginLeft: spacing.md },
  rowTitle: { fontSize: fontSize.md, fontWeight: '600' },
  rowSub: { fontSize: fontSize.sm, marginTop: 2 },
});
