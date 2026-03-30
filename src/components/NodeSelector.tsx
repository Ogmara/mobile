/**
 * NodeSelector — modal/bottom sheet for choosing L2 node with ping display.
 *
 * Discovers available nodes, measures latency, displays as a list.
 * User taps to select; selection is persisted in settings.
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
} from 'react-native';
import { pingNode } from '@ogmara/sdk';
import { useTranslation } from 'react-i18next';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { getAvailableNodes, getCurrentNodeUrl, switchNode } from '../lib/api';
import type { NodeWithPing } from '@ogmara/sdk';

interface Props {
  visible: boolean;
  onClose: () => void;
}

export default function NodeSelector({ visible, onClose }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [nodes, setNodes] = useState<NodeWithPing[]>([]);
  const [loading, setLoading] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');
  const [manualUrl, setManualUrl] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const url = await getCurrentNodeUrl();
      setCurrentUrl(url);
      const discovered = await getAvailableNodes();
      setNodes(discovered);
    } catch {
      // Discovery failed
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (visible) refresh();
  }, [visible, refresh]);

  const handleSelect = async (url: string) => {
    await switchNode(url);
    setCurrentUrl(url);
    onClose();
  };

  const pingColor = (ping: number) => {
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
    >
      <Text style={[styles.nodeUrl, { color: colors.textPrimary }]}>
        {item.url.replace(/^https?:\/\//, '')}
      </Text>
      <Text style={[styles.nodePing, { color: pingColor(item.ping) }]}>
        {item.ping}ms
      </Text>
    </TouchableOpacity>
  );

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.overlay}>
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
              onChangeText={setManualUrl}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <TouchableOpacity
              style={[styles.manualBtn, { backgroundColor: colors.accentPrimary }]}
              onPress={async () => {
                const url = manualUrl.trim().replace(/\/$/, '');
                if (!url) return;
                const ping = await pingNode(url);
                if (ping < Infinity) {
                  await handleSelect(url);
                  setManualUrl('');
                }
              }}
            >
              <Text style={{ color: colors.textInverse, fontWeight: '700' }}>+</Text>
            </TouchableOpacity>
          </View>

          {loading && nodes.length === 0 ? (
            <ActivityIndicator color={colors.accentPrimary} style={styles.loader} />
          ) : (
            <FlatList
              data={nodes}
              keyExtractor={(item) => item.url}
              renderItem={renderNode}
              contentContainerStyle={styles.list}
            />
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    maxHeight: '60%',
    paddingBottom: spacing.xl,
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
  nodeUrl: { fontSize: fontSize.md, flex: 1 },
  nodePing: { fontSize: fontSize.sm, fontWeight: '700' },
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
});
