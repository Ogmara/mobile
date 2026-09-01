/**
 * Bottom tab navigator with nested stacks.
 *
 * Each tab has its own native stack for drill-down navigation:
 *   News → NewsFeed → NewsDetail → UserProfile
 *   Chat → ChannelList → ChannelMessages → UserProfile
 *   DMs  → DmList → DmConversation → UserProfile
 *   Search → SearchHome → (any detail screen)
 *   More → Settings → Wallet / UserProfile
 *
 * Per spec 06-frontend.md section 5.2.
 */

import React, { useState, useCallback } from 'react';
import { TouchableOpacity, Text } from 'react-native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { useNavigation, getFocusedRouteNameFromRoute } from '@react-navigation/native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';
import { useTheme, fontSize, spacing } from '../theme';
import type { StartScreen } from '../lib/settings';
import QuickMenu from '../components/QuickMenu';
import { useConnection } from '../context/ConnectionContext';
import type {
  NewsStackParamList,
  ChatStackParamList,
  DmStackParamList,
  MoreStackParamList,
  SearchStackParamList,
} from './types';

// Screens
import NewsFeedScreen from '../screens/NewsFeedScreen';
import NewsDetailScreen from '../screens/NewsDetailScreen';
import TopicsScreen from '../screens/TopicsScreen';
import ChatScreen from '../screens/ChatScreen';
import ChannelMessagesScreen from '../screens/ChannelMessagesScreen';
import DmListScreen from '../screens/DmListScreen';
import DmConversationScreen from '../screens/DmConversationScreen';
import ComposePostScreen from '../screens/ComposePostScreen';
import SearchScreen from '../screens/SearchScreen';
import SettingsScreen from '../screens/SettingsScreen';
import WalletScreen from '../screens/WalletScreen';
import PinSetupScreen from '../screens/PinSetupScreen';
import DebugScreen from '../screens/DebugScreen';
import BookmarksScreen from '../screens/BookmarksScreen';
import AddressbookScreen from '../screens/AddressbookScreen';
import WalletBalanceScreen from '../screens/WalletBalanceScreen';
import ReceiveScreen from '../screens/ReceiveScreen';
import TokenDetailScreen from '../screens/TokenDetailScreen';
import CreateChannelScreen from '../screens/CreateChannelScreen';
import ChannelAdminScreen from '../screens/ChannelAdminScreen';
import ChannelJoinScreen from '../screens/ChannelJoinScreen';
import FollowListScreen from '../screens/FollowListScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import UserProfileScreen from '../screens/UserProfileScreen';

const Tab = createBottomTabNavigator();
const NewsStack = createNativeStackNavigator<NewsStackParamList>();
const ChatStack = createNativeStackNavigator<ChatStackParamList>();
const DmStack = createNativeStackNavigator<DmStackParamList>();
const MoreStack = createNativeStackNavigator<MoreStackParamList>();
const SearchStack = createNativeStackNavigator<SearchStackParamList>();

function NewsTab() {
  return (
    <NewsStack.Navigator screenOptions={{ headerShown: false }}>
      <NewsStack.Screen name="NewsFeed" component={NewsFeedScreen} />
      <NewsStack.Screen name="NewsDetail" component={NewsDetailScreen} options={{ headerShown: true, title: '' }} />
      <NewsStack.Screen name="Topics" component={TopicsScreen} options={{ headerShown: true, title: '' }} />
      <NewsStack.Screen name="ComposePost" component={ComposePostScreen} />
      <NewsStack.Screen name="UserProfile" component={UserProfileScreen} options={{ headerShown: true, title: 'Profile' }} />
      <NewsStack.Screen name="FollowList" component={FollowListScreen} options={{ headerShown: true, title: '' }} />
    </NewsStack.Navigator>
  );
}

function ChatTab() {
  return (
    <ChatStack.Navigator screenOptions={{ headerShown: false }}>
      <ChatStack.Screen name="ChannelList" component={ChatScreen} />
      <ChatStack.Screen name="CreateChannel" component={CreateChannelScreen} />
      <ChatStack.Screen name="ChannelMessages" component={ChannelMessagesScreen} />
      <ChatStack.Screen name="ChannelAdmin" component={ChannelAdminScreen} />
      <ChatStack.Screen name="ChannelJoin" component={ChannelJoinScreen} />
      <ChatStack.Screen name="UserProfile" component={UserProfileScreen} options={{ headerShown: true, title: 'Profile' }} />
      <ChatStack.Screen name="FollowList" component={FollowListScreen} options={{ headerShown: true, title: '' }} />
    </ChatStack.Navigator>
  );
}

