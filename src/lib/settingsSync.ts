/**
 * Settings sync — encrypt/decrypt user settings for cross-device sync via L2 node.
 *
 * Key derivation: HKDF-SHA256 from wallet private key → AES-256-GCM.
 *
 * Uses @noble/hashes and @noble/ciphers instead of crypto.subtle,
 * which is not available in React Native Hermes runtime.
 */

import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';
import { randomBytes } from '@noble/ciphers/webcrypto';
import { getSetting, setSetting } from './settings';
import { getClient } from './api';
import { vaultExportKey } from './vault';
import { ensureChannelOrgLoaded, getChannelOrg, applyRemoteOrg } from './channelOrg';
import { addJoinedChannels } from './joinedChannels';
import { ensureHiddenDmsLoaded, getHiddenDms, applyRemoteHiddenDms } from './dmHide';
import { ensureTopicGroupsLoaded, getTopicGroups, applyRemoteTopicGroups } from './topicGroups';

/** Settings keys that are synced across devices. */
const SYNC_KEYS = ['theme', 'lang', 'notificationSound', 'compactLayout', 'fontSize'] as const;

/** Object-valued synced setting (channel groups + custom ordering). Stored under
 *  its own key in the blob and applied via LWW merge, not the scalar setSetting path. */
const CHANNEL_ORG_KEY = 'channelOrg';
/** Hidden DM conversations (per-peer hide timestamp) — same object-valued pattern. */
const HIDDEN_DMS_KEY = 'hiddenDms';
/** Followed news hashtags + user-named subgroups — LWW by `updatedAt` on receipt. */
const TOPIC_GROUPS_KEY = 'topicGroups';

/** Highest `updatedAt` across the object-valued synced settings — the blob's
 *  cleartext "content last-edited at". Sent as `SettingsSyncData.updated_at` so
 *  the node can last-writer-wins across devices + the profile-topic gossip relay
 *  (l2-node 0.125.0+), and used to decide whether this device's copy is newer
 *  than a node's and should be re-uploaded to seed it. Callers must have
 *  hydrated the three caches first. hiddenDms has no single `updatedAt` — max
 *  the per-peer values. */
function syncedContentTimestamp(): number {
  const org = getChannelOrg() as { updatedAt?: number };
  const tg = getTopicGroups();
  const hidden = getHiddenDms() as Record<string, number>;
  const hiddenMax = Object.values(hidden).reduce((m, v) => (typeof v === 'number' && v > m ? v : m), 0);
  return Math.max(org?.updatedAt ?? 0, tg?.updatedAt ?? 0, hiddenMax);
}

/** Highest `updatedAt` present in a decrypted remote blob. */
function remoteContentTimestamp(settings: Record<string, unknown>): number {
  const org = settings?.[CHANNEL_ORG_KEY] as { updatedAt?: number } | undefined;
  const tg = settings?.[TOPIC_GROUPS_KEY] as { updatedAt?: number } | undefined;
  const hidden = settings?.[HIDDEN_DMS_KEY] as Record<string, number> | undefined;
  const hiddenMax = hidden
    ? Object.values(hidden).reduce((m, v) => (typeof v === 'number' && v > m ? v : m), 0)
    : 0;
  return Math.max(org?.updatedAt ?? 0, tg?.updatedAt ?? 0, hiddenMax);
}

function fromHex(hex: string): Uint8Array {
  if (!hex || hex.length === 0) return new Uint8Array(0);
  const matches = hex.match(/.{1,2}/g);
  if (!matches) return new Uint8Array(0);
  return new Uint8Array(matches.map((b) => parseInt(b, 16)));
}

/** Derive a 32-byte AES key from the wallet private key using HKDF-SHA256. */
function deriveKey(hexKey: string): Uint8Array {
  if (!hexKey || !/^[0-9a-fA-F]+$/.test(hexKey)) {
    throw new Error('Invalid key format');
  }
  const keyBytes = fromHex(hexKey);
  const salt = new TextEncoder().encode('ogmara-settings-sync');
  const info = new TextEncoder().encode('aes-256-gcm');
  const derived = hkdf(sha256, keyBytes, salt, info, 32);
  // Zero the input key material
  keyBytes.fill(0);
  return derived;
}

