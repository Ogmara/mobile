/**
 * Pure deep-link path data — the React Navigation `linking.config` screen map,
 * the hash-route normalisation and the inbound-link resolver, kept free of
 * React Native imports so `node --test` can verify them (see
 * deepLinkPaths.test.ts). `deepLinks.ts` wires these into the
 * NavigationContainer; `push.ts` uses {@link chatPushTarget}.
 *
 * Every inbound link — OS deep link (`ogmara://…`, `https://ogmara.org/app/#/…`)
 * and push payload — is an UNTRUSTED string. Share-link kinds (chat, news,
 * join) go through the SDK's `parsePermalink` (spec 06 §6.5) and are rebuilt
 * from the parsed target, so a raw query string never reaches a screen's
 * params. Anything the parser rejects is not a permalink: the path may still
 * route (a bare channel / post / join page), but its `msg` / `c` / `node` /
 * `inv` targets are dropped silently.
 */

import { buildPermalink, parsePermalink, normalizeMsgId, type PermalinkTarget } from '@ogmara/sdk';

/** React Navigation linking configuration for ogmara:// deep links.
 *
 * The paths here are the INTERNAL form produced by {@link resolveInboundPath}
 * (e.g. `chat/7?msgId=<hex>`), not the share-link wire form — the resolver is
 * the only producer, so a query key a link supplies itself never maps to a
 * screen param. */
export const linkingConfig = {
  screens: {
    NewsTab: {
      // A post opened from a link sits on top of the feed, so Back works.
      initialRouteName: 'NewsFeed',
      screens: {
        NewsFeed: 'news',
        // `?commentId=` (internal) — a news-comment permalink (`?c=`).
        NewsDetail: 'news/:msgId',
        UserProfile: 'user/:address',
      },
    },
    ChatTab: {
      initialRouteName: 'ChannelList',
      screens: {
        ChannelList: 'channels',
        // `chat/` is the share-link form (spec 06 §6.5); `channel/` stays as
        // an alias for push-notification and older links. `?msgId=` (internal)
        // opens the permalink jump; `?fromLink=1` (internal, always set by the
        // resolver) disables the silent auto-join of encrypted channels.
        ChannelMessages: { path: 'chat/:channelId', alias: ['channel/:channelId'] },
        // Invite-link landing: ogmara://join/{id}?node=…[&inv=…] (federate-on-join).
        // Query params become screen params, so a personal private-channel
        // invite (`inv`, base64url) reaches ChannelJoinScreen untouched.
        ChannelJoin: 'join/:channelId',
        // NOTE: no `UserProfile: 'user/:address'` here — NewsTab already owns
        // that pattern, and React Navigation's getStateFromPath THROWS on two
        // screens sharing one pattern ("Found conflicting screens…"), which
        // made EVERY inbound deep link fail, join links included.
      },
    },
    DmTab: {
      screens: {
        DmList: 'dms',
        DmConversation: 'dm/:address',
      },
    },
    SearchTab: 'search',
    MoreTab: {
      screens: {
        Settings: 'settings',
        Wallet: 'wallet',
      },
    },
  },
} as const;

/** Longest inbound link considered at all (the SDK parser's own cap). */
const MAX_INBOUND_LEN = 8192;
/** Canonical decimal channel id: no sign, no leading zero, ≤ 16 digits. */
const CHANNEL_ID = /^[1-9][0-9]{0,15}$/;
/** Non-permalink routes passed through as a bare path (no query). */
const PASS_THROUGH = /^(?:dm\/[A-Za-z0-9]{1,100}|user\/[A-Za-z0-9]{1,100}|channels|dms|news|search|settings|wallet)$/;

/**
 * Strip the link prefix residue React Navigation leaves on the path, so the
 * canonical share form (`/#/join/123?node=x&inv=y` after the
 * `https://ogmara.org/app` prefix) maps to the same route as
 * `ogmara://join/123?…`. Returns null for an https-form path that is not a
 * hash route (`/chat/7`, `/?x#/…`) — spec 06 §6.5 accepts the exact base
 * `https://ogmara.org/app/#/…` only. A native path has no leading `/`.
 */
export function normalizeLinkPath(path: string): string | null {
  if (path.startsWith('/') || path.startsWith('#')) {
    const m = /^\/?#\/?/.exec(path);
    return m ? path.slice(m[0].length) : null;
  }
  return path;
}

