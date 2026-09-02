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
import AsyncStorage from '@react-native-async-storage/async-storage';
import { WalletSigner, type NodeBinding } from '@ogmara/sdk';
import { encryptWithKey, decryptWithKey } from './appLock';
import { vaultMigrationsReady } from './vaultMigration';
import {
  SS,
  AS,
  MAX_ACCOUNTS,
  isValidAddress,
  parseIndex,
  parseMirror,
  parseAddressesFromScopedKeys,
  mergeIndexes,
  serializeMirror,
  type AccountEntry,
} from './vaultAccounts';

/**
 * LEGACY single-slot keys. Deliberately still read and still written for the
 * active built-in account: they are the only slots findable WITHOUT the
 * account index, so they remain the anchor that guarantees a wallet stays
 * reachable if the index is ever lost or the app is downgraded.
 */
const VAULT_RAW_KEY = 'ogmara.vault.private_key';
const VAULT_ENCRYPTED_KEY = 'ogmara.vault.encrypted_key';
const VAULT_MODE_KEY = 'ogmara.vault.mode'; // 'raw' | 'encrypted'

const SS_OPTS = { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY } as const;

/** Internal signer — never exported directly. */
let cachedSigner: WalletSigner | null = null;
/** Address of the account `cachedSigner` belongs to. */
let activeAddress: string | null = null;

// ── Account index ───────────────────────────────────────────────────────

/**
 * Every account this device holds.
 *
 * Unions the AsyncStorage primary index, the SecureStore mirror, and a
 * recovery scan of `<base>::<address>` preference keys — then keeps only
 * entries whose key slot actually exists. SecureStore cannot enumerate, so an
 * account missing from all three sources would be unreachable forever; the
 * redundancy is the whole point.
 */
export async function vaultListAccounts(): Promise<AccountEntry[]> {
  await vaultMigrationsReady();
  const primary = parseIndex(await AsyncStorage.getItem(AS.primaryIndex).catch(() => null));
  const mirror = parseMirror(await SecureStore.getItemAsync(SS.mirror).catch(() => null));
  const allKeys = await AsyncStorage.getAllKeys().catch(() => [] as string[]);
  // Bound the scan CANDIDATES, not the merged result. Capping after the merge
  // let a flood of slot-less orphans push real accounts out of the list — and
  // out of the persisted index. Indexed accounts are already bounded by
  // `vaultAddAccount`, so only this untrusted input needs a limit.
  const recovered = parseAddressesFromScopedKeys(allKeys).slice(0, MAX_ACCOUNTS);

  // BOUND the candidate set before probing. `parseAddressesFromScopedKeys`
  // scans every AsyncStorage key, and each surviving candidate costs up to
  // three SecureStore reads plus an ed25519 derivation in `hasSlot`. Left
  // uncapped, a device with many stale `::<addr>` preference keys — or one
  // seeded with them — would do that work on every boot and every account
  // create, to the point of not starting at all. Real accounts are capped at
  // MAX_ACCOUNTS anyway, so anything beyond that cannot be legitimate.
  const merged = mergeIndexes(primary, mirror, recovered);

  // PERSIST THE UNION, NEVER THE PRUNED SET.
  //
  // A failed slot read cannot be distinguished from an absent slot — every
  // read here is `.catch(() => null)`, and vault items are written
  // WHEN_UNLOCKED_THIS_DEVICE_ONLY. So a read while the device is locked, or
  // an Android Keystore fault, makes every probe return null. Writing the
  // pruned set back would then overwrite BOTH indexes with `[]` while the key
  // slots still exist — and since SecureStore cannot enumerate, those wallets
  // would be unreachable forever. Removal happens in `vaultRemoveAccount`
  // and nowhere else.
  if (merged.length > 0) await persistIndex(merged);

  // Probing is for DISPLAY only: an entry whose slot does not currently read
  // is reported as unusable rather than deleted, so a transient failure is
  // recoverable on the next launch.
  const confirmed: AccountEntry[] = [];
  for (const e of merged) {
    if (await hasSlot(e.a)) confirmed.push(e);
  }
  return confirmed;
}

async function hasSlot(addr: string): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(SS.rawFor(addr)).catch(() => null);
  if (raw) return true;
  const enc = await SecureStore.getItemAsync(SS.encFor(addr)).catch(() => null);
  if (enc) return true;
  // The legacy anchor may still be the only copy for the pre-v3 account.
  const legacy = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  if (!legacy) return false;
  try {
    return (await WalletSigner.fromHex(legacy)).address === addr;
  } catch {
    return false;
  }
}

