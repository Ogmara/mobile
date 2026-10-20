/**
 * Deep link handling — ogmara:// URL scheme.
 *
 * Supported deep links:
 *   ogmara://channel/{id}      → ChannelMessages screen
 *   ogmara://news/{msgId}      → NewsDetail screen
 *   ogmara://dm/{address}      → DmConversation screen
 *   ogmara://user/{address}    → UserProfile screen
 *   ogmara://join/{id}?node=…&inv=…  → ChannelJoin screen (personal private invite)
 *
 * Used for push notification navigation, external app links,
 * and K5 wallet callbacks.
 */

import { getStateFromPath, type LinkingOptions } from '@react-navigation/native';
import { linkingConfig, normalizeLinkPath } from './deepLinkPaths';

export { linkingConfig };

/** Build a linking configuration object for NavigationContainer.
 *
 * `getStateFromPath` is wrapped to tolerate the canonical hash-routed share URLs
 * (`https://ogmara.org/app/#/join/123?node=…`) so an inbound link that reaches the app
 * maps to the same screens as the native `ogmara://join/123` form. (OS-level opening of
 * `https://` links still requires Android App Links / iOS Universal Links manifest
 * config — a platform follow-up.) */
export function getLinkingConfig(): LinkingOptions<{}> {
  return {
    prefixes: ['ogmara://', 'https://ogmara.org/app', 'https://ogmara.org'],
    config: linkingConfig,
    getStateFromPath: (path, options) => {
      return getStateFromPath(normalizeLinkPath(path), options);
    },
  };
}
