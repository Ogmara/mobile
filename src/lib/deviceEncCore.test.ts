/**
 * deviceEncCore — own-device re-bind backoff, node capability checks and the
 * "revoke only our own verified rows" rule (mobile 0.58.0).
 * Run with: node --test src/lib/deviceEncCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  semverAtLeast, nodeReportsBinding, nodeHasFeature, RebindBackoff, selectStaleOwnRows,
  REBIND_DELAYS_MS, REBIND_RATE_LIMIT_DELAY_MS, MAX_REBIND_ENTRIES, FEATURE_KEY_COMMITMENT,
  type OwnEncRow,
} from './deviceEncCore.ts';

const H = 60 * 60_000;

test('semverAtLeast: numeric compare, prefixes/suffixes tolerated, junk is false', () => {
  assert.equal(semverAtLeast('0.142.0', '0.142.0'), true);
  assert.equal(semverAtLeast('0.143.1', '0.142.0'), true);
  assert.equal(semverAtLeast('v1.0.0-rc1', '0.142.0'), true);
  assert.equal(semverAtLeast('0.141.9', '0.142.0'), false);
  assert.equal(semverAtLeast('0.99.0', '0.142.0'), false, 'not a string compare');
  assert.equal(semverAtLeast(undefined, '0.142.0'), false);
  assert.equal(semverAtLeast('garbage', '0.142.0'), false);
});

test('never re-bind against nodes < 0.142 (or an unknown version)', () => {
  assert.equal(nodeReportsBinding({ version: '0.141.3' }), false);
  assert.equal(nodeReportsBinding({}), false);
  assert.equal(nodeReportsBinding(null), false);
  assert.equal(nodeReportsBinding({ version: '0.142.0' }), true);
});

test('feature check: absent list = older node', () => {
  assert.equal(nodeHasFeature({ features: [FEATURE_KEY_COMMITMENT] }, FEATURE_KEY_COMMITMENT), true);
  assert.equal(nodeHasFeature({ features: ['x'] }, FEATURE_KEY_COMMITMENT), false);
  assert.equal(nodeHasFeature({}, FEATURE_KEY_COMMITMENT), false);
  assert.equal(nodeHasFeature({ features: 'key_commitment_v1' }, FEATURE_KEY_COMMITMENT), false);
});

test('re-bind backoff: 1 h → 4 h → 24 h per (wallet, device, enc_pub); 1 h after a 429', () => {
  const b = new RebindBackoff();
  const k = RebindBackoff.key('klv1w', 'AB', 'CD');
  assert.equal(k, RebindBackoff.key('klv1w', 'ab', 'cd'), 'hex case-insensitive');
  let now = 1_000_000;
  assert.equal(b.allowed(k, now), true);
  b.record(k, now);
  assert.equal(b.allowed(k, now + H - 1), false);
  assert.equal(b.allowed(k, now + REBIND_DELAYS_MS[0]), true);
  now += H;
  b.record(k, now);
  assert.equal(b.remainingMs(k, now), 4 * H);
  now += 4 * H;
  b.record(k, now);
  assert.equal(b.remainingMs(k, now), 24 * H);
  now += 24 * H;
  b.record(k, now);
  assert.equal(b.remainingMs(k, now), 24 * H, 'stays at 24 h');
  // A 429 waits 1 h and does not climb the ladder.
  const k2 = RebindBackoff.key('klv1w', 'ef', '01');
  b.record(k2, 0, true);
  assert.equal(b.remainingMs(k2, 0), REBIND_RATE_LIMIT_DELAY_MS);
  b.record(k2, H);
  assert.equal(b.remainingMs(k2, H), REBIND_DELAYS_MS[0]);
  // Another key is independent.
  assert.equal(b.allowed(RebindBackoff.key('klv1other', 'ab', 'cd'), now), true);
  b.clear(k);
  assert.equal(b.allowed(k, now), true);
});

test('re-bind backoff survives a restart (JSON) and is bounded; corrupt JSON is tolerated', () => {
  const b = new RebindBackoff();
  b.record('a', 10);
  const back = RebindBackoff.fromJson(b.toJson());
  assert.equal(back.allowed('a', 10 + H - 1), false);
  assert.equal(RebindBackoff.fromJson('{nope').size, 0);
  assert.equal(RebindBackoff.fromJson(JSON.stringify({ x: { n: -1, next: 5 }, y: { n: 1, next: 'z' } })).size, 0);
  const many = new RebindBackoff();
  for (let i = 0; i < MAX_REBIND_ENTRIES + 10; i++) many.record(`k${i}`, i);
  assert.equal(many.size, MAX_REBIND_ENTRIES);
  assert.equal(many.allowed(`k${MAX_REBIND_ENTRIES + 9}`, 0), false, 'newest kept');
});

test('revoke only OUR device rows whose wallet-signed binding verifies', async () => {
  const mine = 'aa'.repeat(32);
  const rows: OwnEncRow[] = [
    { device_id: mine, enc_pub: 'cur', bound: true },                 // current key: never
    { device_id: mine.toUpperCase(), enc_pub: 'old1', bound: true },   // ours, verifies → revoke
    { device_id: mine, enc_pub: 'forged', bound: true },              // bound flag but signature fails
    { device_id: mine, enc_pub: 'unbound', bound: false },            // node-minted, unsigned
    { device_id: mine, enc_pub: 'rev', bound: true, revoked: true },
    { device_id: 'bb'.repeat(32), enc_pub: 'other-dev', bound: true }, // another device: never
  ];
  const verified: string[] = [];
  const out = await selectStaleOwnRows(rows, mine, 'CUR', async (r) => {
    verified.push(r.enc_pub!);
    if (r.enc_pub === 'forged') return 'invalid';
    if (r.enc_pub === 'old1') return 'bound';
    throw new Error('verify error');
  });
  assert.deepEqual(out.map((r) => r.enc_pub), ['old1']);
  assert.deepEqual(verified.sort(), ['forged', 'old1']);
  // A verifier error is "not ours" (fail closed).
  assert.deepEqual(await selectStaleOwnRows([{ device_id: mine, enc_pub: 'x', bound: true }], mine, 'cur', async () => { throw new Error('boom'); }), []);
});