/** Read the persisted index union without probing slots. */
async function readPersistedIndex(): Promise<AccountEntry[]> {
  const primary = parseIndex(await AsyncStorage.getItem(AS.primaryIndex).catch(() => null));
  const mirror = parseMirror(await SecureStore.getItemAsync(SS.mirror).catch(() => null));
  return mergeIndexes(primary, mirror, []);
}

/** Add one entry to the persisted index, preserving everything already there. */
async function persistIndexAdding(entry: AccountEntry): Promise<void> {
  const current = await readPersistedIndex();
  if (current.some((e) => e.a === entry.a)) return;
  await persistIndex([...current, entry]);
}

/** Remove exactly one address from the persisted index, touching nothing else. */
async function persistIndexRemoving(addr: string): Promise<void> {
  const current = await readPersistedIndex();
  await persistIndex(current.filter((e) => e.a !== addr));
}

async function persistIndex(entries: AccountEntry[]): Promise<void> {
  try {
    await AsyncStorage.setItem(AS.primaryIndex, JSON.stringify(entries));
    await SecureStore.setItemAsync(SS.mirror, serializeMirror(entries), SS_OPTS);
  } catch {
    /* best-effort; the recovery scan is the backstop */
  }
}

/** The address the vault is currently unlocked for. */
export function vaultActiveAddress(): string | null {
  return activeAddress;
}

/** Read the private key of a SPECIFIC account (raw mode only). */
async function readKeyFor(addr: string): Promise<string | null> {
  const perAccount = await SecureStore.getItemAsync(SS.rawFor(addr)).catch(() => null);
  if (perAccount) return perAccount;
  // Fall back to the legacy anchor when it belongs to this account. This is
  // what makes a half-finished migration harmless.
  const legacy = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  if (!legacy) return null;
  try {
    return (await WalletSigner.fromHex(legacy)).address === addr ? legacy : null;
  } catch {
    return null;
  }
}

/**
 * Make `addr` the active account and load its signer.
 *
 * Does NOT touch per-wallet preference storage or any E2E cache — the caller
 * (ConnectionContext) owns that teardown/setup, because it must happen in a
 * specific order relative to the scope flip.
 */
export async function vaultActivate(addr: string): Promise<string | null> {
  await vaultMigrationsReady();
  if (!isValidAddress(addr)) return null;
  const hex = await readKeyFor(addr);
  if (!hex) return null;
  try {
    cachedSigner = await WalletSigner.fromHex(hex);
    activeAddress = cachedSigner.address;
    await SecureStore.setItemAsync(SS.active, activeAddress, SS_OPTS).catch(() => {});
    return activeAddress;
  } catch {
    return null;
  }
}

/** Add an account from an existing private key, and make it active. */
export async function vaultAddAccount(privateKeyHex: string): Promise<string> {
  // Validate the shape here as well as in the UI: this is a public entry point
  // that writes key material to SecureStore.
  if (!/^[0-9a-fA-F]{64}$/.test(privateKeyHex)) {
    throw new Error('Invalid private key format');
  }
  await vaultMigrationsReady();
  const signer = await WalletSigner.fromHex(privateKeyHex);
  const addr = signer.address;
  if (!isValidAddress(addr)) throw new Error('Invalid wallet address');

  const existing = await vaultListAccounts();
  if (existing.some((e) => e.a === addr)) {
    // Already held — activate rather than duplicating.
    await vaultActivate(addr);
    return addr;
  }
  if (existing.length >= MAX_ACCOUNTS) throw new Error('ACCOUNT_LIMIT');

  // Write the slot, then VERIFY by read-back before indexing it. An indexed
  // account whose slot never landed would look present and be unusable.
  await SecureStore.setItemAsync(SS.rawFor(addr), privateKeyHex, SS_OPTS);
  await SecureStore.setItemAsync(SS.modeFor(addr), 'raw', SS_OPTS);
  const back = await SecureStore.getItemAsync(SS.rawFor(addr)).catch(() => null);
  if (back !== privateKeyHex) throw new Error('Vault write could not be verified');

  // Merge into what is CURRENTLY PERSISTED, never into the probed list.
  // `existing` is the confirmed subset, so writing it back would drop any
  // account whose slot happened to read null a moment ago — reintroducing the
  // exact index-shrinking bug the union write in `vaultListAccounts` fixes.
  await persistIndexAdding({ a: addr, label: null, source: 'builtin', added: Date.now() });
  cachedSigner = signer;
  activeAddress = addr;
  await SecureStore.setItemAsync(SS.active, addr, SS_OPTS).catch(() => {});
  return addr;
}

