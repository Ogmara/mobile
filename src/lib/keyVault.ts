/**
 * E2E key-recovery vault wiring (P3, protocol §2.5) — mobile port of desktop
 * `keyVault.ts`. Persists this wallet's symmetric content keys (DM `conv_key`s and
 * channel epoch `channel_key`s) to the node, sealed under a backup key derived from
 * the wallet's signature of `VAULT_SIGN_CLAIM`, so a fresh device / reinstall can
 * restore full message history. The node stores the blob opaquely (it never holds
 * the backup key).
 *
 * Wallet PRIVATE keys are NEVER placed in the vault — only symmetric content keys.
 *
 * Flow (state machine in lib/keyVaultCore.ts `createVaultController`, same rules as
 * web 0.84.0 / desktop 1.84.0):
 *  - **Backup:** whenever a content key is cached, `scheduleBackup` debounces a
 *    publish (one LWW record per wallet) — but only once restore is `done` for this
 *    account, so a publish never overwrites a vault this session hasn't read (or
 *    confirmed verifiably empty: a 404 AND no per-wallet `keyVaultSeen` marker).
 *  - **Restore:** a decrypt-miss triggers a session-once background pull → open →
 *    merge into the in-memory caches.
 *  - **Blocked:** a vault our own key can't open, or a 404 for a vault this device has
 *    seen before, pauses backups until the user presses Retry or confirms "Replace
 *    backup" (Settings → Encryption & Key Backup).
 */
import {
  deriveVaultBackupKey,
  sealKeyVault,
  openKeyVault,
  VAULT_SIGN_CLAIM,
  ChannelKeyringError,
  type VaultKeyring,
  type OgmaraClient,
  type KeyVaultResponse,
  type KeyVaultSyncData,
} from '@ogmara/sdk';
import { walletAddress, getSigner, e2eAvailable } from './cryptoEnv';
import { captureAccountContext } from './accountContext';
import { scopedGetForStrict, scopedSetFor } from './walletScope';
import {
  BackupKeyCache,
  createVaultController,
  makeEnsureBackupKey,
  KeyringReadError,
  type BackupNowResult,
  type BackupPauseReason,
  type PublishOutcome,
  type RestoreNowResult,
  type VaultStatus,
} from './keyVaultCore';
import {
  setKeyringChangeListener,
  setVaultRestoreRequester,
  exportConvKeysForVault,
  importConvKeysFromVault,
} from './dmCrypto';
import {
  prepareChannelKeyExport,
  importChannelKeysFromVault,
  channelKeysHeld,
  previewChannelKeyPrune,
  applyChannelKeyPrune,
} from './channelCrypto';
import type { PruneLevel, PrunePlan } from './channelKeyCore';
import { e2elog } from './e2eDebug';

export type { BackupNowResult, RestoreNowResult, VaultStatus, PublishOutcome, BackupPauseReason, PruneLevel, PrunePlan };

/** Per-wallet "this device has opened or published this wallet's vault" marker.
 *  Lives under `<base>::<wallet>`, so `wipeWalletScope` (sign-out) removes it. */
const KEYVAULT_SEEN = 'ogmara.keyVaultSeen';

// Per-wallet backup-key cache: never hands one wallet's key (cached OR still
// being derived) to another wallet's caller; `clear()` invalidates in-flight
// derivations too. See keyVaultCore.ts for the bug this replaces.
const backupKeys = new BackupKeyCache();

/**
 * The backup key FOR `wallet`: derived only while `wallet` is the crypto-env
 * identity and the signer is that wallet's own key (signer.address === wallet),
 * signing with exactly the signer that was checked.
 */
const ensureBackupKey = makeEnsureBackupKey(backupKeys, {
  e2eAvailable,
  walletAddress,
  signer: getSigner,
  derive: async (signer) =>
    deriveVaultBackupKey(await signer.signKleverMessage(new TextEncoder().encode(VAULT_SIGN_CLAIM))),
  log: e2elog,
});

