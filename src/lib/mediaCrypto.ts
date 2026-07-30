/**
 * Encrypted media (P5, spec 04 §9) — mobile.
 *
 * Closes the mobile attachment gap: in an encrypted DM / private channel / public
 * encrypted channel, the FILE BYTES are encrypted with a fresh per-file key BEFORE
 * the IPFS upload, so the node only ever stores opaque ciphertext. The per-file key
 * + nonce ride inside the message ciphertext as a {@link MediaDescriptor}; only a
 * stripped `{ cid, size }` reaches the wire (handled by the SDK encrypted builders).
 *
 * Hermes/RN constraints (no `crypto.subtle`):
 * - Read file bytes from the picked asset's `base64` (ImagePicker `{ base64: true }`).
 * - `encryptFile` / `decryptMedia` are pure-JS (@noble) — safe on Hermes.
 * - Upload: build a `Blob` from the cipher bytes and append to a `FormData` with an
 *   `encrypted=1` field (RN 0.81 `fetch` + `Blob` multipart).
 * - Render: fetch the ciphertext (retrying a 404/network error — a freshly-uploaded
 *   cross-node CID can take a few seconds to become fetchable), `decryptMedia`, and
 *   persist the plaintext to a TTL-bounded disk cache (`mediaDiskCache.ts`) so a cold
 *   app restart doesn't re-fetch/re-decrypt every attachment in a revisited
 *   conversation. Also cached in-memory for the current session (faster, and covers
 *   the case where disk write/read has some latency).
 */

import { encryptFile, decryptMedia, type MediaDescriptor } from '@ogmara/sdk';
import { getCryptoClient } from './cryptoEnv';
import { e2elog } from './e2eDebug';
import { getCachedMediaUri, putCachedMedia, clearDiskCache } from './mediaDiskCache';

/** Hard cap on the plaintext size we buffer in memory (matches the plaintext-path
 *  50 MB UI cap). Streaming encryption is post-MVP. */
export const MAX_ENCRYPTED_MEDIA_BYTES = 50 * 1024 * 1024;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
// Reverse lookup table (char code → 6-bit value) so the codecs stay O(n) on large files.
const B64_REV = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  return t;
})();

/** Hermes-safe base64 → bytes (avoids relying on a working global `atob`). */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const pad = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const outLen = (clean.length / 4) * 3 - pad;
  const out = new Uint8Array(Math.max(0, outLen));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_REV[clean.charCodeAt(i)] & 0x3f;
    const c1 = B64_REV[clean.charCodeAt(i + 1)] & 0x3f;
    const cc2 = B64_REV[clean.charCodeAt(i + 2)];
    const cc3 = B64_REV[clean.charCodeAt(i + 3)];
    const c2 = cc2 < 0 ? 0 : cc2;
    const c3 = cc3 < 0 ? 0 : cc3;
    const n = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    if (o < outLen) out[o++] = (n >> 16) & 0xff;
    if (o < outLen) out[o++] = (n >> 8) & 0xff;
    if (o < outLen) out[o++] = n & 0xff;
  }
  return out;
}

/** Hermes-safe bytes → base64 (for `data:` render URIs). */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < len ? bytes[i + 1] : 0;
    const b2 = i + 2 < len ? bytes[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 0x03) << 4) | (b1 >> 4)];
    out += i + 1 < len ? B64[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < len ? B64[b2 & 0x3f] : '=';
  }
  return out;
}

/** A picked asset's bytes + metadata, normalized for encryption. */
export interface PickedFile {
  /** Plaintext bytes (already in memory). */
  bytes: Uint8Array;
  /** Real MIME (e.g. `image/png`) — hidden from the node once encrypted. */
  mime: string;
  /** Original filename — hidden from the node once encrypted. */
  name: string;
}

/**
 * Encrypt `file` with a fresh per-file key and upload the OPAQUE cipher to IPFS via
 * the node (`encrypted=1`). Returns a {@link MediaDescriptor} carrying the cid +
 * per-file key/nonce; pass it via `media` on an encrypted send.
 *
 * Throws if the file exceeds {@link MAX_ENCRYPTED_MEDIA_BYTES}, no signer-bound client
 * is available, or the upload fails.
 */