/**
 * Permanently remove one account's key material and index entry.
 *
 * Slots are deleted BEFORE the index entry, which is the inverse of the
 * intuitive order and is deliberate: a crash between the two leaves an index
 * entry with no slot — visible, self-healing (`vaultListAccounts` drops it)
 * and purgeable. The reverse leaves an orphan slot holding private key
 * material that nothing can enumerate and no UI can ever remove.
 */
export async function vaultRemoveAccount(addr: string): Promise<void> {
  await vaultMigrationsReady();
  if (!isValidAddress(addr)) return;
  for (const k of [SS.rawFor(addr), SS.encFor(addr), SS.modeFor(addr), SS.encPrivFor(addr)]) {
    await SecureStore.deleteItemAsync(k).catch(() => {});
  }
  // Retire the legacy anchor too if it belonged to this account, otherwise it
  // would resurrect the account on the next recovery scan.
  const legacy = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  if (legacy) {
    try {
      if ((await WalletSigner.fromHex(legacy)).address === addr) {
        for (const k of [VAULT_RAW_KEY, VAULT_ENCRYPTED_KEY, VAULT_MODE_KEY]) {
          await SecureStore.deleteItemAsync(k).catch(() => {});
        }
      }
    } catch {
      /* unparsable legacy key — leave it, it cannot resurrect anything */
    }
  }
  // Remove from the PERSISTED set, not from the probed one — otherwise
  // removing account A also drops any account whose slot read null just then.
  await persistIndexRemoving(addr);
  if (activeAddress === addr) {
    cachedSigner = null;
    activeAddress = null;
    await SecureStore.deleteItemAsync(SS.active).catch(() => {});
  }
}

/** Export a specific account's key, for the pre-removal backup gate. */
export async function vaultExportKeyFor(addr: string): Promise<string | null> {
  await vaultMigrationsReady();
  return readKeyFor(addr);
}

/**
 * Initialize the vault WITHOUT PIN (for apps without PIN lock).
 * Returns the public address if a wallet exists, null otherwise.
 */
export async function vaultInit(): Promise<string | null> {
  // Never read vault storage before migrations have settled — v3 copies key
  // material and builds an index, and a read racing that is exactly how a
  // half-migrated vault gets observed.
  await vaultMigrationsReady();

  const mode = await SecureStore.getItemAsync(VAULT_MODE_KEY).catch(() => null);
  if (mode === 'encrypted') {
    // Key is encrypted — cannot load without PIN. Return address hint only.
    return null; // caller must use vaultUnlockWithPin()
  }

  // Prefer the recorded active account (v3). Falls through to the legacy slot
  // when there is no index yet, which is what makes a partially-completed
  // migration — or a downgrade — harmless.
  try {
    const recorded = await SecureStore.getItemAsync(SS.active).catch(() => null);
    if (recorded && isValidAddress(recorded)) {
      const loaded = await vaultActivate(recorded);
      if (loaded) return loaded;
    }
    const hex = await SecureStore.getItemAsync(VAULT_RAW_KEY);
    if (hex) {
      cachedSigner = await WalletSigner.fromHex(hex);
      activeAddress = cachedSigner.address;
      return activeAddress;
    }
  } catch {
    cachedSigner = null;
    activeAddress = null;
  }
  return null;
}

/**
 * Check if the vault has a stored wallet (encrypted or raw).
 */
export async function vaultHasWallet(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  const enc = await SecureStore.getItemAsync(VAULT_ENCRYPTED_KEY).catch(() => null);
  if (raw || enc) return true;
  // Per-account slots count too. Checking only the legacy anchor meant that
  // once the pre-migration account was removed this returned false while
  // other accounts were still held — and `vaultEncryptWithPin` refuses on
  // that basis, so App Lock could never be enabled again.
  return (await vaultListAccounts().catch(() => [] as AccountEntry[])).length > 0;
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
    // Set the ACTIVE address. Leaving it null meant `vaultExportKey()`
    // returned null after a PIN unlock, which breaks settings sync.
    activeAddress = cachedSigner.address;

    // Complete the deferred v3 migration. `migrateV2toV3` cannot run for an
    // encrypted-only vault because the address is not derivable without the
    // PIN — it records `SS.pending` and leaves the tag at 2. Nothing read that
    // marker, so PIN users would have stayed at v2 forever with an empty
    // account list. Now we know the address, so finish the job here.
    await completeDeferredV3(activeAddress, encrypted);
    return activeAddress;
  } catch {
    return null; // wrong PIN or corrupted data
  }
}

