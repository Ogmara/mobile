/**
 * Device encryption keys (E2E P0, protocol §2.4) — mobile port.
 *
 * Each install holds an X25519 *encryption* keypair. The wallet authorizes the
 * binding (built-in wallet signs with the embedded vault key), and the binding lets
 * other users wrap message keys to this device. There is no separate device *signing*
 * key (the wallet signs directly), so we mint a stable random `device_id` as the
 * device's public identifier.
 *
 * Mobile differences vs desktop:
 *  - The enc private key lives in `expo-secure-store` under the `ogmara.e2e.*`
 *    namespace (kept clear of the wallet vault's `ogmara.vault.*` keys).
 *  - `getSetting`/`setSetting` are async (AsyncStorage), so `getOrCreateDeviceId`
 *    is async here.
 *  - The wallet signer/address/client come from `cryptoEnv`, not `auth`.
 */
import {
  generateDeviceEncKeypair,
  encPublicKeyHex,
  buildDeviceEncBinding,
  buildDeviceEncRevoke,
  verifyEncKeyBinding,
  type WalletSignFn,
  type DeviceEncKeyRecord,
} from '@ogmara/sdk';
import * as SecureStore from 'expo-secure-store';
import { getWalletScope, scopedGetFor, scopedSetFor } from './walletScope';
import { isValidAddress } from './vaultAccounts';
import { getSetting, setSetting } from './settings';
import { walletAddress, signClaim, getCryptoClient, e2eAvailable } from './cryptoEnv';
import { e2elog, withRetry, isRateLimit } from './e2eDebug';
import { RebindBackoff, nodeReportsBinding, selectStaleOwnRows } from './deviceEncCore';

/**
 * Per-wallet AsyncStorage row (NEW key, `::<wallet>` scoped, wiped on sign-out)
 * holding the own-device re-bind backoff (deviceEncCore `RebindBackoff`).
 * Not vault / SecureStore data.
 */
const REBIND_BACKOFF_BASE = 'ogmara.e2e.rebindBackoff';

/**
 * The device's X25519 private key, PER ACCOUNT.
 *
 * Sharing one keypair across accounts would be protocol-legal but wrong on two
 * counts. It would publish the SAME `enc_pub` for every wallet on this device,
 * proving to the node and to every peer that they are the same person —
 * defeating the point of holding separate accounts. And a shared private key
 * means a ciphertext wrapped to account A is decryptable with the key account
 * B holds, so "one account can never read another's keys" would rest on
 * argument rather than construction.
 *
 * Note `.` as the separator: SecureStore validates keys against
 * `/^[\w.-]+$/` and THROWS on `:`, so the `::` used for AsyncStorage scopes
 * cannot be used here.
 */
const ENC_PRIV_KEY_BASE = 'ogmara.e2e.enc_private_key';

/**
 * Resolve this account's key slot.
 *
 * Falls back to the legacy device-global slot only when no wallet is active —
 * never as a substitute for a missing per-account key, which would hand one
 * account another's identity.
 */
function encPrivKey(): string {
  const addr = getWalletScope();
  // Validate before interpolating: SecureStore rejects anything outside
  // `/^[\w.-]+$/` by THROWING, and the scope ultimately originates from
  // unencrypted AsyncStorage and from the K5 handshake. An unchecked value
  // containing a colon would make every device-enc read and write throw,
  // permanently breaking encryption binding for that account.
  return addr && isValidAddress(addr) ? `${ENC_PRIV_KEY_BASE}.${addr}` : ENC_PRIV_KEY_BASE;
}

const bytesToHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Stable per-install device identifier (32-byte hex). Public, persisted once.
 *
 * ACCEPTED SPEC DEVIATION (protocol §2.4): §2.4 defines `device_id` as the device's
 * Ed25519 *signing* key. The built-in-wallet model has no separate device signing key
 * (it signs with the wallet key directly), so we mint a random stable per-install
 * `device_id` instead — the node only checks it is 32-byte hex.
 */
export async function getOrCreateDeviceId(): Promise<string> {
  let id = await getSetting('deviceId');
  if (!id) {
    id = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    await setSetting('deviceId', id);
  }
  return id;
}

