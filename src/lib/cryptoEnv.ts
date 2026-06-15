/**
 * Crypto environment accessors (mobile).
 *
 * The E2E crypto libs (deviceEnc / dmCrypto / channelCrypto / keyVault) are React-free
 * modules that need the live, signer-bound SDK client plus the wallet signer/address.
 * On desktop those came from `auth.ts`; on mobile the source of truth is
 * `ConnectionContext`, which pushes them here via {@link setCryptoEnv} on every wallet
 * attach/restore and on node switch.
 *
 * IMPORTANT: this deliberately holds the SIGNER-BOUND client (the one created in
 * ConnectionContext), NOT the signer-less singleton in `api.ts` — auth-required
 * endpoints (publishKeyEnvelope, syncKeyVault, …) would 401 with an unsigned client.
 */

import type { OgmaraClient, WalletSigner } from '@ogmara/sdk';

type WalletSource = 'builtin' | 'k5-delegation' | null;

interface CryptoEnv {
  signer: WalletSigner | null;
  /** On-chain wallet (identity) address — the target/recipient peers wrap keys to. */
  walletAddress: string | null;
  client: OgmaraClient | null;
  walletSource: WalletSource;
}

const env: CryptoEnv = {
  signer: null,
  walletAddress: null,
  client: null,
  walletSource: null,
};

/** Populate the crypto environment (called by ConnectionContext). */
export function setCryptoEnv(next: {
  signer: WalletSigner | null;
  walletAddress: string | null;
  client: OgmaraClient | null;
  walletSource: WalletSource;
}): void {
  env.signer = next.signer;
  env.walletAddress = next.walletAddress;
  env.client = next.client;
  env.walletSource = next.walletSource;
}

/** Update only the client (e.g. after a node switch recreates it). */
export function setCryptoClient(client: OgmaraClient | null): void {
  env.client = client;
}

/** Clear all crypto environment state (on wallet wipe). */
export function clearCryptoEnv(): void {
  env.signer = null;
  env.walletAddress = null;
  env.client = null;
  env.walletSource = null;
}

/** The wallet signer, or null when no wallet is attached. */
export function getSigner(): WalletSigner | null {
  return env.signer;
}

/** The on-chain wallet address, or null. */
export function walletAddress(): string | null {
  return env.walletAddress;
}

/** The signer-bound SDK client, or null. */
export function getCryptoClient(): OgmaraClient | null {
  return env.client;
}

/**
 * Whether E2E encryption is available for the current wallet.
 *
 * v1 supports BUILT-IN wallets only. A k5-delegation wallet signs binding/vault
 * claims with the delegated DEVICE key, which would not verify against the external
 * wallet pubkey on the node (and `bk` would not reproduce across devices). K5 E2E is
 * deferred until a general "ask K5 to sign claim X" round-trip exists. Plaintext DMs
 * remain the fallback for K5 wallets in the meantime.
 */
export function e2eAvailable(): boolean {
  return !!env.signer && !!env.walletAddress && env.walletSource === 'builtin';
}

/**
 * Sign a UTF-8 claim string with the wallet key (Klever message signing).
 * Returns the raw 64-byte signature; the SDK normalizes it via `normalizeWalletSig`.
 * Used for device-enc binding (P0) and key-vault backup-key derivation (P3).
 */
export async function signClaim(claim: string): Promise<Uint8Array> {
  const signer = env.signer;
  if (!signer) throw new Error('no signer');
  return signer.signKleverMessage(new TextEncoder().encode(claim));
}