/**
 * Finish the v3 migration for an encrypted vault, once a successful unlock has
 * revealed the address. Best-effort and idempotent: a failure just leaves the
 * marker in place to retry on the next unlock.
 */
async function completeDeferredV3(addr: string, encryptedBlob: string): Promise<void> {
  try {
    const pending = await SecureStore.getItemAsync(SS.pending).catch(() => null);
    if (pending !== 'encrypted') return;
    if (!isValidAddress(addr)) return;

    await SecureStore.setItemAsync(SS.encFor(addr), encryptedBlob, SS_OPTS);
    await SecureStore.setItemAsync(SS.modeFor(addr), 'encrypted', SS_OPTS);
    // Verify before indexing — an indexed account with no readable slot would
    // look present and be unusable.
    const back = await SecureStore.getItemAsync(SS.encFor(addr)).catch(() => null);
    if (back !== encryptedBlob) return;

    const existing = parseIndex(await AsyncStorage.getItem(AS.primaryIndex).catch(() => null));
    if (!existing.some((e) => e.a === addr)) {
      existing.push({ a: addr, label: null, source: 'builtin', added: Date.now() });
    }
    await persistIndex(existing);
    await SecureStore.setItemAsync(SS.active, addr, SS_OPTS).catch(() => {});
    await SecureStore.deleteItemAsync(SS.pending).catch(() => {});
    // Only now is the vault genuinely at v3.
    await SecureStore.setItemAsync('ogmara.vault.version', '3').catch(() => {});
  } catch {
    /* retry on the next unlock */
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
  // Never write the legacy anchor before migrations have settled: if v3
  // deferred (encrypted vault) or failed, the pre-existing account has no
  // per-account slot and the anchor is its ONLY copy.
  await vaultMigrationsReady();
  // This is the single-wallet onboarding path and it overwrites the anchor.
  // Once other accounts exist, adding one must go through `vaultAddAccount`,
  // which is additive.
  const held = await vaultListAccounts().catch(() => [] as AccountEntry[]);
  const signerAddr = (await WalletSigner.fromHex(privateKeyHex)).address;
  if (held.some((e) => e.a !== signerAddr)) {
    return vaultAddAccount(privateKeyHex);
  }

  const signer = await WalletSigner.fromHex(privateKeyHex);

  await SecureStore.setItemAsync(VAULT_RAW_KEY, privateKeyHex, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  await SecureStore.setItemAsync(VAULT_MODE_KEY, 'raw');
  // Clean up any encrypted version
  await SecureStore.deleteItemAsync(VAULT_ENCRYPTED_KEY).catch(() => {});

  // Also write the per-account slot and index the account (v3). The legacy
  // slot above is kept as the index-free anchor.
  const addr = signer.address;
  await SecureStore.setItemAsync(SS.rawFor(addr), privateKeyHex, SS_OPTS);
  await SecureStore.setItemAsync(SS.modeFor(addr), 'raw', SS_OPTS);
  await persistIndexAdding({ a: addr, label: null, source: 'builtin', added: Date.now() });
  await SecureStore.setItemAsync(SS.active, addr, SS_OPTS).catch(() => {});

  cachedSigner = signer;
  activeAddress = addr;
  return addr;
}

/**
 * Encrypt the vault with a PIN-derived key.
 * Migrates from raw → encrypted storage. Call after PIN setup.
 * The raw key is deleted after successful encryption.
 */



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

/**
 * Export the private key for user backup.
 *
 * SECURITY: This is the ONLY way to get the raw private key out of the vault.
 * The caller MUST show a warning before displaying the key to the user.
 * Returns the hex string from SecureStore, or null if unavailable.
 */
export async function vaultExportKey(): Promise<string | null> {
  // Read the ACTIVE account's slot. Reading the legacy slot unconditionally
  // would return the pre-migration account's key regardless of which account
  // is selected — and `settingsSync` derives its encryption key from this, so
  // it would have encrypted account B's settings with account A's key.
  if (activeAddress) {
    // Guarded: NO fallback once an account is active. Falling through on a
    // transient read failure would return a DIFFERENT account's private key —
    // and `settingsSync` derives its encryption key from this, so it would
    // encrypt this account's settings with another account's key, making them
    // permanently undecryptable on every device.
    return readKeyFor(activeAddress);
  }
  // No active account at all (early boot) — the legacy anchor is the only
  // thing that can be meant.
  const raw = await SecureStore.getItemAsync(VAULT_RAW_KEY).catch(() => null);
  if (raw) return raw;

  // If encrypted, the key is only in memory via cachedSigner —
  // but WalletSigner doesn't expose the raw bytes. The encrypted
  // storage holds the hex, so we need the PIN to decrypt it.
  // Return null here — caller must unlock via PIN first.
  return null;
}

/** Wipe the wallet from memory and all storage. */
export async function vaultWipe(): Promise<void> {
  cachedSigner = null;
  activeAddress = null;

  // Wipe EVERY account, not just the legacy slots. Deleting only those left
  // each `ogmara.vault.private_key.<addr>` in place while `vaultInit` prefers
  // `SS.active` → so a "disconnected" device restored the wallet, with a full
  // spending signer, on the next launch. Key retention after an explicit
  // sign-out is the worst possible failure for this function.
  //
  // Enumerate from the index UNION rather than the probed list: an account
  // whose slot happens to read null right now must still have its slot
  // deleted, or it survives the wipe.
  try {
    const primary = parseIndex(await AsyncStorage.getItem(AS.primaryIndex).catch(() => null));
    const mirror = parseMirror(await SecureStore.getItemAsync(SS.mirror).catch(() => null));
    const allKeys = await AsyncStorage.getAllKeys().catch(() => [] as string[]);
    // Include the recorded active account. A freshly added account may have no
    // scoped preference keys yet and, if `persistIndex` had failed, no index
    // entry either — leaving `SS.active` as the only reference to its slot.
    const activeRecorded = await SecureStore.getItemAsync(SS.active).catch(() => null);
    const scanned = parseAddressesFromScopedKeys(allKeys);
    if (activeRecorded && isValidAddress(activeRecorded)) scanned.push(activeRecorded);
    // NOT capped: a wipe must reach every account, including any beyond the
    // display cap.
    const every = mergeIndexes(primary, mirror, scanned);
    for (const e of every) {
      for (const k of [SS.rawFor(e.a), SS.encFor(e.a), SS.modeFor(e.a), SS.encPrivFor(e.a)]) {
        await SecureStore.deleteItemAsync(k).catch(() => {});
      }
    }
  } catch {
    /* fall through — the legacy and index deletions below still run */
  }

  for (const k of [VAULT_RAW_KEY, VAULT_ENCRYPTED_KEY, VAULT_MODE_KEY, SS.mirror, SS.active]) {
    await SecureStore.deleteItemAsync(k).catch(() => {});
  }
  // The device-global E2E identity retained by the migration must go too —
  // it unwraps every envelope ever wrapped to it.
  await SecureStore.deleteItemAsync('ogmara.e2e.enc_private_key').catch(() => {});
  await AsyncStorage.removeItem(AS.primaryIndex).catch(() => {});
}

/**
 * Sign an auth request through the vault. `binding` is the target node's
 * `{ network, nodeId }` (audit 2026-06-07 host-binding) — obtain it from the
 * node's `/api/v1/health`; the vault layer stays network-free by taking it as
 * a parameter. Prefer `OgmaraClient.authHeaders()` for client-routed calls.
 */
export async function vaultSignRequest(
  method: string,
  path: string,
  binding: NodeBinding,
): Promise<{ [key: string]: string } | null> {
  if (!cachedSigner) return null;
  const headers = await cachedSigner.signRequest(method, path, binding);
  return { ...headers };
}

/*
 * PIN-at-rest encryption was REMOVED in 0.47.0 rather than carried forward.
 *
 * `vaultEncryptWithPin` / `vaultDecryptToRaw` had never had a caller since the
 * app shipped — App Lock gates the UI only, and the private key has always sat
 * raw in SecureStore. With per-account slots they became actively unsafe:
 * encrypting only the legacy slot left every `ogmara.vault.private_key.<addr>`
 * in plaintext while reporting success, and a version that encrypted the
 * per-account slots would have made those accounts permanently unloadable,
 * because `readKeyFor` has no decrypt path and `vaultUnlockWithPin` reads only
 * the legacy slot.
 *
 * Shipping a dead function that would lock a user out of every wallet if
 * anyone wired it is worse than not having the feature. Implement PIN-at-rest
 * properly — per-slot encrypt AND a matching decrypt in `readKeyFor` — when
 * App Lock actually needs it.
 */
