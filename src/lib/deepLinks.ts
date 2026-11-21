/**
 * Deep link handling — ogmara:// URL scheme and the canonical share links.
 *
 * Supported deep links (spec 06 §6.5):
 *   ogmara://chat/{id}?msg={hex}  → ChannelMessages, jumps to the message
 *   ogmara://chat/{id}            → ChannelMessages
 *   ogmara://channel/{id}         → alias of chat/ (push + older links)
 *   ogmara://news/{hex}[?c={hex}] → NewsDetail (optionally a comment)
 *   ogmara://join/{id}?node=…&inv=…  → ChannelJoin (node hint is UNTRUSTED)
 *   ogmara://dm/{address}         → DmConversation screen
 *   ogmara://user/{address}       → UserProfile screen
 * plus the same routes behind `https://ogmara.org/app/#/…` (OS-level opening of
 * `https://` links still needs Android App Links / iOS Universal Links — a
 * platform follow-up, plan Phase 7).
 *
 * Every inbound path goes through `resolveInboundPath` (deepLinkPaths.ts),
 * which runs share-link kinds through the SDK's `parsePermalink` before React
 * Navigation sees them — never a raw path into `getStateFromPath`.
 */

import { Linking } from 'react-native';
import { getStateFromPath, type LinkingOptions } from '@react-navigation/native';
import { linkingConfig, resolveInboundPath, pathFromInboundUrl } from './deepLinkPaths';

export { linkingConfig };

/** The launch URL is handed to a NavigationContainer once per process. The
 *  container unmounts while the app is locked and remounts on unlock; without
 *  this every unlock would re-open the link the app was launched with. */
let initialUrlConsumed = false;

/** Last inbound URL and when it arrived — see {@link takeRecentInboundUrl}. */
let lastInbound: { url: string; at: number } | null = null;

/** Record an inbound OS link (launch URL or a `url` event). */
export function noteInboundUrl(url: string | null | undefined): void {
  if (typeof url === 'string' && url) lastInbound = { url, at: Date.now() };
}

/**
 * The last inbound link if it arrived within `maxAgeMs`, consuming it. Used to
 * re-dispatch a link the navigator lost — the tab tree remounts when the saved
 * account finishes restoring on a cold start (App.tsx keys it on the wallet).
 */
export function takeRecentInboundUrl(maxAgeMs: number): string | null {
  const l = lastInbound;
  lastInbound = null;
  return l && Date.now() - l.at <= maxAgeMs ? l.url : null;
}

/** Navigation state for an inbound URL, or undefined when it is not a link
 *  the app handles (rejected by {@link resolveInboundPath}). */
export function stateForInboundUrl(url: string): ReturnType<typeof getStateFromPath> | undefined {
  const path = pathFromInboundUrl(url);
  if (path === null) return undefined;
  const resolved = resolveInboundPath(path);
  if (!resolved) return undefined;
  return getStateFromPath(resolved, linkingConfig as never) ?? undefined;
}

/** Build a linking configuration object for NavigationContainer. */
export function getLinkingConfig(): LinkingOptions<{}> {
  return {
    // Exact share base only (spec 06 §6.5); `resolveInboundPath` also
    // requires the hash route after it.
    prefixes: ['ogmara://', 'https://ogmara.org/app'],
    config: linkingConfig as never,
    async getInitialURL() {
      if (initialUrlConsumed) return null;
      initialUrlConsumed = true;
      const url = await Linking.getInitialURL();
      noteInboundUrl(url);
      return url;
    },
    // Rejected / unknown links resolve to `undefined`: React Navigation then
    // leaves the current screen alone instead of navigating anywhere.
    getStateFromPath: (path, options) => {
      const resolved = resolveInboundPath(path);
      if (!resolved) return undefined;
      return getStateFromPath(resolved, options);
    },
  };
}
