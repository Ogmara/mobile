/**
 * DM List — direct message conversations.
 *
 * Lists conversations ordered by last activity. Requires wallet auth.
 * FAB for starting a new DM by entering a klv1 address.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  FlatList,
  RefreshControl,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { useApi } from '../hooks/useApi';
import type { DmConversation } from '@ogmara/sdk';
import type { DmStackParamList } from '../navigation/types';

type NavProp = NativeStackNavigationProp<DmStackParamList, 'DmList'>;

export default function DmListScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer } = useConnection();
  const navigation = useNavigation<NavProp>();
  const [newDmOpen, setNewDmOpen] = useState(false);
  const [newDmAddress, setNewDmAddress] = useState('');

  const { data, refreshing, onRefresh } = useApi(
    async () => {
      if (!client || !signer) return { conversations: [], total: 0 };
      return client.getDmConversations();
    },
    [client, signer],
  );

  const conversations = data?.conversations ?? [];

  const handleStartDm = () => {
    const addr = newDmAddress.trim();
    if (!addr.startsWith('klv1') || addr.length < 10) {
      Alert.alert('Invalid address', 'Enter a valid klv1... address');
      return;
    }
    setNewDmOpen(false);
    setNewDmAddress('');
    navigation.navigate('DmConversation', { address: addr });
  };

  const renderConversation = ({ item }: { item: DmConversation }) => (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.border }]}
      activeOpacity={0.7}
      onPress={() => navigation.navigate('DmConversation', { address: item.peer })}
    >
      <View style={[styles.avatar, { backgroundColor: colors.accentPrimary }]}>
        <Text style={[styles.avatarText, { color: colors.textInverse }]}>
          {item.peer[4]?.toUpperCase() || '?'}
        </Text>
      </View>
      <View style={styles.rowContent}>
        <Text style={[styles.peer, { color: colors.textPrimary }]}>
          {item.peer.slice(0, 16)}...
        </Text>
        <Text style={[styles.time, { color: colors.textSecondary }]}>
          {new Date(item.last_message_at).toLocaleDateString()}
        </Text>
      </View>
      {item.unread_count > 0 && (
        <View style={[styles.unread, { backgroundColor: colors.accentPrimary }]}>
          <Text style={[styles.unreadText, { color: colors.textInverse }]}>
            {item.unread_count}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );

  if (!signer) {
    return (
      <View style={[styles.container, styles.empty, { backgroundColor: colors.bgPrimary }]}>
        <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
          {t('wallet_connect')}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <FlatList
        data={conversations}
        keyExtractor={(item) => item.conversation_id}
        renderItem={renderConversation}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accentPrimary}
          />
        }
        contentContainerStyle={conversations.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              No conversations yet
            </Text>
          </View>
        }
      />

      {/* New DM FAB */}
      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.accentPrimary }]}
        onPress={() => setNewDmOpen(true)}
      >
        <Text style={[styles.fabText, { color: colors.textInverse }]}>+</Text>
      </TouchableOpacity>

      {/* New DM modal */}
      <Modal visible={newDmOpen} transparent animationType="fade" onRequestClose={() => setNewDmOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setNewDmOpen(false)}>
          <View style={[styles.modalContent, { backgroundColor: colors.bgSecondary }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>New Message</Text>
            <TextInput
              style={[styles.modalInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder="klv1... address"
              placeholderTextColor={colors.textSecondary}
              value={newDmAddress}
              onChangeText={setNewDmAddress}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: colors.accentPrimary }]}
              onPress={handleStartDm}
            >
              <Text style={[styles.modalBtnText, { color: colors.textInverse }]}>Start Conversation</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  emptyContainer: { flex: 1 },
  empty: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  emptyText: { fontSize: fontSize.md },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
  },
  avatarText: { fontSize: fontSize.lg, fontWeight: '600' },
  rowContent: { flex: 1, marginLeft: spacing.md },
  peer: { fontSize: fontSize.md, fontWeight: '600' },
  time: { fontSize: fontSize.xs, marginTop: spacing.xs },
  unread: {
    minWidth: 24,
    height: 24,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
  },
  unreadText: { fontSize: fontSize.xs, fontWeight: '700' },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    width: 56,
    height: 56,
    borderRadius: radius.full,
    justifyContent: 'center',
    alignItems: 'center',
    elevation: 4,
  },
  fabText: { fontSize: fontSize.xl, fontWeight: '600' },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    width: '85%',
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  modalTitle: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.md },
  modalInput: {
    padding: spacing.md,
    borderRadius: radius.md,
    fontSize: fontSize.sm,
    marginBottom: spacing.md,
  },
  modalBtn: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: 'center',
  },
  modalBtnText: { fontSize: fontSize.md, fontWeight: '600' },
});