/**
 * The keyring to seal. The channel part is the SDK keyring's export
 * (sdk-js 0.68.0): it refuses — `ChannelKeyringError` — rather than shrink
 * the backup (`vault_too_large`, `opaque_overflow`) or export for another
 * account (`stale`); those become {@link KeyringReadError}, which the
 * controller surfaces as "backup paused" (never as backed up).
 */
/** Commit handles of prepared (not yet published) exports, by the keyring object handed to the seal. */
const pendingCommits = new WeakMap<VaultKeyring, () => boolean>();

function currentKeyring(): VaultKeyring {
  let prepared: ReturnType<typeof prepareChannelKeyExport>;
  try {
    prepared = prepareChannelKeyExport();
  } catch (e) {
    if (e instanceof ChannelKeyringError) throw new KeyringReadError(e.code);
    throw e;
  }
  const kr: VaultKeyring = { conv: exportConvKeysForVault(), chan: prepared.chan };
  pendingCommits.set(kr, prepared.commit);
  return kr;
}

/** The publish of `kr` succeeded: commit its channel-key export. False when the keyring refused it (stale). */
function commitKeyring(kr: VaultKeyring): boolean {
  const c = pendingCommits.get(kr);
  pendingCommits.delete(kr);
  if (!c) return false;
  const ok = c();
  if (!ok) e2elog('keyvault: export commit refused (account changed)');
  return ok;
}

/** Anything to back up? Cheap: never builds the channel export (it marks keys persisted). */
const hasKeys = (): boolean => channelKeysHeld() || Object.keys(exportConvKeysForVault()).length > 0;

const isEmptyKeyring = (kr: VaultKeyring): boolean =>
  Object.keys(kr.conv).length === 0 && Object.keys(kr.chan).length === 0;

/** `null` on a storage error: the restore stays retryable instead of guessing "empty". */
async function seenMarker(wallet: string): Promise<boolean | null> {
  try {
    return (await scopedGetForStrict(wallet, KEYVAULT_SEEN)) === wallet;
  } catch {
    return null;
  }
}

/** Explicit-address write: lands in `wallet`'s namespace even if a switch follows. */
function markSeen(wallet: string): void {
  void scopedSetFor(wallet, KEYVAULT_SEEN, wallet);
}

const listeners = new Set<() => void>();

