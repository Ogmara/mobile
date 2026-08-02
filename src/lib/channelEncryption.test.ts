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
import { resolveIsEncrypted } from './channelEncryption.ts';

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
