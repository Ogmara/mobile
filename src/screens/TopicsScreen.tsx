/**
 * Topics — manage followed news hashtags + user-named subgroups, and browse the
 * network's Hot Topics (globally most-used hashtags over a rolling 24h window).
 *
 * The followed-topics model is synced across devices inside the encrypted
 * settings blob (see `lib/topicGroups.ts` + `lib/settingsSync.ts`). Tapping any
 * topic — a single tag, a group, or the followed-topics union — opens the News
 * Feed filtered to it (route params on `NewsFeed`).
 *
 * Hot Topics come from `GET /api/v1/news/hot-topics` (l2-node 0.124.0+); against
 * an older node the SDK degrades to an empty result and this section stays
 * hidden.
 */

import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { debugLog } from '../lib/debug';
import Button from '../components/Button';
import PromptModal from '../components/PromptModal';
import ConfirmModal from '../components/ConfirmModal';
import { showAlert } from '../components/AlertHost';
import type { NewsStackParamList } from '../navigation/types';
import {
  ensureTopicGroupsLoaded,
  subscribeTopicGroups,
  getTopicGroups,
  topicCaps,
  followTag,
  unfollowTag,
  createGroup,
  renameGroup,
  deleteGroup,
  addTagToGroup,
  removeTagFromGroup,
  type TopicGroup,
} from '../lib/topicGroups';

type NavProp = NativeStackNavigationProp<NewsStackParamList, 'Topics'>;

/** Shape returned by `client.getHotTopics()` (kept local — the SDK's `.d.ts` is
 *  not always resolvable in this repo's typecheck, runtime is unaffected). */
interface HotTopicRow {
  hashtag: string;
  count: number;
}

