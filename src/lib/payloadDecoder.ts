/**
 * Payload decoder — extracts human-readable content from Envelope payloads.
 *
 * The L2 node stores payloads as MessagePack-serialized bytes. When the API
 * returns envelopes as JSON, the `payload` field is a number array (decimal
 * byte values). This module decodes those bytes back into typed payloads.
 */

import { decode } from '@msgpack/msgpack';

/** Decoded news post payload fields. */
export interface DecodedNewsPost {
  title: string;
  content: string;
  tags?: string[];
  attachments?: { cid: string; mime_type: string; filename?: string }[];
}

/** Decoded chat message payload fields. */
export interface DecodedChatMessage {
  channel_id: number;
  content: string;
  reply_to?: Uint8Array | null;
  mentions?: string[];
}

/**
 * Decode a payload from an API envelope response.
 *
 * The API returns `payload` as either:
 * - A number array [134, 165, ...] (JSON-serialized Vec<u8>)
 * - A base64 string (some endpoints)
 * - Already an object (if pre-decoded by the server)
 */
export function decodePayload(payload: unknown): Record<string, unknown> | null {
  try {
    if (!payload) return null;

    // Already decoded object (server pre-decoded it)
    if (typeof payload === 'object' && !Array.isArray(payload) && !(payload instanceof Uint8Array)) {
      return payload as Record<string, unknown>;
    }

    // Number array from JSON (Vec<u8> serialized as JSON array)
    if (Array.isArray(payload)) {
      const bytes = new Uint8Array(payload);
      return decode(bytes) as Record<string, unknown>;
    }

    // Base64 string
    if (typeof payload === 'string') {
      // Try base64 decode
      try {
        const binary = atob(payload);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
          bytes[i] = binary.charCodeAt(i);
        }
        return decode(bytes) as Record<string, unknown>;
      } catch {
        return null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/** Extract a news post from an envelope's payload. */
export function decodeNewsPost(payload: unknown): DecodedNewsPost | null {
  const decoded = decodePayload(payload);
  if (!decoded) return null;
  return {
    title: String(decoded.title ?? ''),
    content: String(decoded.content ?? ''),
    tags: Array.isArray(decoded.tags) ? decoded.tags.map(String) : undefined,
    attachments: Array.isArray(decoded.attachments) ? decoded.attachments : undefined,
  };
}

/** Extract a chat message from an envelope's payload. */
export function decodeChatMessage(payload: unknown): DecodedChatMessage | null {
  const decoded = decodePayload(payload);
  if (!decoded) return null;
  return {
    channel_id: Number(decoded.channel_id ?? 0),
    content: String(decoded.content ?? ''),
    reply_to: decoded.reply_to instanceof Uint8Array ? decoded.reply_to : null,
    mentions: Array.isArray(decoded.mentions) ? decoded.mentions.map(String) : undefined,
  };
}
