/**
 * Edit Profile — display name, bio and avatar for the ACTIVE account.
 *
 * Lives in its own screen rather than inside Settings so it can be reached
 * from the Accounts list, which is where a multi-account user goes to think
 * about "who am I right now". The profile always belongs to whichever account
 * is active: `updateProfile` is authenticated with that account's key, so
 * editing another account's profile means switching to it first — which is
 * what the Accounts screen does before navigating here.
 *
 * The avatar is uploaded to the node, not just remembered locally. The old
 * Settings card only ever wrote `avatarLocalUri`, so a picture chosen on the
 * phone stayed on that phone and every other client kept showing the default —
 * the picture looked editable but never actually changed.
 */

import React, { useEffect, useState } from 'react';
import {
  View,
  Text,
  TextInput,
  Image,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useTranslation } from 'react-i18next';
import { useNavigation } from '@react-navigation/native';
import KeyboardAwareView from '../components/KeyboardAwareView';
import { useTheme, spacing, fontSize, radius } from '../theme';
import { useConnection } from '../context/ConnectionContext';
import { getSetting, setSetting } from '../lib/settings';
import { setCachedUser } from '../lib/userCache';
import { sanitizeFilename } from '../lib/sanitize';
import { showAlert } from '../components/AlertHost';
import { debugLog } from '../lib/debug';
import Button from '../components/Button';

