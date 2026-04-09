/**
 * Navigation type definitions — param lists for all stack navigators.
 */

export type NewsStackParamList = {
  NewsFeed: undefined;
  NewsDetail: { msgId: string; post?: any };
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
  ChannelMessages: { channelId: number; channelName: string };
  ChannelAdmin: { channelId: number; channelName: string };
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
  ChannelMessages: { channelId: number; channelName: string };
  NewsDetail: { msgId: string; post?: any };
};

export type MoreStackParamList = {
  Settings: undefined;
  Bookmarks: undefined;
  Addressbook: undefined;
  Wallet: undefined;
  WalletBalance: undefined;
  PinSetup: undefined;
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
