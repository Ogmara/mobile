/**
 * Fresh-account unread baseline flag.
 *
 * A brand-new account has no read cursor on the node, so `GET
 * /api/v1/channels/unread` reports the auto-joined default channel's whole
 * history (capped at 99) as unread — a "99+" badge on the very first screen of
 * an account that has read nothing because it could not have. The create-new
 * paths (`ConnectionContext.generateWallet` / `createAccount`) set this flag;
 * `ChatScreen` consumes it after the first live channel list by marking the
 * default channel read, then clears it.
 *
 * Only set on CREATE paths — never on import/restore/add-from-key, where the
 * account may have real history and real unread state that must not be
 * silently marked read.
 *
 * Keyed on an EXPLICIT address (`<base>::<address>`, the same suffix layout
 * `walletScope.ts`'s `scopedSetFor` uses) rather than the active scope, so a write racing an
 * account switch can't land on the wrong account, and so `wipeWalletScope`
 * (suffix match) removes it with the rest of the account's data.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SEP, scopedGetFor, scopedSetFor } from './walletScope';

const BASE = 'ogmara.unread_baseline_pending';

/** Mark a freshly CREATED account as needing the unread baseline. */
export async function markUnreadBaselinePending(address: string): Promise<void> {
  await scopedSetFor(address, BASE, '1');
}

/** Whether the account still needs its unread baseline applied. */
export async function isUnreadBaselinePending(address: string): Promise<boolean> {
  return (await scopedGetFor(address, BASE)) === '1';
}

/** Consume the flag once the baseline has actually been applied. */
export async function clearUnreadBaselinePending(address: string): Promise<void> {
  if (!address) return;
  await AsyncStorage.removeItem(`${BASE}${SEP}${address}`).catch(() => {});
}
