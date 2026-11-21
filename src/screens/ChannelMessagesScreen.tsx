/**
 * Channel Messages — message view for a specific channel.
 *
 * Features: real-time updates via WebSocket, message edit/delete/react/reply,
 * date grouping, author grouping, reactions display, optimistic updates.
 * Decodes MessagePack payloads to show human-readable text.
 *
 * History is windowed (spec 06 §6.5, mobile 0.60.0): the newest page, older
 * pages via `before` as the list scrolls up, and — for a permalink / mention
 * push (`msgId` param) — ONE `around` fetch that opens a detached "jump
 * window" centred on the target, paged with `before` / `after` until it meets
 * the live tail. Two layers, never mixed:
 *   - the LIVE layer (`messages` ∪ `cachedMessages`): newest page, older
 *     pages, WS and optimistic rows — contiguous up to the tail, the only
 *     thing ever persisted to the message cache;
 *   - the JUMP WINDOW (`jumpWindow`): a slice of old history, rendered INSTEAD
 *     of the live layer while detached and never persisted. Live messages keep
 *     landing in the live layer meanwhile (held back from view, counted in the
 *     banner), so "Jump to present" just switches back.
 */

import React, { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { readCachedMessages, writeCachedMessages, clearCachedMessages, mergeMessages, isAccessRevokedError } from '../lib/messageCache';
import * as ImagePicker from 'expo-image-picker';
import {
  View,
  Text,
  FlatList,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  AppState,
  Share,
  ActivityIndicator,
  type TextInputInstance,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import KeyboardAwareView from '../components/KeyboardAwareView';
import { useTranslation } from 'react-i18next';
import ComposerSuggestions from '../components/ComposerSuggestions';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import { decodeChatMessage } from '../lib/payloadDecoder';
import { normalizeEnvelopes, normalizeEnvelope } from '../lib/envelopeNormalizer';
import { debugLog } from '../lib/debug';
import MessageBubble, { CHAT_REACTIONS, type ReplyContext } from '../components/MessageBubble';
import TipDialog from '../components/TipDialog';
import EmojiPicker from '../components/EmojiPicker';
import InfoModal from '../components/InfoModal';
import { e2eAvailable } from '../lib/cryptoEnv';
import {
  buildEncryptedChannelMsg,
  decryptChannelMessage,
  coverChannelMembers,
  rotateChannelKey,
  markChannelKeyStale,
  getChannelKeyStatus,
  subscribeChannelKeyStatus,
  type DmDisplay,
  type ChannelKeyStatus,
} from '../lib/channelCrypto';
import { chatErrorKey } from '../lib/chatErrors';
import { statusMessageKey } from '../lib/channelKeyCore';
import { encryptAndUploadFile, base64ToBytes, MAX_ENCRYPTED_MEDIA_BYTES } from '../lib/mediaCrypto';
import {
  resolveIsEncrypted, resolveCoverType, shouldAutoJoinEncryptedChannel, isChanMetaResolvedFor, isChannelRecordUsable, type ChanMetaKey,
} from '../lib/channelEncryption';
import { CHANNEL_TYPE_PRIVATE, canPost, normalizeMsgId, type Envelope, type MediaDescriptor } from '@ogmara/sdk';
import {
  JUMP_PAGE_LIMIT, JUMP_WINDOW_LIMIT, classifyAround, classifyJumpFailure, httpStatusOf, jumpAccountKey,
  mergeWindowPage, moreAfter, moreBefore, capNewest, oldestRealId, newestRealId, type JumpFailure,
} from '../lib/jumpWindow';
import { buildChatShareUrl } from '../lib/share';
import Toast, { useToast } from '../components/Toast';
import NodeSelector from '../components/NodeSelector';
import Button from '../components/Button';
import { isInviteGatedChannel } from '../lib/privateInvite';
import { loadJoinedChannels } from '../lib/joinedChannels';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { ChatStackParamList } from '../navigation/types';
import type { PayloadButtonRow } from '../lib/payloadDecoder';
import { uploadMedia, type UploadClient } from '../lib/mediaUpload';

type Props = NativeStackScreenProps<ChatStackParamList, 'ChannelMessages'>;

/** 30-minute edit window */
const EDIT_WINDOW_MS = 30 * 60 * 1000;
/** Group consecutive messages from the same author within 2 minutes */
const GROUP_WINDOW_MS = 2 * 60 * 1000;
/**
 * Cap on the LIVE layer (newest page + older pages + WS + optimistic rows).
 * Over it the OLDEST rows are shed (`capNewest`) and "older history exists"
 * is re-armed; scrolling up stops loading older pages once it is reached.
 */
const MAX_LIVE_ROWS = 500;
/** Rows per `before` page while scrolling up. */
const OLDER_PAGE_LIMIT = 50;
/** Cap on the detached jump window; over it the edge FARTHEST from the page
 *  just loaded is shed and that direction re-armed (`mergeWindowPage`). */
const MAX_WINDOW_ROWS = 200;
/** How long a permalink target keeps its highlight unless the user scrolls. */
const PERMALINK_HIGHLIGHT_MS = 10_000;
/**
 * Size of the newest page (the `useApi` fetch below) and what
 * `mergeMessages` treats as "a full page". The node hard-clamps
 * `getChannelMessages` at 100 (`l2-node/src/api/routes.rs`), so 100 is the
 * real ceiling a response can reach — asking for more would make
 * `mergeMessages`'s "disconnected island" discard branch
 * (`fresh.length >= requestedLimit`) unreachable. The module's safety
 * invariant (`MAX_ROWS_PER_CONV` <= the smallest real page) holds explicitly.
 * Re-derive this if the node's clamp ever changes.
 */
const CHANNEL_REQUESTED_LIMIT = 100;

/** Convert msg_id to consistent hex string */
function msgIdToHex(msgId: unknown): string {
  if (typeof msgId === 'string') return msgId;
  if (msgId instanceof Uint8Array) {
    return Array.from(msgId).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  if (Array.isArray(msgId)) {
    return (msgId as number[]).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return String(msgId);
}

/** Message timestamp in ms (numbers on the wire; a string is parsed). */
function tsOf(m: { timestamp: unknown }): number {
  const t = m.timestamp;
  if (typeof t === 'number') return t;
  const n = new Date(t as string).getTime();
  return Number.isFinite(n) ? n : 0;
}

/** Hex id of a row, for the window helpers. */
const idOf = (m: { msg_id: unknown }): string => msgIdToHex(m.msg_id);

/**
 * Fold a newest-page response into the live layer WITHOUT losing live rows:
 * rows the page cannot know about — unconfirmed sends and WS rows newer than
 * the page's newest — are kept; everything else is the page.
 */
function mergeNewestPage<T extends { msg_id: unknown; timestamp: unknown; _optimistic?: boolean }>(prev: readonly T[], fresh: T[]): T[] {
  const ids = new Set(fresh.map(idOf));
  let newest = -Infinity;
  for (const m of fresh) newest = Math.max(newest, tsOf(m));
  const keep = prev.filter((m) => !ids.has(idOf(m)) && (m._optimistic || tsOf(m) > newest));
  return keep.length === 0 ? fresh : [...fresh, ...keep];
}

/** Cache key for a decrypted channel message — includes the edit stamp so edits re-decrypt. */
function chanCacheId(m: { msg_id: unknown; last_edited_at?: number }): string {
  return `${msgIdToHex(m.msg_id)}:${m.last_edited_at ?? ''}`;
}

/** Get a date label for message grouping (i18n-aware) */
function getDateLabel(timestamp: string | number, todayLabel: string, yesterdayLabel: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const diff = today.getTime() - msgDay.getTime();
  if (diff === 0) return todayLabel;
  if (diff === 86400000) return yesterdayLabel;
  return date.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
}

type ExtendedEnvelope = Omit<Envelope, 'payload'> & {
  // Real server envelopes carry `payload` as bytes (the SDK's `Envelope`
  // type). A locally-constructed optimistic message (sent-but-unconfirmed,
  // or mid-edit) instead stuffs the plain content string in here directly —
  // `_decodedContent` is what's actually rendered, but some fallback reads
  // go through `.payload` when it's a string (see `typeof m.payload ===
  // 'string'` checks below).
  payload: Envelope['payload'] | string;
  deleted?: boolean;
  edited?: boolean;
  last_edited_at?: number;
  reactions?: Record<string, number>;
  _optimistic?: boolean;
  /** Cached decoded content to avoid re-decoding msgpack on every render */
  _decodedContent?: string;
  _decodedAttachments?: Array<{ cid: string; mime_type: string; filename?: string }>;
  /** P5: optimistic encrypted-media descriptors for a locally-sent message. */
  _decodedEncryptedMedia?: MediaDescriptor[];
  /** Interactive buttons (protocol §3.3), cached alongside the fields above. */
  _decodedButtons?: PayloadButtonRow[];
  /** Whether this message IS a button press — see `payloadDecoder.ts`. */
  _decodedViaButton?: boolean;
};

type ListItem =
  | { type: 'date'; label: string; key: string }
  | { type: 'message'; envelope: ExtendedEnvelope; isGrouped: boolean; key: string };

export default function ChannelMessagesScreen({ route, navigation }: Props) {
  // Ensure channelId is always a number (React Navigation may serialize as string)
  const channelId = Number(route.params.channelId);
  const routeChannelName = route.params.channelName;
  // Permalink / mention-push target. Inbound links were already validated by
  // `parsePermalink` (deepLinkPaths.ts); re-normalised here because params can
  // also come from in-app `navigate` calls.
  const targetMsgId = normalizeMsgId(route.params.msgId);
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress, onWsEvent, nodeUrl, walletAddress } = useConnection();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<ExtendedEnvelope[]>([]);
  // Older history beyond the live layer's oldest row (`has_more_before`,
  // legacy `has_more`), and whether a `before` page is in flight.
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const loadingOlderRef = useRef(false);
  // Set inside a `setMessages` updater when `capNewest` shed old rows; the
  // effect below re-arms `hasMoreOlder` from it (updaters stay pure of setState).
  const liveTrimmedRef = useRef(false);

  // ── Permalink jump state (spec 06 §6.5) ──
  // `loading`: the single `around` fetch is in flight (the live view stays on
  // screen under a "Jumping…" line). `detached`: `jumpWindow` is rendered
  // instead of the live layer. Null in the normal flow.
  const [jump, setJump] = useState<{ channelId: number; target: string; phase: 'loading' | 'detached' } | null>(null);
  const [jumpWindow, setJumpWindow] = useState<ExtendedEnvelope[]>([]);
  const [windowMoreBefore, setWindowMoreBefore] = useState(false);
  const [windowMoreAfter, setWindowMoreAfter] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const loadingNewerRef = useRef(false);
  // Others' live messages that arrived while detached (banner count).
  const [jumpNewCount, setJumpNewCount] = useState(0);
  // Why a jump could not land (plan §9). `node-outdated`: a pre-0.150.0 node
  // ignored `around` and the target is not in its newest page.
  const [jumpNotice, setJumpNotice] = useState<'not-on-node' | 'node-outdated' | Exclude<JumpFailure, 'error'> | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // The landed target stays visible (via_button exemption) after its `msgId`
  // param was cleared; dropped with the rest of the jump state.
  const [pinnedId, setPinnedId] = useState<string | null>(null);
  // Set right before this screen clears its OWN `msgId` param after landing,
  // so the jump effect treats that as "done", not as "link removed".
  const selfClearedTargetRef = useRef(false);
  const [nodePickerOpen, setNodePickerOpen] = useState(false);
  // Once a jump touched this channel, the list keeps its visible rows in place
  // when rows are inserted at the bottom (forward pages, re-attach).
  const [jumpSession, setJumpSession] = useState(false);
  // Bumped on every jump start / reset and on unmount; any `around` / `after`
  // / `before` response for an older token is dropped.
  const jumpTokenRef = useRef(0);
  const detached = !!jump && jump.phase === 'detached' && jump.channelId === channelId;
  const [toast, showToast] = useToast();

  // Latest values for async continuations (read after an await, never stale).
  const jumpRef = useRef(jump);
  jumpRef.current = jump;
  const detachedRef = useRef(detached);
  detachedRef.current = detached;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const jumpWindowRef = useRef(jumpWindow);
  jumpWindowRef.current = jumpWindow;
  const channelIdRef = useRef(channelId);
  channelIdRef.current = channelId;
  const clientRef = useRef(client);
  clientRef.current = client;
  const walletRef = useRef(walletAddress);
  walletRef.current = walletAddress;
  const signerRef = useRef(signer);
  signerRef.current = signer;
  /** Identity a request is made for: wallet, auth, and the live signing key —
   *  `switchAccount` swaps the signer on the SAME client object in place
   *  before the tree remounts, so the signer catches a switch mid-await. */
  const accountKeyNow = useCallback(
    () => `${jumpAccountKey(walletRef.current, !!signerRef.current)}|${clientRef.current?.address ?? ''}`,
    [],
  );
  // Local message-history cache (`lib/messageCache.ts`) — paints a resumed
  // channel instantly from the last-seen snapshot instead of blanking on
  // every (re-)open. Kept as a SEPARATE state from `messages` (which is the
  // live server+optimistic+WS layer) rather than merged directly into it —
  // `allMsgs` below unions the two, with `messages` always winning on an
  // overlapping id, so a WS-delivered edit/delete/reaction is never shadowed
  // by a stale cached copy. Mobile port of web 0.80.0 / desktop 1.80.0.
  const [cachedMessages, setCachedMessages] = useState<ExtendedEnvelope[]>([]);
  const [editingMsg, setEditingMsg] = useState<{ msgId: string; content: string } | null>(null);
  const [replyTo, setReplyTo] = useState<ReplyContext | null>(null);
  const [info, setInfo] = useState<{ title?: string; message: string } | null>(null);
  const showInfo = useCallback((title: string, message: string) => setInfo({ title, message }), []);
  const inputRef = useRef<TextInputInstance>(null);
  // Addresses resolved by the @-mention / -command pickers, merged with any raw
  // `@klv1…` typed by hand when the message is sent. Mobile previously sent an
  // EMPTY mentions[] on every message — so no mobile user could generate a
  // mention notification at all, and the command picker's handle-collision
  // disambiguation (which routes on the address, not the handle) had nothing to
  // route with.
  const [pendingMentions, setPendingMentions] = useState<string[]>([]);
  // Profile cache: address → display name
  const [profileNames, setProfileNames] = useState<Record<string, string>>({});
  const profileFetchedRef = useRef<Set<string>>(new Set());

  // Channel encryption metadata (drives encrypt-on-send). Decryption is shape-driven
  // (decryptChannelMessage handles v1 plaintext vs v2), so rendering doesn't need this.
  const [chanMeta, setChanMeta] = useState<{
    channelType: number; encryptionEnabled: boolean; keyEpochFloor: number; isMod: boolean; creator: string;
  }>({ channelType: 0, encryptionEnabled: false, keyEpochFloor: 0, isMod: false, creator: '' });
  // Which (client, channelId) `chanMeta` was successfully fetched FOR, or null.
  // `chanMetaResolved` is DERIVED from it rather than stored as a bare boolean:
  // the metadata effect below resets the state on a channel / node switch, but
  // that reset only lands on the NEXT render — for the one commit in which
  // `channelId` (or `client`) has already changed, a bare `true` would still
  // describe the PREVIOUS channel, and every effect running in that same commit
  // (notably auto-join) would act on the new channel id with the old channel's
  // type/encryption flags. Channel ids are per-node, hence `client` too; and
  // `isMod` is per-account, hence `address` — a record fetched for a previous
  // account must never count as resolved for the next one.
  const [chanMetaFor, setChanMetaFor] = useState<ChanMetaKey | null>(null);
  // Name from the channel record — the header fallback when the screen was
  // opened from a link or push (no `channelName` param).
  const [channelTitle, setChannelTitle] = useState<string | null>(null);
  // This account is known to be a member (members list / creator / local
  // joined set) — see the Join bar for link-opened channels.
  const [knownMember, setKnownMember] = useState(false);
  const channelName = routeChannelName || channelTitle || String(channelId);
  const chanMetaResolved = isChanMetaResolvedFor(chanMetaFor, { client, channelId, address: myAddress ?? null });
  // B1 (0.58.0): an id in the private namespace (>= 2^32) is private no
  // matter what type a node reports — a hostile node calling a private channel
  // "public" must not get plaintext sends or unverified key cover. Same rule as
  // the join screen (`isInviteGatedChannel`); unknown types also read private.
  const isPrivate = chanMeta.channelType === CHANNEL_TYPE_PRIVATE
    || isInviteGatedChannel(chanMeta.channelType, channelId);
  // FAILS CLOSED (2026-08-02, see channelEncryption.ts) — mirrors the web/
  // desktop fix for the same bug (an image attached to a private channel
  // during this exact window uploaded to IPFS unencrypted).
  const isEncrypted = resolveIsEncrypted(chanMetaResolved, chanMeta.encryptionEnabled, isPrivate);
  const canEstablishKey = isPrivate ? chanMeta.isMod : true; // public: any member may seed
  const encFloor = isPrivate ? chanMeta.keyEpochFloor : 0;    // public never rotates
  // Channel type for key COVER (verify-before-cover, mobile 0.58.0): `null`
  // while the record is unresolved, which makes `coverChannelMembers` a no-op.
  // The placeholder `channelType: 0` reads Public, and covering a private
  // channel on that path would skip the member-proof verification.
  const coverType = resolveCoverType(chanMetaResolved, isPrivate);
  // Whether the current viewer may post in this channel under the runtime
  // posting policy (protocol §3.6). False in `ReadPublic` (broadcast)
  // channels for non-creator/non-mod members. Gates message buttons the same
  // way web/desktop gate the composer — a tap that can't actually post
  // shouldn't be able to trigger an encrypted channel's epoch-key
  // establishment as a side effect. FAILS CLOSED while `chanMetaResolved` is
  // false, matching `isEncrypted`'s own discipline three lines above (the
  // default `channelType: 0` is Public, under which `canPost` already
  // returns `true` on its own once resolved — an unconditional `true`
  // default here bought nothing for the common case and cost the one that
  // matters: a `ReadPublic` channel where buttons would otherwise stay live
  // for the entire metadata round-trip).
  const canPostHere = chanMetaResolved && !!myAddress
    && canPost({ channel_type: chanMeta.channelType, creator: chanMeta.creator }, myAddress, chanMeta.isMod);

  // Async decryption cache (text only). Attachments/reply stay plaintext metadata.
  const [decoded, setDecoded] = useState<Map<string, DmDisplay>>(new Map());
  const decodedRef = useRef(decoded);
  useEffect(() => { decodedRef.current = decoded; }, [decoded]);
  const [decodeTick, setDecodeTick] = useState(0);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => { if (s === 'active') setDecodeTick((x) => x + 1); });
    return () => sub.remove();
  }, []);

  // Tracks which (channelId, nodeUrl) pair is CURRENTLY open, set
  // synchronously at the top of the switch effect below, and whether that
  // pair's access has been revoked since. Both are read by async
  // continuations (the fetcher's catch branch, the cache-seed disk read)
  // that may resolve after the screen has already moved on to a different
  // channel or node — see the switch effect for how they're used.
  const currentConvRef = useRef<{ channelId: number | null; nodeUrl: string }>({ channelId: null, nodeUrl: '' });
  const revokedRef = useRef(false);

  // Tagged with `channelId` AND `nodeUrl` at fetch time — `useApi` retains
  // the PREVIOUS `data` while a new fetch is in flight and has no built-in
  // staleness guard against an out-of-order resolution (two in-flight
  // fetches resolving in the wrong order). The seed/merge effect below only
  // applies a result whose tag matches the CURRENT channel AND node,
  // closing that race without needing a Solid-style `.loading` guard.
  // `nodeUrl` matters here specifically because `ConnectionContext.tsx`'s
  // `maybeOptimizeNode()` can switch nodes automatically (no user action)
  // once per launch — without it, a slower fetch against the OLD node could
  // resolve after the switch and get applied because `channelId` alone
  // still matched, persisting a DIFFERENT node's channel history (channel
  // ids are per-node) under the NEW node's cache key.
  const { data } = useApi(
    async () => {
      if (!client) return { channelId, nodeUrl, messages: [], has_more: false };
      try {
        // Newest page (positional form; the node clamps to 100). Older pages
        // are fetched on scroll (`loadOlder`), a permalink by `around`.
        const resp = await client.getChannelMessages(channelId, CHANNEL_REQUESTED_LIMIT);
        return { channelId, nodeUrl, ...resp, messages: normalizeEnvelopes(resp.messages) };
      } catch (e) {
        // 403/404 means access was actually revoked (removed from a private
        // channel, channel deleted) — as opposed to a generic network blip,
        // which a stale local cache should survive. Clear it too, not just
        // the live view: otherwise the next open paints the same
        // now-inaccessible content from disk again. Re-thrown so `useApi`'s
        // existing error-surfacing behavior (and its "leave `data` alone"
        // semantics on failure) is unchanged.
        //
        // `clearCachedMessages` runs unconditionally — it's keyed on THIS
        // fetch's own captured `channelId`/`nodeUrl`, which really is the
        // conversation that was revoked, regardless of what's on screen
        // now. `setCachedMessages([])` is guarded, though: this catch can
        // run after the screen has already switched to a DIFFERENT channel
        // (or node) — without the guard, a stale revoked-fetch would blank
        // that unrelated, freshly-seeded conversation's cache view.
        if (isAccessRevokedError(e)) {
          clearCachedMessages('ch', channelId, nodeUrl).catch(() => {});
          if (currentConvRef.current.channelId === channelId && currentConvRef.current.nodeUrl === nodeUrl) {
            revokedRef.current = true;
            setCachedMessages([]);
            // `useApi` leaves `data` untouched on a thrown fetcher (that's
            // the whole reason this is re-thrown, to preserve its existing
            // error-surfacing contract) — so without this, `messages` keeps
            // holding the pre-revocation envelopes. `allMsgs` unions
            // `messages` back in regardless of `cachedMessages`, and the
            // persist effect (guarded below by `revokedRef`, but only AFTER
            // this render) would otherwise still see the just-cleared
            // conversation's own pre-revocation content reflected in
            // `allMsgs` on this very commit — clear both together so
            // there's no render in between where they disagree.
            setMessages([]);
          }
        }
        throw e;
      }
    },
    [channelId, client, nodeUrl],
  );

  // Seed `messages` from the fetch AND reconcile the cache against it, once
  // a result tagged for the CURRENT channel AND node arrives. Never
  // refreshed via an `after` cursor — see `messageCache.ts`'s doc comment
  // for why an edit/delete/reaction on an already-cached row can only be
  // revalidated by a full, unconditional fetch like this one.
  useEffect(() => {
    if (data && data.channelId === channelId && data.nodeUrl === nodeUrl && data.messages) {
      const fresh = (data.messages as ExtendedEnvelope[]).slice(0, CHANNEL_REQUESTED_LIMIT);
      // Merged, not replaced: a live message or an unconfirmed send that
      // landed while this page was in flight must not vanish.
      setMessages((prev) => mergeNewestPage(prev, fresh));
      setHasMoreOlder(moreBefore(data));
      setCachedMessages((prev) => mergeMessages(prev, fresh, CHANNEL_REQUESTED_LIMIT) as ExtendedEnvelope[]);
    }
  }, [data, channelId, nodeUrl]);

  // `capNewest` shed the oldest live rows: older history exists again.
  useEffect(() => {
    if (liveTrimmedRef.current) {
      liveTrimmedRef.current = false;
      setHasMoreOlder(true);
    }
  }, [messages]);

  // Mentions belong to the draft for THIS channel, so they are cleared ONLY on a
  // real channel change.
  //
  // This screen instance is reused across channel switches (React Navigation
  // re-parameterizes the existing route rather than remounting), so without this
  // a mention picked in channel A rides along on the next message sent in
  // channel B — notifying, and push-notifying, someone never named in it.
  //
  // Deliberately its OWN effect keyed only on `channelId`, NOT folded into the
  // channel-meta effect below: that one also depends on `client` and
  // `myAddress`, so switching nodes in Settings mints a new client object,
  // re-fires it on the SAME channel, and would wipe a mention the user
  // deliberately picked while `@Alice` still sits in the composer. The send path
  // can only recover raw `@klv1…` text, so that mention would vanish silently —
  // the exact inverse of the leak this clearing exists to prevent.
  useEffect(() => {
    setPendingMentions([]);
    // `useApi` doesn't null its `data` while a new channel's fetch is in
    // flight (see the seed effect above), so without this, `messages` keeps
    // rendering the PREVIOUS channel's envelopes — including their message
    // buttons — until the fetch resolves. Harmless for read-only content,
    // but a button tap on one of those stale rows would sign and send into
    // the NEWLY OPEN channel (`pressButton` correctly reads the current
    // route `channelId`) with a `reply_to` pointing at a message that
    // belongs to the channel just left — an orphaned cross-channel reply.
    setMessages([]);
    setHasMoreOlder(false);
    setJumpSession(false);
    // Seed the cache view too, so the newly-open channel paints instantly
    // from its last-seen snapshot instead of a blank screen while the fetch
    // above is in flight. `cancelled` guards against a slow read for a
    // channel already switched away from applying after the fact;
    // `revokedRef` guards against a DIFFERENT, narrower race — the fetch's
    // 403 handler above clearing this SAME conversation's cache while this
    // very disk read is still in flight, which `cancelled` alone can't
    // catch since the conversation hasn't changed. Both are reset here,
    // synchronously, before the read starts.
    currentConvRef.current = { channelId, nodeUrl };
    revokedRef.current = false;
    setCachedMessages([]);
    let cancelled = false;
    readCachedMessages('ch', channelId, nodeUrl).then((rows) => {
      if (!cancelled && !revokedRef.current) setCachedMessages(rows as ExtendedEnvelope[]);
    });
    return () => { cancelled = true; };
  }, [channelId, nodeUrl]);

  // Mark channel read on enter. Gated on the channel record having resolved for
  // THIS channel: a signed write keyed on a channel id the node can't confirm
  // (unknown / inaccessible channel, failed detail fetch) has no business being
  // sent. Fires once the record lands, not on the raw route param.
  //
  // Not while a permalink jump is loading or detached: the viewer is not at
  // the live end (spec 06 §6.5). Runs once the jump ends — re-attached to the
  // tail, "Jump to present", or a jump that fell back to the newest page.
  const jumpActive = jump !== null;
  useEffect(() => {
    if (client && signer && chanMetaResolved && !jumpActive) {
      client.markChannelRead(channelId).catch(() => {});
    }
  }, [client, signer, channelId, chanMetaResolved, jumpActive]);

  // Load channel encryption metadata + my role (gates encrypt-on-send + key seeding).
  useEffect(() => {
    if (!client) return;
    // New channel (or first mount): we don't yet know its encryption state —
    // isEncrypted's fail-closed guard needs this false until proven otherwise.
    setChanMetaFor(null);
    setChanMeta({ channelType: 0, encryptionEnabled: false, keyEpochFloor: 0, isMod: false, creator: '' });
    setChannelTitle(null);
    setKnownMember(false);
    let cancelled = false;
    (async () => {
      try {
        // `getChannelDetail` deliberately has NO `.catch()` of its own here —
        // its rejection must reach the outer `catch` below, which is what
        // keeps `chanMetaResolved` false (fail closed) on a real failure.
        // `Promise.all` rejects as soon as either promise does, and the
        // member fetch's OWN `.catch()` intentionally stays: a missing role
        // should degrade to "not a moderator", not to "channel unresolved" —
        // `isEncrypted` doesn't depend on membership, but `canPostHere` DOES
        // (via `chanMeta.isMod`, for the `ReadPublic` case), so a member-
        // fetch failure here silently demotes a real moderator's button
        // access rather than blocking it outright. Fails safe either way.
        const [detail, membersResp] = await Promise.all([
          client.getChannelDetail(channelId),
          myAddress
            ? client.getChannelMembers(channelId, { limit: 200 }).catch(() => ({ members: [] }))
            : Promise.resolve({ members: [] }),
        ]);
        if (cancelled) return;
        // A 200 response with no `channel`, a non-number `channel_type`, the
        // node's `restricted` non-member summary, or a record for a different
        // channel is, for this purpose, the same failure as a rejected fetch —
        // fall through to the outer `catch`'s fail-closed behavior rather than
        // defaulting the type to 0 (Public) and marking this resolved (spec 06
        // §6.10 rules 3/5).
        if (!isChannelRecordUsable(detail, channelId)) throw new Error('channel record not usable');
        const ch = (detail as any).channel;
        const role = (membersResp.members as any[]).find((m) => m.address === myAddress)?.role;
        const isMod = role === 'moderator' || ch?.creator === myAddress;
        setChanMeta({
          channelType: ch.channel_type,
          encryptionEnabled: ch?.encryption_enabled === true,
          keyEpochFloor: ch?.key_epoch_floor ?? 0,
          isMod,
          creator: ch?.creator ?? '',
        });
        // Header title for a channel opened from a link (no `channelName`).
        const title = typeof ch?.display_name === 'string' && ch.display_name ? ch.display_name : ch?.slug;
        setChannelTitle(typeof title === 'string' && title ? title : null);
        setChanMetaFor({ client, channelId, address: myAddress ?? null });
        // Positive membership evidence (W2: decides whether a link-opened
        // encrypted channel needs the explicit Join bar). The member list is
        // capped at 200, so the local joined set is consulted too.
        if (role || (myAddress && ch?.creator === myAddress)) {
          setKnownMember(true);
        } else if (myAddress) {
          const joined = await loadJoinedChannels().catch(() => null);
          if (!cancelled && joined?.has(channelId)) setKnownMember(true);
        }
      } catch {
        // FAIL CLOSED: do NOT mark resolved on failure. isEncrypted stays true
        // for the rest of this mount instead of falling back to the
        // plaintext-shaped defaults (was "keep defaults — plaintext path",
        // itself part of the bug this fixes).
      }
    })();
    return () => { cancelled = true; };
  }, [client, channelId, myAddress]);

  // P4: reading/posting in an encrypted PUBLIC channel requires membership (the node
  // only wraps the epoch key to members; anyone may join permissionlessly). Ensure
  // membership once. Private channels use the normal invite/join flow.
  //
  // Requires POSITIVE evidence from the fetched channel record (see
  // `shouldAutoJoinEncryptedChannel`) — NOT the fail-closed `isEncrypted`, which
  // reads `true` while unresolved and, combined with the default
  // `channelType: 0`, used to auto-join EVERY channel (private ones included,
  // which the node accepts and grants real membership + key cover for) during
  // the metadata round-trip or forever after a failed fetch.
  //
  // Tracked per `${nodeUrl}|${myAddress}|${channelId}`: the old single boolean
  // was set by the first channel and never reset, so every later encrypted
  // channel opened on the same screen instance was never joined. An entry is
  // removed on failure so a later open can retry.
  //
  // NEVER from a link (owner decision): a channel opened from an inbound link
  // or push (`fromLink`, set only by the link-resolution path, or a `msgId`
  // target) is not joined silently — the user gets a Join bar instead and
  // joins with an explicit tap (`handleJoinFromLink`).
  const autoJoinedRef = useRef<Set<string>>(new Set());
  const shouldAutoJoin = shouldAutoJoinEncryptedChannel(chanMetaResolved, chanMeta.encryptionEnabled, isPrivate);
  const openedFromLink = route.params.fromLink !== undefined || route.params.msgId !== undefined;
  const [joiningFromLink, setJoiningFromLink] = useState(false);
  const joinedKey = `${nodeUrl}|${myAddress}|${channelId}`;
  const showJoinBar = openedFromLink && shouldAutoJoin && !!signer && !!myAddress
    && !knownMember && !autoJoinedRef.current.has(joinedKey);
  useEffect(() => {
    if (!client || !signer || !myAddress || !shouldAutoJoin || openedFromLink) return;
    const key = `${nodeUrl}|${myAddress}|${channelId}`;
    if (autoJoinedRef.current.has(key)) return;
    autoJoinedRef.current.add(key);
    client.joinChannel(channelId).catch(() => { autoJoinedRef.current.delete(key); });
  }, [client, signer, myAddress, nodeUrl, shouldAutoJoin, channelId, openedFromLink]);

  /** Explicit join for a link-opened encrypted public channel (W2). */
  const handleJoinFromLink = useCallback(async () => {
    if (!client || !signer || !myAddress || joiningFromLink) return;
    const cid = channelId;
    const key = joinedKey;
    const account = accountKeyNow();
    setJoiningFromLink(true);
    try {
      await client.joinChannel(cid);
      // A join that resolved after a channel / account change is not this view's.
      if (channelIdRef.current !== cid || accountKeyNow() !== account) return;
      autoJoinedRef.current.add(key);
      setKnownMember(true);
      // The epoch key is wrapped to members: retry decryption.
      void coverChannelMembers(cid, coverTypeRef.current).catch(() => {});
      setDecodeTick((x) => x + 1);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Join from link failed: ${msg}`);
      const k = chatErrorKey(msg);
      showInfo(t('permalink_join_channel'), k ? t(k) : msg.slice(0, 150));
    } finally {
      setJoiningFromLink(false);
    }
  }, [client, signer, myAddress, joiningFromLink, channelId, joinedKey, accountKeyNow, showInfo, t]);

  // Union of the live layer (`messages` — fetched + optimistic + WS-applied)
  // and the cache layer (`cachedMessages` — already reconciled against the
  // last full fetch by the merge effect above). `messages` wins on any
  // overlapping id, since it may carry a WS edit/delete/reaction newer than
  // that reconciliation. Used everywhere downstream that needs the FULL
  // conversation view (decrypt, reply-resolution, rendering) — `messages`
  // itself stays the "what did the network actually give us this session"
  // layer, still the only thing WS handlers and send/edit/delete mutate.
  const allMsgs = useMemo(() => {
    const seenIds = new Set<string>();
    for (const m of messages) {
      const id = msgIdToHex(m.msg_id);
      if (id) seenIds.add(id);
    }
    const cachedOnly = cachedMessages.filter((m) => {
      const id = msgIdToHex(m.msg_id);
      return id ? !seenIds.has(id) : false;
    });
    return [...messages, ...cachedOnly];
  }, [messages, cachedMessages]);

  // Every row this screen holds: the live layer plus the jump window. Used for
  // decrypt, author names and reply resolution — so a REPLACED window (a new
  // jump, a page from either end) is decrypted like any other row. NEVER
  // persisted: the cache write below reads `allMsgs` (live layer) only.
  const knownMsgs = useMemo(
    () => (jumpWindow.length === 0 ? allMsgs : [...allMsgs, ...jumpWindow]),
    [allMsgs, jumpWindow],
  );

  // Resolve display names for message authors — over `allMsgs`, not just
  // `messages`, so an author only present via a cached row gets resolved
  // too instead of showing a truncated address until a live message from
  // them arrives.
  useEffect(() => {
    if (!client) return;
    const authors = new Set(knownMsgs.map((m) => m.author));
    for (const addr of authors) {
      if (profileFetchedRef.current.has(addr)) continue;
      profileFetchedRef.current.add(addr);
      client.getUserProfile(addr).then((resp: any) => {
        const name = resp?.user?.display_name;
        if (name) {
          setProfileNames((prev) => ({ ...prev, [addr]: name }));
        }
      }).catch(() => {});
    }
  }, [client, knownMsgs]);

  // Persist the merged view to disk, debounced. Each effect invocation is
  // its own closure over THIS render's `channelId`/`nodeUrl`/`allMsgs` — the
  // `setTimeout` callback below only ever reads from that closure, never a
  // live ref re-read later, so a channel switch mid-debounce can't write the
  // OLD channel's content under the NEW channel's cache key (React's own
  // effect-cleanup model gives this schedule-time-capture property for
  // free, unlike Solid's manual `pendingPersist` bookkeeping on web/desktop).
  // `pendingCacheWriteRef` exists ONLY so the separate unmount/channel-
  // change flush effect below can still reach the latest snapshot from its
  // own cleanup — the debounce timer itself never reads through it.
  //
  // `ownerWallet` is captured from `walletAddress` (this screen's own
  // `useConnection()` value, read at the SAME moment as the rest of this
  // pairing) — deliberately NOT `getWalletScope()`, even though that's what
  // `writeCachedMessages` itself checks against. `getWalletScope()` is a
  // plain module-level variable that `switchAccount`/`removeAccount` flip
  // synchronously, AHEAD of the `setWalletAddress` call that actually
  // drives a re-render — so a `getWalletScope()` read from inside this
  // effect's body could observe the NEW wallet on a stale render, paired
  // with `allMsgs` that's still the OLD wallet's messages (this render
  // hasn't been superseded yet; React's own effect flush can lag a plain
  // synchronous global write like `setWalletScope`). `walletAddress`, by
  // contrast, can only change via a commit — any render that sees a
  // particular `allMsgs` is GUARANTEED to see the `walletAddress` that was
  // current for that same commit, so the pairing captured here can never
  // itself already be split across the flip. This exists because mobile's
  // account switch (unlike a plain channel switch) UNMOUNTS this whole
  // screen, and an unmount can itself race the wallet-scope flip — without
  // it, the DEPARTING wallet's messages could be written into the ARRIVING
  // wallet's cache namespace. See `messageCache.ts`'s doc comment for the
  // full reasoning.
  const pendingCacheWriteRef = useRef<{ channelId: number; nodeUrl: string; ownerWallet: string | null; snapshot: ExtendedEnvelope[] } | null>(null);
  useEffect(() => {
    if (!channelId) { pendingCacheWriteRef.current = null; return; }
    // A 403 for the CURRENT channel sets `revokedRef` and clears both
    // `messages`/`cachedMessages` in the same tick (see the fetcher's catch
    // branch above) — but `allMsgs` (and this effect, which depends on it)
    // still re-runs on that same state change. Without this guard, arming a
    // write here would persist whatever the pre-revocation `allMsgs` looked
    // like the LAST time this effect ran before the clear (this effect's
    // own closure is from a PRIOR render, so `allMsgs` here could still be
    // stale-pre-revocation content), re-writing straight back to disk under
    // the very key `clearCachedMessages` just removed. `revokedRef` is only
    // ever reset at the top of the channel-switch effect, so this stays
    // shut for the remainder of this channel's revoked session.
    if (revokedRef.current) { pendingCacheWriteRef.current = null; return; }
    const ownerWallet = walletAddress;
    pendingCacheWriteRef.current = { channelId, nodeUrl, ownerWallet, snapshot: allMsgs };
    const timer = setTimeout(() => {
      writeCachedMessages('ch', channelId, allMsgs, nodeUrl, ownerWallet).catch(() => {});
      pendingCacheWriteRef.current = null;
    }, 1000);
    return () => clearTimeout(timer);
  }, [allMsgs, channelId, nodeUrl, walletAddress]);
  // Flushes whatever the debounce above hasn't written yet — on unmount
  // (screen navigated away, including an account switch) AND on every
  // channelId/nodeUrl change (this effect's cleanup re-runs then too), so
  // at most ~1s of a switched-away-from channel's state is ever lost
  // rather than silently dropped every single time. The pairing check
  // (`pending.channelId === channelId && pending.nodeUrl === nodeUrl`) is
  // redundant with how the ref is currently populated — included so this
  // stays correct even if that changes later, rather than trusting the
  // pairing implicitly.
  useEffect(() => {
    return () => {
      const pending = pendingCacheWriteRef.current;
      if (pending && pending.channelId === channelId && pending.nodeUrl === nodeUrl) {
        writeCachedMessages('ch', pending.channelId, pending.snapshot, pending.nodeUrl, pending.ownerWallet).catch(() => {});
        pendingCacheWriteRef.current = null;
      }
    };
  }, [channelId, nodeUrl]);

  // Decrypt messages asynchronously into `decoded`. decryptChannelMessage is shape-
  // driven (v1 plaintext passes through), so this runs for every channel. Optimistic
  // local messages (raw text payload) short-circuit to plain.
  useEffect(() => {
    let cancelled = false;
    // Apply ONE message's result immediately, independent of every other
    // message's decrypt — never downgrade an already-resolved entry back to
    // 'waiting' (a slower, superseded call finishing after a faster retry).
    const applyResult = (id: string, d: DmDisplay) => {
      setDecoded((prev) => {
        const ex = prev.get(id);
        if (ex && ex.kind !== 'waiting' && d.kind === 'waiting') return prev;
        const next = new Map(prev);
        next.set(id, d);
        return next;
      });
    };
    for (const m of knownMsgs) {
      const id = chanCacheId(m);
      if (m._optimistic) {
        const optText = typeof m.payload === 'string' ? m.payload : '';
        applyResult(id, m._decodedEncryptedMedia
          ? { kind: 'text', text: optText, media: m._decodedEncryptedMedia }
          : { kind: 'plain', text: optText });
        continue;
      }
      const ex = decodedRef.current.get(id);
      if (ex && ex.kind !== 'waiting') continue;
      // Fired concurrently, NOT awaited in sequence — the previous version
      // awaited each message's decrypt one at a time inside this loop and
      // committed every result in a SINGLE `setDecoded` call only after the
      // entire batch finished, so every bubble (cached rows included — the
      // cache holds ciphertext only, so a cache hit still needs this same
      // pass) stayed blank for the full sum of every message's decrypt
      // latency, not the slowest one. On a cold open this fires up to ~100
      // messages' key lookups at once — `channelCrypto.ts`'s `establishing`
      // map does NOT cover this (it only dedupes the SEND-side key-
      // establishment path), so `fetchChannelKey` itself has its own
      // in-flight de-dup keyed by (scope, epoch); without it, this loop
      // would fire up to ~100 identical `getKeyEnvelope` requests at once.
      decryptChannelMessage(m.payload as never, channelId).then((d) => {
        if (!cancelled) applyResult(id, d);
      }).catch(() => {
        if (!cancelled) applyResult(id, { kind: 'error' });
      });
    }
    return () => { cancelled = true; };
  }, [knownMsgs, decodeTick, channelId]);

  // Late channel-key arrival: re-poll while anything is still 'waiting' (bounded; renewed
  // by the `channel_members_changed` WS handler below since a cross-node cold topic-mesh +
  // host-notify-mod + gossip-back round trip observed in testnet bake-in can run well past
  // a naive ~30s cutoff). Deliberately NOT depending on `decoded` — that would recreate the
  // interval (and reset the tick counter) on every decrypt pass, defeating the cap and
  // polling forever. We read the latest state via decodedRef and bound total attempts with
  // a ref.
  const repollTicksRef = useRef(0);
  // Channel key state ("re-keying…" while an epoch settles, ~2 min after a
  // kick; or a problem the user should know about). Module-level in
  // channelCrypto, reset on every account switch.
  const [keyStatus, setKeyStatus] = useState<ChannelKeyStatus>(() => getChannelKeyStatus(channelId));
  useEffect(() => {
    setKeyStatus(getChannelKeyStatus(channelId));
    return subscribeChannelKeyStatus(() => setKeyStatus(getChannelKeyStatus(channelId)));
  }, [channelId]);
  // Read by the interval / WS closures below without re-creating them.
  const coverTypeRef = useRef<boolean | null>(coverType);
  coverTypeRef.current = coverType;
  useEffect(() => {
    if (!isEncrypted) return;
    repollTicksRef.current = 0;
    const iv = setInterval(() => {
      const anyWaiting = [...decodedRef.current.values()].some((d) => d.kind === 'waiting');
      if (!anyWaiting || repollTicksRef.current >= 100) { clearInterval(iv); return; }
      repollTicksRef.current++;
      void coverChannelMembers(channelId, coverTypeRef.current).catch(() => {});
      setDecodeTick((x) => x + 1);
    }, 3000);
    return () => clearInterval(iv);
  }, [isEncrypted, channelId]);

  /**
   * Apply an edit / delete / reaction to the row with `targetId` in BOTH
   * layers — the live layer and the jump window — without ever copying a row
   * from one into the other. Unknown target → no-op.
   */
  const applyToRow = useCallback((targetId: unknown, fn: (m: ExtendedEnvelope) => ExtendedEnvelope) => {
    const hex = msgIdToHex(targetId);
    const hit = (m: ExtendedEnvelope) => msgIdToHex(m.msg_id) === hex;
    setMessages((prev) => (prev.some(hit) ? prev.map((m) => (hit(m) ? fn(m) : m)) : prev));
    setJumpWindow((prev) => (prev.some(hit) ? prev.map((m) => (hit(m) ? fn(m) : m)) : prev));
  }, []);

  // Listen for real-time messages on this channel (including edit/delete)
  useEffect(() => {
    const unsub = onWsEvent((event) => {
      // P2d/P4: membership change → rotate the channel key past the new floor (private)
      // and re-cover remaining members so a removed member can't read new messages.
      if (event.type === 'channel_members_changed' && (event as any).channel_id === channelId) {
        const floor = (event as any).key_epoch_floor ?? 0;
        // F: the next send re-reads the node's latest epoch.
        markChannelKeyStale(channelId);
        // The rotation gate is NOT the node-derived channel type: channelCrypto
        // rotates only channels in the private id range or with a creator pin
        // (a node could otherwise make members rotate a public channel, or
        // keep a private one from rotating by calling it public / leaving the
        // record unresolved). Any other channel just gets a cover pass.
        if (isEncrypted && Number.isSafeInteger(floor) && floor > 0) {
          void rotateChannelKey(channelId, floor).catch(() => {});
        }
        if (isEncrypted) void coverChannelMembers(channelId, coverTypeRef.current).catch(() => {});
        // Renew the late-key-arrival poll's give-up budget: a membership change is
        // exactly the signal that a key cover may be in flight for a waiting message.
        repollTicksRef.current = 0;
        return;
      }
      // Channel deletion + kick/ban removal are now handled app-wide in App.tsx
      // (works regardless of which screen is open, not just this one).
      if (event.type === 'message' && event.envelope) {
        const env = normalizeEnvelope(event.envelope) as ExtendedEnvelope;
        const decoded = decodeChatMessage(env.payload);

        // Check if this message belongs to this channel
        const msgChannelId = decoded?.channel_id ?? (env as any).channel_id;
        if (msgChannelId !== channelId && String(msgChannelId) !== String(channelId)) return;

        // Handle edit/delete events by updating existing messages
        const msgType = (env as any).msg_type;
        if (msgType === 'ChatEdit' || msgType === 2) {
          const targetId = (env as any).target_msg_id || env.msg_id;
          if (targetId) {
            applyToRow(targetId, (m) => {
              // Clear every cached decode, not just content: protocol §3.7 /
              // frontend spec §6.1.3 rely on a bot being able to edit
              // `buttons` in place (a sub-menu swap) — without resetting
              // `_decodedButtons` too, the stale pre-edit row would stay
              // rendered and tappable forever, silently sending whatever
              // command the bot had already retired. `_decodedContent`
              // survives this in practice today only because the async
              // decrypt cache (keyed by `last_edited_at`) takes priority
              // over it in `renderItem` — buttons have no such fallback.
              return {
                ...m, payload: env.payload, edited: true, last_edited_at: env.timestamp as number,
                _decodedContent: undefined, _decodedAttachments: undefined,
                _decodedButtons: undefined, _decodedViaButton: undefined,
              };
            });
          }
          return;
        }
        if (msgType === 'ChatDelete' || msgType === 3) {
          const targetId = (env as any).target_msg_id || env.msg_id;
          if (targetId) applyToRow(targetId, (m) => ({ ...m, deleted: true }));
          return;
        }
        // Handle reaction events
        if (msgType === 'ChatReaction' || msgType === 4) {
          const targetId = (env as any).target_msg_id || env.msg_id;
          const reactionDecoded = decodeChatMessage(env.payload);
          const emoji = (reactionDecoded as any)?.emoji || (env as any).emoji;
          if (targetId && emoji) {
            applyToRow(targetId, (m) => {
              const reactions = { ...(m.reactions || {}) };
              reactions[emoji] = (reactions[emoji] || 0) + 1;
              return { ...m, reactions };
            });
          }
          return;
        }

        // New message — deduplicate and add to the LIVE layer. While a jump
        // window is shown this is the held-back buffer: not rendered, no
        // auto-scroll, no read marker; the banner counts others' messages.
        const envId = msgIdToHex(env.msg_id);
        const isNew = !messagesRef.current.some((m) => msgIdToHex(m.msg_id) === envId);
        setMessages((prev) => {
          if (prev.some((m) => msgIdToHex(m.msg_id) === envId)) return prev;
          // Remove optimistic messages from same author with similar timestamp
          const filtered = prev.filter((m) => {
            if (!m._optimistic) return true;
            return !(m.author === env.author &&
              Math.abs(new Date(m.timestamp).getTime() - new Date(env.timestamp).getTime()) < 10000);
          });
          const capped = capNewest([env, ...filtered], MAX_LIVE_ROWS, tsOf);
          if (capped.trimmed) liveTrimmedRef.current = true;
          return capped.rows;
        });

        if (jumpRef.current !== null) {
          if (detachedRef.current && isNew && env.author !== myAddress) setJumpNewCount((n) => n + 1);
        } else if (signer) {
          // Mark read while viewing the live end.
          client?.markChannelRead(channelId).catch(() => {});
        }
        // Cover any newly-joined member devices with the channel key (no-op if none).
        // A live message may come from a newer epoch: re-read the latest on the next send (F).
        if (isEncrypted) {
          markChannelKeyStale(channelId);
          void coverChannelMembers(channelId, coverTypeRef.current).catch(() => {});
        }
      }
    });
    return unsub;
  }, [onWsEvent, channelId, client, signer, isEncrypted, isPrivate, applyToRow, myAddress]);

  // ── Paging + permalink jump (spec 06 §6.5) ──

  const listRef = useRef<FlatList<ListItem>>(null);
  const hasMoreOlderRef = useRef(hasMoreOlder);
  hasMoreOlderRef.current = hasMoreOlder;
  const windowMoreBeforeRef = useRef(windowMoreBefore);
  windowMoreBeforeRef.current = windowMoreBefore;
  const windowMoreAfterRef = useRef(windowMoreAfter);
  windowMoreAfterRef.current = windowMoreAfter;
  // Request ids: only the newest `before` / `after` request may clear its
  // in-flight flag (a reset drops an older request's result AND its flag).
  const olderReqRef = useRef(0);
  const newerReqRef = useRef(0);
  // Target still to be scrolled to once it is rendered; `landed` turns on
  // forward paging only after the landing scroll, so the initial layout of a
  // short window cannot page the view away from the target.
  const pendingScrollRef = useRef<{ id: string; token: number } | null>(null);
  const [scrollNonce, setScrollNonce] = useState(0);
  const [landed, setLanded] = useState(false);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRetriesRef = useRef(0);

  const clearHighlight = useCallback(() => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = null;
    setHighlightId(null);
  }, []);
  useEffect(() => () => {
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
  }, []);

  /** Drop every piece of jump state (new jump, link removed, present). */
  const resetJump = useCallback(() => {
    jumpTokenRef.current++;
    newerReqRef.current++;
    olderReqRef.current++;
    loadingNewerRef.current = false;
    loadingOlderRef.current = false;
    pendingScrollRef.current = null;
    setJump(null);
    setJumpWindow([]);
    setWindowMoreBefore(false);
    setWindowMoreAfter(false);
    setLoadingNewer(false);
    setLoadingOlder(false);
    setJumpNewCount(0);
    setJumpNotice(null);
    setLanded(false);
    setPinnedId(null);
    clearHighlight();
  }, [clearHighlight]);

  /** Fold rows that are contiguous with the live tail (a window that reached
   *  it, or a legacy node's newest page) into the live layer. */
  const foldIntoLive = useCallback((rows: ExtendedEnvelope[], olderExists: boolean) => {
    if (rows.length > 0) {
      setMessages((prev) => {
        const ids = new Set(prev.map(idOf));
        const add = rows.filter((m) => !ids.has(idOf(m)));
        if (add.length === 0) return prev;
        const capped = capNewest([...prev, ...add], MAX_LIVE_ROWS, tsOf);
        if (capped.trimmed) liveTrimmedRef.current = true;
        return capped.rows;
      });
    }
    if (olderExists) setHasMoreOlder(true);
  }, []);

  /** Scroll to + highlight `target` once it is rendered. */
  const landOn = useCallback((target: string, token: number) => {
    pendingScrollRef.current = { id: target, token };
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightId(target);
    setPinnedId(target);
    highlightTimerRef.current = setTimeout(() => {
      highlightTimerRef.current = null;
      setHighlightId(null);
    }, PERMALINK_HIGHLIGHT_MS);
    scrollRetriesRef.current = 0;
    setScrollNonce((n) => n + 1);
    // Forward paging switches on after the landing scroll; this is the
    // fallback should that scroll never run (target not rendered).
    setTimeout(() => { if (jumpTokenRef.current === token) setLanded(true); }, 1500);
  }, []);

  /** The jump is finished and the view is the live one again: drop the
   *  link's `msgId` so a re-render / remount does not jump again (N3). */
  const clearOwnTarget = useCallback(() => {
    selfClearedTargetRef.current = true;
    navigation.setParams({ msgId: undefined });
  }, [navigation]);

  // The window met the live tail: fold it into the live layer and resume the
  // normal flow (held-back live messages are already there).
  const attachToTail = useCallback((windowRows: ExtendedEnvelope[]) => {
    jumpTokenRef.current++;
    foldIntoLive(windowRows, windowMoreBeforeRef.current);
    setJump(null);
    setJumpWindow([]);
    setWindowMoreBefore(false);
    setWindowMoreAfter(false);
    setJumpNewCount(0);
    setLanded(false);
    clearOwnTarget();
  }, [foldIntoLive, clearOwnTarget]);

  /** "Jump to present": drop the window and show the live layer at its tail. */
  const jumpToPresent = useCallback(() => {
    resetJump();
    // Drop the link's target so it is not jumped to again on a re-render.
    navigation.setParams({ msgId: undefined });
    requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: false }));
  }, [resetJump, navigation]);

  // Start / drop the jump. Keyed on (channel, target, node client, account):
  // a new link or a node switch jumps again; an ACCOUNT change under the same
  // link drops it instead — a jump opened as one account is never re-run as
  // another (spec 06 §6.10). App.tsx also remounts the tree on a switch.
  const lastJumpKeyRef = useRef<{ channelId: number; target: string | null; wallet: string | null } | null>(null);
  useEffect(() => {
    const prev = lastJumpKeyRef.current;
    const wallet = walletAddress ?? null;
    lastJumpKeyRef.current = { channelId, target: targetMsgId, wallet };
    if (selfClearedTargetRef.current) {
      selfClearedTargetRef.current = false;
      // Our own clear after landing (same channel / account): keep the landed
      // view, highlight and pin; nothing to start.
      if (prev && prev.channelId === channelId && prev.wallet === wallet && !targetMsgId) return;
    }
    resetJump();
    if (prev && targetMsgId && prev.channelId === channelId && prev.target === targetMsgId && prev.wallet !== wallet) {
      navigation.setParams({ msgId: undefined });
      return;
    }
    if (!client || !targetMsgId || !Number.isSafeInteger(channelId) || channelId <= 0) return;
    const cid = channelId;
    const target = targetMsgId;
    const token = jumpTokenRef.current;
    const account = accountKeyNow();
    // Re-checked after every await: same jump, channel, node and account.
    const stale = () => token !== jumpTokenRef.current || channelIdRef.current !== cid
      || clientRef.current !== client || accountKeyNow() !== account;
    // Stale only because the account / signer changed (no re-run of this
    // effect follows for a signer-only change): leave the "Jumping…" state
    // instead of showing it forever. A newer jump owns the state otherwise.
    const abandon = () => { if (token === jumpTokenRef.current) setJump(null); };
    setJumpSession(true);
    setJump({ channelId: cid, target, phase: 'loading' });
    void (async () => {
      let resp;
      try {
        resp = await client.getChannelMessages(cid, { around: target, limit: JUMP_WINDOW_LIMIT });
      } catch (e) {
        if (stale()) { abandon(); return; }
        // Plan §9: tell "no access" apart from "channel gone" via the channel
        // record (a private channel answers with its restricted view, a
        // deleted one 404s); Join is offered only for a public channel.
        const status = httpStatusOf(e);
        let failure: JumpFailure = 'error';
        if (status === 403 || status === 404) {
          let record: Parameters<typeof classifyJumpFailure>[1];
          try {
            const detail = await client.getChannelDetail(cid);
            const ch = (detail as { channel?: { channel_id?: unknown; channel_type?: unknown } } | null)?.channel;
            record = ch && Number(ch.channel_id) === cid
              ? { found: true, isPublic: !isInviteGatedChannel(ch.channel_type as number | undefined, cid) }
              : { found: false, status: null };
          } catch (e2) {
            record = { found: false, status: httpStatusOf(e2) };
          }
          if (stale()) { abandon(); return; }
          failure = classifyJumpFailure(status, record);
        }
        setJump(null);
        if (failure === 'error') showToast(t('permalink_load_failed'));
        else setJumpNotice(failure);
        return;
      }
      if (stale()) { abandon(); return; }
      // Defensive cap, as for every other page.
      const rows = normalizeEnvelopes(resp.messages || []).slice(0, JUMP_WINDOW_LIMIT) as ExtendedEnvelope[];
      const lowerId = (m: unknown) => idOf(m as ExtendedEnvelope).toLowerCase();
      const outcome = classifyAround({ target_found: resp.target_found, messages: rows as unknown as Envelope[] }, target, lowerId);
      if (outcome === 'found') {
        if (resp.has_more_after !== false) {
          // Detached: the window REPLACES the view; the live layer keeps
          // collecting live messages behind it.
          setJumpWindow(rows);
          setWindowMoreBefore(moreBefore(resp));
          setWindowMoreAfter(true);
          setJump({ channelId: cid, target, phase: 'detached' });
        } else {
          // The window already reaches the live tail: nothing to detach from.
          foldIntoLive(rows, moreBefore(resp));
          setJump(null);
          clearOwnTarget();
        }
        landOn(target, token);
        return;
      }
      // Both other outcomes served the newest page instead.
      setJump(null);
      if (outcome === 'legacy' && rows.some((m) => lowerId(m) === target)) {
        // Pre-0.150.0 node, but the target is in its newest page.
        foldIntoLive(rows, moreBefore(resp));
        landOn(target, token);
        clearOwnTarget();
        return;
      }
      // `target_found: false` → honest "not on your current node", never
      // "not found"; a legacy node that missed it → "can't jump here".
      setJumpNotice(outcome === 'not-on-node' ? 'not-on-node' : 'node-outdated');
    })();
    return () => { jumpTokenRef.current++; };
    // `t` / `showToast` / helpers are stable enough; listing them would
    // re-run (and re-fetch) the jump on a language change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId, targetMsgId, client, walletAddress]);

  /** Older page (`before`) — the live layer, or the jump window's top edge. */
  const loadOlder = useCallback(async () => {
    const c = clientRef.current;
    if (!c || loadingOlderRef.current) return;
    const inWindow = detachedRef.current;
    if (jumpRef.current !== null && !inWindow) return; // jump loading: wait for it
    if (!(inWindow ? windowMoreBeforeRef.current : hasMoreOlderRef.current)) return;
    const rows = inWindow ? jumpWindowRef.current : messagesRef.current;
    if (!inWindow && rows.length >= MAX_LIVE_ROWS) return;
    const oldest = oldestRealId(rows, idOf, tsOf);
    if (!oldest) return;
    const token = jumpTokenRef.current;
    const cid = channelIdRef.current;
    const account = accountKeyNow();
    const req = ++olderReqRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    try {
      const resp = await c.getChannelMessages(cid, { before: oldest, limit: OLDER_PAGE_LIMIT });
      // Dropped if the channel, node, account or jump changed meanwhile — the
      // page belongs to the view that asked for it.
      if (token !== jumpTokenRef.current || channelIdRef.current !== cid || clientRef.current !== c
        || accountKeyNow() !== account || detachedRef.current !== inWindow) return;
      const page = normalizeEnvelopes(resp.messages || []).slice(0, OLDER_PAGE_LIMIT) as ExtendedEnvelope[];
      if (inWindow) {
        // Over the cap the NEWEST end of the window is shed: re-arm forward paging.
        const willTrim = mergeWindowPage(jumpWindowRef.current, page, 'older', MAX_WINDOW_ROWS, idOf).trimmed;
        setJumpWindow((prev) => mergeWindowPage(prev, page, 'older', MAX_WINDOW_ROWS, idOf).rows);
        setWindowMoreBefore(moreBefore(resp));
        if (willTrim) setWindowMoreAfter(true);
      } else {
        setMessages((prev) => {
          const ids = new Set(prev.map(idOf));
          const add = page.filter((m) => !ids.has(idOf(m)));
          return add.length === 0 ? prev : [...add, ...prev];
        });
        setHasMoreOlder(moreBefore(resp));
      }
    } catch (e) {
      debugLog('warn', `Older messages failed: ${e instanceof Error ? e.message : ''}`);
    } finally {
      if (olderReqRef.current === req) {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      }
    }
  }, [accountKeyNow]);

  /** Newer page (`after`) from the jump window's bottom edge; re-attaches at the tail. */
  const loadNewer = useCallback(async () => {
    const c = clientRef.current;
    if (!c || !detachedRef.current || loadingNewerRef.current || !windowMoreAfterRef.current) return;
    const newest = newestRealId(jumpWindowRef.current, idOf, tsOf);
    if (!newest) return;
    const token = jumpTokenRef.current;
    const cid = channelIdRef.current;
    const account = accountKeyNow();
    const req = ++newerReqRef.current;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    try {
      const resp = await c.getChannelMessages(cid, { after: newest, limit: JUMP_PAGE_LIMIT });
      if (token !== jumpTokenRef.current || channelIdRef.current !== cid || clientRef.current !== c
        || accountKeyNow() !== account || !detachedRef.current) return;
      const page = normalizeEnvelopes(resp.messages || []).slice(0, JUMP_PAGE_LIMIT) as ExtendedEnvelope[];
      const merged = mergeWindowPage(jumpWindowRef.current, page, 'newer', MAX_WINDOW_ROWS, idOf);
      if (moreAfter(resp, page.length, JUMP_PAGE_LIMIT)) {
        setJumpWindow((prev) => mergeWindowPage(prev, page, 'newer', MAX_WINDOW_ROWS, idOf).rows);
        // The oldest end was shed: older history exists again.
        if (merged.trimmed) setWindowMoreBefore(true);
      } else {
        attachToTail(merged.rows);
      }
    } catch (e) {
      // Keep `windowMoreAfter` so the next scroll retries.
      debugLog('warn', `Newer messages failed: ${e instanceof Error ? e.message : ''}`);
    } finally {
      if (newerReqRef.current === req) {
        loadingNewerRef.current = false;
        setLoadingNewer(false);
      }
    }
  }, [accountKeyNow, attachToTail]);

  // Build lookup map for reply context resolution — over `allMsgs`, so a
  // reply to a message only present via the cache still resolves.
  const msgById = useMemo(() => {
    const map = new Map<string, ExtendedEnvelope>();
    for (const msg of knownMsgs) map.set(msgIdToHex(msg.msg_id), msg);
    return map;
  }, [knownMsgs]);

  /** Resolve reply context for a message */
  const resolveReply = useCallback((msg: ExtendedEnvelope): ReplyContext | null => {
    // Check server-provided reply preview
    if ((msg as any).reply_to_preview?.author) {
      const rtp = (msg as any).reply_to_preview;
      return {
        author: rtp.author,
        preview: rtp.content_preview || '...',
        msgId: msgIdToHex(rtp.msg_id),
      };
    }
    // Check decoded payload for reply_to
    const decoded = decodeChatMessage(msg.payload);
    if (!decoded?.reply_to) return null;
    const replyHex = msgIdToHex(decoded.reply_to);
    const original = msgById.get(replyHex);
    if (original) {
      const originalDecoded = decodeChatMessage(original.payload);
      const content = originalDecoded?.content || (typeof original.payload === 'string' ? original.payload : '');
      return {
        author: original.author,
        preview: content.length > 80 ? content.slice(0, 80) + '...' : content,
        msgId: replyHex,
      };
    }
    return { author: '...', preview: '(original message not loaded)', msgId: replyHex };
  }, [msgById]);

  // Sort messages chronologically and build list items with date separators + grouping.
  // O(n) optimistic dedup: build a Set of non-optimistic signatures first,
  // then filter optimistic messages that have a real counterpart.
  // What the list shows: the jump window while detached, else the live layer.
  const viewMsgs = detached ? jumpWindow : allMsgs;
  const listItems = useMemo((): ListItem[] => {
    // Build dedup set for O(n) optimistic filtering: "author|timestamp_bucket"
    const realMsgKeys = new Set<string>();
    for (const m of viewMsgs) {
      if (!m._optimistic) {
        // 10-second bucket for matching optimistic to confirmed messages
        const bucket = Math.floor(new Date(m.timestamp).getTime() / 10000);
        realMsgKeys.add(`${m.author}|${bucket}`);
      }
    }

    const filtered = viewMsgs.filter((m) => {
      if (!m._optimistic) return true;
      const bucket = Math.floor(new Date(m.timestamp).getTime() / 10000);
      return !realMsgKeys.has(`${m.author}|${bucket}`);
    });

    // Sort oldest-first for processing (`filtered` is a fresh array — the
    // state arrays themselves are never sorted in place).
    const sorted = filtered.sort((a, b) =>
      new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    // Cache decoded content + attachments to avoid re-decoding in renderItem
    for (const msg of sorted) {
      if (msg._decodedContent === undefined) {
        const decoded = decodeChatMessage(msg.payload);
        msg._decodedContent = decoded?.content || (typeof msg.payload === 'string' ? msg.payload : '');
        msg._decodedAttachments = (decoded as any)?.attachments;
        msg._decodedButtons = decoded?.buttons;
        msg._decodedViaButton = decoded?.via_button ?? false;
      }
    }

    // Button-press messages (via_button: true) are suppressed from the
    // default feed — frontend spec §6.1.3: "the user only wants to see the
    // bot's reply, not their own tap." `allMsgs`/`sorted` stay the
    // unfiltered source of truth (`msgById`/`resolveReply` above read from
    // `allMsgs` directly, not from this derived list).
    //
    // Suppress only the VIEWER'S OWN presses, not everyone's — deliberately
    // narrower than web/desktop, which hide every wallet's via_button
    // messages. `via_button` carries no server-side authority (protocol
    // §3.3 — any wallet can set it), and mobile has NO pagination at all
    // (fixed `getChannelMessages(channelId, 200)` page, no `onEndReached`,
    // no load-more): a global suppression would let any wallet blank the
    // entire visible window for every mobile client by posting 200+
    // ordinary messages flagged `via_button: true`, with no client-side way
    // to recover (web/desktop have this same exposure in principle, but can
    // page past it; mobile cannot). Matching spec §6.1.3's own stated
    // rationale ("the user only wants to see the bot's reply, not THEIR OWN
    // tap") this scoping is not a deviation from intent, just from the
    // other clients' broader implementation of it.
    // A permalink target always renders, even when it is the viewer's own
    // button press — the user explicitly asked to see that message.
    const visible = sorted.filter((m) => !(m._decodedViaButton && m.author === myAddress && msgIdToHex(m.msg_id) !== (pinnedId ?? targetMsgId)));

    const items: ListItem[] = [];
    let lastDate = '';
    let lastAuthor = '';
    let lastTimestamp = 0;

    for (const msg of visible) {
      const dateLabel = getDateLabel(msg.timestamp, t('chat_today'), t('chat_yesterday'));
      if (dateLabel !== lastDate) {
        items.push({ type: 'date', label: dateLabel, key: `date-${dateLabel}` });
        lastDate = dateLabel;
        lastAuthor = '';
        lastTimestamp = 0;
      }

      const msgTime = new Date(msg.timestamp).getTime();
      const isGrouped = msg.author === lastAuthor && (msgTime - lastTimestamp) < GROUP_WINDOW_MS;

      items.push({
        type: 'message',
        envelope: msg,
        isGrouped,
        key: msgIdToHex(msg.msg_id) || `msg-${msg.timestamp}`,
      });

      lastAuthor = msg.author;
      lastTimestamp = msgTime;
    }

    // Reverse for inverted FlatList (newest at top)
    return items.reverse();
  }, [viewMsgs, t, myAddress, targetMsgId, pinnedId]);

  // Land on a permalink target once its row is in the list: centred, no
  // animation. Variable-height rows → `scrollToIndex`, with the failure
  // handler below estimating the offset first when the row is not measured.
  useEffect(() => {
    const p = pendingScrollRef.current;
    if (!p) return;
    const index = listItems.findIndex((it) => it.type === 'message' && it.key.toLowerCase() === p.id);
    if (index < 0) return;
    const timer = setTimeout(() => {
      if (pendingScrollRef.current !== p) return;
      pendingScrollRef.current = null;
      try {
        listRef.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 });
      } catch { /* handled by onScrollToIndexFailed */ }
      if (jumpTokenRef.current === p.token) setLanded(true);
    }, 60);
    return () => clearTimeout(timer);
  }, [listItems, scrollNonce]);

  const handleScrollToIndexFailed = useCallback((info: { index: number; averageItemLength: number }) => {
    if (scrollRetriesRef.current >= 3) return;
    scrollRetriesRef.current++;
    listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
    setTimeout(() => {
      try {
        listRef.current?.scrollToIndex({ index: info.index, animated: false, viewPosition: 0.5 });
      } catch { /* give up quietly — the row stays highlighted */ }
    }, 120);
  }, []);

  // ── Message Actions ──

  // Declared BEFORE `handleSend` and listed in its deps: with them left out of the
  // deps (and read through a stale closure) an attachment-only send saw empty
  // pending lists and silently did nothing — it only worked once text had been
  // typed, because typing re-created the callback.
  // Media attachments for current message (must include size_bytes for SDK Attachment type)
  const [pendingAttachments, setPendingAttachments] = useState<Array<{ cid: string; mime_type: string; size_bytes: number; filename: string }>>([]);
  // P5: encrypted-channel attachments — descriptors hold per-file keys, sent via `media`.
  const [pendingEncryptedMedia, setPendingEncryptedMedia] = useState<MediaDescriptor[]>([]);
  const [uploading, setUploading] = useState(false);

  const handleSend = useCallback(async () => {
    const text = input.trim();
    // Allow sending text, attachments (plaintext or encrypted), or both
    if ((!text && pendingAttachments.length === 0 && pendingEncryptedMedia.length === 0) || !client || !signer) return;

    // `isEncrypted` FAILS CLOSED (reads `true`) while `chanMetaResolved` is
    // false, so proceeding here would silently take the ENCRYPTED branch —
    // for a channel that may well be plaintext — and mint + publish a fresh
    // epoch key as a side effect. That used to be a ~100ms window; since
    // `getChannelDetail` no longer swallows its own failure (see the
    // channel-metadata effect), a real fetch failure now leaves this false
    // for the rest of the mount, not just a moment. `handlePickMedia`
    // already refuses the same way for attachments; text sending needs the
    // identical guard, with visible feedback since there's no disabled
    // button state to communicate it silently the way the picker has.
    if (!chanMetaResolved) {
      showInfo(t('chat_send'), t('chat_channel_info_loading'));
      return;
    }

    // Encrypted channels block plaintext edits via editMessage. Editing an encrypted
    // message isn't wired yet (the SDK channel-edit envelope is text-only); skip for now.
    if (editingMsg) {
      if (isEncrypted) {
        showInfo(t('chat_edit'), t('e2e_cant_decrypt'));
        return;
      }
      try {
        await client.editMessage(channelId, editingMsg.msgId, text);
        // Optimistic update — clear cached content so it re-decodes
        applyToRow(editingMsg.msgId, (m) => ({ ...m, payload: text, edited: true, last_edited_at: Date.now(), _decodedContent: undefined }));
        setEditingMsg(null);
        setInput('');
        // editMessage carries no mentions of its own; anything pending belonged
        // to a draft that no longer exists.
        setPendingMentions([]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : '';
        debugLog('warn', `Edit failed: ${msg}`);
        showInfo(t('chat_edit'), msg.slice(0, 150));
      }
      return;
    }

    try {
      const options: any = {};
      // Merge two sources, identical to web/desktop (ChatView's send handler):
      //  1. raw `@klv1…` addresses typed or pasted into the text
      //  2. addresses resolved by the @-mention / -command pickers
      //
      // Deliberately NOT filtered by "is the address still in the text" — the
      // pickers insert `@DisplayName`, not the address, so such a filter would
      // drop every picker-resolved mention. Same known limitation as web: a
      // mention deleted from the text before sending still notifies. Matching
      // the other clients matters more than fixing it unilaterally here.
      const raw = text.match(/@(klv1[a-z0-9]{58})/g) ?? [];
      const merged = new Set([...pendingMentions, ...raw.map((m) => m.slice(1))]);
      if (merged.size > 0) options.mentions = Array.from(merged);
      if (replyTo) options.replyTo = replyTo.msgId;
      if (pendingAttachments.length > 0) options.attachments = pendingAttachments;
      const sentAttachments = [...pendingAttachments];
      const sentEncryptedMedia = [...pendingEncryptedMedia];
      let sentMsgId: string | undefined;

      if (isEncrypted) {
        // E2E channels need a built-in wallet to sign the key envelopes.
        if (!e2eAvailable()) {
          showInfo(t('chat_send'), t('e2e_builtin_only'));
          return;
        }
        // Encrypted attachments ride INSIDE the ciphertext via `media` (not plaintext).
        if (sentEncryptedMedia.length > 0) options.media = sentEncryptedMedia;
        const built = await buildEncryptedChannelMsg(channelId, canEstablishKey, text || '', options, encFloor, isPrivate);
        if (built === 'waiting') {
          showInfo(t('chat_send'), t('e2e_channel_waiting'));
          return;
        }
        if (built === 'rekeying') {
          showInfo(t('chat_send'), t('e2e_channel_rekeying'));
          return;
        }
        const r = await client.sendMessageEnvelope(built);
        sentMsgId = r.msg_id;
      } else {
        const r = await client.sendMessage(channelId, text || '', options);
        sentMsgId = r.msg_id;
      }
      setInput('');
      setReplyTo(null);
      // Clear alongside the composer, or the next message silently carries the
      // previous one's mentions — notifying people who were never named in it.
      setPendingMentions([]);
      setPendingAttachments([]);
      setPendingEncryptedMedia([]);

      // Optimistically add the sent message with cached attachments
      const optimistic: ExtendedEnvelope = {
        version: 1,
        msg_type: 1,
        msg_id: sentMsgId || `local-${Date.now()}`,
        author: myAddress || '',
        timestamp: Date.now(),
        lamport_ts: 0,
        payload: text || '',
        signature: [],
        relay_path: [],
        _optimistic: true,
        _decodedContent: text || '',
        _decodedAttachments: sentAttachments.length > 0 ? sentAttachments : undefined,
        _decodedEncryptedMedia: sentEncryptedMedia.length > 0 ? sentEncryptedMedia : undefined,
      };
      // Sending from a jump window: back to the present first, so the
      // optimistic bubble shows at the live tail, not under old history.
      if (detachedRef.current) jumpToPresent();
      setMessages((prev) => {
        const capped = capNewest([optimistic, ...prev], MAX_LIVE_ROWS, tsOf);
        if (capped.trimmed) liveTrimmedRef.current = true;
        return capped.rows;
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Send failed: ${msg}`);
      const key = chatErrorKey(msg);
      showInfo(t('chat_send'), key ? t(key) : msg.slice(0, 150));
    }
  }, [input, client, signer, channelId, myAddress, editingMsg, replyTo, t, isEncrypted, canEstablishKey, encFloor, isPrivate, pendingMentions, chanMetaResolved, pendingAttachments, pendingEncryptedMedia, jumpToPresent, applyToRow]);

  /**
   * Sends a button press (protocol §3.3): an ordinary signed message whose
   * content is the literal `command`, replying to `origin` and flagged
   * `via_button`. Branches on encryption exactly like `handleSend` above —
   * spec §6.1.3: "Private and encrypted channels. Buttons work there
   * unchanged" — only `content` is ever sealed, so a press needs the
   * channel's epoch key the same way a typed message does. Passed to
   * `MessageBubble` (which forwards to `MessageButtons`) as `onPressButton`;
   * neither has channel-crypto access itself.
   */
  const pressButton = useCallback(async (
    origin: { channelId: number; msgId: string; author: string },
    command: string,
  ) => {
    if (!client) throw new Error('not connected');
    // Same guard as `handleSend`: while the channel record is unresolved,
    // `isPrivate` reads false from the placeholder `channelType: 0`, so
    // `canEstablishKey` would be `true` and `encFloor` 0 — letting a non-mod
    // seed a private channel's epoch key, or send below its key floor. Also
    // refuse a press whose origin isn't the channel the resolved record is
    // for (the flags below describe THIS channel only).
    if (!chanMetaResolved || origin.channelId !== channelId) {
      throw new Error(t('chat_channel_info_loading'));
    }
    if (isEncrypted) {
      const built = await buildEncryptedChannelMsg(origin.channelId, canEstablishKey, command, {
        replyTo: origin.msgId, mentions: [origin.author], viaButton: true,
      }, encFloor, isPrivate);
      if (built === 'waiting') {
        throw new Error(t('e2e_channel_waiting'));
      }
      if (built === 'rekeying') {
        throw new Error(t('e2e_channel_rekeying'));
      }
      await client.sendMessageEnvelope(built);
      return;
    }
    await client.pressButton(origin, command);
  }, [client, isEncrypted, canEstablishKey, encFloor, isPrivate, t, chanMetaResolved, channelId]);

  const handleReply = useCallback((msg: ExtendedEnvelope) => {
    const d = decodedRef.current.get(chanCacheId(msg));
    const content = (d && (d.kind === 'text' || d.kind === 'plain') ? d.text : '') || msg._decodedContent || '';
    const preview = content.length > 80 ? content.slice(0, 80) + '...' : content;
    setReplyTo({
      msgId: msgIdToHex(msg.msg_id),
      author: msg.author.slice(0, 12) + '...',
      preview,
    });
    inputRef.current?.focus();
  }, []);

  const handleEdit = useCallback((msg: ExtendedEnvelope) => {
    // Ownership guard — only edit own messages
    if (msg.author !== myAddress) return;
    const d = decodedRef.current.get(chanCacheId(msg));
    const content = (d && (d.kind === 'text' || d.kind === 'plain') ? d.text : '') || msg._decodedContent || '';
    setEditingMsg({ msgId: msgIdToHex(msg.msg_id), content });
    setInput(content);
    // The draft being replaced takes its mentions with it. Without this, a
    // mention picked for the abandoned draft survives and attaches to whatever
    // is sent next — notifying someone who was never named in it.
    setPendingMentions([]);
    setReplyTo(null);
    inputRef.current?.focus();
  }, [myAddress]);

  const handleDelete = useCallback(async (msg: ExtendedEnvelope) => {
    // Ownership guard — only delete own messages
    if (!client || msg.author !== myAddress) return;
    try {
      await client.deleteMessage(channelId, msgIdToHex(msg.msg_id));
      applyToRow(msg.msg_id, (m) => ({ ...m, deleted: true }));
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : '';
      debugLog('warn', `Delete failed: ${errMsg}`);
      const key = chatErrorKey(errMsg);
      showInfo(t('chat_delete'), key ? t(key) : errMsg.slice(0, 150));
    }
  }, [client, channelId, myAddress, t, applyToRow]);

  const handleReact = useCallback(async (msg: ExtendedEnvelope, emoji: string) => {
    if (!client) return;
    // Validate emoji against allowlist
    if (!CHAT_REACTIONS.includes(emoji)) return;
    try {
      await client.reactToMessage(channelId, msgIdToHex(msg.msg_id), emoji);
      applyToRow(msg.msg_id, (m) => {
        const reactions = { ...(m.reactions || {}) };
        reactions[emoji] = (reactions[emoji] || 0) + 1;
        return { ...m, reactions };
      });
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : '';
      debugLog('warn', `React failed: ${errMsg}`);
      const key = chatErrorKey(errMsg);
      if (key) showInfo(t('chat_react'), t(key));
    }
  }, [client, channelId, t, applyToRow]);

  const cancelEdit = useCallback(() => {
    setEditingMsg(null);
    setInput('');
    setPendingMentions([]);
  }, []);

  const cancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  // Tipping
  const [tipTarget, setTipTarget] = useState<string | null>(null);
  // Emoji picker
  const [showEmoji, setShowEmoji] = useState(false);

  const handleTip = useCallback((msg: ExtendedEnvelope) => {
    if (msg.author === myAddress) return; // can't tip yourself
    setTipTarget(msg.author);
  }, [myAddress]);

  const handlePickMedia = useCallback(async () => {
    // Belt-and-suspenders alongside isEncrypted's fail-closed guard: don't even
    // open the picker until we know this channel's real encryption state.
    if (!client || !signer || uploading || !chanMetaResolved) return;
    // Encrypted channels read the bytes (base64) so we can encrypt BEFORE upload (P5).
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: false,
      quality: 0.8,
      base64: isEncrypted,
    });
    if (result.canceled || !result.assets?.[0]) return;
    const asset = result.assets[0];
    const cap = isEncrypted ? MAX_ENCRYPTED_MEDIA_BYTES : 50 * 1024 * 1024;
    if (asset.fileSize && asset.fileSize > cap) {
      showInfo(t('error_generic'), 'File too large (max 50MB)');
      return;
    }
    setUploading(true);
    try {
      const filename = asset.fileName ?? `file-${Date.now()}`;
      const mimeType = asset.mimeType ?? 'application/octet-stream';

      if (isEncrypted) {
        // Encrypt-before-upload: read bytes → encryptFile → upload opaque cipher.
        if (!asset.base64) throw new Error('could not read file bytes for encryption');
        const bytes = base64ToBytes(asset.base64);
        const descriptor = await encryptAndUploadFile({ bytes, mime: mimeType, name: filename });
        setPendingEncryptedMedia((prev) => [...prev, descriptor]);
        return;
      }

      // Plaintext path (non-encrypted channels); multipart body built in JS
      // (lib/multipart.ts) because SDK 58's fetch rejects RN FormData uri parts.
      const uploadResp = await uploadMedia(
        client as unknown as UploadClient,
        { uri: asset.uri, mimeType, fileName: filename, sizeHint: asset.fileSize },
      );
      setPendingAttachments((prev) => [...prev, {
        cid: uploadResp.cid,
        mime_type: mimeType,
        size_bytes: asset.fileSize || 0,
        filename,
      }]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Media upload failed: ${msg}`);
      const friendly = msg === 'FILE_TOO_LARGE' ? 'File too large (max 50MB)'
        : msg.includes('404') ? t('news_upload_unavailable')
          : msg.slice(0, 150);
      showInfo(t('error_generic'), friendly);
    } finally {
      setUploading(false);
    }
  }, [client, signer, uploading, isEncrypted, chanMetaResolved, t]);

  // ── Render ──

  const handleAuthorPress = useCallback((addr: string) => {
    navigation.navigate('UserProfile', { address: addr });
  }, [navigation]);

  // Share links (spec 06 §6.5). A private / encrypted channel's link only
  // opens for members — say so rather than hiding the action (plan §8.6).
  // `isEncrypted` fails closed while the record loads, which only makes this
  // note appear early, never the reverse.
  const membersOnly = isPrivate || isEncrypted;
  const handleCopyLink = useCallback(async (msg: ExtendedEnvelope) => {
    const url = buildChatShareUrl(channelId, msgIdToHex(msg.msg_id));
    if (!url) { showToast(t('share_link_failed')); return; }
    try {
      await Clipboard.setStringAsync(url);
      showToast(t(membersOnly ? 'share_link_copied_members' : 'share_link_copied'));
    } catch {
      showToast(t('share_link_failed'));
    }
  }, [channelId, membersOnly, showToast, t]);
  const handleShareLink = useCallback(async (msg: ExtendedEnvelope) => {
    const url = buildChatShareUrl(channelId, msgIdToHex(msg.msg_id));
    if (!url) { showToast(t('share_link_failed')); return; }
    if (membersOnly) showToast(t('share_link_members_note'));
    try {
      await Share.share({ message: url });
    } catch (e) {
      debugLog('warn', `Share link failed: ${e instanceof Error ? e.message : ''}`);
    }
  }, [channelId, membersOnly, showToast, t]);

  const renderItem = useCallback(({ item }: { item: ListItem }) => {
    if (item.type === 'date') {
      return (
        <View style={styles.dateSeparator}>
          <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
          <Text style={[styles.dateLabel, { color: colors.textSecondary, backgroundColor: colors.bgPrimary }]}>
            {item.label}
          </Text>
          <View style={[styles.dateLine, { backgroundColor: colors.border }]} />
        </View>
      );
    }

    const { envelope, isGrouped } = item;
    const isOwn = envelope.author === myAddress;
    const envHex = msgIdToHex(envelope.msg_id).toLowerCase();
    // Unconfirmed sends (`local-…`) have no permalink.
    const linkable = !envelope._optimistic && /^[0-9a-f]{64}$/.test(envHex);
    // Text comes from the async decrypt cache (handles v1 plaintext + v2 encrypted).
    const disp = decoded.get(chanCacheId(envelope));
    const content = !disp ? (envelope._decodedContent || '')
      : disp.kind === 'waiting' ? t('e2e_channel_waiting')
        : disp.kind === 'error' ? t('e2e_cant_decrypt')
          : disp.text;
    // P5 encrypted attachments live INSIDE the decrypted content; plaintext wire
    // attachments are shown only when the message wasn't encrypted.
    const encryptedMedia = disp && disp.kind === 'text' ? disp.media : undefined;
    const authorLabel = profileNames[envelope.author] || envelope.author.slice(0, 12) + '...';
    const replyContext = resolveReply(envelope);
    const nodeUrl = (client as any)?.nodeUrl || '';

    return (
      <MessageBubble
        message={envelope}
        content={content}
        isOwn={isOwn}
        authorLabel={authorLabel}
        attachments={encryptedMedia && encryptedMedia.length > 0 ? undefined : envelope._decodedAttachments}
        encryptedMedia={encryptedMedia}
        mediaBaseUrl={nodeUrl ? `${nodeUrl}/api/v1/media/` : undefined}
        replyContext={replyContext}
        isGrouped={isGrouped}
        onReply={handleReply}
        onEdit={handleEdit}
        onDelete={handleDelete}
        onReact={handleReact}
        onTip={handleTip}
        onAuthorPress={handleAuthorPress}
        onCopyLink={linkable ? handleCopyLink : undefined}
        onShareLink={linkable ? handleShareLink : undefined}
        highlighted={highlightId !== null && envHex === highlightId}
        // Omitted entirely (not just disabled) when the viewer can't post
        // here — see `canPostHere`'s doc comment above.
        buttons={canPostHere ? envelope._decodedButtons : undefined}
        buttonMsgId={msgIdToHex(envelope.msg_id)}
        channelId={channelId}
        onPressButton={canPostHere ? pressButton : undefined}
      />
    );
  }, [myAddress, colors, profileNames, client, decoded, t, resolveReply, handleReply, handleEdit, handleDelete, handleReact, handleTip, handleAuthorPress, canPostHere, pressButton, handleCopyLink, handleShareLink, highlightId]);

  const keyExtractor = useCallback((item: ListItem) => item.key, []);

  return (
    <KeyboardAwareView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
    >
      {/* Channel header — title and the (sometimes long) encryption badge each
          get their own line, in a column that shares the row with the gear
          icon; a long badge text used to steal width from the title's `flex: 1`
          and wrap the channel name across multiple lines. */}
      <View style={[styles.header, { backgroundColor: colors.bgSecondary, borderBottomColor: colors.border }]}>
        <TouchableOpacity
          onPress={() => navigation.goBack()}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          style={{ marginRight: spacing.sm }}
        >
          <Text style={{ color: colors.textPrimary, fontSize: fontSize.lg }}>←</Text>
        </TouchableOpacity>
        <View style={styles.headerTextCol}>
          <Text style={[styles.headerTitle, { color: colors.textPrimary }]} numberOfLines={1}>#{channelName}</Text>
          {isEncrypted && (
            <Text
              style={{ color: colors.textSecondary, fontSize: fontSize.xs }}
              numberOfLines={1}
            >
              {isPrivate ? t('e2e_encrypted_badge') : t('e2e_public_by_design')}
            </Text>
          )}
          {isEncrypted && keyStatus.state !== 'idle' && (
            <Text
              style={{ color: keyStatus.state === 'problem' ? colors.error : colors.textSecondary, fontSize: fontSize.xs }}
              numberOfLines={2}
            >
              {t(statusMessageKey(keyStatus) ?? 'e2e_channel_key_failed')}
            </Text>
          )}
        </View>
        {signer && (
          <TouchableOpacity
            onPress={() => navigation.navigate('ChannelAdmin', { channelId, channelName })}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.lg }}>⚙</Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Link-opened encrypted public channel: join only on an explicit tap. */}
      {showJoinBar && (
        <View style={[styles.joinBar, { backgroundColor: colors.bgSecondary, borderBottomColor: colors.border }]}>
          <Text style={{ color: colors.textPrimary, fontSize: fontSize.sm, flex: 1 }}>
            {t('channel_join_to_read')}
          </Text>
          <Button
            size="sm"
            label={t('permalink_join_channel')}
            loading={joiningFromLink}
            onPress={() => { void handleJoinFromLink(); }}
          />
        </View>
      )}

      <View style={styles.listWrap}>
        <FlatList
          ref={listRef}
          data={listItems}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          inverted
          contentContainerStyle={styles.list}
          // Inverted: the END is the top (older history), the START the
          // bottom (newer — only paged while a jump window is detached).
          onEndReached={() => { void loadOlder(); }}
          onEndReachedThreshold={0.5}
          onStartReached={detached && landed ? () => { void loadNewer(); } : undefined}
          onStartReachedThreshold={0.5}
          // Once a jump touched this channel: keep the visible rows in place
          // when rows are inserted at the bottom (forward pages, re-attach).
          // Detached: no auto-scroll to the newest row, which would chain
          // forward pages to the tail on its own.
          maintainVisibleContentPosition={
            detached ? { minIndexForVisible: 0 }
              : jumpSession ? { minIndexForVisible: 0, autoscrollToTopThreshold: 40 }
                : undefined
          }
          onScrollToIndexFailed={handleScrollToIndexFailed}
          onScrollBeginDrag={highlightId ? clearHighlight : undefined}
          ListFooterComponent={loadingOlder ? <ActivityIndicator style={styles.pageSpinner} color={colors.textSecondary} /> : undefined}
          ListHeaderComponent={loadingNewer ? <ActivityIndicator style={styles.pageSpinner} color={colors.textSecondary} /> : undefined}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={{ color: colors.textSecondary }}>
                {t('chat_no_messages')}
              </Text>
            </View>
          }
        />

        {/* Permalink jump: the single `around` fetch in flight. */}
        {jump?.phase === 'loading' && jump.channelId === channelId && (
          <View style={[styles.jumpPill, { backgroundColor: colors.bgSecondary, borderColor: colors.border }]} accessibilityRole="progressbar">
            <ActivityIndicator size="small" color={colors.textSecondary} />
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm, marginLeft: spacing.xs }}>
              {t('permalink_jumping')}
            </Text>
          </View>
        )}

        {/* Detached from the live tail: the way back + held-back live count. */}
        {detached && (
          <View style={[styles.jumpBanner, { backgroundColor: colors.bgSecondary, borderColor: colors.border }]}>
            <Text style={{ color: colors.textSecondary, fontSize: fontSize.sm, flexShrink: 1 }} numberOfLines={1}>
              {t('permalink_viewing_older')}
            </Text>
            <Button
              size="sm"
              label={jumpNewCount > 0 ? t('permalink_jump_present_new', { count: jumpNewCount }) : t('permalink_jump_present')}
              icon="↓"
              onPress={jumpToPresent}
            />
          </View>
        )}

        {/* Why a jump could not land (plan §9). */}
        {jumpNotice && (
          <View style={[styles.jumpNotice, { backgroundColor: colors.bgSecondary, borderColor: colors.warning }]} accessibilityLiveRegion="polite">
            <View style={styles.jumpNoticeRow}>
              <Text style={{ color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600', flex: 1 }}>
                {t({
                  'not-on-node': 'permalink_not_on_node',
                  'node-outdated': 'permalink_node_outdated',
                  'no-access': 'permalink_no_access',
                  'no-access-joinable': 'permalink_no_access',
                  'channel-gone': 'permalink_channel_gone',
                }[jumpNotice])}
              </Text>
              <TouchableOpacity
                onPress={() => setJumpNotice(null)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('close')}
              >
                <Text style={{ color: colors.textSecondary, fontSize: fontSize.md }}>✕</Text>
              </TouchableOpacity>
            </View>
            {(jumpNotice === 'not-on-node' || jumpNotice === 'node-outdated') && (
              <Button
                size="sm"
                variant="secondary"
                label={t('permalink_choose_node')}
                onPress={() => setNodePickerOpen(true)}
              />
            )}
            {jumpNotice === 'no-access-joinable' && (
              <Button
                size="sm"
                label={t('permalink_join_channel')}
                onPress={() => navigation.navigate('ChannelJoin', { channelId })}
              />
            )}
          </View>
        )}

        <Toast message={toast} bottom={spacing.md} />
      </View>

      {signer ? (
        <View style={{ backgroundColor: colors.bgSecondary, borderTopWidth: 1, borderTopColor: colors.border }}>
          {/* Reply context bar */}
          {replyTo && (
            <View style={[styles.contextBar, { borderBottomColor: colors.border }]}>
              <View style={[styles.contextIndicator, { backgroundColor: colors.accentPrimary }]} />
              <View style={styles.contextContent}>
                <Text style={[styles.contextLabel, { color: colors.accentPrimary }]}>
                  {t('channel_reply_to')} {replyTo.author}
                </Text>
                <Text style={[styles.contextPreview, { color: colors.textSecondary }]} numberOfLines={1}>
                  {replyTo.preview}
                </Text>
              </View>
              <TouchableOpacity onPress={cancelReply} style={styles.contextClose}>
                <Text style={{ color: colors.textSecondary, fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Edit context bar */}
          {editingMsg && (
            <View style={[styles.contextBar, { borderBottomColor: colors.border }]}>
              <View style={[styles.contextIndicator, { backgroundColor: colors.warning }]} />
              <View style={styles.contextContent}>
                <Text style={[styles.contextLabel, { color: colors.warning }]}>
                  {t('chat_editing')}
                </Text>
                <Text style={[styles.contextPreview, { color: colors.textSecondary }]} numberOfLines={1}>
                  {editingMsg.content}
                </Text>
              </View>
              <TouchableOpacity onPress={cancelEdit} style={styles.contextClose}>
                <Text style={{ color: colors.textSecondary, fontSize: 18 }}>✕</Text>
              </TouchableOpacity>
            </View>
          )}

          {/* Attachment preview (plaintext) */}
          {pendingAttachments.length > 0 && (
            <View style={[styles.attachPreview, { borderBottomColor: colors.border }]}>
              {pendingAttachments.map((att, i) => (
                <View key={i} style={[styles.attachChip, { backgroundColor: colors.bgTertiary }]}>
                  <Text style={{ color: colors.textPrimary, fontSize: fontSize.xs }} numberOfLines={1}>
                    📎 {att.filename}
                  </Text>
                  <TouchableOpacity onPress={() => setPendingAttachments((p) => p.filter((_, j) => j !== i))}>
                    <Text style={{ color: colors.error, fontSize: fontSize.sm }}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* Encrypted attachment preview (P5) */}
          {pendingEncryptedMedia.length > 0 && (
            <View style={[styles.attachPreview, { borderBottomColor: colors.border }]}>
              {pendingEncryptedMedia.map((m, i) => (
                <View key={i} style={[styles.attachChip, { backgroundColor: colors.bgTertiary }]}>
                  <Text style={{ color: colors.textPrimary, fontSize: fontSize.xs }} numberOfLines={1}>
                    🔒 {m.name || m.cid.slice(0, 12)}
                  </Text>
                  <TouchableOpacity onPress={() => setPendingEncryptedMedia((p) => p.filter((_, j) => j !== i))}>
                    <Text style={{ color: colors.error, fontSize: fontSize.sm }}>✕</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </View>
          )}

          {/* @-mention and /-command pickers (frontend §6.1.1, §6.1.2), docked
              directly above the composer — React Native exposes no caret
              geometry, so a floating popover is not an option. */}
          <ComposerSuggestions
            value={input}
            channelId={channelId}
            client={client}
            onPick={({ value, mention }) => {
              setInput(value);
              if (mention) {
                setPendingMentions((prev) => Array.from(new Set([...prev, mention])));
              }
              inputRef.current?.focus();
            }}
          />

          {/* Input bar */}
          <View style={styles.inputBar}>
            <TouchableOpacity
              onPress={handlePickMedia}
              style={styles.emojiBtn}
              disabled={uploading || !chanMetaResolved}
            >
              <Text style={{ fontSize: 20, opacity: (uploading || !chanMetaResolved) ? 0.4 : 1 }}>📎</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setShowEmoji(true)}
              style={styles.emojiBtn}
            >
              <Text style={{ fontSize: 22 }}>😀</Text>
            </TouchableOpacity>
            <TextInput
              ref={inputRef}
              style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder={t('chat_placeholder')}
              placeholderTextColor={colors.textSecondary}
              value={input}
              onChangeText={setInput}
              maxLength={4000}
              multiline
            />
            <TouchableOpacity
              style={[styles.sendBtn, { backgroundColor: (input.trim() || pendingAttachments.length > 0 || pendingEncryptedMedia.length > 0) ? colors.accentPrimary : colors.textSecondary }]}
              onPress={handleSend}
              disabled={!input.trim() && pendingAttachments.length === 0 && pendingEncryptedMedia.length === 0}
            >
              <Text style={{ color: colors.textInverse, fontWeight: '600' }}>
                {editingMsg ? t('save') : t('chat_send')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={[styles.inputBar, { backgroundColor: colors.bgSecondary, borderTopWidth: 1, borderTopColor: colors.border }]}>
          <Text style={{ color: colors.textSecondary, padding: spacing.md }}>
            {t('wallet_connect')}
          </Text>
        </View>
      )}
      <EmojiPicker
        visible={showEmoji}
        onSelect={(emoji) => setInput((prev) => prev + emoji)}
        onClose={() => setShowEmoji(false)}
      />
      {tipTarget && (
        <TipDialog
          visible={!!tipTarget}
          recipientAddress={tipTarget}
          onClose={() => setTipTarget(null)}
        />
      )}
      <InfoModal visible={!!info} title={info?.title} message={info?.message || ''} onClose={() => setInfo(null)} />
      {/* "Try another node" for a message this node does not hold. Picking
          one swaps the client, which re-runs the jump on the new node. */}
      <NodeSelector visible={nodePickerOpen} onClose={() => setNodePickerOpen(false)} />
    </KeyboardAwareView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTextCol: { flex: 1, marginRight: spacing.sm },
  headerTitle: { fontSize: fontSize.lg, fontWeight: '700' },
  listWrap: { flex: 1 },
  joinBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  list: { paddingHorizontal: spacing.md, paddingBottom: spacing.md },
  pageSpinner: { paddingVertical: spacing.sm },
  jumpPill: {
    position: 'absolute',
    top: spacing.sm,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: StyleSheet.hairlineWidth,
  },
  jumpBanner: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.md,
    right: spacing.md,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm,
    paddingLeft: spacing.md,
    paddingRight: spacing.xs,
    paddingVertical: spacing.xs,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
  },
  jumpNotice: {
    position: 'absolute',
    bottom: spacing.sm,
    left: spacing.md,
    right: spacing.md,
    gap: spacing.sm,
    padding: spacing.sm,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  jumpNoticeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 60 },
  dateSeparator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.md,
  },
  dateLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
  },
  dateLabel: {
    fontSize: fontSize.xs,
    fontWeight: '600',
    paddingHorizontal: spacing.sm,
  },
  contextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  contextIndicator: {
    width: 3,
    height: '100%',
    borderRadius: 2,
    marginRight: spacing.sm,
    minHeight: 32,
  },
  contextContent: {
    flex: 1,
  },
  contextLabel: {
    fontSize: fontSize.xs,
    fontWeight: '600',
  },
  contextPreview: {
    fontSize: fontSize.xs,
  },
  contextClose: {
    padding: spacing.sm,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: spacing.sm,
  },
  emojiBtn: {
    justifyContent: 'center',
    paddingRight: spacing.xs,
    paddingBottom: spacing.xs,
  },
  attachPreview: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  attachChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.sm,
  },
  input: {
    flex: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: fontSize.md,
    minHeight: 44,
    maxHeight: 100,
  },
  sendBtn: {
    marginLeft: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    justifyContent: 'center',
  },
});
