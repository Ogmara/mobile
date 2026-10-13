/**
 * Account-safe core of the E2E key-recovery vault (keyVault.ts), with injected
 * dependencies so the account-switch behaviour is testable under plain
 * `node --test` (no React Native / SDK imports).
 *
 * The bug class this closes: the backup key is derived from a wallet-bound
 * signature, the derivation is async and was de-duplicated with ONE global
 * in-flight promise. A second caller for a DIFFERENT wallet got the first
 * wallet's derivation back; `clearKeyVaultSession` didn't clear it; restore
 * never checked whose key it got — so B's restore could decrypt with A's key,
 * fail, go terminal 'done', and the pending backup would then overwrite B's
 * remote vault with a partial keyring.
 */

/** A derived backup key and the wallet it was derived FOR. */
export interface OwnedKey { key: Uint8Array; wallet: string }

/**
 * Per-wallet backup-key cache with per-wallet in-flight de-duplication.
 * Never returns a key (cached or in flight) belonging to another wallet, and
 * `clear()` invalidates any derivation still in flight (it can't cache).
 */
export class BackupKeyCache {
  private key: Uint8Array | null = null;
  private keyWallet: string | null = null;
  private inflight: Promise<OwnedKey | null> | null = null;
  private inflightWallet: string | null = null;
  private inflightToken: object | null = null;
  private epoch = 0;

  /**
   * @param derive MUST start synchronously with the signer of `wallet`
   *               (cryptoEnv.signClaim reads the signer synchronously).
   */
  get(wallet: string, derive: () => Promise<Uint8Array>): Promise<OwnedKey | null> {
    if (!wallet) return Promise.resolve(null);
    if (this.key && this.keyWallet === wallet) return Promise.resolve({ key: this.key, wallet });
    if (this.inflight && this.inflightWallet === wallet) return this.inflight;
    const epoch = this.epoch;
    // Identity token for THIS derivation, set before it starts (a derive that
    // throws synchronously must not touch a not-yet-assigned promise).
    const token = {};
    this.inflightToken = token;
    this.inflightWallet = wallet;
    const p: Promise<OwnedKey | null> = (async () => {
      try {
        const k = await derive();
        // Cache only if nothing cleared / superseded this derivation meanwhile.
        if (this.epoch === epoch && this.inflightToken === token) {
          this.key?.fill(0);
          this.key = k;
          this.keyWallet = wallet;
        }
        return { key: k, wallet };
      } catch {
        return null;
      } finally {
        if (this.inflightToken === token) {
          this.inflight = null; this.inflightWallet = null; this.inflightToken = null;
        }
      }
    })();
    if (this.inflightToken === token) this.inflight = p;
    return p;
  }

  /** Drop everything (wallet disconnect/switch). In-flight results won't be cached. */
  clear(): void {
    this.key?.fill(0);
    this.key = null;
    this.keyWallet = null;
    this.inflight = null;
    this.inflightWallet = null;
    this.inflightToken = null;
    this.epoch++;
  }
}

/** A key that was zeroed by `clear()` while a caller held it is never usable. */
function usable(owned: OwnedKey | null, wallet: string): owned is OwnedKey {
  return !!owned && owned.wallet === wallet && owned.key.length > 0 && owned.key.some((b) => b !== 0);
}

/** The account a run is bound to (see accountContext.ts). */
export interface RunContext { account: string | null; stillValid: () => boolean }

export interface RestoreDeps<R, K> {
  getKey: (wallet: string) => Promise<OwnedKey | null>;
  /** Fetch the remote vault; `null` = none stored (404). Throws on transient failure. */
  fetch: () => Promise<R | null>;
  /** Decrypt; throws on failure. */
  open: (key: Uint8Array, resp: R) => K;
  /** Merge restored keys into the in-memory caches (synchronous). */
  importKeys: (keyring: K) => void;
}

/**
 * One restore attempt. 'done' = this account's vault was definitively handled
 * (imported, or none exists, or it genuinely can't be decrypted with THIS
 * account's own key). 'idle' = not handled; retry later. Anything that went
 * wrong because the account changed, or because the key wasn't this account's,
 * is 'idle' — never terminal — so the pending backup can't fire against a
 * vault that was never actually read.
 */
export async function runKeyVaultRestore<R, K>(ctx: RunContext, deps: RestoreDeps<R, K>): Promise<'done' | 'idle'> {
  const wallet = ctx.account;
  if (!wallet || !ctx.stillValid()) return 'idle';
  const owned = await deps.getKey(wallet);
  if (!usable(owned, wallet) || !ctx.stillValid()) return 'idle';
  let resp: R | null;
  try {
    resp = await deps.fetch();
  } catch {
    return 'idle';
  }
  if (!ctx.stillValid() || !usable(owned, wallet)) return 'idle';
  if (resp) {
    let keyring: K;
    try {
      keyring = deps.open(owned.key, resp);
    } catch {
      // A real decrypt failure under THIS account's own key is terminal (the
      // existing design); one caused by a switch is not.
      return ctx.stillValid() ? 'done' : 'idle';
    }
    if (!ctx.stillValid()) return 'idle';
    deps.importKeys(keyring);
  }
  return 'done';
}

export interface PublishDeps<KR, S> {
  getKey: (wallet: string) => Promise<OwnedKey | null>;
  /** Snapshot of the live in-memory keyring (synchronous). */
  readKeyring: () => KR;
  isEmpty: (kr: KR) => boolean;
  /** Synchronous seal. */
  seal: (key: Uint8Array, kr: KR) => S;
  /** The signed upload. */
  send: (sealed: S) => Promise<void>;
}

/**
 * One backup publish. Seals ONLY the captured account's keyring with ONLY that
 * account's key, re-checked after the key await and immediately before the
 * signed send. Returns true if something was sent.
 */
export async function runKeyVaultPublish<KR, S>(ctx: RunContext, deps: PublishDeps<KR, S>): Promise<boolean> {
  const wallet = ctx.account;
  if (!wallet || !ctx.stillValid()) return false;
  if (deps.isEmpty(deps.readKeyring())) return false; // nothing to back up
  const owned = await deps.getKey(wallet);
  if (!usable(owned, wallet) || !ctx.stillValid()) return false;
  // Read the keyring AFTER the await + re-check: it must be this account's.
  const keyring = deps.readKeyring();
  if (deps.isEmpty(keyring) || !usable(owned, wallet)) return false;
  const sealed = deps.seal(owned.key, keyring);
  if (!ctx.stillValid()) return false;
  await deps.send(sealed);
  return true;
}