export async function encryptAndUploadFile(file: PickedFile): Promise<MediaDescriptor> {
  if (file.bytes.length > MAX_ENCRYPTED_MEDIA_BYTES) {
    throw new Error('FILE_TOO_LARGE');
  }
  const client = getCryptoClient();
  if (!client) throw new Error('crypto client unavailable');

  const { cipher, key, nonce } = encryptFile(file.bytes);

  // RN's `Blob` polyfill only accepts strings/other Blobs as parts — passing
  // an ArrayBuffer/Uint8Array throws "Creating blobs from 'ArrayBuffer' and
  // 'ArrayBufferView' are not supported". There's no on-disk file for the
  // cipher (it only exists in memory), so — mirroring the plaintext upload
  // paths in ChannelMessagesScreen/ComposePostScreen, which use the picked
  // asset's real `file://` uri — we hand RN's networking layer a `data:`
  // URI instead of a Blob; both bridges (Android/iOS) read bytes directly
  // from a `{ uri, type, name }` FormData part without any JS-side re-encode.
  const formData = new FormData();
  // Filename is irrelevant for an encrypted blob (the real name lives in the descriptor).
  formData.append('file', {
    uri: `data:application/octet-stream;base64,${bytesToBase64(cipher)}`,
    type: 'application/octet-stream',
    name: 'blob.bin',
  } as unknown as Blob);
  formData.append('encrypted', '1');

  const headers = await client.authHeaders('POST', '/api/v1/media/upload');
  const nodeUrl = (client as unknown as { nodeUrl?: string }).nodeUrl || '';
  const resp = await fetch(`${nodeUrl}/api/v1/media/upload`, {
    method: 'POST',
    headers: { ...headers }, // no content-type — FormData sets the boundary
    body: formData,
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Upload failed (${resp.status}): ${text.slice(0, 150)}`);
  }
  const json = await resp.json();
  if (!json?.cid) throw new Error('Upload returned no cid');

  return {
    cid: String(json.cid),
    size: file.bytes.length, // plaintext size (UI hint)
    mime: file.mime,
    name: file.name,
    key,
    nonce,
  };
}

/** A resolved encrypted attachment, ready for `<Image>` / a file chip. */
export interface DecryptedMedia {
  /** `data:<mime>;base64,...` (freshly decrypted) or `file://...` (served from
   *  the on-disk cache) URI of the DECRYPTED bytes. */
  uri: string;
  mime: string;
  name?: string;
}

// Cache by cid + full key/nonce fingerprint (NOT cid alone — a CID is an
// attacker-chooseable content-addressed pointer, so two messages could
// reference the same CID with different descriptor keys; a CID-only cache
// would let one context's plaintext leak into another's — see the matching
// comment in web/desktop's mediaCrypto.ts). Bounded LRU-ish in-memory; the
// disk cache (mediaDiskCache.ts) is unbounded but TTL-expiring.
const mediaCache = new Map<string, DecryptedMedia>();
const MAX_MEDIA_CACHE = 64;
const inflight = new Map<string, Promise<DecryptedMedia | null>>();

function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

const keyTag = (m: MediaDescriptor): string =>
  `${m.cid}:${bytesToHex(m.key)}:${bytesToHex(m.nonce)}`;

// A freshly-uploaded cross-node CID can 404 for a few seconds while it
// propagates to the node the receiving client is talking to. Retry a
// 404/network error on a flat poll (mirrors the equivalent web/desktop fix)
// instead of failing permanently on the first attempt.
const MEDIA_FETCH_RETRY_MS = 3000;
const MEDIA_FETCH_MAX_WAIT_MS = 45000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCipherWithRetry(url: string): Promise<Uint8Array> {
  const start = Date.now();
  for (;;) {
    let resp: Response;
    try {
      resp = await fetch(url);
    } catch (err) {
      if (Date.now() - start >= MEDIA_FETCH_MAX_WAIT_MS) throw err;
      await sleep(MEDIA_FETCH_RETRY_MS);
      continue;
    }
    if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
    if (resp.status !== 404 || Date.now() - start >= MEDIA_FETCH_MAX_WAIT_MS) {
      throw new Error(`media fetch ${resp.status}`);
    }
    await sleep(MEDIA_FETCH_RETRY_MS);
  }
}

/**
 * Fetch the encrypted blob for `m.cid`, decrypt it, and return a URI of the
 * plaintext (disk-cached across app restarts, in-memory-cached for the
 * session). Returns `null` on fetch/decrypt failure (caller shows a
 * "🔒 encrypted attachment" fallback). `mediaBaseUrl` ends with `/api/v1/media/`.
 */
export async function loadDecryptedMedia(
  m: MediaDescriptor,
  mediaBaseUrl: string,
): Promise<DecryptedMedia | null> {
  const tag = keyTag(m);
  const cached = mediaCache.get(tag);
  if (cached) return cached;
  const pending = inflight.get(tag);
  if (pending) return pending;

  const job = (async (): Promise<DecryptedMedia | null> => {
    try {
      const diskUri = getCachedMediaUri(tag);
      const result: DecryptedMedia = diskUri
        ? { uri: diskUri, mime: m.mime, name: m.name }
        : await (async () => {
            const buf = await fetchCipherWithRetry(`${mediaBaseUrl}${m.cid}`);
            const plain = decryptMedia(buf, m.key, m.nonce);
            const fileUri = putCachedMedia(tag, plain);
            return { uri: fileUri, mime: m.mime, name: m.name };
          })();
      if (mediaCache.size >= MAX_MEDIA_CACHE) {
        const first = mediaCache.keys().next().value;
        if (first) mediaCache.delete(first);
      }
      mediaCache.set(tag, result);
      return result;
    } catch (e) {
      e2elog('media decrypt failed', { cid: m.cid, err: (e as Error)?.message });
      return null;
    } finally {
      inflight.delete(tag);
    }
  })();
  inflight.set(tag, job);
  return job;
}

/** Drop cached decrypted media, in-memory AND on disk (logout / wallet switch —
 *  a different identity shouldn't inherit another wallet's decrypted plaintext). */
export function clearMediaCache(): void {
  mediaCache.clear();
  inflight.clear();
  clearDiskCache();
}
