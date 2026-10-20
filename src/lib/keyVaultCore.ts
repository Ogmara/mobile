/**
 * Account-safe core of the E2E key-recovery vault (keyVault.ts), with injected
 * dependencies so the account-switch behaviour is testable under plain
 * `node --test` (no React Native / SDK imports).
 *
 * The bug class this closes (0.47.x): the backup key is derived from a
 * wallet-bound signature, the derivation is async and was de-duplicated with
 * ONE global in-flight promise. A second caller for a DIFFERENT wallet got the
 * first wallet's derivation back; `clearKeyVaultSession` didn't clear it;
 * restore never checked whose key it got — so B's restore could decrypt with
 * A's key, fail, go terminal 'done', and the pending backup would then
 * overwrite B's remote vault with a partial keyring.
 *
 * Why (mobile 0.57.0, same rule as web 0.84.0 / desktop 1.84.0): the remote
 * vault is one last-write-wins record per wallet, so ANY publish replaces it
 * on every node. Rule: never overwrite the remote vault unless THIS session,
 * for THIS account (wallet + storage scope + reset generation + signer),
 *  (1) opened the remote vault with this wallet's own backup key,
 *  (2) confirmed it verifiably empty — a real 404 AND no per-wallet
 *      `keyVaultSeen` marker on this device (vaults replicate by live gossip
 *      only, so a node that joined after the last publish answers 404 for a
 *      vault that exists elsewhere), or
 *  (3) the user explicitly confirmed "Replace backup".
 * An `open` failure under our own key (wrong-key blob, corruption, a future
 * `format_version`) is `blocked: 'unreadable'`, not terminal `done`.
 * Remaining gap: a fresh device (no marker) on a node without a copy can't be
 * told apart from a brand-new user until nodes backfill vaults.
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
   *               (see {@link makeEnsureBackupKey}).
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

// --- backup-key derivation guard ------------------------------------------------

/** The signer as far as the guard needs it. */
export interface ClaimSigner { address: string }

export interface BackupKeyEnv<S extends ClaimSigner> {
  /** cryptoEnv.e2eAvailable() — built-in wallets only today. */
  e2eAvailable(): boolean;
  /** cryptoEnv.walletAddress() now. */
  walletAddress(): string | null;
  /** cryptoEnv.getSigner() now. */
  signer(): S | null;
  /** Sign the vault claim with EXACTLY this signer and derive the backup key. */
  derive(signer: S): Promise<Uint8Array>;
  log?(step: string, data?: Record<string, unknown>): void;
}

/**
 * `ensureBackupKey(wallet)` for the restore/publish runs: derives only while
 * `wallet` is still the crypto-env identity AND the signer that will sign the
 * claim is that wallet's own key (built-in: `signer.address === wallet`). A
 * signer for any other address would derive a backup key that opens nothing
 * of `wallet`'s — and a publish sealed under it would make `wallet`'s vault
 * unreadable everywhere. The checked signer object is the one that signs (no
 * second read of the environment).
 *
 * K5 note: a K5 account's signer is the delegated DEVICE key, which never
 * equals the wallet, so this refuses K5 by construction — matching
 * `e2eAvailable()` (built-in only) today.
 */
export function makeEnsureBackupKey<S extends ClaimSigner>(
  cache: BackupKeyCache,
  env: BackupKeyEnv<S>,
): (wallet: string) => Promise<OwnedKey | null> {
  return (wallet) => {
    if (!wallet || !env.e2eAvailable() || env.walletAddress() !== wallet) return Promise.resolve(null);
    const signer = env.signer();
    if (!signer || signer.address !== wallet) {
      env.log?.('keyvault: signer is not the wallet key; backup key not derived');
      return Promise.resolve(null);
    }
    return cache.get(wallet, () => env.derive(signer));
  };
}

// --- one restore / one publish ---------------------------------------------------

/** The account a run is bound to (see accountContext.ts). */
export interface RunContext {
  account: string | null;
  /** Same account AND same crypto client (wallet, scope, generation, client, signer). */
  stillValid: () => boolean;
  /**
   * Same account, ignoring a crypto-client swap (node switch). Defaults to
   * `stillValid` when absent.
   */
  accountStillValid?: () => boolean;
}

const sameAccount = (ctx: RunContext) => (ctx.accountStillValid ?? ctx.stillValid)();