/** Load or create the device X25519 encryption keypair, persisting the secret. */
export async function getOrCreateEncKeypair(): Promise<{ privateKey: Uint8Array; publicKeyHex: string }> {
  const slot = encPrivKey();
  const stored = await SecureStore.getItemAsync(slot).catch(() => null);
  if (stored) {
    const privateKey = hexToBytes(stored);
    return { privateKey, publicKeyHex: encPublicKeyHex(privateKey) };
  }
  // Reading the device-global legacy slot is fine — it is the pre-0.47 key and
  // the migration's retained copy. CREATING into it is not: with no account
  // scoped there is no account to own the key, and minting one there would
  // hand a shared identity to whichever account is activated next. Refuse
  // instead; the caller re-runs once an account is active.
  if (slot === ENC_PRIV_KEY_BASE) {
    throw new Error('No account is active — refusing to create a device encryption key');
  }
  const kp = generateDeviceEncKeypair();
  await SecureStore.setItemAsync(slot, bytesToHex(kp.privateKey), {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  return kp;
}

/**
 * Revoke any of MY OWN previously-published enc keys for `deviceId` whose `enc_pub`
 * differs from my current one. The node keys `device_enc_keys` by `enc_pub`, so a
 * regenerated enc key would otherwise leave the stale enc_pub active — and since
 * channel_keys envelopes are keyed by `device_id` (first-write-wins), a stale wrapping
 * could win and make messages undecryptable. Best-effort.
 */
async function revokeStaleEncKeys(
  wallet: string,
  deviceId: string,
  currentEncPub: string,
  sign: WalletSignFn,
): Promise<void> {
  const client = getCryptoClient();
  if (!client) return;
  try {
    const { keys } = await client.getEncKeys(wallet);
    if (walletAddress() !== wallet) return;
    const network = await client.getNetwork();
    if (walletAddress() !== wallet) return;
    // 0.58.0 (D): revoke ONLY rows whose wallet-signed binding verifies for
    // OUR device id (the signature covers device_id + wallet). A node serving
    // another device's row — or a fabricated unbound one — under our device
    // id must not be able to make this device revoke it.
    const stale = await selectStaleOwnRows(keys, deviceId, currentEncPub,
      async (row) => (await verifyEncKeyBinding(row as DeviceEncKeyRecord, wallet, network)).status);
    for (const k of stale) {
      if (walletAddress() !== wallet) return;
      const revoke = await buildDeviceEncRevoke({
        walletAddress: wallet,
        encPubHex: k.enc_pub,
        walletSign: sign,
        network,
      });
      await withRetry(() => {
        if (walletAddress() !== wallet) return Promise.reject(new Error('account changed before revoke publish'));
        return client.publishEncKeyEnvelope(wallet, revoke);
      }, 'revoke stale enc-key');
      e2elog('revoked stale enc_pub', { deviceId, staleEncPub: k.enc_pub });
    }
  } catch (e) {
    e2elog('stale enc-key revoke skipped', { err: (e as Error)?.message });
  }
}

/** Load the re-bind backoff of `wallet` (a read error → empty: worst case one extra attempt). */
async function loadRebindBackoff(wallet: string): Promise<RebindBackoff> {
  return RebindBackoff.fromJson(await scopedGetFor(wallet, REBIND_BACKOFF_BASE));
}

/** One binding run per wallet at a time (it is fired un-awaited from several connect paths). */
const bindingInflight = new Map<string, Promise<void>>();

/**
 * Called after every binding run settles (connect, account switch, node
 * switch) — channelCrypto registers its "resume persisted epoch
 * establishments" here (a hook, because channelCrypto already imports this
 * module through dmCrypto).
 */
let bindingSettledHook: (() => void) | null = null;
export function setBindingSettledHook(fn: (() => void) | null): void {
  bindingSettledHook = fn;
}

/**
 * Ensure this device's encryption key is bound to the wallet on the node.
 * Idempotent: skips when the registry already has THIS device_id bound to our CURRENT
 * enc_pub AND the local marker is set. Best-effort — a failure leaves the marker unset
 * so the next login retries. On a key change, supersedes the old enc_pub (revoke).
 *
 * No-op for non-built-in (K5) wallets — see {@link e2eAvailable}.
 */
export async function ensureDeviceEncBinding(): Promise<void> {
  if (!e2eAvailable()) return;
  const wallet = walletAddress();
  if (!wallet) return;
  const running = bindingInflight.get(wallet);
  if (running) return running;
  const p = ensureDeviceEncBindingFor(wallet)
    .finally(() => {
      if (bindingInflight.get(wallet) === p) bindingInflight.delete(wallet);
      try { bindingSettledHook?.(); } catch { /* never break binding */ }
    });
  bindingInflight.set(wallet, p);
  return p;
}

async function ensureDeviceEncBindingFor(wallet: string): Promise<void> {
  const client = getCryptoClient();
  if (!client) return;

  const kp = await getOrCreateEncKeypair();
  // The keypair is resolved from the CURRENT scope, which may have changed
  // while that await was outstanding — this function is fired un-awaited on
  // connect, and an account switch can land in the middle. Publishing then
  // binds the NEW account's enc_pub to the OLD account's wallet and
  // `revokeStaleEncKeys` below revokes the old account's real key, making
  // every envelope already wrapped to it permanently undecryptable.
  if (walletAddress() !== wallet) return;
  const marker = `v2:${wallet}:${kp.publicKeyHex}`;
  const deviceId = await getOrCreateDeviceId();

  // Registry-verified (not just the local marker): confirm the node actually has THIS
  // device_id bound to our CURRENT enc_pub; only skip when registry agrees AND marker set.
  let registryOk = false;
  /** Our row exists with our CURRENT enc_pub but the node serves it `bound: false`. */
  let ownRowUnbound = false;
  try {
    const { keys } = await client.getEncKeys(wallet);
    const mine = keys.find((k) => (k.device_id ?? '').toLowerCase() === deviceId.toLowerCase()
      && (k.enc_pub ?? '').toLowerCase() === kp.publicKeyHex.toLowerCase())
      ?? keys.find((k) => (k.device_id ?? '').toLowerCase() === deviceId.toLowerCase());
    // 0.58.0 (B2): a row served `bound: false` (stored before l2-node 0.142.0,
    // no wallet signature retained) is NOT ok — private channels no longer
    // wrap keys to unbound rows, so re-publish the binding (a newer ts
    // re-binds). `bound` absent = an older node that doesn't report it: ok.
    const encMatches = !!mine && (mine.enc_pub ?? '').toLowerCase() === kp.publicKeyHex.toLowerCase();
    ownRowUnbound = encMatches && (mine as { bound?: boolean }).bound === false;
    registryOk = encMatches && !ownRowUnbound;
    e2elog('binding check', {
      wallet, deviceId, localEncPub: kp.publicKeyHex,
      registryEncPub: mine?.enc_pub ?? null, registryOk,
      registryBound: (mine as { bound?: boolean } | undefined)?.bound ?? null,
      markerSet: (await getSetting('encKeyBound')) === marker,
    });
  } catch {
    if ((await getSetting('encKeyBound')) === marker) return;
  }
  const backoffKey = RebindBackoff.key(wallet, deviceId, kp.publicKeyHex);
  if (registryOk) {
    // Bound now: forget any re-bind backoff for this key (best-effort).
    const b = await loadRebindBackoff(wallet);
    if (b.has(backoffKey)) {
      b.clear(backoffKey);
      await scopedSetFor(wallet, REBIND_BACKOFF_BASE, b.toJson());
    }
  }
  if (registryOk && (await getSetting('encKeyBound')) === marker) return;
  if (walletAddress() !== wallet) return;

  // 0.58.0 (D): RE-binding an own row the node serves `bound: false` is
  // rate-limited — never against a node older than 0.142.0 (it cannot store
  // a bound row, so every attempt would only spend the wallet's 10/h
  // DeviceEnc budget), and otherwise at most once per 1 h → 4 h → 24 h per
  // (wallet, device, enc_pub), 1 h after a 429. First-time binding (no row /
  // a different enc_pub) is not affected.
  let backoff: RebindBackoff | null = null;
  if (ownRowUnbound) {
    let reports = false;
    try {
      reports = nodeReportsBinding(await client.health());
    } catch {
      reports = false; // unknown node version → treat as old (fail closed)
    }
    if (walletAddress() !== wallet) return;
    if (!reports) {
      e2elog('re-bind skipped: node does not store wallet-bound rows (< 0.142.0)', { deviceId });
      return;
    }
    backoff = await loadRebindBackoff(wallet);
    if (walletAddress() !== wallet) return;
    const now = Date.now();
    if (!backoff.allowed(backoffKey, now)) {
      e2elog('re-bind skipped: backoff', { deviceId, waitMs: backoff.remainingMs(backoffKey, now) });
      return;
    }
    // Recorded BEFORE publishing: a crash or kill mid-publish must not let the
    // next launch retry immediately.
    backoff.record(backoffKey, now);
    await scopedSetFor(wallet, REBIND_BACKOFF_BASE, backoff.toJson());
    if (walletAddress() !== wallet) return;
  }

  const sign: WalletSignFn = (claim) => signClaim(claim);
  const envelope = await buildDeviceEncBinding({
    walletAddress: wallet,
    encPubHex: kp.publicKeyHex,
    deviceIdHex: deviceId,
    walletSign: sign,
    network: await client.getNetwork(),
  });
  // Account re-check INSIDE the retry: a switch during a backoff sleep (or
  // while the wallet signed) must not publish this binding.
  try {
    await withRetry(() => {
      if (walletAddress() !== wallet) return Promise.reject(new Error('account changed before binding publish'));
      return client.publishEncKeyEnvelope(wallet, envelope);
    }, 'publish binding');
  } catch (e) {
    if (backoff && isRateLimit(e)) {
      backoff.record(backoffKey, Date.now(), true);
      await scopedSetFor(wallet, REBIND_BACKOFF_BASE, backoff.toJson());
    }
    throw e;
  }
  e2elog('published binding', { deviceId, encPub: kp.publicKeyHex });
  // Re-check once more before the DESTRUCTIVE step: revocation is not
  // reversible, and the publish above may itself have taken a while.
  if (walletAddress() !== wallet) return;
  // Retire any stale enc_pub AFTER the new key is registered (never a zero-key window).
  await revokeStaleEncKeys(wallet, deviceId, kp.publicKeyHex, sign);
  await setSetting('encKeyBound', marker);
}

/** Wipe the device encryption key + binding markers (on wallet disconnect). */
/**
 * Destroy THIS account's device encryption identity.
 *
 * Scoped deliberately: before multi-account this wiped the single shared key,
 * which with per-account keys would have broken E2E for every other account on
 * the device when one was removed.
 */
export async function wipeDeviceEncKey(): Promise<void> {
  await SecureStore.deleteItemAsync(encPrivKey()).catch(() => {});
  await setSetting('encKeyBound', '');
  await setSetting('deviceId', '');
}
