/**
 * Capture "which account is this async flow for" and re-validate it later.
 *
 * Shared by settings sync (settingsSync.ts) and the E2E key-recovery vault
 * (keyVault.ts): both read caches / export or derive keys / sign uploads
 * across several awaits, during which an account switch can land.
 */
import { getCryptoClient, walletAddress } from './cryptoEnv';
import { getWalletScope, getScopeGeneration } from './walletScope';
import {
  isAccountContextValid,
  isSameAccountIgnoringClient,
  type AccountContextSnapshot,
} from './accountGuard';

/**
 * Capture the account a sync run is FOR, and a predicate that stays true only
 * while it is still the active account in BOTH places that matter — the
 * crypto env (`walletAddress()`, whose key decrypts) and the storage scope
 * (`getWalletScope()`, where cache commits land) — and no cache reset has
 * happened since (`getScopeGeneration()`, which also catches an A→B→A round
 * trip and the pre-activation reset window). See settingsApply.ts.
 *
 * Identity note (verified): `setWalletScope` and `setCryptoEnv` are always
 * called with the SAME identity — the wallet address for built-in accounts
 * and the EXTERNAL wallet address for K5 delegations (ConnectionContext
 * restoreWallet, switchAccount, generateWallet, registerExternalWallet) — so
 * `getWalletScope() === walletAddress()` holds for both kinds. The signer is
 * compared to its OWN start value, never to the wallet: for K5 it is the
 * device key.
 */
export function captureAccountContext(): {
  account: string | null;
  signer: string | null;
  client: ReturnType<typeof getCryptoClient>;
  stillValid: () => boolean;
  /** Same account, ignoring a crypto-client swap (node switch). Re-arm decisions only. */
  accountStillValid: () => boolean;
} {
  const snap = (): AccountContextSnapshot => {
    const client = getCryptoClient();
    return {
      wallet: walletAddress(),
      scope: getWalletScope(),
      gen: getScopeGeneration(),
      client,
      // The key the shared client signs with. Compared to ITS OWN start value,
      // not to the wallet: for a K5 account it is the device key. `withSigner`
      // swaps it IN PLACE on a switch, so this also catches that.
      signer: client?.address ?? null,
    };
  };
  const start = snap();
  const stillValid = () => isAccountContextValid(start, snap());
  const accountStillValid = () => isSameAccountIgnoringClient(start, snap());
  const ok = stillValid();
  return {
    account: ok ? start.wallet : null,
    signer: ok ? (start.signer ?? null) : null,
    client: start.client as ReturnType<typeof getCryptoClient>,
    stillValid,
    accountStillValid,
  };
}