export interface RestoreDeps<R, K> {
  getKey: (wallet: string) => Promise<OwnedKey | null>;
  /** Fetch the remote vault; `null` = none stored (404). Throws on transient failure. */
  fetch: () => Promise<R | null>;
  /** Decrypt; throws on failure (wrong key, corrupt blob, unsupported format). */
  open: (key: Uint8Array, resp: R) => K;
  /** Merge restored keys into the in-memory caches (synchronous). */
  importKeys: (keyring: K) => void;
  /**
   * Whether this device has ever opened or published `wallet`'s vault
   * (`keyVaultSeen`). `null` = can't tell (storage error): the restore stays
   * retryable instead of guessing "empty".
   */
  seenMarker: (wallet: string) => Promise<boolean | null> | boolean | null;
  /** Record that `wallet`'s vault exists (after an open or a publish). */
  markSeen: (wallet: string) => void;
  log?: (step: string, data?: Record<string, unknown>) => void;
}

/**
 * Outcome of a restore attempt:
 *  - `done`       — terminal FOR the run's account: restored with its own key,
 *                   or verifiably empty (404 and no marker)
 *  - `unreadable` — the remote exists but our own key can't open it; never
 *                   overwrite it without the user's confirmation
 *  - `missing`    — 404, but this device has seen this wallet's vault before
 *  - `idle`       — retry on the next trigger (no key, transient fetch,
 *                   marker unreadable)
 *  - `stale`      — the account (or crypto client) changed mid-flight; nothing
 *                   was written for anyone
 */
export type RestoreOutcome = 'done' | 'unreadable' | 'missing' | 'idle' | 'stale';

export async function runKeyVaultRestore<R, K>(ctx: RunContext, deps: RestoreDeps<R, K>): Promise<RestoreOutcome> {
  const wallet = ctx.account;
  if (!wallet || !ctx.stillValid()) return 'idle';
  const owned = await deps.getKey(wallet);
  if (!ctx.stillValid()) return 'stale';
  if (!usable(owned, wallet)) return 'idle';
  let resp: R | null;
  try {
    resp = await deps.fetch();
  } catch (e) {
    if (!ctx.stillValid()) return 'stale';
    deps.log?.('keyvault: restore fetch failed (will retry)', { err: (e as Error)?.message });
    return 'idle';
  }
  if (!ctx.stillValid()) return 'stale';
  // A key zeroed by clearKeyVaultSession while we awaited: decide nothing.
  if (!usable(owned, wallet)) return 'idle';
  if (!resp) {
    const seen = await deps.seenMarker(wallet);
    if (!ctx.stillValid()) return 'stale';
    if (seen === null) return 'idle';
    if (seen) {
      deps.log?.('keyvault: node has no copy of a vault this device has seen');
      return 'missing';
    }
    return 'done';
  }
  let keyring: K;
  try {
    keyring = deps.open(owned.key, resp);
  } catch (e) {
    // A failure for a key/blob of another account must not decide anything
    // for the CURRENT account.
    if (!ctx.stillValid()) return 'stale';
    deps.log?.('keyvault: remote vault unreadable under own key', { err: (e as Error)?.message });
    return 'unreadable';
  }
  // No await between this check and the writes.
  if (!ctx.stillValid()) return 'stale';
  deps.importKeys(keyring);
  deps.markSeen(wallet);
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
  /** Whether overwriting the remote vault is allowed NOW (restore `done` for this account). */
  canPublish: () => boolean;
  /** Record that the run's wallet has a vault (after a successful publish). */
  markSeen: (wallet: string) => void;
  log?: (step: string, data?: Record<string, unknown>) => void;
}

/**
 * Outcome of a publish attempt:
 *  - `published`   — sealed and accepted by the node
 *  - `empty`       — nothing to back up
 *  - `unavailable` — signed out, or no usable backup key
 *  - `blocked`     — publishing is not allowed now (`canPublish()` false)
 *  - `stale`       — the account or crypto client changed mid-flight; nothing sent
 *  - `failed`      — the node / network refused it
 */
export type PublishOutcome = 'published' | 'empty' | 'unavailable' | 'blocked' | 'stale' | 'failed';

/**
 * One backup publish. Seals ONLY the captured account's keyring with ONLY that
 * account's key, re-checked after the key await and immediately before the
 * signed send, and only while `canPublish()` (checked after the last await).
 */
