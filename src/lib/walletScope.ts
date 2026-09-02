/**
 * Per-wallet namespacing for locally cached account state.
 *
 * The project rule is that ALL data is indexed under the wallet address. The
 * vault and E2E layers already honour it; the profile/preference layer did not
 * — display name, joined channels, news topic groups and mutes all lived under
 * global AsyncStorage keys. Switching wallets therefore left the previous
 * account's identity and lists on screen, which is both confusing and a
 * privacy leak between accounts on a shared device.
 *
 * Keys resolved through here become `<base>::<address>`, so two accounts on
 * one device never collide, and switching back restores what that account had.
 *
 * DEVICE-level settings (language, theme, node URL, font size…) deliberately
 * do NOT go through here: they belong to the install, not the account.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** Separator chosen so it cannot occur in a bech32 address or an existing key. */
export const SEP = '::';

/** Set once the legacy global keys have been claimed. Never migrate twice. */
const MIGRATED_MARKER = 'ogmara.walletScope.migrated';

let activeWallet: string | null = null;

/**
 * Point per-wallet storage at `address`, or clear it on sign-out.
 *
 * Must be called BEFORE any per-wallet read, so the boot path sets it as soon
 * as the persisted wallet address is known.
 */
/**
 * Caches that must be dropped the instant the active wallet changes.
 *
 * A REGISTRY rather than direct imports, because those stores import
 * `scopedGet`/`scopedSet` from here — calling back into them directly would be
 * a cycle. Each store registers itself at module load.
 */
const switchResets = new Set<() => void>();

/** Register a cache to be cleared on every wallet-scope change. */
export function registerWalletSwitchReset(fn: () => void): void {
  switchResets.add(fn);
}

export function setWalletScope(address: string | null): void {
  const next = address && address.length > 0 ? address : null;
  const changed = next !== activeWallet;
  activeWallet = next;
  // Namespacing storage is not enough on its own: the stores that cache in
  // memory memoize for the life of the PROCESS, so after a switch the previous
  // account's data would still render — and the first edit would persist it
  // under the new wallet and sync it to the node.
  //
  // These run SYNCHRONOUSLY, in the same tick as the scope flip. An earlier
  // version used `void import(...).then(...)`, which left a window of at least
  // one microtask where `activeWallet` was already the new account while the
  // caches still held the old one — any read in that window returned the wrong
  // account's data, and any write persisted it under the new wallet and synced
  // it to the node. Harmless while the only callers were boot and sign-out;
  // fatal once accounts can be switched at runtime.
  if (changed) {
    for (const reset of switchResets) {
      try {
        reset();
      } catch {
        /* one bad reset must not block the rest of the switch */
      }
    }
  }
}

/** The wallet per-wallet storage is currently pointed at. */
export function getWalletScope(): string | null {
  return activeWallet;
}

/**
 * Namespace `base` to the active wallet.
 *
 * Returns `null` when no wallet is active — there is no per-wallet data
 * without a wallet, and callers must treat that as "nothing stored" rather
 * than falling back to a global key. Falling back is what produced the bug
 * this module exists to fix.
 */
export function scopedKey(base: string): string | null {
  return activeWallet ? `${base}${SEP}${activeWallet}` : null;
}

/** Read a per-wallet value. `null` when unset or when no wallet is active. */
export async function scopedGet(base: string): Promise<string | null> {
  const k = scopedKey(base);
  if (!k) return null;
  try {
    return await AsyncStorage.getItem(k);
  } catch {
    return null;
  }
}

/** Write a per-wallet value. A no-op when no wallet is active. */
export async function scopedSet(base: string, value: string): Promise<void> {
  const k = scopedKey(base);
  if (!k) return;
  try {
    await AsyncStorage.setItem(k, value);
  } catch {
    /* best-effort */
  }
}

/** Remove a per-wallet value. */
export async function scopedRemove(base: string): Promise<void> {
  const k = scopedKey(base);
  if (!k) return;
  try {
    await AsyncStorage.removeItem(k);
  } catch {
    /* best-effort */
  }
}

