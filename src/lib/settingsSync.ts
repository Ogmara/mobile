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
import { getCryptoClient } from './cryptoEnv';
import { vaultExportKeyFor } from './vault';
import { collectAndUploadSettings } from './settingsUpload';
import { ensureChannelOrgLoaded, getChannelOrg, applyRemoteOrg } from './channelOrg';
import { addJoinedChannelsFor } from './joinedChannels';
import { captureAccountContext as captureSyncAccount } from './accountContext';
import {
  applyDecryptedSettings, type SettingsApplyDeps, CHANNEL_ORG_KEY, HIDDEN_DMS_KEY, TOPIC_GROUPS_KEY,
} from './settingsApply';
import { ensureHiddenDmsLoaded, getHiddenDms, applyRemoteHiddenDms } from './dmHide';
import { ensureTopicGroupsLoaded, getTopicGroups, applyRemoteTopicGroups } from './topicGroups';

// `captureSyncAccount` lives in accountContext.ts (shared with keyVault.ts).

function applyDeps(syncKeys: readonly string[]): SettingsApplyDeps {
  return {
    syncKeys,
    setSetting: (k, v) => setSetting(k as any, v),
    ensureChannelOrgLoaded,
    applyRemoteOrg,
    addJoinedChannelsFor,
    ensureHiddenDmsLoaded,
    applyRemoteHiddenDms,
    ensureTopicGroupsLoaded,
    applyRemoteTopicGroups,
  };
}

/** Settings keys that are synced across devices. */
const SYNC_KEYS = ['theme', 'lang', 'notificationSound', 'compactLayout', 'fontSize'] as const;

// Object-valued synced settings (channel groups + ordering, hidden DMs,
// followed topics) — stored under their own keys in the blob and applied via
// LWW/merge, not the scalar setSetting path. Keys live in settingsApply.ts.

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

/**
 * The signer-bound SDK client. `GET /api/v1/settings` and `syncSettings` are
 * authenticated, so they MUST use the client ConnectionContext calls
 * `.withSigner()` on — NOT the signer-less singleton in `api.ts`, which throws
 * "Signer required" (and can surface as "undefined is not a function" when an
 * older bundle lacks `syncSettings`). Same pattern as `dmCrypto` / `channelCrypto`.
 */
function authedClient(): NonNullable<ReturnType<typeof getCryptoClient>> {
  const c = getCryptoClient();
  if (!c) throw new Error('Not connected — sign in first');
  return c;
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

type SyncPayload = {
  encrypted_settings: Uint8Array;
  nonce: Uint8Array;
  key_epoch: number;
  updated_at: number;
};

/** Synchronous: derive the AES key, encrypt the collected settings, stamp `updated_at`. */
function encryptCollected(hexKey: string, settings: Record<string, unknown>): SyncPayload {
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
    // a newer copy on another node. Caches were hydrated by the collector.
    updated_at: syncedContentTimestamp(),
  };
}

/**
 * Decrypt settings blob and apply to local storage.
 *
 * Account-safe: the account is captured BEFORE the key export, re-checked
 * after it, and the apply loop re-checks after every await (see
 * settingsApply.ts) — a switch mid-apply abandons the rest rather than writing
 * one account's settings into another's namespace.
 */
export async function decryptAndApplySettings(
  encryptedSettings: number[],
  nonce: number[],
  /** Account captured by the caller BEFORE it fetched this blob (see
   *  `downloadSettings`); captured here when omitted. */
  captured?: ReturnType<typeof captureSyncAccount>,
): Promise<boolean> {
  const { account, signer, stillValid } = captured ?? captureSyncAccount();
  if (!account || !signer) throw new Error('No active account for settings sync');
  // Switched since the caller captured (e.g. during its fetch): this blob is
  // the PREVIOUS account's — decrypting it with the active key would just
  // fail the GCM tag. Quiet no-op, not an error.
  if (!stillValid()) return false;
  // The CAPTURED account's own key — never "whoever is active".
  const hexKey = await vaultExportKeyFor(signer);
  if (!hexKey) throw new Error('Cannot export wallet key for decryption');
  if (!stillValid()) return false;

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

  return (await applyDecryptedSettings(settings, account, stillValid, applyDeps(SYNC_KEYS))) !== 'aborted';
}

/**
 * Upload current settings to L2 node.
 *
 * Account-safe (see settingsUpload.ts): the account and its signing key are
 * captured at entry, the key is exported for THAT account only
 * (`vaultExportKeyFor`), and wallet + scope + reset generation + signer are
 * re-checked after every await and immediately before the signed upload.
 * Returns `false` quietly (nothing sent) if the account changed mid-flight.
 */