const controller = createVaultController<OgmaraClient | null, KeyVaultResponse, KeyVaultSyncData, VaultKeyring>({
  capture: captureAccountContext,
  getKey: ensureBackupKey,
  fetch: async (client) => {
    if (!client) throw new Error('no client');
    return client.getKeyVault(); // null only on a true 404
  },
  open: openKeyVault,
  importKeys: (keyring) => {
    const conv = importConvKeysFromVault(keyring.conv);
    const chan = importChannelKeysFromVault(keyring.chan);
    e2elog('keyvault: restored', { conv, chan });
    return Object.keys(keyring.conv).length + Object.keys(keyring.chan).length;
  },
  seenMarker,
  markSeen,
  readKeyring: currentKeyring,
  isEmpty: isEmptyKeyring,
  hasKeys,
  committed: commitKeyring,
  // Re-open + import the remote vault before EVERY seal (one LWW record per
  // wallet: never overwrite keys another device backed up since our restore).
  refreshBeforeSeal: true,
  seal: sealKeyVault,
  send: async (client, sealed) => {
    if (!client) throw new Error('no client');
    await client.syncKeyVault(sealed);
    e2elog('keyvault: backup published', { bytes: sealed.encrypted_vault.length });
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  onStateChange: () => {
    for (const l of listeners) {
      try { l(); } catch { /* a bad listener must not break the vault */ }
    }
  },
  log: e2elog,
});

/** Forget the cached backup key + session state (on wallet disconnect/switch).
 *  Cancels any pending/armed backup so it can't fire under a NEW wallet. */
export function clearKeyVaultSession(): void {
  backupKeys.clear();
  controller.clearSession();
}

/** Pull + decrypt the vault and merge restored keys into the in-memory caches.
 *  Session-once, coalesced and idempotent; safe to call from a decrypt-miss render
 *  path. A transient failure stays retryable; `blocked` waits for the user. */
export function tryRestoreKeyVault(): void {
  controller.tryRestore();
}

/**
 * Settings → "Back up keys now". Waits for (or runs) this session's restore first
 * and NEVER publishes unless it finished `done`; then waits for any in-flight
 * publish and runs exactly one, reporting the real outcome.
 */
export function backupNow(): Promise<BackupNowResult> {
  return controller.backupNow();
}

/** Settings → "Restore": (re)fetch + merge with an honest result. */
export function restoreKeyVaultNow(): Promise<RestoreNowResult> {
  return controller.restoreNow();
}

/** User Retry while blocked: run restore again. */
export function retryKeyVault(): void {
  controller.retry();
}

/** The account a "Replace backup" confirmation is FOR. Capture it BEFORE the
 *  confirm opens and pass it to {@link replaceKeyVault}; `null` when no account
 *  is fully active (nothing can be confirmed for it). */
export type KeyVaultAccount = ReturnType<typeof captureAccountContext>;
export function keyVaultAccount(): KeyVaultAccount | null {
  const ctx = captureAccountContext();
  return ctx.account ? ctx : null;
}

/** User-confirmed "Replace backup" (behind a confirm): overwrite an unreadable /
 *  missing remote vault with this device's keyring. Only acts while `blocked`,
 *  and only for `forAccount` — the account the user confirmed for: if another
 *  account is active by now (a switch while the confirm was open) it returns
 *  'stale' and publishes nothing. A node switch alone (same account) is fine. */
export function replaceKeyVault(forAccount: KeyVaultAccount | null): Promise<PublishOutcome> {
  if (forAccount === null) return Promise.resolve('stale');
  return controller.replace(forAccount);
}

/**
 * Settings → "Free up backup space" while the backup is paused as
 * `vault_too_large`: the next prune ladder level (from `from` on) whose DRY
 * RUN would remove something, with per-class counts — nothing removed.
 * null = nothing removable at any remaining level.
 */
export function previewKeyPrune(from?: PruneLevel): PrunePlan | null {
  return previewChannelKeyPrune(from);
}

/**
 * After the user CONFIRMED `plan` (captured for `forAccount` before the
 * confirm opened): prune exactly that level / scope, then run one backup
 * (restore gate, pre-seal re-open + import — the SDK remembers pruned keys
 * for the session, so the re-import does not bring them back — honest
 * result). 'stale' when the account changed meanwhile, 'changed' when a
 * fresh dry run would remove MORE than the confirmed plan (nothing removed:
 * re-confirm with the new counts).
 */
export async function pruneKeysAndBackup(
  forAccount: KeyVaultAccount | null, plan: PrunePlan,
): Promise<{ removed: number; backup: BackupNowResult } | 'stale' | 'changed'> {
  if (!forAccount || !forAccount.account || !forAccount.accountStillValid()) return 'stale';
  // B1: never remove more than the user confirmed — a fresh dry run that grew
  // (keys arrived while the dialog was open) returns 'changed', nothing removed.
  const r = applyChannelKeyPrune(plan);
  if (r === 'changed') return 'changed';
  if (!r) return 'stale';
  e2elog('keyvault: user-confirmed prune', { level: plan.level, removed: r.removedCount });
  return { removed: r.removedCount, backup: await controller.backupNow() };
}

/** Current vault status for the active account (Settings E2E section). */
export function getKeyVaultStatus(): VaultStatus {
  return controller.status();
}

/** Subscribe to status changes; returns the unsubscribe function. */
export function subscribeKeyVaultStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

// Register into the crypto caches at module load (imported for side effects).
setKeyringChangeListener(() => controller.scheduleBackup());
setVaultRestoreRequester(tryRestoreKeyVault);