/** Collect current settings and encrypt them with AES-256-GCM. */
export async function encryptSettings(): Promise<{
  encrypted_settings: Uint8Array;
  nonce: Uint8Array;
  key_epoch: number;
  updated_at: number;
}> {
  const hexKey = await vaultExportKey();
  if (!hexKey) throw new Error('Cannot export wallet key for encryption');

  const settings: Record<string, unknown> = {};
  for (const key of SYNC_KEYS) {
    settings[key] = await getSetting(key);
  }
  // Channel organization (groups + custom ordering) — an object value, carried
  // with its own LWW `updatedAt` so the receiver can resolve multi-device edits.
  // Must be hydrated first: if Settings is opened before the Chat tab ever
  // mounts, the in-memory cache would still be the module-default emptyOrg(),
  // and uploading it would silently wipe any real synced state.
  await ensureChannelOrgLoaded();
  settings[CHANNEL_ORG_KEY] = getChannelOrg();
  // Hidden DM conversations — per-peer hide timestamps, merged by max() on receipt.
  await ensureHiddenDmsLoaded();
  settings[HIDDEN_DMS_KEY] = getHiddenDms();
  // Followed news topics — hashtags + subgroups, LWW by `updatedAt` on receipt.
  // Hydrate first for the same reason channelOrg does: an un-loaded cache is the
  // module-default emptyTopicGroups() and uploading it would wipe synced state.
  await ensureTopicGroupsLoaded();
  settings[TOPIC_GROUPS_KEY] = getTopicGroups();

  const plaintext = new TextEncoder().encode(JSON.stringify(settings));
  const key = deriveKey(hexKey);
  const nonce = randomBytes(12);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  // Zero the key
  key.fill(0);

  return {
    encrypted_settings: ciphertext,
    nonce,
    key_epoch: 0,
    // Cleartext LWW key for the node — the content's own edit time, NOT "now",
    // so re-uploading an unchanged copy to seed a fresh node can't jump ahead of
    // a newer copy on another node. Caches were hydrated above.
    updated_at: syncedContentTimestamp(),
  };
}

/** Decrypt settings blob and apply to local storage. */
export async function decryptAndApplySettings(
  encryptedSettings: number[],
  nonce: number[],
): Promise<void> {
  const hexKey = await vaultExportKey();
  if (!hexKey) throw new Error('Cannot export wallet key for decryption');

  const key = deriveKey(hexKey);
  const cipher = gcm(key, new Uint8Array(nonce));
  const plaintext = cipher.decrypt(new Uint8Array(encryptedSettings));

  // Zero the key
  key.fill(0);

  let settings: Record<string, unknown>;
  try {
    settings = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error('Failed to parse synced settings');
  }
  if (typeof settings !== 'object' || settings === null) {
    throw new Error('Invalid settings format');
  }

  for (const [k, v] of Object.entries(settings)) {
    if (SYNC_KEYS.includes(k as any) && v !== null && v !== undefined) {
      await setSetting(k as any, String(v));
    }
    // Channel organization: apply via LWW (only if the remote copy is newer) and
    // auto-join any channel the remote org places, so a channel grouped on
    // another device becomes visible here. Must hydrate the local cache first,
    // otherwise the LWW comparison runs against the module-default emptyOrg()
    // (updatedAt: 0) instead of this device's real on-disk state, and the
    // remote copy would always "win" and clobber a not-yet-loaded local edit.
    if (k === CHANNEL_ORG_KEY && v && typeof v === 'object') {
      await ensureChannelOrgLoaded();
      const placedIds = applyRemoteOrg(v);
      if (placedIds.length) await addJoinedChannels(placedIds);
    }
    // Hidden DM conversations: per-peer max() merge (see dmHide.ts). Hydrate
    // first for the same reason channelOrg does above.
    if (k === HIDDEN_DMS_KEY && v && typeof v === 'object') {
      await ensureHiddenDmsLoaded();
      applyRemoteHiddenDms(v);
    }
    // Followed news topics: LWW by `updatedAt` (see topicGroups.ts). Hydrate
    // first so the comparison runs against this device's real on-disk state.
    if (k === TOPIC_GROUPS_KEY && v && typeof v === 'object') {
      await ensureTopicGroupsLoaded();
      applyRemoteTopicGroups(v);
    }
  }
}

