/**
 * Debug mode — in-app logging and crash diagnostics.
 *
 * When enabled, collects logs in memory and displays them in a
 * debug overlay accessible from Settings. Useful for testing
 * without adb/logcat access.
 *
 * Default: ON during development, OFF in production.
 * Users can toggle it in Settings → About → Debug Mode.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const DEBUG_ENABLED_KEY = 'ogmara.debug.enabled';
const MAX_LOG_ENTRIES = 500;

interface LogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  data?: string;
}

/** In-memory log buffer. */
const logs: LogEntry[] = [];

let debugEnabled = __DEV__; // default ON in dev, OFF in production

/** Initialize debug mode from saved preference. */
export async function initDebugMode(): Promise<void> {
  try {
    const saved = await AsyncStorage.getItem(DEBUG_ENABLED_KEY);
    if (saved !== null) {
      debugEnabled = saved === 'true';
    }
  } catch {
    // Fall back to default
  }
}

/** Check if debug mode is enabled. */
export function isDebugEnabled(): boolean {
  return debugEnabled;
}

/** Enable or disable debug mode. */
export async function setDebugEnabled(enabled: boolean): Promise<void> {
  debugEnabled = enabled;
  await AsyncStorage.setItem(DEBUG_ENABLED_KEY, enabled ? 'true' : 'false');
}

/** Log a debug message. */
export function debugLog(level: 'info' | 'warn' | 'error', message: string, data?: unknown): void {
  const entry: LogEntry = {
    timestamp: Date.now(),
    level,
    message,
    data: data !== undefined ? String(data) : undefined,
  };

  logs.push(entry);
  if (logs.length > MAX_LOG_ENTRIES) {
    logs.shift();
  }

  // Also forward to console in dev mode
  if (__DEV__) {
    const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
    fn(`[Ogmara:${level}] ${message}`, data ?? '');
  }
}

/** Get all log entries (newest first). */
export function getDebugLogs(): LogEntry[] {
  return [...logs].reverse();
}

/** Clear all log entries. */
export function clearDebugLogs(): void {
  logs.length = 0;
}

/** Format a log entry for display. */
export function formatLogEntry(entry: LogEntry): string {
  const time = new Date(entry.timestamp).toLocaleTimeString();
  const prefix = entry.level === 'error' ? 'ERR' : entry.level === 'warn' ? 'WRN' : 'INF';
  let line = `[${time}] ${prefix}: ${entry.message}`;
  if (entry.data) {
    line += `\n  ${entry.data}`;
  }
  return line;
}

/**
 * Global error handler — catches unhandled JS errors.
 * Install this early in the app lifecycle.
 */
export function installGlobalErrorHandler(): void {
  const originalHandler = ErrorUtils.getGlobalHandler();

  ErrorUtils.setGlobalHandler((error, isFatal) => {
    debugLog('error', `${isFatal ? 'FATAL' : 'Unhandled'}: ${error.message}`, error.stack?.slice(0, 500));

    // Call original handler (shows red screen in dev)
    if (originalHandler) {
      originalHandler(error, isFatal);
    }
  });

  // Catch unhandled promise rejections
  const tracking = require('promise/setimmediate/rejection-tracking');
  tracking.enable({
    allRejections: true,
    onUnhandled: (_id: number, error: Error) => {
      debugLog('error', `Unhandled promise: ${error?.message || error}`, error?.stack?.slice(0, 500));
    },
    onHandled: () => {},
  });
}
