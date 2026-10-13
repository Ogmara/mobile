/**
 * Regression test for the 2026-08-02 media-encryption fail-open bug: an image
 * attached to a private/encrypted channel while the channel metadata was
 * still loading (or right after a fetch failure) uploaded to IPFS in the
 * clear. Run with:
 *   node --test src/lib/channelEncryption.test.ts
 * (Node 24 strips simple TS type syntax natively — no build step needed.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveIsEncrypted, shouldAutoJoinEncryptedChannel, isChanMetaResolvedFor, isChannelRecordUsable,
} from './channelEncryption.ts';

test('unresolved -> fails closed (encrypted) regardless of the (still-default) flags', () => {
  assert.equal(resolveIsEncrypted(false, false, false), true);
});

test('the exact reported bug: attach mid-load on a private channel must stay encrypted', () => {
  // Before the fix, isEncrypted was `chanMeta.encryptionEnabled || isPrivate`
  // with no resolved-gate — both default to false while chanMeta hasn't been
  // fetched yet, so this returned false (plaintext).
  assert.equal(resolveIsEncrypted(false, false, false), true);
});

test('resolved + private -> encrypted, regardless of encryptionEnabled', () => {
  assert.equal(resolveIsEncrypted(true, false, true), true);
});

test('resolved + public with encryptionEnabled -> encrypted', () => {
  assert.equal(resolveIsEncrypted(true, true, false), true);
});

test('resolved + public legacy channel (no flag) -> plaintext ONLY when definitively resolved', () => {
  assert.equal(resolveIsEncrypted(true, false, false), false);
});

// --- shouldAutoJoinEncryptedChannel: POSITIVE evidence only -----------------
// Regression for the auto-join bug: `isEncrypted && !isPrivate` was true for
// EVERY channel while metadata was unresolved (fail-closed isEncrypted +
// default channelType 0), so private/unknown channels were auto-joined.

test('auto-join: full matrix — only resolved + encrypted + public joins', () => {
  for (const resolved of [false, true]) {
    for (const enc of [false, true]) {
      for (const priv of [false, true]) {
        const expected = resolved && enc && !priv;
        assert.equal(
          shouldAutoJoinEncryptedChannel(resolved, enc, priv),
          expected,
          `resolved=${resolved} enc=${enc} private=${priv}`,
        );
      }
    }
  }
});

test('auto-join: the exact reported bug — unresolved with default flags must NOT join', () => {
  // What the screen passes before/without a successful detail fetch.
  assert.equal(shouldAutoJoinEncryptedChannel(false, false, false), false);
  // ...even though the confidentiality predicate fails closed to "encrypted".
  assert.equal(resolveIsEncrypted(false, false, false), true);
});

test('auto-join: resolved private encrypted channel never auto-joins', () => {
  assert.equal(shouldAutoJoinEncryptedChannel(true, true, true), false);
});

// --- isChanMetaResolvedFor: resolved only for the exact (client, channel, account)

test('chan-meta key: matches only the exact client + channel + account', () => {
  const c1 = {}; const c2 = {};
  const fetched = { client: c1, channelId: 5, address: 'klv1a' };
  assert.equal(isChanMetaResolvedFor(fetched, { client: c1, channelId: 5, address: 'klv1a' }), true);
  assert.equal(isChanMetaResolvedFor(null, { client: c1, channelId: 5, address: 'klv1a' }), false);
  // channel switch
  assert.equal(isChanMetaResolvedFor(fetched, { client: c1, channelId: 6, address: 'klv1a' }), false);
  // node switch (new client object, same per-node channel id)
  assert.equal(isChanMetaResolvedFor(fetched, { client: c2, channelId: 5, address: 'klv1a' }), false);
  // account switch: a previous account's record must never count
  assert.equal(isChanMetaResolvedFor(fetched, { client: c1, channelId: 5, address: 'klv1b' }), false);
  assert.equal(isChanMetaResolvedFor(fetched, { client: c1, channelId: 5, address: null }), false);
});

// --- isChannelRecordUsable: only a definite record may count as "resolved" ----

test('record: a normal typed record for this channel is usable', () => {
  assert.equal(isChannelRecordUsable({ channel: { channel_id: 5, channel_type: 0 } }, 5), true);
  assert.equal(isChannelRecordUsable({ channel: { channel_type: 2 } }, 5), true); // id omitted
});

test('record: restricted non-member summary is rejected (even if it somehow had a type)', () => {
  assert.equal(isChannelRecordUsable({ channel: { display_name: 'x' }, restricted: true }, 5), false);
  assert.equal(isChannelRecordUsable({ channel: { channel_type: 0 }, restricted: true }, 5), false);
});

test('record: missing/unknown channel_type is NOT evidence of public', () => {
  assert.equal(isChannelRecordUsable({ channel: {} }, 5), false);
  assert.equal(isChannelRecordUsable({ channel: { channel_type: '0' } }, 5), false);
  assert.equal(isChannelRecordUsable({ channel: { channel_type: null } }, 5), false);
  assert.equal(isChannelRecordUsable({ channel: { channel_type: 1.5 } }, 5), false);
});

test('record: missing channel / garbage / wrong channel id rejected', () => {
  for (const d of [null, undefined, 'x', {}, { channel: null }, { channel: 'x' }]) {
    assert.equal(isChannelRecordUsable(d, 5), false);
  }
  assert.equal(isChannelRecordUsable({ channel: { channel_id: 6, channel_type: 0 } }, 5), false);
});