/** Avatars are small by nature; anything larger is a mistake, not a portrait. */
const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export default function EditProfileScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { client, signer, address, refreshProfile } = useConnection();
  const navigation = useNavigation<any>();

  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  /** Avatar resolved from the node profile's `avatar_cid`. Used when this device
   *  has no local copy — an imported account, a reinstall, or a picture that was
   *  uploaded from another device. */
  const [remoteAvatarUrl, setRemoteAvatarUrl] = useState<string | null>(null);
  /** Set only when the user picks a NEW image, so saving without touching the
   *  avatar does not re-upload the existing one on every save. */
  const [pickedAvatar, setPickedAvatar] = useState<ImagePicker.ImagePickerAsset | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getSetting('displayName').then((n) => { if (!cancelled && n) setDisplayName((cur) => cur || n); });
    getSetting('bio').then((b) => { if (!cancelled && b) setBio((cur) => cur || b); });
    getSetting('avatarLocalUri').then((u) => { if (!cancelled && u) setAvatarUri((cur) => cur || u); });
    return () => { cancelled = true; };
  }, []);

  // Pull the profile the network actually holds, so an avatar (or name/bio) that
  // only exists on the node still shows here. The old screen read local settings
  // only, so an imported account or a picture uploaded elsewhere looked empty.
  useEffect(() => {
    if (!client || !address) return;
    let cancelled = false;
    // A previously-saved CID resolves an avatar instantly, before the fetch lands.
    getSetting('avatarCid').then((cid) => {
      if (!cancelled && cid && client) setRemoteAvatarUrl(client.getMediaUrl(cid));
    });
    (async () => {
      try {
        const resp: any = await client.getUserProfile(address);
        const user = resp?.user;
        if (cancelled || !user) return;
        if (user.avatar_cid) setRemoteAvatarUrl(client.getMediaUrl(user.avatar_cid));
        // Prefill only what this device does not already know locally — never
        // overwrite an edit in progress or a value the user just typed. Clamp to
        // the same limits the inputs enforce, so a hostile node cannot seed an
        // oversized string that the user then saves under their key.
        setDisplayName((cur) => cur || (user.display_name ?? '').slice(0, 50));
        setBio((cur) => cur || (user.bio ?? '').slice(0, 200));
      } catch {
        // No profile on this node yet, or it is unreachable — fine, the local
        // fields and monogram stand.
      }
    })();
    return () => { cancelled = true; };
  }, [client, address]);

  const pickAvatar = async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.7,
    });
    if (result.canceled || !result.assets[0]) return;
    const asset = result.assets[0];
    if ((asset.fileSize ?? 0) > MAX_AVATAR_BYTES) {
      showAlert(t('error_generic'), t('profile_avatar_too_large'));
      return;
    }
    setAvatarUri(asset.uri);
    setPickedAvatar(asset);
  };

  /**
   * Upload the picked image and return its CID.
   *
   * Returns `null` when there is nothing new to upload. THROWS on a failed
   * upload rather than returning null, so the caller does not quietly save a
   * name change while silently dropping the picture the user just chose.
   */
  const uploadAvatar = async (): Promise<string | null> => {
    if (!pickedAvatar || !client) return null;
    const formData = new FormData();
    // React Native FormData takes {uri, type, name}, never a Blob.
    formData.append('file', {
      uri: pickedAvatar.uri,
      type: pickedAvatar.mimeType || 'image/jpeg',
      name: sanitizeFilename(pickedAvatar.fileName || 'avatar.jpg'),
    } as any);
    const headers = signer ? await client.authHeaders('POST', '/api/v1/media/upload') : {};
    const nodeUrl = (client as any).nodeUrl || '';
    const resp = await fetch(`${nodeUrl}/api/v1/media/upload`, {
      method: 'POST',
      headers: { ...headers },
      body: formData,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      throw new Error(`Upload failed (${resp.status}): ${body.slice(0, 150)}`);
    }
    const result = await resp.json();
    if (!result?.cid) throw new Error('Upload returned no CID');
    return result.cid as string;
  };

  const handleSave = async () => {
    if (!client || !signer) {
      showAlert(t('error_generic'), t('wallet_connect'));
      return;
    }
    setSaving(true);
    try {
      const avatarCid = await uploadAvatar();
      await client.updateProfile({
        display_name: displayName.trim() || undefined,
        bio: bio.trim() || undefined,
        avatar_cid: avatarCid ?? undefined,
      });
      // Persist locally only AFTER the node accepted it, so a rejected update
      // does not leave the app showing a name the network never took.
      //
      // Empty means "leave unchanged", NOT "clear": `updateProfile` omits
      // undefined fields, so the node keeps its value. Clearing it locally
      // would diverge until the next profile fetch pulled the old name back.
      if (displayName.trim()) await setSetting('displayName', displayName.trim());
      if (bio.trim()) await setSetting('bio', bio.trim());
      if (pickedAvatar) await setSetting('avatarLocalUri', pickedAvatar.uri);
      // Remember the CID too, so a later open (or a device without the local
      // file) can resolve the avatar straight from settings without a fetch.
      if (avatarCid) await setSetting('avatarCid', avatarCid);
      if (address) {
        await setCachedUser(address, {
          displayName: displayName.trim() || null,
          bio: bio.trim() || null,
          ...(avatarCid ? { avatarCid } : {}),
        });
      }
      // The header shows the display name; without this it keeps the old one
      // until the next launch.
      await refreshProfile();
      navigation.goBack();
    } catch (e) {
      debugLog('warn', `Profile save failed: ${e instanceof Error ? e.message : ''}`);
      showAlert(t('error_generic'), e instanceof Error ? e.message.slice(0, 200) : '');
    } finally {
      setSaving(false);
    }
  };

  if (!address) {
    return (
      <View style={[styles.center, { backgroundColor: colors.bgPrimary }]}>
        <Text style={{ color: colors.textSecondary }}>{t('wallet_connect')}</Text>
      </View>
    );
  }

  return (
    <KeyboardAwareView style={{ flex: 1, backgroundColor: colors.bgPrimary }}>
      <ScrollView contentContainerStyle={styles.content}>
        <TouchableOpacity
          style={[styles.avatar, { backgroundColor: colors.accentPrimary }]}
          onPress={pickAvatar}
          activeOpacity={0.6}
        >
          {avatarUri || remoteAvatarUrl ? (
            <Image
              source={{ uri: (avatarUri || remoteAvatarUrl) as string }}
              style={styles.avatarImage}
              // A local picker-cache URI can be evicted by the OS, and a node
              // media URL can 404. Drop whichever one just failed so the render
              // falls through: local → node avatar → monogram, never a blank
              // circle.
              onError={() => (avatarUri ? setAvatarUri(null) : setRemoteAvatarUrl(null))}
            />
          ) : (
            <Text style={[styles.avatarText, { color: colors.textInverse }]}>
              {(displayName || address)[0]?.toUpperCase() || 'O'}
            </Text>
          )}
          <View style={[styles.avatarBadge, { backgroundColor: colors.bgSecondary }]}>
            <Text style={{ color: colors.accentPrimary, fontSize: fontSize.xs }}>
              {t('chat_edit')}
            </Text>
          </View>
        </TouchableOpacity>

        <Text style={[styles.addr, { color: colors.textSecondary }]} numberOfLines={1}>
          {address}
        </Text>

        <Text style={[styles.label, { color: colors.textSecondary }]}>
          {t('profile_display_name')}
        </Text>
        <TextInput
          style={[styles.input, { color: colors.textPrimary, backgroundColor: colors.bgSecondary }]}
          placeholder={t('profile_display_name')}
          placeholderTextColor={colors.textSecondary}
          value={displayName}
          onChangeText={setDisplayName}
          maxLength={50}
        />

        <Text style={[styles.label, { color: colors.textSecondary }]}>{t('profile_bio')}</Text>
        <TextInput
          style={[styles.input, styles.bioInput, { color: colors.textPrimary, backgroundColor: colors.bgSecondary }]}
          placeholder={t('profile_bio')}
          placeholderTextColor={colors.textSecondary}
          value={bio}
          onChangeText={setBio}
          maxLength={200}
          multiline
        />

        <Button
          label={t('save')}
          onPress={handleSave}
          loading={saving}
          fullWidth
          style={{ marginTop: spacing.lg }}
        />
      </ScrollView>
    </KeyboardAwareView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  content: { padding: spacing.lg, alignItems: 'center' },
  avatar: {
    width: 96, height: 96, borderRadius: radius.full,
    justifyContent: 'center', alignItems: 'center', overflow: 'hidden',
  },
  avatarImage: { width: '100%', height: '100%' },
  avatarText: { fontSize: 36, fontWeight: '700' },
  avatarBadge: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    paddingVertical: 2, alignItems: 'center',
  },
  addr: { fontSize: fontSize.xs, marginTop: spacing.sm, marginBottom: spacing.lg },
  label: { alignSelf: 'flex-start', fontSize: fontSize.sm, marginBottom: spacing.xs },
  input: {
    width: '100%', borderRadius: radius.md, padding: spacing.md,
    fontSize: fontSize.md, marginBottom: spacing.md,
  },
  bioInput: { minHeight: 90, textAlignVertical: 'top' },
});
