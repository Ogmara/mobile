/**
 * Envelope normalizer — converts raw API envelope responses to SDK format.
 *
 * The L2 node serializes binary fields ([u8; 32], Vec<u8>) as JSON number
 * arrays. The SDK's Envelope type expects hex strings for msg_id and
 * signature. This module normalizes the API response format.
 */

import type { Envelope } from '@ogmara/sdk';

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalize a raw API envelope into the SDK's Envelope format.
 * Converts msg_id/signature from number arrays to hex strings.
 * Leaves payload as-is (decoded separately by payloadDecoder).
 */
export function normalizeEnvelope(raw: any): Envelope {
  return {
    ...raw,
    msg_id: Array.isArray(raw.msg_id) ? bytesToHex(raw.msg_id) : raw.msg_id,
    signature: Array.isArray(raw.signature) ? bytesToHex(raw.signature) : raw.signature,
    // payload stays as number array for payloadDecoder to handle
  };
}

/** Normalize an array of envelopes. */
export function normalizeEnvelopes(raws: any[]): Envelope[] {
  return (raws ?? []).map(normalizeEnvelope);
}
