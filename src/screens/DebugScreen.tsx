/**
 * Debug Screen — in-app log viewer for testing and diagnostics.
 *
 * Shows captured debug logs with timestamps and levels.
 * Accessible from Settings → About → Debug Logs.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Share,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { getDebugLogs, clearDebugLogs, formatLogEntry, isDebugEnabled, setDebugEnabled } from '../lib/debug';
import { getVaultDiagnostics } from '../lib/vaultMigration';

export default function DebugScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { status, peers, address } = useConnection();
  const [logs, setLogs] = useState(getDebugLogs());
  const [debugOn, setDebugOn] = useState(isDebugEnabled());

  const refresh = useCallback(() => {
    setLogs(getDebugLogs());
  }, []);

  const handleClear = () => {
    clearDebugLogs();
    setLogs([]);
  };

  const handleToggle = async () => {
    const next = !debugOn;
    await setDebugEnabled(next);
    setDebugOn(next);
  };

  const handleExport = async () => {
    const diag = await getVaultDiagnostics().catch(() => ({}));
    const report = [
      `Ogmara Debug Report`,
      `Version: 0.4.0`,
      `Status: ${status}`,
      `Peers: ${peers}`,
      `Wallet: ${address ? address.slice(0, 16) + '...' : 'none'}`,
      `Vault: ${JSON.stringify(diag)}`,
      `---`,
      ...getDebugLogs().map(formatLogEntry),
    ].join('\n');

    Share.share({ message: report, title: 'Ogmara Debug Report' });
  };

  const levelColor = (level: string) => {
    if (level === 'error') return colors.error;
    if (level === 'warn') return colors.warning;
    return colors.textSecondary;
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      {/* Status bar */}
      <View style={[styles.statusBar, { backgroundColor: colors.bgSecondary }]}>
        <Text style={[styles.statusText, { color: status === 'connected' ? colors.success : colors.error }]}>
          {status} ({peers} peers)
        </Text>
        <Text style={[styles.statusText, { color: colors.textSecondary }]}>
          {address ? address.slice(0, 12) + '...' : 'no wallet'}
        </Text>
      </View>

      {/* Action buttons */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: debugOn ? colors.success : colors.bgTertiary }]}
          onPress={handleToggle}
        >
          <Text style={{ color: debugOn ? colors.textInverse : colors.textPrimary, fontSize: fontSize.sm }}>
            Debug: {debugOn ? 'ON' : 'OFF'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.accentPrimary }]}
          onPress={refresh}
        >
          <Text style={{ color: colors.textInverse, fontSize: fontSize.sm }}>Refresh</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.accentSecondary }]}
          onPress={handleExport}
        >
          <Text style={{ color: colors.textInverse, fontSize: fontSize.sm }}>Export</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.btn, { backgroundColor: colors.error }]}
          onPress={handleClear}
        >
          <Text style={{ color: colors.textInverse, fontSize: fontSize.sm }}>Clear</Text>
        </TouchableOpacity>
      </View>

      {/* Log list */}
      <FlatList
        data={logs}
        keyExtractor={(_, i) => i.toString()}
        renderItem={({ item }) => (
          <View style={[styles.logRow, { borderBottomColor: colors.border }]}>
            <Text style={[styles.logLevel, { color: levelColor(item.level) }]}>
              {item.level.toUpperCase()}
            </Text>
            <View style={styles.logContent}>
              <Text style={[styles.logTime, { color: colors.textSecondary }]}>
                {new Date(item.timestamp).toLocaleTimeString()}
              </Text>
              <Text style={[styles.logMsg, { color: colors.textPrimary }]}>
                {item.message}
              </Text>
              {item.data && (
                <Text style={[styles.logData, { color: colors.textSecondary }]} numberOfLines={3}>
                  {item.data}
                </Text>
              )}
            </View>
          </View>
        )}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: colors.textSecondary }]}>
            No logs captured yet
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  statusBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: spacing.md,
  },
  statusText: { fontSize: fontSize.sm, fontWeight: '600' },
  actions: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  btn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
  },
  logRow: {
    flexDirection: 'row',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  logLevel: { fontSize: fontSize.xs, fontWeight: '700', width: 36 },
  logContent: { flex: 1, marginLeft: spacing.sm },
  logTime: { fontSize: fontSize.xs },
  logMsg: { fontSize: fontSize.sm, marginTop: 2 },
  logData: { fontSize: fontSize.xs, marginTop: 2, fontFamily: 'monospace' },
  empty: { textAlign: 'center', padding: spacing.xl, fontSize: fontSize.md },
});