function DmTab() {
  return (
    <DmStack.Navigator screenOptions={{ headerShown: false }}>
      <DmStack.Screen name="DmList" component={DmListScreen} />
      <DmStack.Screen name="DmConversation" component={DmConversationScreen} />
      <DmStack.Screen name="UserProfile" component={UserProfileScreen} options={{ headerShown: true, title: 'Profile' }} />
      <DmStack.Screen name="FollowList" component={FollowListScreen} options={{ headerShown: true, title: '' }} />
    </DmStack.Navigator>
  );
}

function SearchTab() {
  return (
    <SearchStack.Navigator screenOptions={{ headerShown: false }}>
      <SearchStack.Screen name="SearchHome" component={SearchScreen} />
      <SearchStack.Screen name="ChannelMessages" component={ChannelMessagesScreen} />
      <SearchStack.Screen name="ChannelJoin" component={ChannelJoinScreen} />
      <SearchStack.Screen name="NewsDetail" component={NewsDetailScreen} options={{ headerShown: true, title: '' }} />
      <SearchStack.Screen name="UserProfile" component={UserProfileScreen} options={{ headerShown: true, title: 'Profile' }} />
      <SearchStack.Screen name="FollowList" component={FollowListScreen} options={{ headerShown: true, title: '' }} />
    </SearchStack.Navigator>
  );
}

function MoreTab() {
  return (
    <MoreStack.Navigator screenOptions={{ headerShown: false }}>
      <MoreStack.Screen name="Settings" component={SettingsScreen} />
      <MoreStack.Screen name="Bookmarks" component={BookmarksScreen} options={{ headerShown: true, title: 'Bookmarks' }} />
      <MoreStack.Screen name="Addressbook" component={AddressbookScreen} options={{ headerShown: true, title: 'Addressbook' }} />
      <MoreStack.Screen name="Wallet" component={WalletScreen} />
      <MoreStack.Screen name="WalletBalance" component={WalletBalanceScreen} options={{ headerShown: true, title: 'Wallet' }} />
      <MoreStack.Screen name="Receive" component={ReceiveScreen} options={{ headerShown: true, title: 'Receive' }} />
      <MoreStack.Screen name="TokenDetail" component={TokenDetailScreen} options={{ headerShown: true, title: 'Staking' }} />
      <MoreStack.Screen name="PinSetup" component={PinSetupScreen} />
      <MoreStack.Screen name="DebugLogs" component={DebugScreen} />
      <MoreStack.Screen name="Notifications" component={NotificationsScreen} />
      <MoreStack.Screen name="UserProfile" component={UserProfileScreen} options={{ headerShown: true, title: 'Profile' }} />
      <MoreStack.Screen name="FollowList" component={FollowListScreen} options={{ headerShown: true, title: '' }} />
    </MoreStack.Navigator>
  );
}

// Screens that render their own native-stack header (back arrow + title).
// The outer Tab.Navigator header must be hidden while one of these is
// focused, otherwise it stacks on top and leaves e.g. a "Settings" header
// above a screen that isn't Settings — and with no header of its own at
// all, a pushed screen like UserProfile/NewsDetail/FollowList had no way
// back except an OS-level gesture.
const MORE_STACK_SCREENS_WITH_OWN_HEADER = [
  'Bookmarks',
  'Addressbook',
  'WalletBalance',
  'Receive',
  'TokenDetail',
  'UserProfile',
  'FollowList',
];
const NEWS_STACK_SCREENS_WITH_OWN_HEADER = ['NewsDetail', 'Topics', 'UserProfile', 'FollowList'];
const CHAT_STACK_SCREENS_WITH_OWN_HEADER = ['UserProfile', 'FollowList'];
const DM_STACK_SCREENS_WITH_OWN_HEADER = ['UserProfile', 'FollowList'];
const SEARCH_STACK_SCREENS_WITH_OWN_HEADER = ['NewsDetail', 'UserProfile', 'FollowList'];

/** Map start screen setting to tab route name. */
function startScreenToRoute(startScreen: StartScreen): string {
  switch (startScreen) {
    case 'chat':
      return 'ChatTab';
    case 'channels':
      return 'ChatTab';
    default:
      return 'NewsTab';
  }
}

interface Props {
  startScreen: StartScreen;
}

