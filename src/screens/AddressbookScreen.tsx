/**
 * Addressbook — saved contacts list.
 *
 * Stores klv1 addresses with optional display names in AsyncStorage.
 * Tap a contact to open DM conversation.
 */

import React, { useState, useCallback } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  TouchableOpacity,
  Modal,
  TextInput,
  Alert,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';

const STORAGE_KEY = 'ogmara.addressbook';

interface Contact {
  address: string;
  name: string;
}

async function loadContacts(): Promise<Contact[]> {
  const raw = await AsyncStorage.getItem(STORAGE_KEY).catch(() => null);
  if (!raw) return [];
  try { return JSON.parse(raw); } catch { return []; }
}

async function saveContacts(contacts: Contact[]): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(contacts));
}

export default function AddressbookScreen() {
  const { colors } = useTheme();
  const navigation = useNavigation<any>();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [newAddr, setNewAddr] = useState('');
  const [newName, setNewName] = useState('');

  useFocusEffect(
    useCallback(() => {
      loadContacts().then(setContacts);
    }, []),
  );

  const handleAdd = async () => {
    const addr = newAddr.trim();
    const name = newName.trim();
    if (!addr.startsWith('klv1') || addr.length < 20) {
      Alert.alert('Invalid address', 'Enter a valid klv1... address');
      return;
    }
    if (contacts.some((c) => c.address === addr)) {
      Alert.alert('Duplicate', 'This address is already in your addressbook');
      return;
    }
    const updated = [...contacts, { address: addr, name: name || addr.slice(0, 16) }];
    await saveContacts(updated);
    setContacts(updated);
    setAddOpen(false);
    setNewAddr('');
    setNewName('');
  };

  const handleDelete = (addr: string) => {
    Alert.alert('Remove contact', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const updated = contacts.filter((c) => c.address !== addr);
          await saveContacts(updated);
          setContacts(updated);
        },
      },
    ]);
  };

  const renderContact = ({ item }: { item: Contact }) => (
    <TouchableOpacity
      style={[styles.row, { borderBottomColor: colors.border }]}
      onPress={() => navigation.navigate('DmTab', { screen: 'DmConversation', params: { address: item.address, displayName: item.name } })}
      onLongPress={() => handleDelete(item.address)}
      activeOpacity={0.7}
    >
      <View style={[styles.avatar, { backgroundColor: colors.accentPrimary }]}>
        <Text style={[styles.avatarText, { color: colors.textInverse }]}>
          {item.name[0]?.toUpperCase() || '?'}
        </Text>
      </View>
      <View style={styles.rowContent}>
        <Text style={[styles.contactName, { color: colors.textPrimary }]}>{item.name}</Text>
        <Text style={[styles.contactAddr, { color: colors.textSecondary }]} numberOfLines={1}>
          {item.address}
        </Text>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.bgPrimary }]}>
      <Text style={[styles.heading, { color: colors.textPrimary }]}>Addressbook</Text>
      <FlatList
        data={contacts}
        keyExtractor={(item) => item.address}
        renderItem={renderContact}
        contentContainerStyle={contacts.length === 0 ? styles.emptyContainer : undefined}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              No contacts yet. Tap + to add one.
            </Text>
          </View>
        }
        ListFooterComponent={
          contacts.length > 0 ? (
            <Text style={[styles.hint, { color: colors.textSecondary }]}>
              Long-press to remove a contact
            </Text>
          ) : null
        }
      />

      <TouchableOpacity
        style={[styles.fab, { backgroundColor: colors.accentPrimary }]}
        onPress={() => setAddOpen(true)}
      >
        <Text style={[styles.fabText, { color: colors.textInverse }]}>+</Text>
      </TouchableOpacity>

      <Modal visible={addOpen} transparent animationType="fade" onRequestClose={() => setAddOpen(false)}>
        <TouchableOpacity style={styles.modalOverlay} activeOpacity={1} onPress={() => setAddOpen(false)}>
          <View style={[styles.modalContent, { backgroundColor: colors.bgSecondary }]}>
            <Text style={[styles.modalTitle, { color: colors.textPrimary }]}>Add Contact</Text>
            <TextInput
              style={[styles.modalInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder="klv1... address"
              placeholderTextColor={colors.textSecondary}
              value={newAddr}
              onChangeText={setNewAddr}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TextInput
              style={[styles.modalInput, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
              placeholder="Display name (optional)"
              placeholderTextColor={colors.textSecondary}
              value={newName}
              onChangeText={setNewName}
              maxLength={50}
            />
            <TouchableOpacity
              style={[styles.modalBtn, { backgroundColor: colors.accentPrimary }]}
              onPress={handleAdd}
            >
              <Text style={[styles.modalBtnText, { color: colors.textInverse }]}>Add</Text>
            </TouchableOpacity>
          </View>
        </TouchableOpacity>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  heading: { fontSize: fontSize.xl, fontWeight: '700', padding: spacing.md, paddingBottom: spacing.sm },
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
  avatar: { width: 44, height: 44, borderRadius: radius.full, justifyContent: 'center', alignItems: 'center' },
  avatarText: { fontSize: fontSize.lg, fontWeight: '600' },
  rowContent: { flex: 1, marginLeft: spacing.md },
  contactName: { fontSize: fontSize.md, fontWeight: '600' },
  contactAddr: { fontSize: fontSize.xs, marginTop: 2 },
  hint: { fontSize: fontSize.xs, textAlign: 'center', padding: spacing.md },
  fab: { position: 'absolute', right: spacing.lg, bottom: spacing.lg, width: 56, height: 56, borderRadius: radius.full, justifyContent: 'center', alignItems: 'center', elevation: 4 },
  fabText: { fontSize: fontSize.xl, fontWeight: '600' },
  modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' },
  modalContent: { width: '85%', borderRadius: radius.lg, padding: spacing.lg },
  modalTitle: { fontSize: fontSize.lg, fontWeight: '700', marginBottom: spacing.md },
  modalInput: { padding: spacing.md, borderRadius: radius.md, fontSize: fontSize.sm, marginBottom: spacing.md },
  modalBtn: { paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  modalBtnText: { fontSize: fontSize.md, fontWeight: '600' },
});
