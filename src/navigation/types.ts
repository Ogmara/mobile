/**
 * Navigation type definitions — param lists for all stack navigators.
 */

export type NewsStackParamList = {
  /** `refresh` (a fresh Date.now()) tells the feed to reload the newest page and
   *  jump to the top — set by ComposePost after a successful post/edit, since
   *  the WS echo of the user's own write is intentionally not applied. */
  NewsFeed: { refresh?: number; tag?: string; group?: string; topics?: 'all' } | undefined;
  /** `commentId` (64-hex) scrolls to that comment (news-comment permalink). */
  NewsDetail: { msgId: string; post?: any; commentId?: string };
  Topics: undefined;
  ComposePost: {
    editMsgId?: string;
    editTitle?: string;
    editContent?: string;
    editTags?: string[];
  } | undefined;
  UserProfile: { address: string };
  FollowList: { address: string; tab: 'followers' | 'following' };
};

export type ChatStackParamList = {
  ChannelList: undefined;
  CreateChannel: undefined;
  /** `msgId` (64-hex, from a permalink / mention push) opens the jump to
   *  that message (spec 06 §6.5). Declared identically in the Search stack.
   *  `channelName` is absent when opened from a link; the screen resolves it.
   *  `fromLink` is set ONLY by the inbound-link / push path: such an open never
   *  auto-joins an encrypted channel (an explicit Join bar instead). */
  ChannelMessages: { channelId: number; channelName?: string; msgId?: string; fromLink?: string };
  ChannelAdmin: { channelId: number; channelName: string };
  ChannelJoin: { channelId: number; node?: string; inv?: string };
  UserProfile: { address: string };
  FollowList: { address: string; tab: 'followers' | 'following' };
};

export type DmStackParamList = {
  DmList: undefined;
  DmConversation: { address: string; displayName?: string };
  UserProfile: { address: string };
  FollowList: { address: string; tab: 'followers' | 'following' };
};

export type SearchStackParamList = {
  SearchHome: undefined;
  UserProfile: { address: string };
  /** `msgId` (64-hex, from a permalink / mention push) opens the jump to
   *  that message (spec 06 §6.5). Declared identically in the Search stack.
   *  `channelName` is absent when opened from a link; the screen resolves it.
   *  `fromLink` is set ONLY by the inbound-link / push path: such an open never
   *  auto-joins an encrypted channel (an explicit Join bar instead). */
  ChannelMessages: { channelId: number; channelName?: string; msgId?: string; fromLink?: string };
  ChannelJoin: { channelId: number; node?: string; inv?: string };
  /** `commentId` (64-hex) scrolls to that comment (news-comment permalink). */
  NewsDetail: { msgId: string; post?: any; commentId?: string };
  FollowList: { address: string; tab: 'followers' | 'following' };
};

export type MoreStackParamList = {
  Settings: undefined;
  Bookmarks: undefined;
  Addressbook: undefined;
  Accounts: undefined;
  AddAccount: undefined;
  EditProfile: undefined;
  Wallet: undefined;
  WalletBalance: undefined;
  Receive: undefined;
  TokenDetail: { assetId: string; name: string; precision: number };
  // `disable` turns an existing PIN off (requires re-entering it); default is
  // the create/change flow.
  PinSetup: { mode?: 'setup' | 'disable' } | undefined;
  DebugLogs: undefined;
  Notifications: undefined;
  UserProfile: { address: string };
  FollowList: { address: string; tab: 'followers' | 'following' };
};

export type ChannelAdminParamList = {
  ChannelAdmin: { channelId: number; channelName: string };
};

/** Shared params used by multiple stacks. */
export type SharedStackParams = {
  UserProfile: { address: string };
};
