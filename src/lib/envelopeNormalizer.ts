/**
 * Envelope normalizer — converts raw API envelope responses to SDK format.
 *
 * The L2 node serializes binary fields ([u8; 32], Vec<u8>) as JSON number
 * arrays. `envelope_to_json` (l2-node/src/api/routes.rs) converts only
 * `msg_id` to a hex string server-side — `payload` and `signature` both
 * stay raw number arrays on the wire (verified against l2-node and the
 * SDK's `Envelope` type, sdk-js 0.51.0+). Nothing in this app reads
 * `.signature` off a received envelope, so there's nothing to normalize
 * there; this module only fixes up `msg_id`.
 */

import type { Envelope } from '@ogmara/sdk';

function bytesToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Normalize a raw API envelope into the SDK's Envelope format.
 * Converts msg_id from a number array to a hex string.
 * Leaves payload/signature as-is (decoded separately by payloadDecoder).
 */
export function normalizeEnvelope(raw: any): Envelope {
  return {
    ...raw,
    msg_id: Array.isArray(raw.msg_id) ? bytesToHex(raw.msg_id) : raw.msg_id,
  };
}

/** Normalize an array of envelopes. */
export function normalizeEnvelopes(raws: any[]): Envelope[] {
  return (raws ?? []).map(normalizeEnvelope);
}