function safeChannelId(s: string): number | null {
  if (!CHANNEL_ID.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Parse a route (`chat/7?msg=…`, no prefix) as a share link — the SDK's
 * strict `parsePermalink` on its native form. Legacy compat (as web/desktop):
 * some older invite links double-encoded `?node=`; if the strict parse fails
 * the `node` value is decoded once more and the parse retried, and the retry
 * only ever yields a `join` target.
 */
export function permalinkFromRoute(route: string): PermalinkTarget | null {
  if (typeof route !== 'string' || route.length > MAX_INBOUND_LEN) return null;
  const parse = (r: string) => parsePermalink(`ogmara://${r}`, { allowNative: true });
  const direct = parse(route);
  if (direct) return direct;
  if (!route.startsWith('join/')) return null;
  let changed = false;
  const legacy = route.replace(/([?&]node=)([^&]*)/, (whole, key: string, val: string) => {
    try {
      const once = decodeURIComponent(val);
      if (once === val) return whole;
      changed = true;
      return key + once;
    } catch {
      return whole;
    }
  });
  if (!changed) return null;
  const retry = parse(legacy);
  return retry && retry.kind === 'join' ? retry : null;
}

/**
 * The internal navigation path for a parsed share-link target (the form
 * {@link linkingConfig} matches). Ids are the parser's canonical ones; the
 * join `node` / `inv` are re-encoded by the SDK builder.
 */
export function internalPathForTarget(target: PermalinkTarget): string | null {
  switch (target.kind) {
    case 'chat':
      return `chat/${target.channelId}?msgId=${target.msgId}&fromLink=1`;
    case 'news':
      return target.commentId
        ? `news/${target.msgId}?commentId=${target.commentId}`
        : `news/${target.msgId}`;
    case 'join': {
      const native = buildPermalink(target, { native: true });
      return native ? native.slice('ogmara://'.length) : null;
    }
    default:
      return null;
  }
}

/**
 * Resolve an inbound link path (as React Navigation hands it to
 * `getStateFromPath`, prefix already stripped) to the internal path to
 * navigate to, or null to ignore the link entirely.
 *
 * - `chat/` / `channel/` / `news/` / `join/` go through `parsePermalink`; a
 *   well-formed link yields its rebuilt internal path. A malformed one still
 *   opens the bare channel / post / join page when its id is valid — its
 *   targets are dropped, never echoed.
 * - `channel/<id>?msg=…` (older push links) is treated as `chat/`.
 * - A small set of non-permalink routes (`dm/<addr>`, `user/<addr>`, tab
 *   roots) passes through WITHOUT its query.
 * - Everything else is rejected.
 */
export function resolveInboundPath(rawPath: string): string | null {
  if (typeof rawPath !== 'string' || rawPath.length > MAX_INBOUND_LEN) return null;
  let route = normalizeLinkPath(rawPath);
  if (route === null) return null;
  if (route.startsWith('channel/')) route = `chat/${route.slice('channel/'.length)}`;
  const q = route.indexOf('?');
  const pathPart = q === -1 ? route : route.slice(0, q);
  const segs = pathPart.split('/');
  const head = segs[0];

  if (pathPart === 'news') return 'news';
  if (head === 'chat' || head === 'news' || head === 'join') {
    const target = permalinkFromRoute(route);
    if (target) return internalPathForTarget(target);
    if (segs.length !== 2) return null;
    if (head === 'news') {
      const id = normalizeMsgId(segs[1]);
      return id ? `news/${id}` : null;
    }
    const ch = safeChannelId(segs[1]);
    if (ch === null) return null;
    // `fromLink` marks a channel opened from outside the app: no silent join.
    return head === 'chat' ? `chat/${ch}?fromLink=1` : `${head}/${ch}`;
  }
  return PASS_THROUGH.test(pathPart) ? pathPart : null;
}

/**
 * Extract the route part of an inbound OS URL for the prefixes the app
 * registers (`ogmara://`, `https://ogmara.org/app`) — the same strip React
 * Navigation applies before `getStateFromPath`. The https form must continue
 * with the hash route (`/#/…` or `#/…`, spec 06 §6.5 exact base); null for any
 * other URL. Used to re-dispatch a link the navigator could not consume.
 */
export function pathFromInboundUrl(url: string): string | null {
  if (typeof url !== 'string' || url.length > MAX_INBOUND_LEN) return null;
  if (url.startsWith('ogmara://')) return url.slice('ogmara://'.length);
  const base = 'https://ogmara.org/app';
  if (url.startsWith(base) && /^\/?#/.test(url.slice(base.length))) return url.slice(base.length);
  return null;
}

/**
 * Chat target of a mention push (`data.channel_id`, `data.msg_id`): the pair
 * is validated by building the native permalink and parsing it back, so the
 * push opens the jump to the exact message. A missing / malformed `msg_id`
 * degrades to opening the channel; a bad channel id yields null.
 */
export function chatPushTarget(channelIdRaw: unknown, msgIdRaw: unknown): { channelId: number; msgId?: string } | null {
  const chStr = typeof channelIdRaw === 'number' ? String(channelIdRaw) : typeof channelIdRaw === 'string' ? channelIdRaw : '';
  const channelId = safeChannelId(chStr);
  if (channelId === null) return null;
  if (typeof msgIdRaw === 'string' && msgIdRaw.length <= 128) {
    const p = permalinkFromRoute(`chat/${channelId}?msg=${encodeURIComponent(msgIdRaw)}`);
    if (p && p.kind === 'chat' && p.channelId === channelId) return { channelId, msgId: p.msgId };
  }
  return { channelId };
}
