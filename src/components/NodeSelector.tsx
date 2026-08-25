/**
 * NodeSelector — centered modal for choosing L2 node with ping display.
 *
 * Discovers available nodes, measures latency, displays as a list.
 * User taps to select; selection is persisted in settings.
 * Supports manual URL entry, delete for custom/dead nodes.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  ActivityIndicator,
  Modal,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { pingNode } from '@ogmara/sdk';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { getAvailableNodes, getCurrentNodeUrl } from '../lib/api';
import { useConnection } from '../context/ConnectionContext';
import type { NodeWithPing } from '@ogmara/sdk';
import AnchorBadge from './AnchorBadge';
import { showAlert } from '../components/AlertHost';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function NodeSelector({ visible, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { connectToNode } = useConnection();
  const [nodes, setNodes] = useState<NodeWithPing[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [addError, setAddError] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const url = await getCurrentNodeUrl();
      setCurrentUrl(url);
      // SC-driven discovery (on-chain registry + peers + known nodes). No hardcoded
      // seed — an empty result just means nothing was reachable; the user can add one.
      const discovered = await getAvailableNodes();
      setNodes(discovered);
    } catch {
      setNodes([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (visible) {
      refresh();
      setAddError('');
    }
  }, [visible, refresh]);

  const handleSelect = async (url: string) => {
    // Live switch through the connection manager (recreates the client, re-binds
    // device keys, persists the node + network). pin=true: an explicit user choice
    // the auto best-ping optimizer must not override. No app restart needed.
    await connectToNode(url, true);
    setCurrentUrl(url);
    onClose();
  };

  const handleAddManual = async () => {
    let url = manualUrl.trim().replace(/\/$/, '');
    if (!url) return;
    setAddError('');

    // Strip /api suffix — the SDK appends /api/v1/... automatically
    url = url.replace(/\/api\/?$/, '');

    try {
      const ping = await pingNode(url);
      if (ping < Infinity) {
        await handleSelect(url);
        setManualUrl('');
      } else {
        setAddError('Not an Ogmara node (no valid /api/v1/health response)');
      }
    } catch {
      setAddError('Not an Ogmara node (no valid /api/v1/health response)');
    }
  };

  const handleDelete = (url: string) => {
    // Don't allow deleting the currently selected node
    if (url === currentUrl) {
      showAlert('Cannot delete', 'Switch to another node first.');
      return;
    }
    showAlert(
      'Remove node',
      url.replace(/^https?:\/\//, ''),
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            setNodes((prev) => prev.filter((n) => n.url !== url));
          },
        },
      ],
    );
  };

  const pingColor = (ping: number) => {
    if (ping === Infinity) return '#6b7280'; // grey for unreachable
    if (ping < 100) return '#22c55e';
    if (ping < 300) return '#eab308';
    return '#ef4444';
  };

  const renderNode = ({ item }: { item: NodeWithPing }) => (
    <TouchableOpacity
      style={[
        styles.nodeItem,
        { backgroundColor: item.url === currentUrl ? colors.bgTertiary : colors.bgSecondary },
      ]}
      onPress={() => handleSelect(item.url)}
      onLongPress={() => handleDelete(item.url)}
    >
      <View style={styles.nodeLeft}>
        <Text style={[styles.nodeUrl, { color: colors.textPrimary }]} numberOfLines={1}>
          {item.url.replace(/^https?:\/\//, '')}
        </Text>
        {item.anchorStatus && item.anchorStatus.level !== 'none' && (
          <AnchorBadge level={item.anchorStatus.level} />
        )}
      </View>
      <View style={styles.nodeRight}>
        <Text style={[styles.nodePing, { color: pingColor(item.ping) }]}>
          {item.ping < Infinity ? `${item.ping}ms` : '✕'}
        </Text>
        {item.url !== currentUrl && (
          <TouchableOpacity
            onPress={() => handleDelete(item.url)}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={[styles.deleteBtn, { color: colors.textSecondary }]}>✕</Text>
          </TouchableOpacity>
        )}
      </View>
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} animationType="fade" transparent onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.overlay}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: colors.bgPrimary }]}>
          <View style={styles.header}>
            <Text style={[styles.title, { color: colors.textPrimary }]}>
              {t('settings_node_url')}
            </Text>
            <TouchableOpacity onPress={refresh}>
              <Text style={{ color: colors.accentPrimary, fontSize: fontSize.md }}>
                {loading ? '...' : '↻'}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={onClose}>
              <Text style={{ color: colors.textSecondary, fontSize: fontSize.lg }}>✕</Text>
            </TouchableOpacity>
          </View>

          {/* Manual node input */}
          <View style={[styles.manualRow, { borderColor: colors.border }]}>
            <TextInput
              style={[styles.manualInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder="https://custom-node.example.com"
              placeholderTextColor={colors.textSecondary}
              value={manualUrl}
              onChangeText={(text) => { setManualUrl(text); setAddError(''); }}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              returnKeyType="go"
              onSubmitEditing={handleAddManual}
            />
            <TouchableOpacity
              style={[styles.manualBtn, { backgroundColor: colors.accentPrimary }]}
              onPress={handleAddManual}
            >
              <Text style={{ color: colors.textInverse, fontWeight: '700' }}>+</Text>
            </TouchableOpacity>
          </View>
          {addError ? (
            <Text style={[styles.errorText, { color: colors.error }]}>{addError}</Text>
          ) : null}

          {loading && nodes.length === 0 ? (
            <ActivityIndicator color={colors.accentPrimary} style={styles.loader} />
          ) : (
            <FlatList
              data={nodes}
              keyExtractor={(item) => item.url}
              renderItem={renderNode}
              contentContainerStyle={styles.list}
              keyboardShouldPersistTaps="handled"
              ListEmptyComponent={
                <Text style={[styles.hint, { color: colors.textSecondary }]}>
                  {t('node_none_found')}
                </Text>
              }
              ListFooterComponent={
                nodes.length > 0 ? (
                  <Text style={[styles.hint, { color: colors.textSecondary }]}>
                    Long-press or tap ✕ to remove a node
                  </Text>
                ) : null
              }
            />
          )}
        </View>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onClose} />
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  backdrop: {
    flex: 1,
  },
  sheet: {
    borderRadius: radius.lg,
    marginHorizontal: spacing.md,
    maxHeight: '65%',
    paddingBottom: spacing.md,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    gap: spacing.md,
  },
  title: { fontSize: fontSize.lg, fontWeight: '700', flex: 1 },
  list: { paddingHorizontal: spacing.md },
  loader: { padding: spacing.xl },
  nodeItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
    borderRadius: radius.md,
    marginBottom: spacing.xs,
  },
  nodeLeft: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: spacing.xs,
    flex: 1,
  },
  nodeRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  nodeUrl: { fontSize: fontSize.md, flex: 1 },
  nodePing: { fontSize: fontSize.sm, fontWeight: '700' },
  deleteBtn: { fontSize: fontSize.sm, opacity: 0.6 },
  manualRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    borderBottomWidth: 1,
    marginBottom: spacing.sm,
  },
  manualInput: {
    flex: 1,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    fontSize: fontSize.sm,
  },
  manualBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.sm,
  },
  errorText: {
    fontSize: fontSize.xs,
    paddingHorizontal: spacing.md,
    marginBottom: spacing.sm,
  },
  hint: {
    fontSize: fontSize.xs,
    textAlign: 'center',
    paddingVertical: spacing.md,
  },
});
