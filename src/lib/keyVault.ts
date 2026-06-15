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
import { walletAddress, signClaim, getCryptoClient, e2eAvailable } from './cryptoEnv';
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

let bk: Uint8Array | null = null;
let bkWallet: string | null = null;
let bkInflight: Promise<Uint8Array | null> | null = null;

/** Derive (once per session) and cache the wallet backup key. Dedupes concurrent callers. */
async function ensureBackupKey(): Promise<Uint8Array | null> {
  if (!e2eAvailable()) return null;
  const wallet = walletAddress();
  if (!wallet) return null;
  if (bk && bkWallet === wallet) return bk;
  if (bkInflight) return bkInflight;
  bkInflight = (async () => {
    try {
      const sig = await signClaim(VAULT_SIGN_CLAIM); // SDK normalizes raw/hex/base64
      bk = deriveVaultBackupKey(sig);
      bkWallet = wallet;
      return bk;
    } catch (e) {
      e2elog('keyvault: backup-key derivation failed', { err: (e as Error)?.message });
      return null;
    } finally {
      bkInflight = null;
    }
  })();
  return bkInflight;
}

/** Forget the cached backup key + session state (on wallet disconnect/switch). */
export function clearKeyVaultSession(): void {
  bk?.fill(0);
  bk = null;
  bkWallet = null;
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

async function publishBackup(): Promise<void> {
  if (publishing) return;
  const client = getCryptoClient();
  if (!client) return;
  const sealWallet = walletAddress();
  const keyring = currentKeyring();
  if (isEmptyKeyring(keyring)) return; // nothing to back up
  const key = await ensureBackupKey();
  if (!key) return; // no wallet / declined
  // Guard a wallet switch between scheduling and now.
  if (walletAddress() !== sealWallet || bkWallet !== sealWallet) return;
  publishing = true;
  try {
    const sealed = sealKeyVault(key, keyring);
    await client.syncKeyVault(sealed);
    e2elog('keyvault: backup published', {
      conv: Object.keys(keyring.conv).length,
      chan: Object.keys(keyring.chan).length,
      bytes: sealed.encrypted_vault.length,
    });
  } catch (e) {
    e2elog('keyvault: backup failed', { err: (e as Error)?.message });
  } finally {
    publishing = false;
  }
}

// --- restore (session-once, background) -------------------------------------

let restoreState: 'idle' | 'inflight' | 'done' = 'idle';

/** Pull + decrypt the vault and merge restored keys into the in-memory caches.
 *  Session-once and idempotent; safe to call from a decrypt-miss render path. */
export function tryRestoreKeyVault(): void {
  if (restoreState !== 'idle') return;
  restoreState = 'inflight';
  void (async () => {
    try {
      const client = getCryptoClient();
      if (!client) {
        restoreState = 'idle';
        return;
      }
      const key = await ensureBackupKey();
      if (!key) {
        restoreState = 'idle'; // no wallet / declined — allow a later retry
        return;
      }
      let resp;
      try {
        resp = await client.getKeyVault(); // null only on a true 404
      } catch (e) {
        restoreState = 'idle'; // transient — retry on next trigger
        e2elog('keyvault: restore fetch failed (will retry)', { err: (e as Error)?.message });
        return;
      }
      if (resp) {
        try {
          const keyring = openKeyVault(key, resp);
          const conv = importConvKeysFromVault(keyring.conv);
          const chan = importChannelKeysFromVault(keyring.chan);
          e2elog('keyvault: restored', { conv, chan });
        } catch (e) {
          e2elog('keyvault: restore decrypt failed', { err: (e as Error)?.message });
        }
      }
      restoreState = 'done';
    } finally {
      if (restoreState === 'done' && pendingBackup) {
        pendingBackup = false;
        scheduleBackup();
      }
    }
  })();
}

// Register into the crypto caches at module load (imported for side effects).
setKeyringChangeListener(scheduleBackup);
setVaultRestoreRequester(tryRestoreKeyVault);
