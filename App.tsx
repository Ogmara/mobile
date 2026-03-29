/**
 * Ogmara Mobile — main app entry point.
 *
 * Initializes polyfills, i18n, theme, navigation, app lock, and push.
 * Reads the default start screen setting before rendering.
 */

// Polyfills must be imported FIRST (before any SDK usage)
import 'react-native-get-random-values';
import 'fast-text-encoding';

// Configure @noble/ed25519 to use pure JS SHA-512 instead of crypto.subtle
// (Hermes does not have SubtleCrypto)
import { sha512 } from '@noble/hashes/sha512';
import * as ed from '@noble/ed25519';
const sha512Noble = (...msgs: Uint8Array[]) => {
  const merged = new Uint8Array(msgs.reduce((sum, m) => sum + m.length, 0));
  let offset = 0;
  for (const m of msgs) { merged.set(m, offset); offset += m.length; }
  return sha512(merged);
};
ed.etc.sha512Sync = sha512Noble;
ed.etc.sha512Async = async (...msgs: Uint8Array[]) => sha512Noble(...msgs);

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, type NavigationContainerRef } from '@react-navigation/native';
import * as Notifications from 'expo-notifications';
import { ThemeProvider, useTheme } from './src/theme';
import { ConnectionProvider } from './src/context/ConnectionContext';
import { getStartScreen, type StartScreen } from './src/lib/settings';
import { isLockEnabled, getLockTimeout } from './src/lib/appLock';
import { initDebugMode, installGlobalErrorHandler, debugLog } from './src/lib/debug';
import { runVaultMigrations, verifyVaultIntegrity } from './src/lib/vaultMigration';
import { setupNotificationChannel, parseNotificationData } from './src/lib/push';
import { getLinkingConfig } from './src/lib/deepLinks';
import TabNavigator from './src/navigation/TabNavigator';
import LockScreen from './src/screens/LockScreen';

// Initialize i18n (side-effect import)
import './src/i18n/init';

/** Inner app — needs ThemeProvider to be a parent. */
function AppContent() {
  const { isDark, colors } = useTheme();
  const [startScreen, setStartScreen] = useState<StartScreen | null>(null);
  const [locked, setLocked] = useState<boolean | null>(null); // null = loading
  const lockedRef = useRef<boolean | null>(null);
  const lastBackgroundRef = useRef<number>(0);
  const navigationRef = useRef<NavigationContainerRef<{}>>(null);

  // Load initial state
  useEffect(() => {
    async function init() {
      // Initialize debug mode and global error handler
      await initDebugMode().catch(() => {});
      installGlobalErrorHandler();
      debugLog('info', 'App starting v0.4.1');

      // Run vault migrations FIRST (safe on every launch)
      await runVaultMigrations().catch((e) => {
        debugLog('error', 'Vault migration failed', e);
      });

      // Verify vault integrity (log warning if corrupt, don't crash)
      const integrity = await verifyVaultIntegrity().catch(() => null);
      if (integrity && !integrity.healthy && integrity.hasWallet) {
        console.warn('Vault integrity check failed — wallet data may be corrupt');
      }

      const [screen, lockEnabled] = await Promise.all([
        getStartScreen().catch(() => 'news' as StartScreen),
        isLockEnabled().catch(() => false),
      ]);
      setStartScreen(screen);
      setLocked(lockEnabled);

      // Set up Android notification channels
      setupNotificationChannel();
    }
    init();
  }, []);

  // Auto-lock on app background per spec 05-clients.md 5.6.3
  useEffect(() => {
    const handleAppState = async (nextState: AppStateStatus) => {
      if (nextState === 'background') {
        lastBackgroundRef.current = Date.now();
      } else if (nextState === 'active' && lastBackgroundRef.current > 0) {
        const elapsed = (Date.now() - lastBackgroundRef.current) / 1000;
        const timeout = await getLockTimeout().catch(() => 300);
        const lockEnabled = await isLockEnabled().catch(() => false);
        if (lockEnabled && elapsed >= timeout) {
          setLocked(true);
        }
      }
    };
    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, []);

  // Keep lockedRef in sync with state for use in listeners
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  // Handle notification taps — navigate to the relevant screen
  // Stores pending navigation if app is locked, executes after unlock
  const pendingNavRef = useRef<{ screen: string; params: Record<string, unknown> } | null>(null);

  useEffect(() => {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      const data = response.notification.request.content.data;
      if (!data) return;
      const route = parseNotificationData(data as Record<string, unknown>);
      if (!route) return;

      if (lockedRef.current) {
        pendingNavRef.current = route;
      } else if (navigationRef.current) {
        // @ts-expect-error — dynamic navigation
        navigationRef.current.navigate(route.screen, route.params);
      }
    });
    return () => sub.remove();
  }, [locked]);

  // useMemo MUST be before any conditional returns (React rules of hooks)
  const navTheme = useMemo(
    () => ({
      dark: isDark,
      colors: {
        primary: colors.accentPrimary,
        background: colors.bgPrimary,
        card: colors.bgSecondary,
        text: colors.textPrimary,
        border: colors.border,
        notification: colors.error,
      },
      fonts: {
        regular: { fontFamily: 'System', fontWeight: '400' as const },
        medium: { fontFamily: 'System', fontWeight: '500' as const },
        bold: { fontFamily: 'System', fontWeight: '700' as const },
        heavy: { fontFamily: 'System', fontWeight: '900' as const },
      },
    }),
    [isDark, colors],
  );

  // Still loading initial state
  if (startScreen === null || locked === null) return null;

  // Show lock screen if app is locked
  if (locked) {
    return (
      <LockScreen
        onUnlock={() => {
          setLocked(false);
          if (pendingNavRef.current && navigationRef.current) {
            const route = pendingNavRef.current;
            pendingNavRef.current = null;
            setTimeout(() => {
              // @ts-expect-error — dynamic navigation
              navigationRef.current?.navigate(route.screen, route.params);
            }, 100);
          }
        }}
      />
    );
  }

  return (
    <NavigationContainer ref={navigationRef} theme={navTheme} linking={getLinkingConfig()}>
      <TabNavigator startScreen={startScreen} />
      <StatusBar style={isDark ? 'light' : 'dark'} />
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <ConnectionProvider>
        <AppContent />
      </ConnectionProvider>
    </ThemeProvider>
  );
}
