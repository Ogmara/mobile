/**
 * ComposerSuggestions — the `@`-mention and `/`-command pickers for the channel
 * composer (frontend spec §6.1.1 and §6.1.2).
 *
 * ONE component serving both triggers, because on mobile they differ only in
 * where the rows come from and what gets inserted. Web and desktop have two
 * separate components; here the shared half — a sheet docked above the
 * composer, a tapped list, insertion, and the `mentions[]` plumbing — is the
 * bulk of the work, so splitting it would only duplicate it.
 *
 * Docked ABOVE the composer rather than floating at the caret: React Native
 * exposes no caret geometry, and a mirror-element hack is not worth it here.
 *
 * Mobile conventions this deliberately follows:
 *   - No `KeyboardAvoidingView` (inert under `edgeToEdgeEnabled`); the screen's
 *     `KeyboardAwareView` already lifts the composer and this sits inside it.
 *   - Rows are plain pressables in the established idiom, not hand-rolled
 *     `styles.xBtn` buttons.
 *   - No `Alert.alert` anywhere.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlatList, Image, Pressable, Text, View } from 'react-native';
import type { ChannelBot, UserSearchHit } from '@ogmara/sdk';
import { useTheme } from '../theme';
import { useTranslation } from 'react-i18next';
import VerifiedBadge from './VerifiedBadge';
import BotBadge from './BotBadge';
import { safeText } from '../lib/sanitize';

/** Rows rendered at once — matches web/desktop so the clients agree. */
const MAX_ROWS = 20;
/** How long a channel's bot list is reused. */
const BOT_CACHE_TTL = 60_000;
/**
 * How long a FAILED bot fetch is remembered. Much shorter than a success: a
 * failure is not the same fact as "this channel has no bots", and caching it as
 * one disables the picker long after connectivity returns.
 */
const BOT_ERROR_TTL = 3_000;
/** Debounce for the user search behind `@`. */
const SEARCH_DEBOUNCE = 150;
/** Channels retained in the bot cache — bounded rather than "bounded in practice". */
const MAX_CACHED_CHANNELS = 32;

const truncateAddress = (a: string) => `${a.slice(0, 7)}…${a.slice(-4)}`;

/** What the caller should do with a selection. */
export interface SuggestionPick {
  /** Full replacement value for the composer. */
  value: string;
  /** Wallet address to add to the envelope's `mentions[]`, if any. */
  mention: string | null;
}

interface SuggestClient {
  searchUsers: (q: string, limit?: number) => Promise<{ users: UserSearchHit[] }>;
  getChannelBots: (channelId: number) => Promise<{ bots: ChannelBot[] }>;
  getMediaUrl: (cid: string) => string;
}

interface Props {
  /** Current composer text. */
  value: string;
  /** Channel the composer belongs to. Commands are channel-scoped. */
  channelId: number;
  /** SDK client, or null before auth is ready. */
  client: SuggestClient | null;
  /** Called when the user taps a row. */
  onPick: (pick: SuggestionPick) => void;
}

interface MentionRow {
  kind: 'mention';
  hit: UserSearchHit;
}
interface CommandRow {
  kind: 'command';
  bot: ChannelBot;
  name: string;
  description: string;
  argsHint: string | null;
  ambiguous: boolean;
}
type Row = MentionRow | CommandRow;

/**
 * Detect a `/`-trigger.
 *
 * Position 0 only, and ANY whitespace closes it until the composer is back to a
 * bare token — NOT merely "the caret is before the first space". The weaker rule
 * let the picker reopen while the composer already held arguments, where
 * selecting a row replaced the whole value and silently discarded them.
 */
function detectCommand(value: string): string | null {
  if (!value.startsWith('/')) return null;
  if (/\s/.test(value)) return null;
  const token = value.slice(1);
  if (token.includes('@')) return null;
  return token;
}

/**
 * Detect an `@`-trigger: the LAST `@` token, which must start the value or
 * follow whitespace — `foo@bar` is an email address, not a mention.
 */
function detectMention(value: string): { prefix: string; start: number } | null {
  const at = value.lastIndexOf('@');
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(value[at - 1])) return null;
  const prefix = value.slice(at + 1);
  if (/\s/.test(prefix)) return null;
  return { prefix, start: at };
}

