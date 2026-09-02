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
 *   v1 (0.1.0–0.7.4): raw hex in 'ogmara.vault.private_key' or
 *       AES-256-GCM encrypted in 'ogmara.vault.encrypted_key'
 *       PBKDF2 iterations: 600,000. IV: 12 bytes. Format: "ivHex:ctHex"
 *   v2 (0.7.5+): same keys, but PBKDF2 iterations reduced to 10,000
 *       for mobile perf (600k took 83s in Hermes pure-JS).
 *       Migration: auto on next successful PIN unlock (re-encrypt with
 *       new key). Stored in 'ogmara.app_lock.kdf_iterations'.
 */

import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WalletSigner } from '@ogmara/sdk';
import { patchEd25519 } from './ed25519-polyfill';
import {
  SS,
  AS,
  isValidAddress,
  parseIndex,
  serializeMirror,
  type AccountEntry,
} from './vaultAccounts';

/** Current vault storage format version. */
export const VAULT_VERSION = 3;

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
// v2 adds: iteration count stored alongside PIN data
const V2_KEYS = {
  ...V1_KEYS,
  kdfIterations: 'ogmara.app_lock.kdf_iterations',
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
  2: {
    kdf: 'PBKDF2-SHA256',
    kdfIterations: 10_000,
    cipher: 'AES-256-GCM',
    ivBytes: 12,
    saltBytes: 16,
    format: 'ivHex:ciphertextHex',
    note: 'Reduced iterations for Hermes pure-JS perf. Migration auto on PIN unlock.',
  },
} as const;

/**
 * Run vault migrations on app startup.
 *
 * This is safe to call on every launch. It checks the stored version
 * and only migrates if needed. Returns the current version after migration.
 */
export async function runVaultMigrations(): Promise<number> {
  let version = await getStoredVersion();

  if (version === 0) {
    // First launch or pre-versioning install
    const hasV1Data = await hasV1VaultData();
    if (!hasV1Data) {
      // Nothing to migrate — tag as current and stop.
      await SecureStore.setItemAsync(VERSION_KEY, VAULT_VERSION.toString());
      return VAULT_VERSION;
    }
    await SecureStore.setItemAsync(VERSION_KEY, '1');
    version = 1;
  }

  // A LOOP, not a chain of ifs. The previous version returned immediately
  // after each single step, so a v1 device needed one launch per version to
  // reach current — with three versions that is two launches in a state the
  // app was never tested in. Step through every pending migration in one go.
  while (version < VAULT_VERSION) {
    if (version === 1) {
      // v1 → v2: the iteration-count reduction is applied lazily by
      // appLock.ts on the next successful PIN unlock (re-derives and
      // re-encrypts). Only the tag moves here.
      await SecureStore.setItemAsync(VERSION_KEY, '2');
      version = 2;
      continue;
    }
    if (version === 2) {
      // v2 → v3: single-slot vault becomes per-account slots + an index.
      // Returns false when it cannot complete YET (encrypted-only vault: the
      // address is not derivable without the PIN). Leave the tag at 2 and
      // retry after unlock — the legacy vault keeps working untouched.
      const done = await migrateV2toV3();
      if (!done) break;
      // The tag is written LAST and is the commit point: any crash before it
      // leaves a pristine v2 that simply retries.
      await SecureStore.setItemAsync(VERSION_KEY, '3');
      version = 3;
      continue;
    }
    break;
  }

  return version;
}

/**
 * Awaited by every vault entry point.
 *
 * `App.tsx` starts migrations while `ConnectionContext` independently starts
 * `vaultInit()`; the two effects interleave. That was harmless when a
 * migration only wrote a version tag, but v3 copies key material and builds an
 * index, and a read racing that is exactly how a half-migrated vault gets
 * observed. Memoized so concurrent callers share one run.
 */
let migrationsPromise: Promise<number> | null = null;

/** Idempotent, shared handle on the migration run. */
export function vaultMigrationsReady(): Promise<number> {
  if (!migrationsPromise) migrationsPromise = runVaultMigrations();
  return migrationsPromise;
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
  for (const [name, key] of Object.entries(V2_KEYS)) {
    const val = await SecureStore.getItemAsync(key).catch(() => null);
    result[name] = !!val;
  }
  result[`version`] = !!(await SecureStore.getItemAsync(VERSION_KEY).catch(() => null));
  return result;
}

// ── v2 → v3: single-slot vault becomes per-account slots + an index ──────

/**
 * Migrate the one legacy key slot into a per-account slot and build the index.
 *
 * Returns `false` for "cannot complete yet" — never throws, never partially
 * commits. The caller writes the version tag only on `true`, so the tag is the
 * commit point and any crash before it leaves a pristine, fully working v2.
 *
 * Safety properties, in the order they matter:
 *  - **Write new, verify, keep old.** The legacy slot is NEVER deleted here.
 *    It is the only slot findable without an index, so it stays as the anchor
 *    that guarantees the wallet is reachable even if the index is lost or the
 *    app is downgraded.
 *  - **Verify by re-derivation.** The new slot is read back and its address
 *    re-derived; a mismatch aborts before anything else is written.
 *  - **Idempotent.** A given key always maps to the same address and content,
 *    and index writes dedupe, so re-running after a crash converges.
 */
