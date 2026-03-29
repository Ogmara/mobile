/**
 * Vault — secure key isolation layer ("firewall" for private keys).
 *
 * The private key NEVER leaves this module. When PIN lock is enabled,
 * the key is AES-256-GCM encrypted with a PBKDF2-derived key before
 * storage. The raw key is only in memory after successful PIN entry.
 *
 * Architecture:
 *   App → Vault API (sign, getAddress) → SecureStore
 *         ↑ key never exposed outward  ↑
 *         When PIN enabled: stored key is encrypted with PIN-derived AES key
 */

import * as SecureStore from 'expo-secure-store';
import { WalletSigner } from '@ogmara/sdk';
import { encryptWithKey, decryptWithKey } from './appLock';

const VAULT_RAW_KEY = 'ogmara.vault.private_key';
const VAULT_ENCRYPTED_KEY = 'ogmara.vault.encrypted_key';
const VAULT_MODE_KEY = 'ogmara.vault.mode'; // 'raw' | 'encrypted'

/** Internal signer — never exported directly. */
let cachedSigner: WalletSigner | null = null;

/**
 * Initialize the vault WITHOUT PIN (for apps without PIN lock).
 * Returns the public address if a wallet exists, null otherwise.
 */
export async function vaultInit(): Promise<string | null> {
  const mode = await SecureStore.getItemAsync(VAULT_MODE_KEY).catch(() => null);

  if (mode === 'encrypted') {
    // Key is encrypted — cannot load without PIN. Return address hint only.
    return null; // caller must use vaultUnlockWithPin()
  }

  // Raw (unencrypted) mode — load directly
  try {
    const hex = await SecureStore.getItemAsync(VAULT_RAW_KEY);
    if (hex) {
      cachedSigner = await WalletSigner.fromHex(hex);
      return cachedSigner.address;
    }
  } catch {
    cachedSigner = null;
  }
  return null;
}

/**
 * Check if the vault has a stored wallet (encrypted or raw).
 */
export async function vaultHasWallet(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  const enc = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY).catch(() => null);
  return !!(raw || enc);
}

/**
 * Unlock the vault with a PIN-derived CryptoKey.
 * Decrypts the stored private key and loads it into memory.
 * Returns the public address on success, null on failure.
 */
export async function vaultUnlockWithPin(pinKey: Uint8Array): Promise<string | null> {
  try {
    const encrypted = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY);
    if (!encrypted) return null;

    const hex = await decryptWithKey(pinKey, encrypted);
    cachedSigner = await WalletSigner.fromHex(hex);
    return cachedSigner.address;
  } catch {
    return null; // wrong PIN or corrupted data
  }
}

/**
 * Store a new private key in the vault (raw mode, no PIN encryption).
 * Returns the derived public address.
 */
export async function vaultStore(privateKeyHex: string): Promise<string> {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('Invalid private key format');
  }

  const signer = await WalletSigner.fromHex(privateKeyHex);

  await SecureStore.setItemAsync(VAULT_RAW_KEY, privateKeyHex, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(VAULT_MODE_KEY, 'raw');
  // Clean up any encrypted version
  await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY).catch(() => {});

  cachedSigner = signer;
  return signer.address;
}

/**
 * Encrypt the vault with a PIN-derived key.
 * Migrates from raw → encrypted storage. Call after PIN setup.
 * The raw key is deleted after successful encryption.
 */
export async function vaultEncryptWithPin(pinKey: Uint8Array): Promise<void> {
  // Get the raw key (either from memory or storage)
  let hex: string | null = null;

  const storedRaw = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  if (storedRaw) {
    hex = storedRaw;
  }

  if (!hex) throw new Error('No wallet to encrypt');

  const encrypted = await encryptWithKey(pinKey, hex);
  await SecureStore.setItemAsync(VAULT_ENCRYPTED_KEY, encrypted, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(VAULT_MODE_KEY, 'encrypted');

  // Delete the raw key — it's now only stored encrypted
  await SecureStore.deleteItemAsync(VAULT_RAW_KEY);
}

/**
 * Decrypt vault and switch back to raw storage (when PIN is removed).
 * Requires the PIN-derived key to decrypt first.
 */
export async function vaultDecryptToRaw(pinKey: Uint8Array): Promise<void> {
  const encrypted = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY);
  if (!encrypted) return;

  const hex = await decryptWithKey(pinKey, encrypted);

  await SecureStore.setItemAsync(VAULT_RAW_KEY, hex, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(VAULT_MODE_KEY, 'raw');
  await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY);
}

/**
 * Generate a new random wallet in the vault (raw mode).
 * Returns the derived public address.
 */
export async function vaultGenerate(): Promise<string> {
  const randomBytes = new Uint8Array(32);
  crypto.getRandomValues(randomBytes);
  const hex = Array.from(randomBytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return vaultStore(hex);
}

/** Get the WalletSigner (only available after init or PIN unlock). */
export function vaultGetSigner(): WalletSigner | null {
  return cachedSigner;
}

/** Get the wallet address without exposing the signer. */
export function vaultGetAddress(): string | null {
  return cachedSigner?.address ?? null;
}

/** Wipe the wallet from memory and all storage. */
export async function vaultWipe(): Promise<void> {
  cachedSigner = null;
  await SecureStore.deleteItemAsync(VAULT_RAW_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY).catch(() => {});
  await SecureStore.deleteItemAsync(VAULT_MODE_KEY).catch(() => {});
}

/** Sign an auth request through the vault. */
export async function vaultSignRequest(
  method: string,
  path: string,
): Promise<{ [key: string]: string } | null> {
  if (!cachedSigner) return null;
  const headers = await cachedSigner.signRequest(method, path);
  return { ...headers };
}
