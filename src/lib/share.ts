/**
 * Share-link helpers — mirror desktop `share.ts` so invite links are identical across
 * clients. The canonical URL is hash-routed (`https://ogmara.org/app/#/join/{id}`) for
 * web/desktop compatibility. Private channels get no link from here — only the SDK's
 * personal `buildPrivateChannelInviteUrl` (`?node=…&inv=…`).
 */

const SHARE_BASE = 'https://ogmara.org/app';

function sanitizeChannelId(channelId: number | string): string | null {
  const n = typeof channelId === 'number' ? channelId : parseInt(channelId, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.floor(n));
}

/**
 * Build a shareable channel invite URL — PUBLIC / READ-PUBLIC channels only. A
 * Private channel has no bare link any more (it never granted access): its only
 * shareable link is a personal one built by the SDK's
 * `buildPrivateChannelInviteUrl` from a signed invite (spec 05 §8.4).
 */
export function buildChannelInviteUrl(channelId: number | string): string | null {
  const ch = sanitizeChannelId(channelId);
  if (!ch) return null;
  return `${SHARE_BASE}/#/join/${ch}`;
}
