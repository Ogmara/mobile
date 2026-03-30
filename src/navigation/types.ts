/**
 * Navigation type definitions — param lists for all stack navigators.
 */

export type NewsStackParamList = {
  NewsFeed: undefined;
  NewsDetail: { msgId: string };
  ComposePost: undefined;
  UserProfile: { address: string };
};

export type ChatStackParamList = {
  ChannelList: undefined;
  ChannelMessages: { channelId: number; channelName: string };
  UserProfile: { address: string };
};

export type DmStackParamList = {
  DmList: undefined;
  DmConversation: { address: string; displayName?: string };
  UserProfile: { address: string };
};

export type SearchStackParamList = {
  SearchHome: undefined;
  UserProfile: { address: string };
  ChannelMessages: { channelId: number; channelName: string };
  NewsDetail: { msgId: string };
};

export type MoreStackParamList = {
  Settings: undefined;
  Bookmarks: undefined;
  Wallet: undefined;
  WalletBalance: undefined;
  PinSetup: undefined;
  DebugLogs: undefined;
  UserProfile: { address: string };
};

export type ChannelAdminParamList = {
  ChannelAdmin: { channelId: number; channelName: string };
};

/** Shared params used by multiple stacks. */
export type SharedStackParams = {
  UserProfile: { address: string };
};
