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
import { useNavigation } from '@react-navigation/native';
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
} from './types';

// Screens
import NewsFeedScreen from '../screens/NewsFeedScreen';
import NewsDetailScreen from '../screens/NewsDetailScreen';
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
import CreateChannelScreen from '../screens/CreateChannelScreen';
import UserProfileScreen from '../screens/UserProfileScreen';

const Tab = createBottomTabNavigator();
const NewsStack = createNativeStackNavigator<NewsStackParamList>();
const ChatStack = createNativeStackNavigator<ChatStackParamList>();
const DmStack = createNativeStackNavigator<DmStackParamList>();
const MoreStack = createNativeStackNavigator<MoreStackParamList>();

function NewsTab() {
  return (
    <NewsStack.Navigator screenOptions={{ headerShown: false }}>
      <NewsStack.Screen name="NewsFeed" component={NewsFeedScreen} />
      <NewsStack.Screen name="NewsDetail" component={NewsDetailScreen} />
      <NewsStack.Screen name="ComposePost" component={ComposePostScreen} />
      <NewsStack.Screen name="UserProfile" component={UserProfileScreen} />
    </NewsStack.Navigator>
  );
}

function ChatTab() {
  return (
    <ChatStack.Navigator screenOptions={{ headerShown: false }}>
      <ChatStack.Screen name="ChannelList" component={ChatScreen} />
      <ChatStack.Screen name="CreateChannel" component={CreateChannelScreen} />
      <ChatStack.Screen name="ChannelMessages" component={ChannelMessagesScreen} />
      <ChatStack.Screen name="UserProfile" component={UserProfileScreen} />
    </ChatStack.Navigator>
  );
}

function DmTab() {
  return (
    <DmStack.Navigator screenOptions={{ headerShown: false }}>
      <DmStack.Screen name="DmList" component={DmListScreen} />
      <DmStack.Screen name="DmConversation" component={DmConversationScreen} />
      <DmStack.Screen name="UserProfile" component={UserProfileScreen} />
    </DmStack.Navigator>
  );
}

function MoreTab() {
  return (
    <MoreStack.Navigator screenOptions={{ headerShown: false }}>
      <MoreStack.Screen name="Settings" component={SettingsScreen} />
      <MoreStack.Screen name="Bookmarks" component={BookmarksScreen} />
      <MoreStack.Screen name="Addressbook" component={AddressbookScreen} />
      <MoreStack.Screen name="Wallet" component={WalletScreen} />
      <MoreStack.Screen name="WalletBalance" component={WalletBalanceScreen} />
      <MoreStack.Screen name="PinSetup" component={PinSetupScreen} />
      <MoreStack.Screen name="DebugLogs" component={DebugScreen} />
      <MoreStack.Screen name="UserProfile" component={UserProfileScreen} />
    </MoreStack.Navigator>
  );
}

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
    { icon: 'people-outline' as const, label: 'Followed', onPress: () => nav.navigate('NewsTab') },
    { icon: 'bookmarks-outline' as const, label: 'Bookmarks', onPress: () => nav.navigate('MoreTab', { screen: 'Bookmarks' }) },
    { icon: 'book-outline' as const, label: 'Addressbook', onPress: () => nav.navigate('MoreTab', { screen: 'Addressbook' }) },
    { icon: 'wallet-outline' as const, label: 'Wallet', onPress: () => nav.navigate('MoreTab', { screen: 'WalletBalance' }) },
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
        options={{
          title: t('nav_news'),
          tabBarLabel: t('nav_news'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="newspaper-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="ChatTab"
        component={ChatTab}
        options={{
          title: t('nav_chat'),
          tabBarLabel: t('nav_chat'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="chatbubbles-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="DmTab"
        component={DmTab}
        options={{
          title: t('nav_dms'),
          tabBarLabel: t('nav_dms'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="mail-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="SearchTab"
        component={SearchScreen}
        options={{
          title: t('nav_search'),
          tabBarLabel: t('nav_search'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="search-outline" size={size} color={color} />
          ),
        }}
      />
      <Tab.Screen
        name="MoreTab"
        component={MoreTab}
        options={{
          title: t('nav_settings'),
          tabBarLabel: t('nav_more'),
          tabBarIcon: ({ color, size }) => (
            <Ionicons name="ellipsis-horizontal" size={size} color={color} />
          ),
        }}
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
