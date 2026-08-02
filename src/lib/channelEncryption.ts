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
