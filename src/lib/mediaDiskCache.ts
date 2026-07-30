/**
 * mediaDiskCache — persists decrypted attachment plaintext to a TTL-bounded
 * cache directory so revisiting a channel/DM after an app restart doesn't
 * require re-fetching + re-decrypting every image/video again (the in-memory
 * cache in `mediaCrypto.ts` is lost on every cold start).
 *
 * Security tradeoff (deliberate, user-requested): this persists E2E-decrypted
 * plaintext to app-private disk storage (not memory-only) for up to
 * CACHE_TTL_MS. `Paths.cache` is sandboxed per-app on both platforms (not
 * world-readable, not shared with other apps) — matching the same storage
 * location already used for user-initiated save/share temp files
 * (`fileShare.ts`, `ImageViewerModal.saveImageToDevice`). A stale (past-TTL)
 * entry is deleted lazily on next access, not swept proactively in the
 * background.
 */
import { File, Directory, Paths } from 'expo-file-system';
import { sha256 } from '@noble/hashes/sha256';

const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const cacheDir = new Directory(Paths.cache, 'media-cache');

function ensureDir(): void {
  if (!cacheDir.exists) cacheDir.create({ intermediates: true });
}

function hexHash(s: string): string {
  const bytes = sha256(new TextEncoder().encode(s));
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** `tag` is the full cid+hex(key)+hex(nonce) fingerprint mediaCrypto uses for
 *  its in-memory cache — hashed (not just sanitized/truncated) for the
 *  filename. A length-capped string sanitizer would truncate a long tag
 *  (CID + 64 hex key chars + 48 hex nonce chars can run ~170 chars) down to
 *  little more than the CID + a key prefix, silently discarding the nonce and
 *  tail of the key that the fingerprint was specifically widened to include
 *  — collapsing back into the same cross-context collision risk the
 *  full-fingerprint upgrade was meant to close. Hashing keeps the full
 *  input's collision resistance regardless of length. */
function cacheFile(tag: string): File {
  return new File(cacheDir, hexHash(tag));
}

/** Return a `file://` URI for `tag` if a fresh (< TTL) cached copy exists.
 *  An expired entry is deleted and reported as a miss. */
export function getCachedMediaUri(tag: string): string | null {
  ensureDir();
  const file = cacheFile(tag);
  if (!file.exists) return null;
  const info = file.info();
  const at = info.modificationTime ?? info.creationTime ?? 0;
  if (Date.now() - at > CACHE_TTL_MS) {
    try { file.delete(); } catch { /* best-effort */ }
    return null;
  }
  return file.uri;
}

/** Write `bytes` to the disk cache under `tag`, returning the `file://` URI. */
export function putCachedMedia(tag: string, bytes: Uint8Array): string {
  ensureDir();
  const file = cacheFile(tag);
  file.write(bytes);
  return file.uri;
}

/** Wipe the entire disk cache (logout / wallet switch — a clean slate, not
 *  just a TTL expiry, since a different identity shouldn't inherit another
 *  wallet's already-decrypted plaintext). */
export function clearDiskCache(): void {
  try {
    if (cacheDir.exists) cacheDir.delete();
  } catch { /* best-effort */ }
}
