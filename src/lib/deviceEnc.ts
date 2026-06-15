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
  type WalletSignFn,
} from '@ogmara/sdk';
import * as SecureStore from 'expo-secure-store';
import { getSetting, setSetting } from './settings';
import { walletAddress, signClaim, getCryptoClient, e2eAvailable } from './cryptoEnv';
import { e2elog, withRetry } from './e2eDebug';

const ENC_PRIV_KEY = 'ogmara.e2e.enc_private_key';

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
  const stored = await SecureStore.getItemAsync(ENC_PRIV_KEY).catch(() => null);
  if (stored) {
    const privateKey = hexToBytes(stored);
    return { privateKey, publicKeyHex: encPublicKeyHex(privateKey) };
  }
  const kp = generateDeviceEncKeypair();
  await SecureStore.setItemAsync(ENC_PRIV_KEY, bytesToHex(kp.privateKey), {
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
    const did = deviceId.toLowerCase();
    const cur = currentEncPub.toLowerCase();
    const stale = keys.filter(
      (k) => (k.device_id ?? '').toLowerCase() === did && (k.enc_pub ?? '').toLowerCase() !== cur,
    );
    for (const k of stale) {
      const revoke = await buildDeviceEncRevoke({
        walletAddress: wallet,
        encPubHex: k.enc_pub,
        walletSign: sign,
      });
      await withRetry(() => client.publishEncKeyEnvelope(wallet, revoke), 'revoke stale enc-key');
      e2elog('revoked stale enc_pub', { deviceId, staleEncPub: k.enc_pub });
    }
  } catch (e) {
    e2elog('stale enc-key revoke skipped', { err: (e as Error)?.message });
  }
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
  const client = getCryptoClient();
  if (!wallet || !client) return;

  const kp = await getOrCreateEncKeypair();
  const marker = `v2:${wallet}:${kp.publicKeyHex}`;
  const deviceId = await getOrCreateDeviceId();

  // Registry-verified (not just the local marker): confirm the node actually has THIS
  // device_id bound to our CURRENT enc_pub; only skip when registry agrees AND marker set.
  let registryOk = false;
  try {
    const { keys } = await client.getEncKeys(wallet);
    const mine = keys.find((k) => (k.device_id ?? '').toLowerCase() === deviceId.toLowerCase());
    registryOk = !!mine && (mine.enc_pub ?? '').toLowerCase() === kp.publicKeyHex.toLowerCase();
    e2elog('binding check', {
      wallet, deviceId, localEncPub: kp.publicKeyHex,
      registryEncPub: mine?.enc_pub ?? null, registryOk,
      markerSet: (await getSetting('encKeyBound')) === marker,
    });
  } catch {
    if ((await getSetting('encKeyBound')) === marker) return;
  }
  if (registryOk && (await getSetting('encKeyBound')) === marker) return;

  const sign: WalletSignFn = (claim) => signClaim(claim);
  const envelope = await buildDeviceEncBinding({
    walletAddress: wallet,
    encPubHex: kp.publicKeyHex,
    deviceIdHex: deviceId,
    walletSign: sign,
  });
  await withRetry(() => client.publishEncKeyEnvelope(wallet, envelope), 'publish binding');
  e2elog('published binding', { deviceId, encPub: kp.publicKeyHex });
  // Retire any stale enc_pub AFTER the new key is registered (never a zero-key window).
  await revokeStaleEncKeys(wallet, deviceId, kp.publicKeyHex, sign);
  await setSetting('encKeyBound', marker);
}

/** Wipe the device encryption key + binding markers (on wallet disconnect). */
export async function wipeDeviceEncKey(): Promise<void> {
  await SecureStore.deleteItemAsync(ENC_PRIV_KEY).catch(() => {});
  await setSetting('encKeyBound', '');
  await setSetting('deviceId', '');
}
