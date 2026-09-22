/**
 * Payload decoder — extracts human-readable content from Envelope payloads.
 *
 * The L2 node stores payloads as MessagePack-serialized bytes. When the API
 * returns envelopes as JSON, the `payload` field is a number array (decimal
 * byte values). This module decodes those bytes back into typed payloads.
 */

import { decode } from '@msgpack/msgpack';
import { safeText } from './sanitize.ts';

/** Decoded news post payload fields. */
export interface DecodedNewsPost {
  title: string;
  content: string;
  tags?: string[];
  attachments?: { cid: string; mime_type: string; filename?: string }[];
}

/** One interactive button attached to a message (protocol §3.3). */
export interface PayloadButton {
  label: string;
  command: string;
}

/** A row of buttons rendered together under a message. */
export interface PayloadButtonRow {
  buttons: PayloadButton[];
}

/**
 * Protocol §3.3 button caps, mirrored from `l2-node/src/messages/
 * validation.rs`. The node enforces these at SEND time and rejects the whole
 * envelope on violation — but a node older than 0.131 (the entire fleet, as
 * of when this field shipped) never validated `buttons` at all, and happily
 * stores/relays whatever a client sent. Re-enforcing the caps here at DECODE
 * time is what stops a message from a pre-0.131 node (or a buggy/hostile
 * one) from rendering an unbounded number of buttons.
 */
const MAX_BUTTON_ROWS = 10;
const MAX_BUTTONS_PER_ROW = 8;
const MAX_BUTTONS_TOTAL = 40;
const MAX_BUTTON_LABEL = 24;
const MAX_BUTTON_COMMAND = 256;

/**
 * Decode and re-validate a `buttons` field to the protocol §3.3 caps.
 *
 * A decode here MUST NOT trust the wire shape: truncate rather than render
 * whatever arrives. `label`/`command` are additionally run through
 * `safeText()` — the same control/bidi-codepoint sanitizer used for bot
 * command descriptions — as defense in depth against a pre-0.131 node.
 */
function decodeButtonRows(raw: unknown): PayloadButtonRow[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const rows: PayloadButtonRow[] = [];
  let total = 0;
  for (const rawRow of raw.slice(0, MAX_BUTTON_ROWS)) {
    const rawButtons = (rawRow as any)?.buttons;
    if (!Array.isArray(rawButtons)) {
      rows.push({ buttons: [] });
      continue;
    }
    const buttons: PayloadButton[] = [];
    for (const rawButton of rawButtons.slice(0, MAX_BUTTONS_PER_ROW)) {
      if (total >= MAX_BUTTONS_TOTAL) break;
      const rawLabel = (rawButton as any)?.label;
      const rawCommand = (rawButton as any)?.command;
      // Pre-slice BEFORE sanitizing, not just after: `safeText()` is two full
      // regex passes over the string, and the entire fleet at ship time is
      // pre-0.131 (never validated `buttons` at all), so a node can hand
      // back a `label`/`command` bounded only by the transport (an HTTP
      // response, not the protocol cap this code exists to enforce). The
      // `* 4` headroom means this can never truncate what a legitimate,
      // already-short label would have sanitized to — it only bounds the
      // regex work an adversarial string can force.
      const label = safeText(
        typeof rawLabel === 'string' ? rawLabel.slice(0, MAX_BUTTON_LABEL * 4) : '',
      ).slice(0, MAX_BUTTON_LABEL);
      const command = safeText(
        typeof rawCommand === 'string' ? rawCommand.slice(0, MAX_BUTTON_COMMAND * 4) : '',
      ).slice(0, MAX_BUTTON_COMMAND);
      // The node rejects an empty label/command outright (validate_buttons).
      // A pre-0.131 node never checked, and sanitization above can itself
      // reduce a string to empty — either way, skip it rather than render a
      // blank-but-clickable button.
      if (!label || !command) continue;
      buttons.push({ label, command });
      total += 1;
    }
    rows.push({ buttons });
    if (total >= MAX_BUTTONS_TOTAL) break;
  }
  return rows;
}

/** Decoded chat message payload fields. */
export interface DecodedChatMessage {
  channel_id: number;
  content: string;
  reply_to?: Uint8Array | null;
  mentions?: string[];
  attachments?: { cid: string; mime_type: string; filename?: string; thumbnail_cid?: string }[];
  /** <= 10 rows. Protocol §3.3 — any wallet's message may carry these. */
  buttons?: PayloadButtonRow[];
  /**
   * Set when this message IS a button press (protocol §3.3). Client-
   * rendering hint ONLY, never a security boundary — the node never
   * special-cases it. A compliant feed suppresses a `true` message from the
   * default render; search/permalinks/moderation views MUST NOT.
   */
  via_button: boolean;
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
    attachments: Array.isArray(decoded.attachments) ? decoded.attachments : undefined,
    buttons: decodeButtonRows(decoded.buttons),
    via_button: decoded.via_button === true,
  };
}