export async function uploadSettings(): Promise<boolean> {
  const { account, signer, client, stillValid } = captureSyncAccount();
  if (!account || !signer || !client) {
    throw new Error('Not connected — sign in first');
  }
  return collectAndUploadSettings<SyncPayload>(stillValid, {
    exportKey: () => vaultExportKeyFor(signer),
    syncKeys: SYNC_KEYS,
    getSetting: (k) => getSetting(k as any),
    // Channel organization (groups + ordering, LWW `updatedAt`), hidden DMs
    // (per-peer max), followed topics (LWW) — each hydrated before snapshot.
    objects: [
      { key: CHANNEL_ORG_KEY, ensureLoaded: ensureChannelOrgLoaded, get: getChannelOrg },
      { key: HIDDEN_DMS_KEY, ensureLoaded: ensureHiddenDmsLoaded, get: getHiddenDms },
      { key: TOPIC_GROUPS_KEY, ensureLoaded: ensureTopicGroupsLoaded, get: getTopicGroups },
    ],
    encrypt: encryptCollected,
    send: (payload) => client.syncSettings(payload),
  });
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
    // Capture the account this download is FOR. It is fired on every
    // `walletAddress` change and on every `settings_changed` nudge, so an
    // account switch can land mid-flight. The decrypt itself fails safe (the
    // GCM tag check throws under the wrong key), but AFTER a successful
    // decrypt the `applyRemote*` calls below would write the previous
    // account's channel memberships, hidden-DM peers and followed topics into
    // the new account's caches — which then persist under its namespace and
    // upload to the node under its key, linking the two accounts' interest
    // graphs server-side. That is exactly the unlinkability multi-account
    // exists to provide.
    const { account: forWallet, signer, client, stillValid } = captureSyncAccount();
    if (!forWallet || !signer || !client) return false;
    // Hydrate the three caches up front so both the LWW comparison and any
    // re-seed upload run against this device's real on-disk state.
    await Promise.all([ensureChannelOrgLoaded(), ensureHiddenDmsLoaded(), ensureTopicGroupsLoaded()]);
    if (!stillValid()) return false;

    const resp = await client.getSettings();
    if (!stillValid()) return false;
    if (!resp) {
      // Fresh node with nothing for this wallet. If THIS device holds real
      // synced state, seed the node once — it then gossips it to the mesh so
      // every node converges (l2-node 0.125.0+). Safe: the upload carries the
      // content's own `updated_at`, so a node that already has a newer copy
      // will LWW-drop this one.
      if (stillValid() && syncedContentTimestamp() > 0) void uploadSettings().catch(() => {});
      return false;
    }
    const encrypted = (resp as any).encrypted_settings;
    const nonce = (resp as any).nonce;
    if (!Array.isArray(encrypted) || !Array.isArray(nonce)) return false;

    // The CAPTURED account's own key (`vaultExportKeyFor`), re-checked after.
    const hexKey = await vaultExportKeyFor(signer);
    if (!hexKey) return false;
    if (!stillValid()) return false;
    const key = deriveKey(hexKey);
    const cipher = gcm(key, new Uint8Array(nonce));
    const plaintext = cipher.decrypt(new Uint8Array(encrypted));
    key.fill(0);

    const settings = JSON.parse(new TextDecoder().decode(plaintext));
    if (typeof settings !== 'object' || settings === null) return false;

    // Objects only (no scalar prefs): the apply re-checks the captured
    // account after every await and before every write, and writes joined
    // channels into the captured account explicitly (settingsApply.ts).
    const result = await applyDecryptedSettings(settings, forWallet, stillValid, applyDeps([]));
    if (result === 'aborted') return false;
    const applied = result === 'applied';
    // This device's copy is strictly newer than the node's → push it up once so
    // this node — and, via its re-gossip, every other node — converges to it.
    if (stillValid() && syncedContentTimestamp() > remoteContentTimestamp(settings)) {
      void uploadSettings().catch(() => {});
    }
    return applied;
  } catch {
    return false;
  }
}

/** Download and apply settings from L2 node. Returns true if settings were applied. */
export async function downloadSettings(): Promise<boolean> {
  // Capture BEFORE the fetch so the whole download — fetch, key export,
  // decrypt, apply — is bound to one account. A switch during `getSettings()`
  // used to decrypt account A's blob with B's key (GCM failure surfaced as an
  // error alert); now it returns false quietly.
  const captured = captureSyncAccount();
  // Not connected at all is a real error for the manual action (throws);
  // the captured client is the one the whole download is bound to.
  authedClient();
  const client = captured.client;
  if (!captured.account || !client) return false;
  const resp = await client.getSettings();
  if (!captured.stillValid()) return false;
  if (!resp) return false;
  const encrypted = (resp as any).encrypted_settings;
  const nonce = (resp as any).nonce;
  if (!Array.isArray(encrypted) || !Array.isArray(nonce)) return false;
  if (!encrypted.every((v: unknown) => typeof v === 'number') || !nonce.every((v: unknown) => typeof v === 'number')) return false;
  return decryptAndApplySettings(encrypted, nonce, captured);
}