export async function runKeyVaultPublish<KR, S>(ctx: RunContext, deps: PublishDeps<KR, S>): Promise<PublishOutcome> {
  const wallet = ctx.account;
  if (!wallet || !ctx.stillValid()) return 'unavailable';
  if (deps.isEmpty(deps.readKeyring())) return 'empty'; // nothing to back up
  const owned = await deps.getKey(wallet);
  if (!ctx.stillValid()) return 'stale';
  if (!usable(owned, wallet)) return 'unavailable';
  // Read the keyring AFTER the await + re-check: it must be this account's.
  const keyring = deps.readKeyring();
  if (deps.isEmpty(keyring)) return 'empty';
  // Gate AFTER the last await: restore may have been reset / blocked while the
  // key was being derived.
  if (!deps.canPublish()) return 'blocked';
  // No await between these checks and the send.
  const sealed = deps.seal(owned.key, keyring);
  if (!ctx.stillValid()) return 'stale';
  try {
    await deps.send(sealed);
  } catch (e) {
    deps.log?.('keyvault: backup failed', { err: (e as Error)?.message });
    return 'failed';
  }
  // Explicit-address write, and only while the account is still active (a
  // sign-out wipes the namespace; don't resurrect a key in it).
  if (sameAccount(ctx)) deps.markSeen(wallet);
  return 'published';
}

// --- controller --------------------------------------------------------------------

/** Restore state of the current session. `blocked` is per session, never persisted. */
export type RestoreState = 'idle' | 'inflight' | 'done' | 'blocked';
/** Why restore is `blocked`. */
export type BlockReason = 'unreadable' | 'missing';
/** {@link VaultController.ensureRestored} result. */
export type EnsureRestoredResult = 'done' | 'idle' | 'blocked' | 'stale';
/** {@link VaultController.backupNow} result (each maps to its own message). */
export type BackupNowResult =
  | 'published'
  | 'nothing'
  | 'restore-failed'
  | 'blocked'
  | 'stale'
  | 'failed'
  | 'unavailable';
/** {@link VaultController.restoreNow} result (Settings → "Restore"). */
export type RestoreNowResult =
  | { kind: 'restored'; n: number }
  | { kind: 'none' }
  | { kind: 'failed' }
  | { kind: 'blocked'; reason: BlockReason }
  | { kind: 'stale' };

/** Default debounce between a keyring change and its publish. */
export const BACKUP_DEBOUNCE_MS = 4_000;
/** Automatic retries after a failed publish: 60 s, 5 min, 15 min, then stop. */
export const FAIL_BACKOFF_MS: readonly number[] = [60_000, 300_000, 900_000];

/** A captured account + the crypto client it runs on (accountContext.ts). */
export interface CapturedAccount<C> extends RunContext {
  client: C;
  accountStillValid: () => boolean;
}

export interface VaultControllerDeps<C, R, S, K> {
  /** captureAccountContext() + account-level validity. */
  capture(): CapturedAccount<C>;
  getKey(wallet: string): Promise<OwnedKey | null>;
  fetch(client: C): Promise<R | null>;
  open(key: Uint8Array, resp: R): K;
  /** Merge into the caches; returns how many keys the remote keyring held. */
  importKeys(keyring: K): number;
  seenMarker(wallet: string): Promise<boolean | null> | boolean | null;
  markSeen(wallet: string): void;
  readKeyring(): K;
  isEmpty(keyring: K): boolean;
  seal(key: Uint8Array, keyring: K): S;
  send(client: C, sealed: S): Promise<void>;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Called whenever the restore state / block reason / busy flags change. */
  onStateChange?(): void;
  log?(step: string, data?: Record<string, unknown>): void;
  debounceMs?: number;
  failBackoffMs?: readonly number[];
}

export interface VaultStatus {
  restore: RestoreState;
  blockReason: BlockReason | null;
  pendingBackup: boolean;
  publishing: boolean;
  failStreak: number;
}

export interface VaultController<C = unknown> {
  /** A content key was cached: back it up (debounced) once that is allowed. */
  scheduleBackup(): void;
  /** Background restore trigger (decrypt-miss, keyring change). Coalesced. */
  tryRestore(): void;
  /** Join the in-flight restore or start one; resolves with its result. */
  ensureRestored(): Promise<EnsureRestoredResult>;
  /** Manual backup: restore first, then exactly one publish, honest result. */
  backupNow(): Promise<BackupNowResult>;
  /** Manual restore: (re)fetch + merge, honest result. Never downgrades a `done` on a transient failure. */
  restoreNow(): Promise<RestoreNowResult>;
  /**
   * User-confirmed "Replace backup" while `blocked`: accept overwriting the
   * remote for the current account and publish now. Refused ('blocked') in
   * any other state, so it can never skip a restore that hasn't run.
   * `forRun` is the account the user confirmed for (captured BEFORE the
   * confirm opened): if a different account is active by now — or becomes
   * active while waiting for an in-flight publish — nothing is sent ('stale').
   * A crypto-client swap alone (node switch) does not make it stale.
   */
  replace(forRun?: CapturedAccount<C>): Promise<PublishOutcome>;
  /** User Retry: leave `blocked` and run restore again. */
  retry(): void;
  /** Wallet disconnect / switch: forget everything about the session. */
  clearSession(): void;
  status(): VaultStatus;
}

