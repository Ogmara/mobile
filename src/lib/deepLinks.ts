/**
 * Deep link handling — ogmara:// URL scheme.
 *
 * Supported deep links:
 *   ogmara://channel/{id}      → ChannelMessages screen
 *   ogmara://news/{msgId}      → NewsDetail screen
 *   ogmara://dm/{address}      → DmConversation screen
 *   ogmara://user/{address}    → UserProfile screen
 *
 * Used for push notification navigation, external app links,
 * and K5 wallet callbacks.
 */

import { getStateFromPath, type LinkingOptions } from '@react-navigation/native';

/** React Navigation linking configuration for ogmara:// deep links. */
export const linkingConfig: LinkingOptions<{}>['config'] = {
  screens: {
    NewsTab: {
      screens: {
        NewsFeed: 'news',
        NewsDetail: 'news/:msgId',
        UserProfile: 'user/:address',
      },
    },
    ChatTab: {
      screens: {
        ChannelList: 'channels',
        ChannelMessages: 'channel/:channelId',
        // Invite-link landing: ogmara://join/{id}?node=… (federate-on-join).
        ChannelJoin: 'join/:channelId',
        UserProfile: 'user/:address',
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
};

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
      // Strip a leading hash-route marker so `#/join/123?node=x` → `join/123?node=x`.
      const normalized = path.replace(/^\/?#\/?/, '').replace(/^#/, '');
      return getStateFromPath(normalized, options);
    },
  };
}
