/**
 * Pure deep-link path data — the React Navigation `linking.config` screen map
 * and the hash-route normalisation, kept free of React Native imports so
 * `node --test` can verify that join links keep their query (`node`, `inv`)
 * intact (see deepLinkPaths.test.ts). `deepLinks.ts` wires these into the
 * NavigationContainer.
 */

/** React Navigation linking configuration for ogmara:// deep links. */
export const linkingConfig = {
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

/**
 * Strip a leading hash-route marker so the canonical share form
 * (`#/join/123?node=x&inv=y`) maps to the same path as `ogmara://join/123?…`.
 */
export function normalizeLinkPath(path: string): string {
  return path.replace(/^\/?#\/?/, '').replace(/^#/, '');
}