export default function TabNavigator({ startScreen }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { displayName } = useConnection();
  const [menuOpen, setMenuOpen] = useState(false);

  // Navigation must be obtained from a nested ref since TabNavigator
  // is at the root. Menu items use the tab navigator to switch tabs,
  // then navigate within the target stack.
  const nav = useNavigation<any>();

  const menuItems = [
    { icon: 'notifications-outline' as const, label: t('nav_notifications'), onPress: () => nav.navigate('MoreTab', { screen: 'Notifications' }) },
    { icon: 'bookmarks-outline' as const, label: t('news_bookmark'), onPress: () => nav.navigate('MoreTab', { screen: 'Bookmarks' }) },
    { icon: 'book-outline' as const, label: t('nav_more'), onPress: () => nav.navigate('MoreTab', { screen: 'Addressbook' }) },
    { icon: 'wallet-outline' as const, label: t('settings_wallet'), onPress: () => nav.navigate('MoreTab', { screen: 'WalletBalance' }) },
  ];

  const headerRight = () => (
    <TouchableOpacity
      onPress={() => setMenuOpen(true)}
      style={{ flexDirection: 'row', alignItems: 'center', paddingRight: spacing.md, gap: 6 }}
    >
      {displayName ? (
        <Text style={{ color: colors.textPrimary, fontSize: fontSize.sm, fontWeight: '600' }}>
          {displayName}
        </Text>
      ) : null}
      <Ionicons name="menu" size={24} color={colors.textPrimary} />
    </TouchableOpacity>
  );

  return (
    <>
    <QuickMenu visible={menuOpen} onClose={() => setMenuOpen(false)} items={menuItems} />
    <Tab.Navigator
      initialRouteName={startScreenToRoute(startScreen)}
      screenOptions={{
        headerStyle: { backgroundColor: colors.bgSecondary },
        headerTintColor: colors.textPrimary,
        headerRight,
        tabBarStyle: {
          backgroundColor: colors.bgSecondary,
          borderTopColor: colors.border,
        },
        tabBarActiveTintColor: colors.accentPrimary,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarLabelStyle: { fontSize: fontSize.xs },
      }}
    >
      <Tab.Screen
        name="NewsTab"
        component={NewsTab}
        options={({ route }) => ({
          title: t('nav_news'),
          tabBarLabel: t('nav_news'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="newspaper-outline" size={size} color={color} />
          ),
          headerShown: !NEWS_STACK_SCREENS_WITH_OWN_HEADER.includes(
            getFocusedRouteNameFromRoute(route) ?? 'NewsFeed'
          ),
        })}
        listeners={({ navigation: tabNav }) => ({
          tabPress: () => { tabNav.navigate('NewsTab', { screen: 'NewsFeed' }); },
        })}
      />
      <Tab.Screen
        name="ChatTab"
        component={ChatTab}
        options={({ route }) => ({
          title: t('nav_chat'),
          tabBarLabel: t('nav_chat'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" size={size} color={color} />
          ),
          headerShown: !CHAT_STACK_SCREENS_WITH_OWN_HEADER.includes(
            getFocusedRouteNameFromRoute(route) ?? 'ChannelList'
          ),
        })}
        listeners={({ navigation: tabNav }) => ({
          tabPress: () => { tabNav.navigate('ChatTab', { screen: 'ChannelList' }); },
        })}
      />
      <Tab.Screen
        name="DmTab"
        component={DmTab}
        options={({ route }) => ({
          title: t('nav_dms'),
          tabBarLabel: t('nav_dms'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="mail-outline" size={size} color={color} />
          ),
          headerShown: !DM_STACK_SCREENS_WITH_OWN_HEADER.includes(
            getFocusedRouteNameFromRoute(route) ?? 'DmList'
          ),
        })}
        listeners={({ navigation: tabNav }) => ({
          tabPress: () => { tabNav.navigate('DmTab', { screen: 'DmList' }); },
        })}
      />
      <Tab.Screen
        name="SearchTab"
        component={SearchTab}
        options={({ route }) => ({
          title: t('nav_search'),
          tabBarLabel: t('nav_search'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="search-outline" size={size} color={color} />
          ),
          headerShown: !SEARCH_STACK_SCREENS_WITH_OWN_HEADER.includes(
            getFocusedRouteNameFromRoute(route) ?? 'SearchHome'
          ),
        })}
        listeners={({ navigation: tabNav }) => ({
          tabPress: () => { tabNav.navigate('SearchTab', { screen: 'SearchHome' }); },
        })}
      />
      <Tab.Screen
        name="MoreTab"
        component={MoreTab}
        options={({ route }) => ({
          title: t('nav_settings'),
          tabBarLabel: t('nav_more'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal" size={size} color={color} />
          ),
          headerShown: !MORE_STACK_SCREENS_WITH_OWN_HEADER.includes(
            getFocusedRouteNameFromRoute(route) ?? 'Settings'
          ),
        })}
        listeners={({ navigation: tabNav }) => ({
          tabPress: (e) => {
            // Reset MoreStack to Settings when tab is pressed
            tabNav.navigate('MoreTab', { screen: 'Settings' });
          },
        })}
      />
    </Tab.Navigator>
    </>
  );
}
