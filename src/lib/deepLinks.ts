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

import type { LinkingOptions } from '@react-navigation/native';

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

/** Build a linking configuration object for NavigationContainer. */
export function getLinkingConfig(): LinkingOptions<{}> {
  return {
    prefixes: ['ogmara://'],
    config: linkingConfig,
  };
}
