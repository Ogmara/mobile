/**
 * Ed25519 polyfill — configure @noble/ed25519 to use pure JS SHA-512.
 *
 * MUST be called before any ed25519 operations (key generation, signing).
 * Hermes does not have crypto.subtle, so we replace the async/sync
 * SHA-512 implementations with @noble/hashes.
 *
 * Call `patchEd25519()` once at app startup.
 */

import { sha512 } from '@noble/hashes/sha512';
import * as ed from '@noble/ed25519';

let patched = false;

/** Concatenate multiple Uint8Arrays and hash with SHA-512. */
function sha512Noble(...msgs: Uint8Array[]): Uint8Array {
  const totalLen = msgs.reduce((sum, m) => sum + m.length, 0);
  const merged = new Uint8Array(totalLen);
  let offset = 0;
  for (const m of msgs) {
    merged.set(m, offset);
    offset += m.length;
  }
  return sha512(merged);
}

/**
 * Patch @noble/ed25519 to use pure JS SHA-512.
 * Safe to call multiple times (idempotent).
 */
export function patchEd25519(): void {
  if (patched) return;
  ed.etc.sha512Sync = sha512Noble;
  ed.etc.sha512Async = async (...msgs: Uint8Array[]) => sha512Noble(...msgs);
  patched = true;
}
