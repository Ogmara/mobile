/**
 * Share-link helpers — mirror desktop `share.ts` so invite links are identical across
 * clients. The canonical URL is hash-routed (`https://ogmara.org/app/#/join/{id}`) for
 * web/desktop compatibility; for PRIVATE channels we embed a `?node=` host hint so a
 * recipient on another node can federate the channel to their home node.
 */

const SHARE_BASE = 'https://ogmara.org/app';

function sanitizeChannelId(channelId: number | string): string | null {
  const n = typeof channelId === 'number' ? channelId : parseInt(channelId, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return String(Math.floor(n));
}

/**
 * Build a shareable channel invite URL. For private channels pass the current node URL
 * as `hostNodeUrl` so the recipient can federate the channel from there.
 */
export function buildChannelInviteUrl(
  channelId: number | string,
  hostNodeUrl?: string,
): string | null {
  const ch = sanitizeChannelId(channelId);
  if (!ch) return null;
  let url = `${SHARE_BASE}/#/join/${ch}`;
  if (hostNodeUrl && /^https?:\/\//.test(hostNodeUrl)) {
    url += `?node=${encodeURIComponent(hostNodeUrl)}`;
  }
  return url;
}

/**
 * Parse a join link (canonical hash form OR native `ogmara://join/{id}?node=`) into
 * `{ channelId, node }`, or null if it isn't a join link. Used by an inbound-link
 * handler to route to the ChannelJoin screen.
 */
export function parseJoinUrl(url: string): { channelId: number; node?: string } | null {
  if (!url) return null;
  // Normalise both `…/#/join/123?node=x` and `ogmara://join/123?node=x`.
  const m = url.match(/join\/(\d+)(?:\?([^#]*))?/);
  if (!m) return null;
  const channelId = parseInt(m[1], 10);
  if (!Number.isFinite(channelId) || channelId <= 0) return null;
  let node: string | undefined;
  if (m[2]) {
    const params = new URLSearchParams(m[2]);
    const raw = params.get('node');
    if (raw) node = decodeURIComponent(raw);
  }
  return { channelId, node };
}
