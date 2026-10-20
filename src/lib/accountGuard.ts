/**
 * Account-switch guard for async flows that sign or persist after an `await`.
 *
 * `ConnectionContext.switchAccount` calls `client.withSigner(newSigner)`, which
 * MUTATES the same `OgmaraClient` object, and flips the AsyncStorage wallet
 * scope. The App-level remount on `walletAddress` does NOT stop a closure that
 * is already mid-`await`. So a flow that started as account A and resumes after
 * a switch would sign its next envelope (e.g. a private-channel `ChannelJoin`)
 * as account B, and write scoped data (joined-channel set) into B's namespace.
 *
 * Capture a snapshot when the flow starts; after EVERY await that is followed
 * by a signed request or a scoped write, abort silently unless this returns
 * true.
 *
 * The signer is compared to its own start value rather than to the wallet
 * address: for a K5 (external-wallet) account the signer is the local DEVICE
 * key, which never equals the wallet address.
 */
export interface AccountSnapshot {
  /** Active wallet (identity) address — `walletAddress` from the connection. */
  wallet: string | null | undefined;
  /** Address of the key the client currently signs with — `client.address`. */
  signer: string | null | undefined;
}

/** True only if both the wallet and the live signing key are unchanged and non-empty. */
export function isSameAccount(start: AccountSnapshot, live: AccountSnapshot): boolean {
  return !!start.wallet && !!start.signer
    && live.wallet === start.wallet
    && live.signer === start.signer;
}

/** Everything a background sync run binds itself to (see accountContext.ts). */
export interface AccountContextSnapshot {
  /** `walletAddress()` — crypto-env identity (external address for K5). */
  wallet: string | null;
  /** `getWalletScope()` — storage namespace (same identity as `wallet`). */
  scope: string | null;
  /** `getScopeGeneration()` — bumped on every cache reset. */
  gen: number;
  /** The shared crypto client object. */
  client: unknown;
  /** `client.address` — the signing key (device key for K5). */
  signer: string | null | undefined;
}

/**
 * True only if the start snapshot was a complete, self-consistent account
 * (wallet set, scope === wallet, signer set) and nothing in `live` differs.
 */
export function isAccountContextValid(start: AccountContextSnapshot, live: AccountContextSnapshot): boolean {
  return isSameAccountIgnoringClient(start, live) && live.client === start.client;
}

/**
 * {@link isAccountContextValid} WITHOUT the client identity: true while the
 * same account is active even if the crypto client was replaced (node switch
 * via `setCryptoClient`). Use it only to decide whether work that went stale
 * may be RE-ARMED on the new client — never to let a run keep signing or
 * writing with the client it captured.
 */
export function isSameAccountIgnoringClient(start: AccountContextSnapshot, live: AccountContextSnapshot): boolean {
  return !!start.wallet && !!start.signer && start.scope === start.wallet
    && live.wallet === start.wallet
    && live.scope === start.wallet
    && live.gen === start.gen
    && live.signer === start.signer;
}