export default function ComposerSuggestions({ value, channelId, client, onPick }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [hits, setHits] = useState<UserSearchHit[]>([]);
  const [bots, setBots] = useState<ChannelBot[]>([]);
  const botCache = useRef(new Map<number, { bots: ChannelBot[]; ts: number; failed?: boolean }>());
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const command = detectCommand(value);
  const mention = command === null ? detectMention(value) : null;
  const mentionPrefix = mention?.prefix ?? null;

  // --- bot list: fetched per channel and cached, never per keystroke ---
  /**
   * Resolve a channel's bot list, returning it rather than writing state.
   *
   * The caller decides whether the result is still wanted — this screen is
   * reused across channel switches (React Navigation re-parameterizes the route
   * rather than remounting), so a slow response for a channel we left can
   * otherwise land after a newer one and overwrite it. The picker would then
   * offer another channel's commands, and picking one puts a bot address into
   * `mentions[]` for a bot that is not a member here.
   */
  const loadBots = useCallback(
    async (force = false): Promise<ChannelBot[]> => {
      if (!client) return [];
      const cache = botCache.current;
      const cached = cache.get(channelId);
      const ttl = cached?.failed ? BOT_ERROR_TTL : BOT_CACHE_TTL;
      if (!force && cached && Date.now() - cached.ts < ttl) {
        return cached.bots;
      }
      try {
        const resp = await client.getChannelBots(channelId);
        if (cache.size >= MAX_CACHED_CHANNELS && !cache.has(channelId)) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(channelId, { bots: resp.bots ?? [], ts: Date.now() });
        return resp.bots ?? [];
      } catch {
        // Offline, or a node older than 0.127.0 — the picker simply never opens
        // and `/` stays ordinary text, which is the right fallback.
        if (cache.size >= MAX_CACHED_CHANNELS && !cache.has(channelId)) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        cache.set(channelId, { bots: [], ts: Date.now(), failed: true });
        return [];
      }
    },
    [client, channelId],
  );

  // Clear synchronously on channel change so a `/` typed straight after a switch
  // cannot show the previous channel's commands during the fetch window.
  useEffect(() => {
    // Peek the cache SYNCHRONOUSLY. `loadBots` is async, so even a cache hit
    // resolves a microtask after a `setBots([])` would already have committed —
    // flashing the picker empty on every revisit to a channel we already know.
    const cached = botCache.current.get(channelId);
    const fresh =
      cached && Date.now() - cached.ts < (cached.failed ? BOT_ERROR_TTL : BOT_CACHE_TTL);
    // Otherwise clear, so a `/` typed straight after a switch cannot show the
    // PREVIOUS channel's commands during the fetch window.
    setBots(fresh ? cached!.bots : []);
    if (fresh) return;

    // `cancelled` rather than a ref mutated during render — this mirrors the
    // pattern the surrounding screen already uses for its channel-scoped
    // fetches, and keeps side effects out of the render phase. Without it a slow
    // response for a channel we left lands after a newer one and overwrites it.
    let cancelled = false;
    void loadBots().then((list) => {
      if (!cancelled) setBots(list);
    });
    return () => {
      cancelled = true;
    };
  }, [channelId, loadBots]);

  // --- user search behind `@` ---
  useEffect(() => {
    if (mentionPrefix === null || !client) {
      setHits([]);
      return;
    }
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (mentionPrefix.length === 0) {
      setHits([]);
      return;
    }
    searchTimer.current = setTimeout(async () => {
      try {
        const resp = await client.searchUsers(mentionPrefix, MAX_ROWS);
        setHits(resp.users ?? []);
      } catch {
        // Silent — the sheet just stays empty and the user keeps typing.
        setHits([]);
      }
    }, SEARCH_DEBOUNCE);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [mentionPrefix, client]);

  const rows = useMemo((): Row[] => {
    if (command !== null) {
      const q = command.toLowerCase();
      // Case-FOLDED: matching is case-insensitive, so counting raw names would
      // treat `Ping` and `ping` from two bots as distinct commands, flag neither
      // ambiguous, and insert a bare command with no handle and no mention —
      // unguarded against exactly the collision disambiguation exists to prevent.
      const counts = new Map<string, number>();
      for (const b of bots) {
        for (const c of b.commands ?? []) {
          const k = c.name.toLowerCase();
          counts.set(k, (counts.get(k) ?? 0) + 1);
        }
      }
      const flat: CommandRow[] = [];
      for (const b of bots) {
        for (const c of b.commands ?? []) {
          if (q && !c.name.toLowerCase().startsWith(q)) continue;
          flat.push({
            kind: 'command',
            bot: b,
            name: c.name,
            description: c.description,
            argsHint: c.args_hint ?? null,
            ambiguous: (counts.get(c.name.toLowerCase()) ?? 0) > 1,
          });
        }
      }
      const byBot = (a: CommandRow, b: CommandRow) => {
        if (a.bot.verified !== b.bot.verified) return a.bot.verified ? -1 : 1;
        return a.bot.address.localeCompare(b.bot.address);
      };
      flat.sort((a, b) => {
        if (!q) return byBot(a, b) || a.name.localeCompare(b.name);
        const ae = a.name.toLowerCase() === q ? 0 : 1;
        const be = b.name.toLowerCase() === q ? 0 : 1;
        if (ae !== be) return ae - be;
        if (a.name !== b.name) return a.name.localeCompare(b.name);
        return byBot(a, b);
      });
      // Cap AFTER sorting, so an early-sorting address cannot evict legitimate
      // bots from the visible set before ranking happens.
      return flat.slice(0, MAX_ROWS);
    }
    if (mention) {
      return hits.slice(0, MAX_ROWS).map((hit) => ({ kind: 'mention' as const, hit }));
    }
    return [];
  }, [command, mention, bots, hits]);

  const pick = useCallback(
    (row: Row) => {
      if (row.kind === 'command') {
        // `@handle` is a hint for humans; the wallet in `mentions[]` is what
        // actually routes, so a self-declared, non-unique handle cannot
        // misdirect the command.
        const handle = row.ambiguous && row.bot.bot_handle ? `@${row.bot.bot_handle}` : '';
        onPick({
          value: `/${row.name}${handle} `,
          mention: row.ambiguous ? row.bot.address : null,
        });
        return;
      }
      const m = detectMention(value);
      if (!m) return;
      const label = row.hit.display_name?.trim() || row.hit.address.slice(0, 12);
      onPick({ value: `${value.slice(0, m.start)}@${label} `, mention: row.hit.address });
    },
    [onPick, value],
  );

  if (rows.length === 0) return null;

  return (
    <View
      style={{
        maxHeight: 220,
        borderTopWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgSecondary,
      }}
      accessibilityLabel={command !== null ? t('bot_commands_label') : t('mention_popover_label')}
    >
      <FlatList
        data={rows}
        keyboardShouldPersistTaps="always"
        keyExtractor={(row, i) =>
          row.kind === 'command' ? `c:${row.bot.address}:${row.name}` : `m:${row.hit.address}:${i}`
        }
        renderItem={({ item }) => {
          const address = item.kind === 'command' ? item.bot.address : item.hit.address;
          const avatarCid = item.kind === 'command' ? item.bot.avatar_cid : item.hit.avatar_cid;
          const displayName =
            item.kind === 'command' ? item.bot.display_name : item.hit.display_name;
          const verified = item.kind === 'command' ? item.bot.verified : item.hit.verified;
          const isBot = item.kind === 'command' ? true : item.hit.is_bot;
          return (
            <Pressable
              onPress={() => pick(item)}
              style={({ pressed }) => ({
                flexDirection: 'row',
                alignItems: 'center',
                gap: 10,
                paddingHorizontal: 12,
                paddingVertical: 8,
                backgroundColor: pressed ? colors.bgTertiary : 'transparent',
              })}
            >
              {avatarCid && client ? (
                <Image
                  source={{ uri: client.getMediaUrl(avatarCid) }}
                  style={{ width: 32, height: 32, borderRadius: 16 }}
                />
              ) : (
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    backgroundColor: colors.accentPrimary,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Text style={{ color: '#fff', fontWeight: '600' }}>
                    {(displayName || address).slice(0, 1).toUpperCase()}
                  </Text>
                </View>
              )}
              <View style={{ flex: 1, minWidth: 0 }}>
                {item.kind === 'command' ? (
                  <Text numberOfLines={1} style={{ color: colors.textPrimary, fontWeight: '600' }}>
                    /{safeText(item.name)}
                    {item.ambiguous && item.bot.bot_handle ? (
                      <Text style={{ color: colors.accentPrimary }}>
                        @{safeText(item.bot.bot_handle)}
                      </Text>
                    ) : null}
                    {item.argsHint ? (
                      <Text style={{ color: colors.textSecondary, fontWeight: '400' }}>
                        {' '}
                        {safeText(item.argsHint)}
                      </Text>
                    ) : null}
                  </Text>
                ) : (
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text
                      numberOfLines={1}
                      style={{ color: colors.textPrimary, fontWeight: '500' }}
                    >
                      {safeText(displayName) || truncateAddress(address)}
                    </Text>
                    <VerifiedBadge verified={verified} />
                    <BotBadge isBot={isBot} />
                  </View>
                )}
                {item.kind === 'command' ? (
                  <Text numberOfLines={1} style={{ color: colors.textPrimary, fontSize: 13 }}>
                    {safeText(item.description)}
                  </Text>
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {/* The truncated address is ALWAYS visible — the same
                      anti-impersonation rule §6.1.1 imposes, and mandatory for
                      the same reason: display names and handles are
                      self-declared and non-unique. */}
                  <Text style={{ color: colors.textSecondary, fontSize: 11 }}>
                    {truncateAddress(address)}
                  </Text>
                  {item.kind === 'command' ? (
                    <VerifiedBadge verified={verified} size={12} />
                  ) : null}
                </View>
              </View>
            </Pressable>
          );
        }}
      />
    </View>
  );
}
