/**
 * `parseUnreadCounts` — the node returns `{ unread: { "<id>": n }, mentions }`
 * maps; mobile used to read a non-existent `channels[]` array, so badges never
 * rendered. Run with: node --test src/lib/unreadCounts.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUnreadCounts, parseUnreadMap } from './unreadCounts.ts';

test('parses the real node/SDK wire shape (string keys -> number ids)', () => {
  const m = parseUnreadCounts({ unread: { '1': 3, '42': 99 }, mentions: { '42': 2 } });
  assert.deepEqual({ ...m }, { 1: 3, 42: 99 });
  assert.equal(m[42], 99);
});

test('the old shape (channels[]) yields nothing — it was never the wire format', () => {
  assert.deepEqual({ ...parseUnreadCounts({ channels: [{ channel_id: 1, unread_count: 5 }] }) }, {});
});

test('tolerates null / missing / non-object responses', () => {
  for (const r of [null, undefined, 0, 'x', [], {}, { unread: null }, { unread: [1, 2] }, { unread: 'x' }]) {
    assert.deepEqual({ ...parseUnreadCounts(r) }, {});
  }
});

test('drops non-integer keys and non-positive / non-finite counts', () => {
  const m = parseUnreadMap({
    'abc': 5, '-1': 5, '1.5': 5, '': 5, '99999999999999999999': 5,
    '7': 0, '8': -3, '9': 'NaN', '10': Infinity, '11': 0.5, '12': '4', '13': 2.9,
  });
  assert.deepEqual({ ...m }, { 12: 4, 13: 2 });
});

test('a __proto__ key cannot pollute the result', () => {
  const m = parseUnreadMap(JSON.parse('{"__proto__": 5, "3": 1}'));
  assert.deepEqual({ ...m }, { 3: 1 });
  assert.equal(Object.getPrototypeOf(m), null);
});
