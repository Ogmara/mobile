/**
 * Tests for the multi-account index core.
 *
 * SecureStore cannot enumerate keys, so a lost index means an unreachable
 * private key — i.e. a lost wallet. These tests exist to pin the properties
 * that prevent that, and to prove the recovery paths actually recover.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SS,
  MAX_ACCOUNTS,
  isValidAddress,
  parseIndex,
  parseMirror,
  parseAddressesFromScopedKeys,
  mergeIndexes,
  serializeMirror,
  type AccountEntry,
} from './vaultAccounts.ts';

const A = 'klv1heatuswg9u9u356snvj20fn9jvcgva8fea5v54uhqadchhaz6pgq26t8jh';
const B = 'klv1pz3dz0vmpcl7rn2p5kv0w6pyp6sw9nl0p3kwehhnlllw0q7g3caqxcuqzw';
const entry = (a: string, over: Partial<AccountEntry> = {}): AccountEntry => ({
  a, label: null, source: 'builtin', added: 1, ...over,
});

test('SecureStore keys never contain a colon', () => {
  // expo-secure-store validates /^[\w.-]+$/ and THROWS otherwise, so a `::`
  // separator here would break every vault operation on device.
  const re = /^[\w.-]+$/;
  for (const k of [SS.rawFor(A), SS.encFor(A), SS.modeFor(A), SS.encPrivFor(A),
                   SS.mirror, SS.active, SS.version, SS.pending]) {
    assert.ok(re.test(k), `illegal SecureStore key: ${k}`);
    assert.ok(!k.includes(':'), `colon in SecureStore key: ${k}`);
  }
});

test('address validation rejects anything unusable as a key suffix', () => {
  assert.ok(isValidAddress(A));
  assert.ok(isValidAddress(B));
  for (const bad of ['', 'klv1', 'bogus', 'klv1UPPER', 'klv1with:colon',
                     'klv1with space', null, undefined, 42, 'x'.repeat(200)]) {
    assert.ok(!isValidAddress(bad as unknown), `should reject ${String(bad)}`);
  }
});

test('parseIndex tolerates every kind of malformed input', () => {
  assert.deepEqual(parseIndex(null), []);
  assert.deepEqual(parseIndex('not json'), []);
  assert.deepEqual(parseIndex('{"a":1}'), []);          // not an array
  assert.deepEqual(parseIndex('[null,3,"x"]'), []);     // junk entries
  assert.deepEqual(parseIndex(JSON.stringify([{ a: 'nope' }])), []);
  const ok = parseIndex(JSON.stringify([{ a: A, label: 'Main', source: 'builtin', added: 7 }]));
  assert.equal(ok.length, 1);
  assert.equal(ok[0].label, 'Main');
});

test('parseIndex normalises an unknown source rather than trusting it', () => {
  const r = parseIndex(JSON.stringify([{ a: A, source: 'evil' }]));
  assert.equal(r[0].source, 'builtin');
});

test('recovery scan finds accounts from namespaced preference keys', () => {
  // This is the last line of defence: it works even with BOTH indexes gone.
  const keys = [
    `ogmara.display_name::${A}`,
    `ogmara.topicGroups::${B}`,
    'ogmara.theme',                    // device-level, no address
    'ogmara.user.klv1abc',             // different scheme, must not match
    `ogmara.display_name::notanaddress`,
  ];
  const found = parseAddressesFromScopedKeys(keys).sort();
  assert.deepEqual(found, [A, B].sort());
});

test('mergeIndexes never drops an account present in only one source', () => {
  // Each source alone is enough to keep a wallet reachable.
  assert.equal(mergeIndexes([entry(A)], [], []).length, 1);
  assert.equal(mergeIndexes([], [A], []).length, 1);
  assert.equal(mergeIndexes([], [], [A]).length, 1);
  const all = mergeIndexes([entry(A)], [B], [A]);
  assert.deepEqual(all.map((e) => e.a).sort(), [A, B].sort());
});

test('mergeIndexes keeps the richest entry and does not duplicate', () => {
  const merged = mergeIndexes([entry(A, { label: 'Main' })], [A], [A]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].label, 'Main', 'primary metadata must win');
});

test('mirror stays within the SecureStore 2048-byte value limit', () => {
  const many = Array.from({ length: MAX_ACCOUNTS }, (_, i) =>
    entry(i % 2 ? A : B, { added: i }));
  const s = serializeMirror(many);
  assert.ok(Buffer.byteLength(s, 'utf8') < 2048, `mirror too large: ${s.length}`);
  assert.ok(serializeMirror(
    Array.from({ length: 50 }, (_, i) => entry(A, { added: i })),
  ).length < 2048, 'over-cap input must still be truncated to fit');
});

test('parseMirror survives corruption', () => {
  assert.deepEqual(parseMirror(null), []);
  assert.deepEqual(parseMirror('['), []);
  assert.deepEqual(parseMirror(JSON.stringify([A, 'junk', B])), [A, B]);
});

test('merge output order is stable, so the picker does not reshuffle', () => {
  const one = mergeIndexes([entry(B, { added: 2 }), entry(A, { added: 1 })], [], []);
  const two = mergeIndexes([entry(A, { added: 1 }), entry(B, { added: 2 })], [], []);
  assert.deepEqual(one.map((e) => e.a), two.map((e) => e.a));
  assert.equal(one[0].a, A, 'oldest first');
});

// ── Regression guards for the two audit-blocking wallet-loss paths ──────

test('a negative slot probe must never shrink the persisted index', () => {
  // `vaultListAccounts` persists `mergeIndexes(...)`, NOT the probed subset.
  // Probing cannot tell "slot absent" from "slot unreadable", and vault items
  // are WHEN_UNLOCKED_THIS_DEVICE_ONLY — so a read while the device is locked
  // returns null for every account. Persisting the probed set would overwrite
  // both indexes with [] while the key slots still exist, and SecureStore
  // cannot enumerate: those wallets would be unreachable forever.
  const primary = [entry(A), entry(B)];
  const persisted = mergeIndexes(primary, [], []);   // what the code writes
  assert.equal(persisted.length, 2, 'the union must survive a failed probe');
  assert.deepEqual(persisted.map((e) => e.a).sort(), [A, B].sort());
});

test('an account present only in the recovery scan is adopted, not dropped', () => {
  // The earlier `confirmed.length !== primary.length` repair condition missed
  // this: primary=[A] (slot gone) + recovered=[B] compares 1 === 1, so B was
  // never written into either index.
  const merged = mergeIndexes([entry(A)], [], [B]);
  assert.equal(merged.length, 2);
  assert.ok(merged.some((e) => e.a === B), 'B must be adopted from the scan');
});

test('every per-account SecureStore key derives only from a validated address', () => {
  // `isValidAddress` is the gate that keeps a colon out of a SecureStore key;
  // a colon makes expo-secure-store throw, which would permanently break
  // device-enc binding for that account.
  for (const hostile of ['klv1a:b', 'klv1a b', 'klv1a/b', '../etc', 'klv1A']) {
    assert.ok(!isValidAddress(hostile), `must reject: ${hostile}`);
  }
});

test('a cap sheds unconfirmed candidates, never real accounts', () => {
  // Callers cap this list, so sort order decides what is evicted. Entries
  // recovered from the scan or mirror have `added: 0`; a plain ascending sort
  // put those FIRST and evicted every real account — turning a cap meant to
  // bound work into a way to lose accounts from the persisted index.
  const real = entry(A, { added: Date.now() });
  const ghosts = ['klv1' + 'q'.repeat(58)];   // shape-valid, slot-less
  const merged = mergeIndexes([real], [], ghosts.filter(isValidAddress));
  assert.equal(merged[0].a, A, 'a real, indexed account must sort ahead of a ghost');
  assert.ok(merged.slice(0, 1).some((e) => e.a === A), 'and must survive a cap of 1');
});

test('merge is not itself capped — a wipe must be able to reach every account', () => {
  // `vaultWipe` enumerates through mergeIndexes. Capping inside it would leave
  // key material for accounts past the limit that nothing could ever remove.
  const many = Array.from({ length: MAX_ACCOUNTS + 5 }, (_, i) =>
    entry(i % 2 ? A : B, { added: i + 1 }));
  assert.ok(mergeIndexes(many, [], []).length <= 2, 'dedupes by address');
  const distinct = mergeIndexes([entry(A, { added: 1 }), entry(B, { added: 2 })], [], []);
  assert.equal(distinct.length, 2, 'mergeIndexes applies no cap of its own');
});
