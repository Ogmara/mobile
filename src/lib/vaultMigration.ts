/**
 * Vault Migration — versioned storage format for safe app updates.
 *
 * Every vault storage format is versioned. When the app starts, the
 * migration system checks the stored version and migrates forward if
 * needed. Old versions are NEVER deleted until migration succeeds.
 *
 * CRITICAL RULES (never break these):
 * 1. NEVER rename SecureStore keys — always migrate to new ones
 * 2. NEVER change encryption parameters without incrementing VAULT_VERSION
 * 3. NEVER delete old-format data until new-format data is verified
 * 4. Always write the new format FIRST, verify it, THEN delete old
 * 5. Every format version must have a migration path to the next
 *
 * Storage format history:
 *   v1 (0.1.0–0.3.0): raw hex in 'ogmara.vault.private_key' or
 *       AES-256-GCM encrypted in 'ogmara.vault.encrypted_key'
 *       PBKDF2 iterations: 600,000. IV: 12 bytes. Format: "ivHex:ctHex"
 */

import * as SecureStore from 'expo-secure-store';

/** Current vault storage format version. */
export const VAULT_VERSION = 1;

const VERSION_KEY = 'ogmara.vault.version';

// --- All known SecureStore keys across all versions ---
// v1 keys
const V1_KEYS = {
  rawKey: 'ogmara.vault.private_key',
  encryptedKey: 'ogmara.vault.encrypted_key',
  mode: 'ogmara.vault.mode',
  salt: 'ogmara.app_lock.salt',
  pinVerify: 'ogmara.app_lock.pin_verify',
  lockEnabled: 'ogmara.app_lock.enabled',
  lockTimeout: 'ogmara.app_lock.timeout_seconds',
  failedAttempts: 'ogmara.app_lock.failed_attempts',
  cooldownUntil: 'ogmara.app_lock.cooldown_until',
  biometricEnabled: 'ogmara.app_lock.biometric_enabled',
} as const;

/** Encryption parameters for each version (for documentation and migration). */
export const VAULT_PARAMS = {
  1: {
    kdf: 'PBKDF2-SHA256',
    kdfIterations: 600_000,
    cipher: 'AES-256-GCM',
    ivBytes: 12,
    saltBytes: 16,
    format: 'ivHex:ciphertextHex',
  },
} as const;

/**
 * Run vault migrations on app startup.
 *
 * This is safe to call on every launch. It checks the stored version
 * and only migrates if needed. Returns the current version after migration.
 */
export async function runVaultMigrations(): Promise<number> {
  const storedVersion = await getStoredVersion();

  if (storedVersion === 0) {
    // First launch or pre-versioning install
    // Check if v1 data exists (app was installed before versioning was added)
    const hasV1Data = await hasV1VaultData();
    if (hasV1Data) {
      // Tag existing data as v1
      await SecureStore.setItemAsync(VERSION_KEY, '1');
      return 1;
    }
    // No existing data — set current version for future reference
    await SecureStore.setItemAsync(VERSION_KEY, VAULT_VERSION.toString());
    return VAULT_VERSION;
  }

  // Future: add migration steps here
  // if (storedVersion === 1) { await migrateV1toV2(); }
  // if (storedVersion === 2) { await migrateV2toV3(); }

  return storedVersion;
}

/** Get the stored vault version (0 = not set / first install). */
async function getStoredVersion(): Promise<number> {
  const val = await SecureStore.getItemAsync(VERSION_KEY).catch(() => null);
  if (!val) return 0;
  return parseInt(val, 10) || 0;
}

/** Check if v1 vault data exists in SecureStore. */
async function hasV1VaultData(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(V1_KEYS.rawKey).catch(() => null);
  const enc = await SecureStore.getItemAsync(V1_KEYS.encryptedKey).catch(() => null);
  return !!(raw || enc);
}

/**
 * Verify vault integrity — check that the stored data can be loaded.
 *
 * Call after migration or on app startup to detect corruption early.
 * Returns true if the vault data is readable (doesn't verify PIN decryption,
 * only that the storage keys exist and have valid format).
 */
export async function verifyVaultIntegrity(): Promise<{
  hasWallet: boolean;
  mode: 'raw' | 'encrypted' | 'none';
  version: number;
  healthy: boolean;
}> {
  const version = await getStoredVersion();
  const mode = await SecureStore.getItemAsync(V1_KEYS.mode).catch(() => null);
  const raw = await SecureStore.getItemAsync(V1_KEYS.rawKey).catch(() => null);
  const enc = await SecureStore.getItemAsync(V1_KEYS.encryptedKey).catch(() => null);

  const hasWallet = !!(raw || enc);
  let healthy = true;

  if (mode === 'raw' && !raw) healthy = false; // claims raw but no key
  if (mode === 'encrypted' && !enc) healthy = false; // claims encrypted but no key
  if (raw && !/^[0-9a-fA-F]{64}$/.test(raw)) healthy = false; // corrupt raw key
  if (enc && !enc.includes(':')) healthy = false; // corrupt encrypted format

  return {
    hasWallet,
    mode: (mode as 'raw' | 'encrypted') || 'none',
    version,
    healthy,
  };
}

/**
 * Emergency key export — extracts all vault keys for backup.
 *
 * Returns the raw key names and their existence status.
 * Does NOT return key values (that would defeat the vault).
 * For debugging/support only.
 */
export async function getVaultDiagnostics(): Promise<Record<string, boolean>> {
  const result: Record<string, boolean> = {};
  for (const [name, key] of Object.entries(V1_KEYS)) {
    const val = await SecureStore.getItemAsync(key).catch(() => null);
    result[name] = !!val;
  }
  result[`version`] = !!(await SecureStore.getItemAsync(VERSION_KEY).catch(() => null));
  return result;
}