export default function TopicsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, status } = useConnection();
  const navigation = useNavigation<NavProp>();

  // Re-render on any topic-groups mutation (local or remote sync apply).
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    let alive = true;
    void ensureTopicGroupsLoaded().then(() => {
      if (alive) setHydrated(true);
    });
    const unsub = subscribeTopicGroups(() => bump());
    return () => {
      alive = false;
      unsub();
    };
  }, []);

  const tg = getTopicGroups();
  const caps = topicCaps();

  const [addTag, setAddTag] = useState('');
  const [createPrompt, setCreatePrompt] = useState(false);
  const [renamePrompt, setRenamePrompt] = useState<{ id: string; initial: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<{ id: string } | null>(null);

  const submitAddTag = useCallback(() => {
    const v = addTag.trim();
    if (!v) return;
    followTag(v);
    setAddTag('');
  }, [addTag]);

  const openGroupFeed = useCallback(
    (params: { tag?: string; group?: string; topics?: 'all' }) => {
      // Pass all three keys so React Navigation's param-merge can't leave a
      // stale filter dimension set on the NewsFeed route.
      navigation.navigate('NewsFeed', {
        tag: undefined,
        group: undefined,
        topics: undefined,
        ...params,
      });
    },
    [navigation],
  );

  const groupMenu = useCallback(
    (g: TopicGroup) => {
      showAlert(g.name || t('news_topic_group_new'), undefined, [
        { text: t('news_topic_group_rename'), onPress: () => setRenamePrompt({ id: g.id, initial: g.name }) },
        {
          text: t('news_topic_group_delete'),
          style: 'destructive',
          onPress: () => setConfirmDelete({ id: g.id }),
        },
        { text: t('cancel'), style: 'cancel' },
      ]);
    },
    [t],
  );

  // --- Hot Topics -----------------------------------------------------
  const [hot, setHot] = useState<{ scope: string; topics: HotTopicRow[] } | null>(null);
  const [hotLoading, setHotLoading] = useState(false);

  const loadHot = useCallback(
    async (alive: () => boolean) => {
      if (!client) return;
      setHotLoading(true);
      try {
        const resp = (await client.getHotTopics({ limit: 30 })) as {
          scope: string;
          topics: HotTopicRow[];
        };
        if (alive()) setHot(resp);
      } catch (e) {
        debugLog('warn', `Hot topics load failed: ${e instanceof Error ? e.message : e}`);
        if (alive()) setHot({ scope: 'network', topics: [] });
      } finally {
        if (alive()) setHotLoading(false);
      }
    },
    [client],
  );

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void loadHot(() => live);
      return () => {
        live = false;
      };
    }, [loadHot]),
  );

  const ungroupedFollowed = useMemo(() => tg.follows, [tg]);

  const s = makeStyles(colors);

  if (!hydrated) {
    return (
      <View style={[s.container, s.center]}>
        <ActivityIndicator color={colors.accentPrimary} />
      </View>
    );
  }

  return (
    <ScrollView
      style={s.container}
      contentContainerStyle={{ padding: spacing.md, paddingBottom: spacing.xl }}
    >
      <Text style={s.heading}>{t('news_topics_manage')}</Text>

      {/* Followed Topics union */}
      <TouchableOpacity
        style={s.row}
        activeOpacity={0.7}
        disabled={tg.follows.length === 0}
        onPress={() => openGroupFeed({ topics: 'all' })}
      >
        <Text style={s.rowLabel}>{t('news_topics_followed')}</Text>
        <Text style={s.rowMeta}>{tg.follows.length}</Text>
      </TouchableOpacity>

      {/* Groups */}
      {tg.groups.map((g) => (
        <View key={g.id} style={s.groupBlock}>
          <View style={s.row}>
            <TouchableOpacity
              style={s.rowMain}
              activeOpacity={0.7}
              onPress={() => openGroupFeed({ group: g.id })}
            >
              <Text style={s.rowLabel} numberOfLines={1}>
                {g.name}
              </Text>
              <Text style={s.rowMeta}>{g.tags.length}</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.menuBtn} onPress={() => groupMenu(g)} hitSlop={8}>
              <Text style={s.menuGlyph}>⋯</Text>
            </TouchableOpacity>
          </View>
          {/* Tags in this group */}
          <View style={s.chipWrap}>
            {g.tags.map((tag) => (
              <TouchableOpacity
                key={tag}
                style={s.chip}
                activeOpacity={0.7}
                onPress={() => removeTagFromGroup(g.id, tag)}
              >
                <Text style={s.chipText}>#{tag}</Text>
                <Text style={s.chipX}>  ✕</Text>
              </TouchableOpacity>
            ))}
            {/* Followed tags not yet in this group — tap to add */}
            {ungroupedFollowed
              .filter((tag) => !g.tags.includes(tag))
              .map((tag) => (
                <TouchableOpacity
                  key={`add-${tag}`}
                  style={[s.chip, s.chipGhost]}
                  activeOpacity={0.7}
                  onPress={() => addTagToGroup(g.id, tag)}
                >
                  <Text style={[s.chipText, s.chipGhostText]}>＋ #{tag}</Text>
                </TouchableOpacity>
              ))}
          </View>
        </View>
      ))}

      <View style={s.newGroupRow}>
        <Button
          label={t('news_topic_group_new')}
          variant="secondary"
          size="sm"
          onPress={() => setCreatePrompt(true)}
          disabled={caps.groups.full}
        />
        {caps.groups.full ? <Text style={s.capHint}>{t('news_topics_cap_reached')}</Text> : null}
      </View>

      {/* Manage followed tags */}
      <Text style={s.sectionTitle}>{t('news_topics_followed')}</Text>
      <View style={s.addRow}>
        <TextInput
          style={s.input}
          value={addTag}
          onChangeText={setAddTag}
          placeholder={t('news_topic_add')}
          placeholderTextColor={colors.textSecondary}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={submitAddTag}
          returnKeyType="done"
        />
        <Button
          label={t('news_topic_follow')}
          size="sm"
          onPress={submitAddTag}
          disabled={caps.follows.full || !addTag.trim()}
        />
      </View>
      {caps.follows.full ? <Text style={s.capHint}>{t('news_topics_cap_reached')}</Text> : null}

      {tg.follows.length === 0 ? (
        <Text style={s.emptyText}>{t('news_topics_empty')}</Text>
      ) : (
        <View style={s.chipWrap}>
          {tg.follows.map((tag) => (
            <View key={tag} style={s.chip}>
              <TouchableOpacity activeOpacity={0.7} onPress={() => openGroupFeed({ tag })}>
                <Text style={s.chipText}>#{tag}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => unfollowTag(tag)} hitSlop={8}>
                <Text style={s.chipX}>  ✕</Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      )}

      {/* Hot Topics */}
      {(hotLoading || (hot && hot.topics.length > 0)) && (
        <>
          <View style={s.sep} />
          <Text style={s.sectionTitle}>
            🔥 {t('news_hot_topics_title')}
            {hot?.scope === 'local' ? `  ·  ${t('news_hot_topics_local_hint')}` : ''}
          </Text>
          {hotLoading && !hot ? (
            <ActivityIndicator color={colors.accentPrimary} style={{ marginTop: spacing.sm }} />
          ) : hot && hot.topics.length === 0 ? (
            <Text style={s.emptyText}>{t('news_hot_topics_empty')}</Text>
          ) : (
            hot?.topics.map((ht) => (
              <TouchableOpacity
                key={ht.hashtag}
                style={s.row}
                activeOpacity={0.7}
                onPress={() => openGroupFeed({ tag: ht.hashtag })}
              >
                <Text style={s.rowLabel} numberOfLines={1}>
                  #{ht.hashtag}
                </Text>
                <Text style={s.rowMeta}>{t('news_hot_topics_count', { count: ht.count })}</Text>
              </TouchableOpacity>
            ))
          )}
        </>
      )}

      {status === 'disconnected' && !hot ? (
        <Text style={s.emptyText}>{t('status_disconnected')}</Text>
      ) : null}

      <PromptModal
        visible={createPrompt}
        title={t('news_topic_group_new_prompt')}
        initialValue=""
        maxLength={32}
        onSubmit={(name) => createGroup(name)}
        onClose={() => setCreatePrompt(false)}
      />
      <PromptModal
        visible={!!renamePrompt}
        title={t('news_topic_group_rename')}
        initialValue={renamePrompt?.initial ?? ''}
        maxLength={32}
        onSubmit={(name) => {
          if (renamePrompt) renameGroup(renamePrompt.id, name);
        }}
        onClose={() => setRenamePrompt(null)}
      />
      <ConfirmModal
        visible={!!confirmDelete}
        title={t('news_topic_group_delete')}
        message={t('news_topic_group_delete_confirm')}
        confirmLabel={t('news_topic_group_delete')}
        danger
        onConfirm={() => {
          if (confirmDelete) deleteGroup(confirmDelete.id);
        }}
        onClose={() => setConfirmDelete(null)}
      />
    </ScrollView>
  );
}

function makeStyles(colors: any) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.bgPrimary },
    center: { justifyContent: 'center', alignItems: 'center' },
    heading: {
      fontSize: fontSize.xl,
      fontWeight: '700',
      color: colors.textPrimary,
      marginBottom: spacing.md,
    },
    sectionTitle: {
      fontSize: fontSize.md,
      fontWeight: '700',
      color: colors.textPrimary,
      marginTop: spacing.lg,
      marginBottom: spacing.sm,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      backgroundColor: colors.bgSecondary,
      borderRadius: radius.md,
      marginBottom: spacing.xs,
    },
    rowMain: { flex: 1, flexDirection: 'row', alignItems: 'center' },
    rowLabel: { flex: 1, fontSize: fontSize.md, color: colors.textPrimary },
    rowMeta: { fontSize: fontSize.sm, color: colors.textSecondary, marginLeft: spacing.sm },
    groupBlock: { marginBottom: spacing.sm },
    menuBtn: { paddingHorizontal: spacing.sm },
    menuGlyph: { fontSize: fontSize.lg, color: colors.textSecondary },
    chipWrap: { flexDirection: 'row', flexWrap: 'wrap', marginTop: spacing.xs },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.bgTertiary,
      borderRadius: radius.full,
      paddingVertical: 4,
      paddingHorizontal: spacing.sm,
      marginRight: spacing.xs,
      marginBottom: spacing.xs,
    },
    chipGhost: { backgroundColor: 'transparent', borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
    chipText: { fontSize: fontSize.sm, color: colors.textPrimary },
    chipGhostText: { color: colors.textSecondary },
    chipX: { fontSize: fontSize.sm, color: colors.textSecondary },
    newGroupRow: { flexDirection: 'row', alignItems: 'center', marginTop: spacing.sm },
    capHint: { fontSize: fontSize.xs, color: colors.textSecondary, marginLeft: spacing.sm, marginTop: spacing.xs },
    addRow: { flexDirection: 'row', alignItems: 'center' },
    input: {
      flex: 1,
      backgroundColor: colors.bgSecondary,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      fontSize: fontSize.md,
      color: colors.textPrimary,
      marginRight: spacing.sm,
    },
    emptyText: { fontSize: fontSize.sm, color: colors.textSecondary, marginTop: spacing.sm },
    sep: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: colors.border,
      marginTop: spacing.lg,
    },
  });
}
