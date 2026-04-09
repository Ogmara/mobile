/**
 * Create Channel — UI for creating a new chat channel.
 *
 * Supports three types:
 * - Public (type 0): discoverable, everyone can read and write
 * - Read-Public (type 1): discoverable, everyone reads, only admins write
 * - Private (type 2): L2-only, invitation-based, channel ID from Keccak-256
 *
 * Uses SDK client.createChannel() for clean API interaction.
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
import { debugLog } from '../lib/debug';

export default function CreateChannelScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address: myAddress } = useConnection();
  const navigation = useNavigation();
  const [slug, setSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [description, setDescription] = useState('');
  const [channelType, setChannelType] = useState<0 | 1 | 2>(0);
  const [creating, setCreating] = useState(false);

  const handleCreate = async () => {
    const trimmedSlug = slug.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '-');
    if (!trimmedSlug) {
      Alert.alert(t('error_generic'), t('channel_slug_required'));
      return;
    }
    if (!client || !signer) {
      Alert.alert(t('error_generic'), t('wallet_connect'));
      return;
    }

    setCreating(true);
    try {
      await client.createChannel({
        slug: trimmedSlug,
        channel_type: channelType,
        display_name: displayName.trim() || undefined,
        description: description.trim() || undefined,
        content_rating: 0,
      });

      Alert.alert(t('channel_created'), `#${trimmedSlug}`, [
        { text: t('done'), onPress: () => navigation.goBack() },
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      debugLog('warn', `Channel creation failed: ${msg}`);
      Alert.alert(t('channel_create_failed'), msg.slice(0, 200));
    } finally {
      setCreating(false);
    }
  };

  const typeOptions: { value: 0 | 1 | 2; label: string }[] = [
    { value: 0, label: t('channel_type_public') },
    { value: 1, label: t('channel_type_read_public') },
    { value: 2, label: t('channel_type_private') },
  ];

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: colors.bgPrimary }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[styles.heading, { color: colors.textPrimary }]}>{t('channel_create')}</Text>

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('channel_slug_label')}</Text>
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

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('channel_name_label')}</Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder={t('channel_name_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={64}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('channel_desc_label')}</Text>
        <TextInput
          style={[styles.input, styles.textArea, { color: colors.textPrimary, backgroundColor: colors.bgTertiary }]}
          placeholder={t('channel_desc_placeholder')}
          placeholderTextColor={colors.textSecondary}
          value={description}
          onChangeText={setDescription}
          multiline
          maxLength={256}
          textAlignVertical="top"
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('channel_type_label')}</Text>
        <View style={styles.typeRow}>
          {typeOptions.map((opt) => (
            <TouchableOpacity
              key={opt.value}
              style={[styles.typeBtn, { backgroundColor: channelType === opt.value ? colors.accentPrimary : colors.bgSecondary }]}
              onPress={() => setChannelType(opt.value)}
            >
              <Text style={{ color: channelType === opt.value ? colors.textInverse : colors.textPrimary, fontWeight: '600', fontSize: fontSize.sm }}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {channelType === 2 && (
          <Text style={[styles.hint, { color: colors.textSecondary }]}>
            {t('channel_private_hint')}
          </Text>
        )}

        <TouchableOpacity
          style={[styles.createBtn, { backgroundColor: creating ? colors.textSecondary : colors.accentPrimary }]}
          onPress={handleCreate}
          disabled={creating}
        >
          <Text style={[styles.createBtnText, { color: colors.textInverse }]}>
            {creating ? t('loading') : t('channel_create')}
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
  typeRow: { flexDirection: 'row', gap: spacing.sm },
  typeBtn: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  hint: { fontSize: fontSize.xs, marginTop: spacing.sm, fontStyle: 'italic' },
  createBtn: { marginTop: spacing.xl, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  createBtnText: { fontSize: fontSize.md, fontWeight: '600' },
});