/** Upload current settings to L2 node. */
export async function uploadSettings(): Promise<void> {
  const data = await encryptSettings();
  const client = await getClient();
  await client.syncSettings(data);
}

/**
 * Download the synced blob and apply ONLY the device-local-but-synced object
 * settings (channel organization, hidden DMs, followed topics) — not
 * theme/lang/etc. Used for the automatic on-login pull and the `settings_changed`
 * WS nudge, so a fresh device (or another device after a remote edit) picks up
 * the user's groups, ordering, hidden conversations, and topic follows without
 * overriding this device's other prefs. Best-effort: returns false on any failure.
 */
export async function downloadSyncedObjects(): Promise<boolean> {
  try {
    // Hydrate the three caches up front so both the LWW comparison and any
    // re-seed upload run against this device's real on-disk state.
    await Promise.all([ensureChannelOrgLoaded(), ensureHiddenDmsLoaded(), ensureTopicGroupsLoaded()]);

    const client = await getClient();
    const resp = await client.getSettings();
    if (!resp) {
      // Fresh node with nothing for this wallet. If THIS device holds real
      // synced state, seed the node once — it then gossips it to the mesh so
      // every node converges (l2-node 0.125.0+). Safe: the upload carries the
      // content's own `updated_at`, so a node that already has a newer copy
      // will LWW-drop this one.
      if (syncedContentTimestamp() > 0) void uploadSettings();
      return false;
    }
    const encrypted = (resp as any).encrypted_settings;
    const nonce = (resp as any).nonce;
    if (!Array.isArray(encrypted) || !Array.isArray(nonce)) return false;

    const hexKey = await vaultExportKey();
    if (!hexKey) return false;
    const key = deriveKey(hexKey);
    const cipher = gcm(key, new Uint8Array(nonce));
    const plaintext = cipher.decrypt(new Uint8Array(encrypted));
    key.fill(0);

    const settings = JSON.parse(new TextDecoder().decode(plaintext));
    if (typeof settings !== 'object' || settings === null) return false;

    let applied = false;
    const org = settings[CHANNEL_ORG_KEY];
    if (org && typeof org === 'object') {
      const placedIds = applyRemoteOrg(org);
      if (placedIds.length) await addJoinedChannels(placedIds);
      applied = true;
    }
    const hidden = settings[HIDDEN_DMS_KEY];
    if (hidden && typeof hidden === 'object') {
      applyRemoteHiddenDms(hidden);
      applied = true;
    }
    const topics = settings[TOPIC_GROUPS_KEY];
    if (topics && typeof topics === 'object') {
      applyRemoteTopicGroups(topics);
      applied = true;
    }
    // This device's copy is strictly newer than the node's → push it up once so
    // this node — and, via its re-gossip, every other node — converges to it.
    if (syncedContentTimestamp() > remoteContentTimestamp(settings)) {
      void uploadSettings();
    }
    return applied;
  } catch {
    return false;
  }
}

/** Download and apply settings from L2 node. Returns true if settings were applied. */
export async function downloadSettings(): Promise<boolean> {
  const client = await getClient();
  const resp = await client.getSettings();
  if (!resp) return false;
  const encrypted = (resp as any).encrypted_settings;
  const nonce = (resp as any).nonce;
  if (!Array.isArray(encrypted) || !Array.isArray(nonce)) return false;
  if (!encrypted.every((v: unknown) => typeof v === 'number') || !nonce.every((v: unknown) => typeof v === 'number')) return false;
  await decryptAndApplySettings(encrypted, nonce);
  return true;
}
