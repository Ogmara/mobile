/**
 * E2E key-recovery vault wiring (P3, protocol §2.5) — mobile port of desktop
 * `keyVault.ts`. Persists this wallet's symmetric content keys (DM `conv_key`s and
 * channel epoch `channel_key`s) to the node, sealed under a backup key derived from
 * `signClaim(VAULT_SIGN_CLAIM)`, so a fresh device / reinstall can restore full message
 * history. The node stores the blob opaquely (it never holds the backup key).
 *
 * Wallet PRIVATE keys are NEVER placed in the vault — only symmetric content keys.
 */
import {
  deriveVaultBackupKey,
  sealKeyVault,
  openKeyVault,
  VAULT_SIGN_CLAIM,
  type VaultKeyring,
} from '@ogmara/sdk';
import { walletAddress, signClaim, e2eAvailable } from './cryptoEnv';
import { captureAccountContext } from './accountContext';
import {
  BackupKeyCache, runKeyVaultPublish, runKeyVaultRestore, type OwnedKey,
} from './keyVaultCore';
import {
  setKeyringChangeListener,
  setVaultRestoreRequester,
  exportConvKeysForVault,
  importConvKeysFromVault,
} from './dmCrypto';
import {
  exportChannelKeysForVault,
  importChannelKeysFromVault,
} from './channelCrypto';
import { e2elog } from './e2eDebug';

// Per-wallet backup-key cache: never hands one wallet's key (cached OR still
// being derived) to another wallet's caller; `clear()` invalidates in-flight
// derivations too. See keyVaultCore.ts for the bug this replaces.
const backupKeys = new BackupKeyCache();

/**
 * The backup key FOR `wallet`. The derivation signs with the crypto-env signer,
 * read synchronously inside `signClaim` — so it is only started while `wallet`
 * is still the crypto-env identity; otherwise null.
 */
function ensureBackupKey(wallet: string): Promise<OwnedKey | null> {
  if (!e2eAvailable() || !wallet || walletAddress() !== wallet) return Promise.resolve(null);
  return backupKeys.get(wallet, async () => deriveVaultBackupKey(await signClaim(VAULT_SIGN_CLAIM)));
}

/** Forget the cached backup key + session state (on wallet disconnect/switch). */
export function clearKeyVaultSession(): void {
  backupKeys.clear();
  // Invalidate any restore still in flight: it must not write `restoreState`
  // (or trigger the pending backup) for the account that comes next.
  restoreRun++;
  restoreState = 'idle';
  pendingBackup = false;
  if (backupTimer) {
    clearTimeout(backupTimer);
    backupTimer = null;
  }
}

function currentKeyring(): VaultKeyring {
  return { conv: exportConvKeysForVault(), chan: exportChannelKeysForVault() };
}

const isEmptyKeyring = (kr: VaultKeyring): boolean =>
  Object.keys(kr.conv).length === 0 && Object.keys(kr.chan).length === 0;

// --- backup (debounced) -----------------------------------------------------

const BACKUP_DEBOUNCE_MS = 4_000;
let backupTimer: ReturnType<typeof setTimeout> | null = null;
let pendingBackup = false;
let publishing = false;

/**
 * Arm a debounced backup. CRITICAL ordering: never publish before the remote vault has
 * been pulled + merged this session, or a fresh device would clobber its own history
 * (LWW) with a partial keyring. While restore isn't `done`, record intent + kick restore.
 */
function scheduleBackup(): void {
  if (restoreState !== 'done') {
    pendingBackup = true;
    tryRestoreKeyVault();
    return;
  }
  if (backupTimer) clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    backupTimer = null;
    void publishBackup();
  }, BACKUP_DEBOUNCE_MS);
}

/** Force an immediate backup publish (e.g. Settings → "Back up keys now"). */
export async function backupNow(): Promise<void> {
  if (restoreState !== 'done') {
    tryRestoreKeyVault();
  }
  await publishBackup();
}

/**
 * Seal + publish the CAPTURED account's keyring under ONLY that account's
 * backup key. Wallet, storage scope, reset generation, client and signer are
 * re-checked after the key await and right before the signed upload
 * (keyVaultCore.runKeyVaultPublish); a switch mid-flight sends nothing.
 */
async function publishBackup(): Promise<void> {
  if (publishing) return;
  const ctx = captureAccountContext();
  const client = ctx.client;
  if (!ctx.account || !client) return;
  publishing = true;
  try {
    let sent: { conv: number; chan: number; bytes: number } | null = null;
    const ok = await runKeyVaultPublish(ctx, {
      getKey: ensureBackupKey,
      readKeyring: currentKeyring,
      isEmpty: isEmptyKeyring,
      seal: (key, keyring) => {
        const sealed = sealKeyVault(key, keyring);
        sent = { conv: Object.keys(keyring.conv).length, chan: Object.keys(keyring.chan).length, bytes: sealed.encrypted_vault.length };
        return sealed;
      },
      send: (sealed) => client.syncKeyVault(sealed),
    });
    if (ok) e2elog('keyvault: backup published', sent ?? {});
  } catch (e) {
    e2elog('keyvault: backup failed', { err: (e as Error)?.message });
  } finally {
    publishing = false;
  }
}

// --- restore (session-once, background) -------------------------------------

let restoreState: 'idle' | 'inflight' | 'done' = 'idle';
/** Bumped by `clearKeyVaultSession`; a restore from an older run is stale. */
let restoreRun = 0;

/** Pull + decrypt the vault and merge restored keys into the in-memory caches.
 *  Session-once and idempotent; safe to call from a decrypt-miss render path. */
export function tryRestoreKeyVault(): void {
  if (restoreState !== 'idle') return;
  restoreState = 'inflight';
  const run = restoreRun;
  // Bind this restore to the account it is FOR (wallet + scope + reset
  // generation + client + signer). `clearKeyVaultSession` can't cancel an
  // in-flight restore, so every step re-checks (keyVaultCore.runKeyVaultRestore):
  // without that, a switch mid-flight imported the PREVIOUS account's keys into
  // the new account's caches, or — via a shared in-flight key derivation — tried
  // B's vault with A's key, failed, and went terminal 'done', after which the
  // pending backup overwrote B's remote vault with a partial keyring.
  const ctx = captureAccountContext();
  void (async () => {
    let outcome: 'done' | 'idle' = 'idle';
    try {
      const client = ctx.client;
      if (client) {
        outcome = await runKeyVaultRestore(ctx, {
          getKey: ensureBackupKey,
          fetch: () => client.getKeyVault(), // null only on a true 404
          open: (key, resp) => {
            try {
              return openKeyVault(key, resp);
            } catch (e) {
              e2elog('keyvault: restore decrypt failed', { err: (e as Error)?.message });
              throw e;
            }
          },
          importKeys: (keyring) => {
            const conv = importConvKeysFromVault(keyring.conv);
            const chan = importChannelKeysFromVault(keyring.chan);
            e2elog('keyvault: restored', { conv, chan });
          },
        });
      }
    } catch (e) {
      e2elog('keyvault: restore failed (will retry)', { err: (e as Error)?.message });
      outcome = 'idle';
    } finally {
      // A stale run (session cleared since it started) touches nothing.
      if (run === restoreRun) {
        restoreState = outcome;
        if (outcome === 'done' && pendingBackup) {
          pendingBackup = false;
          scheduleBackup();
        }
      }
    }
  })();
}

// Register into the crypto caches at module load (imported for side effects).
setKeyringChangeListener(scheduleBackup);
setVaultRestoreRequester(tryRestoreKeyVault);
