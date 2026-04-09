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

/** Settings keys that are synced across devices. */
const SYNC_KEYS = ['theme', 'lang', 'notificationSound', 'compactLayout', 'fontSize'] as const;

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
  encrypted_settings: number[];
  nonce: number[];
  key_epoch: number;
}> {
  const hexKey = await vaultExportKey();
  if (!hexKey) throw new Error('Cannot export wallet key for encryption');

  const settings: Record<string, string | null> = {};
  for (const key of SYNC_KEYS) {
    settings[key] = await getSetting(key);
  }

  const plaintext = new TextEncoder().encode(JSON.stringify(settings));
  const key = deriveKey(hexKey);
  const nonce = randomBytes(12);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  // Zero the key
  key.fill(0);

  return {
    encrypted_settings: Array.from(ciphertext),
    nonce: Array.from(nonce),
    key_epoch: 0,
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
      await setSetting(k, String(v));
    }
  }
}

/** Upload current settings to L2 node. */
export async function uploadSettings(): Promise<void> {
  const data = await encryptSettings();
  const client = getClient();
  await client.syncSettings(data);
}

/** Download and apply settings from L2 node. Returns true if settings were applied. */
export async function downloadSettings(): Promise<boolean> {
  const client = getClient();
  const resp = await client.getSettings();
  if (!resp) return false;
  const encrypted = (resp as any).encrypted_settings;
  const nonce = (resp as any).nonce;
  if (!Array.isArray(encrypted) || !Array.isArray(nonce)) return false;
  if (!encrypted.every((v: unknown) => typeof v === 'number') || !nonce.every((v: unknown) => typeof v === 'number')) return false;
  await decryptAndApplySettings(encrypted, nonce);
  return true;
}