async function migrateV2toV3(): Promise<boolean> {
  try {
    patchEd25519();

    const mode = await SecureStore.getItemAsync(SS.legacyMode).catch(() => null);
    const raw = await SecureStore.getItemAsync(SS.legacyRaw).catch(() => null);
    const enc = await SecureStore.getItemAsync(SS.legacyEnc).catch(() => null);

    // No wallet at all — nothing to migrate, and an absent index correctly
    // means an empty account set.
    if (!raw && !enc) return true;

    // Encrypted-only: the address CANNOT be derived without the PIN, and
    // guessing from the persisted wallet address would mis-attribute the slot
    // for a K5 delegation (that address is the external wallet, not this key).
    // Defer: leave the tag at 2 so the legacy vault keeps working untouched,
    // and let the unlock path finish the job once it knows the address.
    if (!raw && enc) {
      await SecureStore.setItemAsync(SS.pending, 'encrypted').catch(() => {});
      return false;
    }

    // Corrupt input: refuse rather than write anything derived from it.
    if (!raw || !/^[0-9a-fA-F]{64}$/.test(raw)) return false;

    const signer = await WalletSigner.fromHex(raw);
    const addr = signer.address;
    if (!isValidAddress(addr)) return false;

    // 1. Write the new slot.
    await SecureStore.setItemAsync(SS.rawFor(addr), raw, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(SS.modeFor(addr), mode === 'encrypted' ? 'encrypted' : 'raw', {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    // 2. Verify by reading back and re-deriving. Never trust the write.
    const check = await SecureStore.getItemAsync(SS.rawFor(addr)).catch(() => null);
    if (!check || check !== raw) return false;
    const reSigner = await WalletSigner.fromHex(check);
    if (reSigner.address !== addr) return false;

    // 3. Only now the indexes. Primary (with metadata) then mirror.
    const walletSource = await AsyncStorage.getItem(AS.legacyWalletSource).catch(() => null);
    const externalAddr = await AsyncStorage.getItem(AS.legacyWalletAddress).catch(() => null);
    const isK5 = walletSource === 'k5-delegation';
    const entry: AccountEntry = {
      a: addr,
      label: null,
      source: isK5 ? 'k5-delegation' : 'builtin',
      ...(isK5 && externalAddr ? { external: externalAddr } : {}),
      added: Date.now(),
    };
    const existing = parseIndex(await AsyncStorage.getItem(AS.primaryIndex).catch(() => null));
    if (!existing.some((e) => e.a === addr)) existing.push(entry);
    await AsyncStorage.setItem(AS.primaryIndex, JSON.stringify(existing));
    await SecureStore.setItemAsync(SS.mirror, serializeMirror(existing), {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });
    await SecureStore.setItemAsync(SS.active, addr, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    });

    // 4. Claim the device E2E identity for this account. MANDATORY: without
    // it, `ensureDeviceEncBinding` mints a fresh keypair for the now
    // per-account namespace, publishes a new binding, and the old enc_pub is
    // revoked — making any channel-key envelope wrapped to it permanently
    // undecryptable. Skipped for K5, which has no device E2E identity.
    if (!isK5) await claimDeviceIdentityOnce(addr);

    // 5. Legacy slot deliberately RETAINED. See the doc comment.
    return true;
  } catch {
    // Never throw out of a migration — a failed run must leave the app usable
    // and simply retry on the next launch.
    return false;
  }
}

/**
 * Move the device-global E2E identity into `addr`'s namespace, exactly once.
 *
 * Marker-gated separately from `ogmara.walletScope.migrated`: devices that
 * already ran 0.46.0 have that marker set, so folding these keys into it would
 * skip them entirely.
 *
 * The globals are COPIED, not moved — they are harmless where they are and
 * serve as the recovery copy if this ever needs re-running by hand.
 */
async function claimDeviceIdentityOnce(addr: string): Promise<void> {
  const MARKER = 'ogmara.e2e.claimed';
  try {
    if (await AsyncStorage.getItem(MARKER)) return;

    const priv = await SecureStore.getItemAsync('ogmara.e2e.enc_private_key').catch(() => null);
    if (priv) {
      await SecureStore.setItemAsync(SS.encPrivFor(addr), priv, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
      const back = await SecureStore.getItemAsync(SS.encPrivFor(addr)).catch(() => null);
      if (back !== priv) return; // verify failed — leave the marker unset, retry later
    }
    for (const base of ['ogmara.e2e.device_id', 'ogmara.e2e.enc_key_bound']) {
      const v = await AsyncStorage.getItem(base).catch(() => null);
      if (v !== null) await AsyncStorage.setItem(`${base}::${addr}`, v);
    }
    await AsyncStorage.setItem(MARKER, '1');
  } catch {
    /* retry next launch */
  }
}