/**
 * Delete every key belonging to `address` (defaults to the active wallet).
 *
 * Called on disconnect so a signed-out account leaves nothing behind on the
 * device. Namespacing alone would keep the data addressable forever; wiping
 * alone would lose it when switching back and forth. Doing both means an
 * account's data survives a switch but not a deliberate sign-out.
 */
export async function wipeWalletScope(address?: string | null): Promise<void> {
  const target = address ?? activeWallet;
  if (!target) return;
  const suffix = `${SEP}${target}`;
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((k) => k.endsWith(suffix));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } catch {
    /* best-effort */
  }
}

/**
 * Every global key that predates namespacing, from `settings.ts` and the
 * standalone stores alike. One list, so the one-shot migration cannot miss a
 * store the way the first attempt missed `channelOrg`.
 */
const ALL_LEGACY_BASES = [
  // settings.ts, PER_WALLET
  'ogmara.display_name',
  'ogmara.bio',
  'ogmara.avatar_cid',
  'ogmara.avatar_local_uri',
  'ogmara.pinned_channels',
  'ogmara.muted_channels',
  'ogmara.muted_users',
  'ogmara.news_last_read_all',
  'ogmara.news_last_read_following',
  'ogmara.news_last_viewed_at',
  // standalone stores
  'ogmara_joined_channels',
  'ogmara.topicGroups',
  'ogmara.hiddenDms',
  'ogmara.channelOrg',
  'ogmara.groupCollapsed',
  'ogmara.addressbook',
  // Became per-wallet in 0.47.0. Devices upgrading from 0.46.0 already have
  // MIGRATED_MARKER set, so this only helps installs that skip 0.46 — the
  // cost of missing it is one redundant device registration, not data loss.
  'ogmara.device_registered',
] as const;

/**
 * Claim the pre-namespacing global keys for the wallet that owned them —
 * exactly once, ever.
 *
 * **This must run before any wallet is created or restored in a session.**
 * The naive version (migrate on every boot-restore, into whatever wallet is
 * active) is actively dangerous: on a device that still has an old account's
 * global keys — which is every device upgrading to this build — a user who
 * creates a NEW wallet and restarts would have the OLD account's display name,
 * channels and topic groups permanently adopted into the new namespace. That
 * is the reported bug, made worse and made irreversible.
 *
 * The owner of the legacy data is whoever was last active, i.e. the persisted
 * global `ogmara.wallet_address`. If there is none, the data is orphaned and
 * is discarded rather than handed to the next wallet to appear.
 */
export async function runWalletScopeMigrationOnce(): Promise<void> {
  try {
    if (await AsyncStorage.getItem(MIGRATED_MARKER)) return;
    // Read the GLOBAL key directly — this predates namespacing by definition.
    const owner = await AsyncStorage.getItem('ogmara.wallet_address');
    for (const base of ALL_LEGACY_BASES) {
      const legacy = await AsyncStorage.getItem(base);
      if (legacy === null) continue;
      if (owner) {
        const target = `${base}${SEP}${owner}`;
        // Never overwrite data already under the wallet.
        if ((await AsyncStorage.getItem(target)) === null) {
          await AsyncStorage.setItem(target, legacy);
        }
      }
      // Remove either way: leaving it lets the next account inherit it.
      await AsyncStorage.removeItem(base);
    }
    await AsyncStorage.setItem(MIGRATED_MARKER, '1');
  } catch {
    // Never block startup. The marker stays unset, so a later boot retries.
  }
}

/**
 * Read/write another account's namespace without switching scope.
 *
 * The account list has to show every account's label and display name at once;
 * `scopedGet` can only ever see the active one. Deliberately narrow — anything
 * that mutates the CURRENT account must go through `scopedSet` so it cannot
 * accidentally target the wrong namespace.
 */
export async function scopedGetFor(address: string, base: string): Promise<string | null> {
  if (!address) return null;
  try {
    return await AsyncStorage.getItem(`${base}${SEP}${address}`);
  } catch {
    return null;
  }
}

/** Write into a specific account's namespace. */
export async function scopedSetFor(address: string, base: string, value: string): Promise<void> {
  if (!address) return;
  try {
    await AsyncStorage.setItem(`${base}${SEP}${address}`, value);
  } catch {
    /* best-effort */
  }
}
