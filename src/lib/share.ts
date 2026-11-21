/**
 * Share-link helpers — build canonical share URLs (spec 06 §6.5).
 *
 * Thin wrappers over the SDK's `buildPermalink` (sdk-js 0.71.0) so every client
 * emits byte-identical links; inbound links go through `parsePermalink` (see
 * `lib/deepLinkPaths.ts`). Every link resolves to the public PWA at
 * https://ogmara.org/app, so recipients always land on a working URL. The
 * target lives in the URL fragment — a link preview never learns it.
 *
 * Private channels: the bare invite link never granted access; their only
 * shareable invite is the personal one built by the SDK's
 * `buildPrivateChannelInviteUrl` from a signed invite (spec 05 §8.4). A chat
 * message link to a private / encrypted channel is fine to share — it only
 * opens for members (callers say so in the copy toast).
 *
 * Kept free of React Native imports so it runs under `node --test`.
 */

import {
  buildPermalink,
  parsePermalink,
  isPermalinkNodeUrl,
  PERMALINK_BASE,
  type ParsePermalinkOptions,
  type PermalinkTarget,
} from '@ogmara/sdk';

/** Canonical public host for share URLs. Self-hosters who want share-out to
 *  point at their own host patch this one constant; the parse side accepts it
 *  too (see `SHARE_PARSE_OPTIONS`). */
const SHARE_BASE: string = 'https://ogmara.org/app';

/** `parsePermalink` options matching what this client emits. */
export const SHARE_PARSE_OPTIONS: ParsePermalinkOptions =
  SHARE_BASE === PERMALINK_BASE ? {} : { extraBases: [SHARE_BASE] };

/** Positive safe-integer channel id from a number or canonical decimal
 *  string, else null (the SDK builder takes numbers only). */
function toChannelId(channelId: number | string): number | null {
  const n = typeof channelId === 'number' ? channelId : /^[1-9][0-9]{0,15}$/.test(channelId) ? Number(channelId) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Link to a news post — or, with `commentIdHex`, to one comment under it
 *  (`?c=`). Null if an id isn't 64-char hex. */
export function buildNewsShareUrl(msgIdHex: string, commentIdHex?: string): string | null {
  const target: PermalinkTarget = commentIdHex === undefined
    ? { kind: 'news', msgId: msgIdHex }
    : { kind: 'news', msgId: msgIdHex, commentId: commentIdHex };
  return buildPermalink(target, { base: SHARE_BASE });
}

/** Link to one chat message in a channel. Null if `channelId` isn't a
 *  positive integer or `msgIdHex` isn't 64-char hex (e.g. an unconfirmed
 *  `local-…` send). */
export function buildChatShareUrl(channelId: number | string, msgIdHex: string): string | null {
  const ch = toChannelId(channelId);
  if (ch === null) return null;
  return buildPermalink({ kind: 'chat', channelId: ch, msgId: msgIdHex }, { base: SHARE_BASE });
}

/**
 * Channel invite / join link — PUBLIC / READ-PUBLIC channels (a private
 * channel's link is the personal one, see the module comment). `hostNodeUrl`
 * is an optional host hint; one the shared parser would reject is dropped
 * (the link still works without it). Null if `channelId` isn't a positive
 * integer.
 */
export function buildChannelInviteUrl(channelId: number | string, hostNodeUrl?: string): string | null {
  const ch = toChannelId(channelId);
  if (ch === null) return null;
  const node = hostNodeUrl && isPermalinkNodeUrl(hostNodeUrl) ? hostNodeUrl : undefined;
  return buildPermalink(node ? { kind: 'join', channelId: ch, node } : { kind: 'join', channelId: ch }, { base: SHARE_BASE });
}

/**
 * A share link found in message / post text (`https://ogmara.org/app/#/…`),
 * rebuilt as the app's own `ogmara://…` link so tapping it opens in-app —
 * through the same inbound path (`resolveInboundPath`) as any OS deep link.
 * Null when the URL is not a well-formed share link (it opens in the browser
 * as before). Native links are not auto-linked in text, so only https bases
 * are accepted here.
 */
export function inAppUrlForShareLink(url: string): string | null {
  const target = parsePermalink(url, { ...SHARE_PARSE_OPTIONS, allowNative: false });
  return target ? buildPermalink(target, { native: true }) : null;
}