/**
 * The key-vault state machine (mirror of web 0.84.0 `createVaultController`).
 * Restore states `idle | inflight | done | blocked`, each bound to the account
 * it was reached for (a state of another account reads as `idle`; a crypto-
 * client swap alone — node switch — keeps it). Publishing requires `done`,
 * checked here AND inside {@link runKeyVaultPublish} after its last await.
 *
 * Re-arm: a publish requested while one is in flight sets `publishAgain` (for
 * the requesting account); when the flight ends, one follow-up is scheduled if
 * that account is still active. A publish or restore that went `stale` ONLY
 * because the crypto client changed (same wallet, scope, generation, signer)
 * is re-armed once on the new client; an account switch is not. A `failed`
 * publish retries with backoff {@link FAIL_BACKOFF_MS}, at most that many
 * times; success or a session clear resets the streak.
 */
export function createVaultController<C, R, S, K>(
  deps: VaultControllerDeps<C, R, S, K>,
): VaultController<C> {
  const debounceMs = deps.debounceMs ?? BACKUP_DEBOUNCE_MS;
  const backoff = deps.failBackoffMs ?? FAIL_BACKOFF_MS;

  let restoreState: RestoreState = 'idle';
  let blockReason: BlockReason | null = null;
  /** Account the current `restoreState` was reached for. */
  let stateRun: CapturedAccount<C> | null = null;
  /** Bumped per restore run and by `clearSession`; only the latest run writes state. */
  let restoreRun = 0;
  let restorePromise: Promise<EnsureRestoredResult> | null = null;
  /** What the last finished restore of this session found (for `restoreNow`). */
  let lastFound: { n: number } | null = null;

  let pendingBackup = false;
  let backupTimer: unknown = null;
  let retryTimer: unknown = null;
  let publishing: Promise<PublishOutcome> | null = null;
  /** Account that asked for a publish while one was in flight. */
  let publishAgain: CapturedAccount<C> | null = null;
  let failStreak = 0;

  const changed = () => deps.onStateChange?.();

  const setState = (s: RestoreState, reason: BlockReason | null, run: CapturedAccount<C> | null) => {
    const differs = s !== restoreState || reason !== blockReason;
    restoreState = s;
    blockReason = reason;
    stateRun = run;
    if (differs) changed();
  };

  /** The restore state as it applies to the account active NOW. */
  const effectiveState = (): RestoreState => {
    if (restoreState !== 'idle' && (!stateRun || !stateRun.account || !stateRun.accountStillValid())) {
      // Reached for another account / generation: abandon it for this one.
      if (restoreState === 'inflight') restoreRun++;
      restorePromise = null;
      lastFound = null;
      setState('idle', null, null);
    }
    return restoreState;
  };

  const canPublish = () => effectiveState() === 'done';

  const cancelBackupTimer = () => {
    if (backupTimer !== null) {
      deps.clearTimer(backupTimer);
      backupTimer = null;
    }
  };
  const cancelRetryTimer = () => {
    if (retryTimer !== null) {
      deps.clearTimer(retryTimer);
      retryTimer = null;
    }
  };

  /** A finished restore run: the state result plus what the run itself saw. */
  interface RestoreRunResult {
    res: EnsureRestoredResult;
    /** The run's own outcome (differs from `res` when `keepDone` kept `done`). */
    outcome: RestoreOutcome;
    /** Keys the remote keyring held, when the run opened one. */
    found: { n: number } | null;
  }

  function startRestore(keepDone = false): Promise<EnsureRestoredResult> {
    return startRestoreRun(keepDone).then((d) => d.res);
  }

  /**
   * @param keepDone the session already restored for this account (manual
   *   re-fetch): a transient failure / client swap goes back to `done`
   *   instead of downgrading it.
   */
  function startRestoreRun(keepDone: boolean): Promise<RestoreRunResult> {
    const run = deps.capture();
    const myRun = ++restoreRun;
    setState('inflight', null, run);
    const p = (async (): Promise<RestoreRunResult> => {
      let outcome: RestoreOutcome = 'idle';
      let found: { n: number } | null = null;
      // A run that went stale ONLY because the crypto client was swapped (node
      // switch) is retried once on the new client.
      for (let attempt = 0; attempt < 2; attempt++) {
        const ctx = attempt === 0 ? run : deps.capture();
        try {
          outcome = await runKeyVaultRestore(ctx, {
            getKey: deps.getKey,
            fetch: () => deps.fetch(ctx.client),
            open: deps.open,
            importKeys: (kr) => { found = { n: deps.importKeys(kr) }; },
            seenMarker: deps.seenMarker,
            markSeen: deps.markSeen,
            log: deps.log,
          });
        } catch (e) {
          deps.log?.('keyvault: restore failed', { err: (e as Error)?.message });
          outcome = 'idle';
        }
        if (myRun !== restoreRun) break;
        if (!(outcome === 'stale' && run.accountStillValid() && ctx.account)) break;
      }
      // Superseded (session cleared / another account took over): the
      // CURRENT account's state is not ours to write.
      if (myRun !== restoreRun) return { res: 'stale', outcome: 'stale', found: null };
      restorePromise = null;
      if (keepDone && (outcome === 'idle' || outcome === 'stale') && run.accountStillValid()) {
        setState('done', null, run);
        if (pendingBackup) {
          pendingBackup = false;
          scheduleBackup();
        }
        return { res: 'done', outcome, found: null };
      }
      switch (outcome) {
        case 'done':
          lastFound = found ?? { n: 0 };
          setState('done', null, run);
          if (pendingBackup) {
            pendingBackup = false;
            scheduleBackup();
          }
          return { res: 'done', outcome, found };
        case 'unreadable':
        case 'missing':
          // pendingBackup stays set: the intent survives until Replace.
          setState('blocked', outcome, run);
          return { res: 'blocked', outcome, found: null };
        case 'stale':
          setState('idle', null, null);
          return { res: 'stale', outcome, found: null };
        default:
          setState('idle', null, null);
          return { res: 'idle', outcome, found: null };
      }
    })();
    restorePromise = p.then((d) => d.res);
    return p;
  }

  function ensureRestored(): Promise<EnsureRestoredResult> {
    if (!deps.capture().account) return Promise.resolve('idle');
    const s = effectiveState();
    if (s === 'done') return Promise.resolve('done');
    if (s === 'blocked') return Promise.resolve('blocked');
    if (s === 'inflight' && restorePromise) return restorePromise;
    return startRestore();
  }

  function scheduleBackup(): void {
    const s = effectiveState();
    if (s !== 'done') {
      // Never publish before the remote was pulled + merged (or confirmed
      // empty) this session. Keep the intent; restore completion re-arms it.
      pendingBackup = true;
      // While blocked: no GET loops — wait for the user's Retry / Replace.
      if (s !== 'blocked') void ensureRestored();
      return;
    }
    cancelBackupTimer();
    backupTimer = deps.setTimer(() => {
      backupTimer = null;
      void publishFromTimer();
    }, debounceMs);
  }

  /** Run one publish (caller guarantees none is in flight) and do the bookkeeping. */
  function startPublish(): Promise<PublishOutcome> {
    const ctx = deps.capture();
    const p = (async (): Promise<PublishOutcome> => {
      try {
        return await runKeyVaultPublish(ctx, {
          getKey: deps.getKey,
          readKeyring: deps.readKeyring,
          isEmpty: deps.isEmpty,
          seal: deps.seal,
          send: (sealed) => deps.send(ctx.client, sealed),
          canPublish,
          markSeen: deps.markSeen,
          log: deps.log,
        });
      } catch (e) {
        deps.log?.('keyvault: backup failed', { err: (e as Error)?.message });
        return 'failed';
      }
    })();
    publishing = p;
    changed();
    void p.then((outcome) => {
      if (publishing === p) publishing = null;
      afterPublish(outcome, ctx);
      changed();
    });
    return p;
  }

  function afterPublish(outcome: PublishOutcome, ctx: CapturedAccount<C>): void {
    if (outcome === 'published') {
      failStreak = 0;
      cancelRetryTimer();
    } else if (outcome === 'failed') {
      if (failStreak < backoff.length && retryTimer === null) {
        const delay = backoff[failStreak];
        failStreak++;
        retryTimer = deps.setTimer(() => {
          retryTimer = null;
          void publishFromTimer();
        }, delay);
      }
    } else if (outcome === 'blocked') {
      pendingBackup = true;
    }
    // Node switch mid-publish (client swapped, same account): nothing was sent;
    // re-arm once so the keyring reaches the new client. An account switch
    // fails `accountStillValid` and is never re-armed.
    const clientOnly = outcome === 'stale' && !!ctx.account && ctx.accountStillValid();
    // One follow-up for a request that arrived during the flight — only for
    // the account that asked, and only while it is still active.
    const again = publishAgain;
    publishAgain = null;
    if (clientOnly || (again && again.account && again.accountStillValid())) scheduleBackup();
  }

  async function publishFromTimer(): Promise<void> {
    if (publishing) {
      publishAgain = deps.capture();
      return;
    }
    if (!canPublish()) {
      pendingBackup = true;
      return;
    }
    await startPublish();
  }

  /** Wait for any in-flight publish, then run exactly one — for `forRun`'s
   *  account (default: the one active now), re-checked after the wait. */
  async function publishNow(forRun?: CapturedAccount<C>): Promise<PublishOutcome> {
    const run = forRun ?? deps.capture();
    while (publishing) {
      await publishing.catch(() => undefined);
      // Let the finished flight's bookkeeping run first.
      await Promise.resolve();
    }
    if (!run.account || !run.accountStillValid()) return 'stale';
    if (!canPublish()) return 'blocked';
    cancelBackupTimer();
    return startPublish();
  }

  async function backupNow(): Promise<BackupNowResult> {
    if (!deps.capture().account) return 'unavailable';
    const r = await ensureRestored();
    if (r === 'idle') return 'restore-failed';
    if (r !== 'done') return r;
    const out = await publishNow();
    switch (out) {
      case 'published': return 'published';
      case 'empty': return 'nothing';
      default: return out;
    }
  }

  async function restoreNow(): Promise<RestoreNowResult> {
    if (!deps.capture().account) return { kind: 'failed' };
    const s = effectiveState();
    let r: EnsureRestoredResult;
    if (s === 'blocked') {
      r = 'blocked';
    } else if (s === 'inflight' && restorePromise) {
      r = await restorePromise;
    } else {
      const d = await startRestoreRun(s === 'done');
      // A manual re-fetch that failed kept the session `done`, but the user
      // asked whether the node answered: say it didn't.
      if (d.res === 'done' && d.outcome === 'idle') return { kind: 'failed' };
      if (d.res === 'done' && d.outcome === 'stale') return { kind: 'stale' };
      r = d.res;
    }
    switch (r) {
      case 'done':
        return lastFound && lastFound.n > 0 ? { kind: 'restored', n: lastFound.n } : { kind: 'none' };
      case 'blocked':
        return { kind: 'blocked', reason: blockReason ?? 'unreadable' };
      case 'stale':
        return { kind: 'stale' };
      default:
        return { kind: 'failed' };
    }
  }

  async function replace(forRun?: CapturedAccount<C>): Promise<PublishOutcome> {
    // The confirmation was given for `forRun`'s account; never act for another
    // (a node switch alone keeps the same account and is fine).
    if (forRun && (!forRun.account || !forRun.accountStillValid())) return 'stale';
    const run = forRun ?? deps.capture();
    if (!run.account || effectiveState() !== 'blocked') return 'blocked';
    deps.log?.('keyvault: user confirmed replacing the remote vault', { reason: blockReason });
    setState('done', null, run);
    pendingBackup = false;
    // publishNow re-checks `run` after waiting for an in-flight publish.
    return publishNow(run);
  }

  function retry(): void {
    const s = effectiveState();
    if (s === 'blocked') setState('idle', null, null);
    if (s !== 'done') void ensureRestored();
  }

  function clearSession(): void {
    restoreRun++;
    restorePromise = null;
    lastFound = null;
    pendingBackup = false;
    publishAgain = null;
    failStreak = 0;
    cancelBackupTimer();
    cancelRetryTimer();
    setState('idle', null, null);
  }

  return {
    scheduleBackup,
    tryRestore: () => void ensureRestored(),
    ensureRestored,
    backupNow,
    restoreNow,
    replace,
    retry,
    clearSession,
    status: () => ({
      restore: effectiveState(),
      blockReason,
      pendingBackup,
      publishing: publishing !== null,
      failStreak,
    }),
  };
}
