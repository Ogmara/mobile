/**
 * Whether a channel's media/content must be treated as encrypted, extracted
 * as a pure function so this security-critical decision is independently
 * testable (see channelEncryption.test.ts).
 *
 * FAILS CLOSED (2026-08-02): a confidentiality decision must never default to
 * "plaintext" just because the channel-metadata fetch hasn't completed (or
 * failed) yet. The bug this fixes — `ChannelMessagesScreen`'s `isEncrypted`
 * computed from `chanMeta` state that starts at hardcoded plaintext-shaped
 * defaults (`{ encryptionEnabled: false, channelType: 0 }`) before the async
 * fetch resolves — meant an image attached to a private channel during that
 * window (or right after a fetch failure, which used to explicitly "keep
 * defaults") uploaded to IPFS unencrypted. Unless the channel metadata has
 * been successfully fetched (`resolved`), this returns `true`.
 */
export function resolveIsEncrypted(
  resolved: boolean,
  encryptionEnabled: boolean,
  isPrivate: boolean,
): boolean {
  if (!resolved) return true;
  return encryptionEnabled || isPrivate;
}

/**
 * Whether the client should AUTO-JOIN a channel on open (P4: reading/posting
 * in an encrypted PUBLIC channel requires membership, because the node only
 * wraps the epoch key to members).
 *
 * Deliberately NOT derived from `resolveIsEncrypted`. That function fails
 * CLOSED (returns `true` while unresolved) because it answers a
 * confidentiality question, where "assume encrypted" is the safe default. For
 * auto-join the safe default is the opposite: joining is a signed, durable
 * side effect, and the node accepts a join for a channel it doesn't know and
 * for a private channel (granting real membership + key cover). The old
 * predicate `isEncrypted && !isPrivate` evaluated to `true` for EVERY channel
 * while metadata was unresolved — `isEncrypted` was fail-closed `true` and
 * `isPrivate` was computed from the default `channelType: 0` — so a private
 * channel was auto-joined before (or without ever) its type being known.
 *
 * Requires POSITIVE evidence: the channel record was successfully fetched for
 * the current channel, says encryption is enabled, and is not private.
 */
export function shouldAutoJoinEncryptedChannel(
  resolved: boolean,
  encryptionEnabled: boolean,
  isPrivate: boolean,
): boolean {
  return resolved === true && encryptionEnabled === true && isPrivate === false;
}

/**
 * Identity of a fetched channel-metadata record: which client (node — channel
 * ids are per-node), which channel, and which account (`isMod` is per-account)
 * it was fetched for.
 */
export interface ChanMetaKey {
  client: unknown;
  channelId: number;
  address: string | null;
}

/**
 * Whether a fetched channel record (`fetchedFor`) describes the CURRENT
 * (client, channel, account). Deriving "resolved" from this, instead of
 * storing a bare boolean, closes the one-commit window after a channel / node
 * / account switch in which a stale `true` would still describe the PREVIOUS
 * one while effects in that same commit already act on the new one.
 */
export function isChanMetaResolvedFor(fetchedFor: ChanMetaKey | null, current: ChanMetaKey): boolean {
  return fetchedFor !== null
    && fetchedFor.client === current.client
    && fetchedFor.channelId === current.channelId
    && fetchedFor.address === current.address;
}

/**
 * Whether a `GET /channels/{id}` response is a definite, usable record for
 * `channelId` (spec 06 §6.10 rules 3/5; parity with web/desktop
 * `isChannelRecordUsable`). Rejects:
 *  - a missing `channel` object;
 *  - a non-number `channel_type` — an unknown type is NOT evidence of "public"
 *    (the screen used to default it to 0, i.e. Public, which is what let
 *    side-effect gates treat "unknown" as "public");
 *  - the node's `restricted: true` non-member summary of a private channel
 *    (it carries no `channel_type` and must never be acted on);
 *  - a record whose own `channel_id` names a different channel.
 * Only a usable record may mark the screen's channel metadata "resolved".
 */
export function isChannelRecordUsable(detail: unknown, channelId: number): boolean {
  if (!detail || typeof detail !== 'object') return false;
  const d = detail as { channel?: unknown; restricted?: unknown };
  if (d.restricted === true) return false;
  const ch = d.channel as { channel_type?: unknown; channel_id?: unknown } | null | undefined;
  if (!ch || typeof ch !== 'object') return false;
  if (typeof ch.channel_type !== 'number' || !Number.isInteger(ch.channel_type)) return false;
  if (ch.channel_id !== undefined && Number(ch.channel_id) !== channelId) return false;
  return true;
}
