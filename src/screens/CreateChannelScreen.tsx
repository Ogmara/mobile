/**
 * Create Channel — UI for creating a new chat channel.
 *
 * Flow: user fills in channel details → app sends ChannelCreate envelope.
 * TODO: In production, this should first call the Klever SC `createChannel`
 * to get an on-chain channel_id, then send the envelope to the L2 node.
 * For testnet, we send directly to the L2 node which assigns the ID.
 */

import React, { useState } from 'react';
import {
  View,
  Text,
  TextInput,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { buildEnvelope, MessageType } from '@ogmara/sdk';
import { debugLog } from '../lib/debug';

export default function CreateChannelScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer } = useConnection();
  const navigation = useNavigation();
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [channelType, setChannelType] = useState<0 | 1>(0); // 0=public, 1=read-public
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    if (!slug.trim()) {
      Alert.alert('Error', 'Channel slug is required');
      return;
    }
    if (!client || !signer) {
      Alert.alert('Error', t('wallet_connect'));
      return;
    }

    setCreating(true);
    try {
      // Build ChannelCreate envelope
      // TODO: First call Klever SC createChannel to get on-chain channel_id
      // For testnet, the L2 node assigns the ID from the envelope
      const payload = {
        channel_id: 0, // node assigns
        slug: slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-'),
        channel_type: channelType,
        display_name: displayName.trim() || null,
        description: description.trim() || null,
        content_rating: 0,
        moderation: {
          admins: [signer.address],
          rules: null,
        },
      };

      const envelope = await buildEnvelope(
        signer,
        MessageType.ChannelCreate,
        payload,
      );

      await client.createChannel(envelope);
      Alert.alert('Channel created', `#${slug.trim()}`, [
        { text: 'OK', onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Channel creation failed: ${msg}`);
      Alert.alert('Failed to create channel', msg.slice(0, 200));
    } finally {
      setCreating(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>Create Channel</Text>

        <Text style={[styles.label, { color: colors.textSecondary }]}>Slug (unique name)</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder="my-channel"
          placeholderTextColor={colors.textSecondary}
          value={slug}
          onChangeText={setSlug}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={64}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>Display Name (optional)</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder="My Channel"
          placeholderTextColor={colors.textSecondary}
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={64}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>Description (optional)</Text>
        <TextInput
          style={[styles.input, styles.textArea, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder="What's this channel about?"
          placeholderTextColor={colors.textSecondary}
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={256}
          textAlignVertical="top"
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>Type</Text>
        <View style={styles.typeRow}>
          <TouchableOpacity
            style={[styles.typeBtn, { backgroundColor: channelType === 0 ? colors.accentPrimary : colors.bgSecondary }]}
            onPress={() => setChannelType(0)}
          >
            <Text style={{ color: channelType === 0 ? colors.textInverse : colors.textPrimary, fontWeight: '600' }}>
              Public
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={[styles.typeBtn, { backgroundColor: channelType === 1 ? colors.accentPrimary : colors.bgSecondary }]}
            onPress={() => setChannelType(1)}
          >
            <Text style={{ color: channelType === 1 ? colors.textInverse : colors.textPrimary, fontWeight: '600' }}>
              Read-Only
            </Text>
          </TouchableOpacity>
        </View>

        <TouchableOpacity
          style={[styles.createBtn, { backgroundColor: creating ? colors.textSecondary : colors.accentPrimary }]}
          onPress={handleCreate}
          disabled={creating}
        >
          <Text style={[styles.createBtnText, { color: colors.textInverse }]}>
            {creating ? 'Creating...' : 'Create Channel'}
          </Text>
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg },
  heading: { fontSize: fontSize.xl, fontWeight: '700', marginBottom: spacing.lg },
  label: { fontSize: fontSize.sm, fontWeight: '600', marginBottom: spacing.xs, marginTop: spacing.md },
  input: { padding: spacing.md, borderRadius: radius.md, fontSize: fontSize.md },
  textArea: { minHeight: 80 },
  typeRow: { flexDirection: 'row', gap: spacing.md },
  typeBtn: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  createBtn: { marginTop: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  createBtnText: { fontSize: fontSize.md, fontWeight: '600' },
});
