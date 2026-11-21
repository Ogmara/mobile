/**
 * Jump-window helpers for permalink jumps (port of web 0.86.0 / desktop 1.86.0). Run:
 *   node --test src/lib/jumpWindow.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyAround, moreBefore, moreAfter, mergeWindowPage, bufferLive, holdBackRows, httpStatusOf, classifyJumpFailure, jumpAccountKey,
  capNewest, oldestRealId, newestRealId,
} from './jumpWindow.ts';

type M = { msg_id: string };
const m = (id: string): M => ({ msg_id: id });
const idOf = (x: unknown) => (x as M).msg_id;
const T = 't'.repeat(64);

test('classifyAround: found / not-on-node / legacy', () => {
  assert.equal(classifyAround({ target_found: true, messages: [m('x'), m(T)] as any }, T, idOf), 'found');
  assert.equal(classifyAround({ target_found: false, messages: [m('x')] as any }, T, idOf), 'not-on-node');
  assert.equal(classifyAround({ messages: [m(T)] as any }, T, idOf), 'legacy');
  // A node claiming success without the row is not trusted to land on it.
  assert.equal(classifyAround({ target_found: true, messages: [m('x')] as any }, T, idOf), 'not-on-node');
  assert.equal(classifyAround({ target_found: true, messages: undefined as any }, T, idOf), 'not-on-node');
});

test('moreBefore prefers the exact flag, falls back to has_more', () => {
  assert.equal(moreBefore({ has_more: true, has_more_before: false }), false);
  assert.equal(moreBefore({ has_more: false, has_more_before: true }), true);
  assert.equal(moreBefore({ has_more: true }), true);
  assert.equal(moreBefore({ has_more: false }), false);
});

test('moreAfter prefers the exact flag, falls back to a full page', () => {
  assert.equal(moreAfter({ has_more_after: false }, 50, 50), false);
  assert.equal(moreAfter({ has_more_after: true }, 3, 50), true);
  assert.equal(moreAfter({}, 50, 50), true);
  assert.equal(moreAfter({}, 49, 50), false);
});

test('mergeWindowPage: prepend / append with dedup', () => {
  const w = [m('c'), m('d')];
  assert.deepEqual(mergeWindowPage(w, [m('a'), m('b'), m('c')], 'older', 10, idOf), { rows: [m('a'), m('b'), m('c'), m('d')], trimmed: false });
  assert.deepEqual(mergeWindowPage(w, [m('d'), m('e')], 'newer', 10, idOf), { rows: [m('c'), m('d'), m('e')], trimmed: false });
  // Duplicates inside the page itself are dropped too.
  assert.deepEqual(mergeWindowPage([], [m('a'), m('a')], 'newer', 10, idOf).rows, [m('a')]);
});

test('mergeWindowPage: over the cap, sheds the edge away from the new page', () => {
  const w = [m('b'), m('c'), m('d')];
  const older = mergeWindowPage(w, [m('a')], 'older', 3, idOf);
  assert.deepEqual(older, { rows: [m('a'), m('b'), m('c')], trimmed: true }); // newest end shed
  const newer = mergeWindowPage(w, [m('e')], 'newer', 3, idOf);
  assert.deepEqual(newer, { rows: [m('c'), m('d'), m('e')], trimmed: true }); // oldest end shed
});

test('bufferLive: dedup, bounded at the oldest end, reports drops', () => {
  let r = bufferLive<M>([], m('a'), 2, idOf);
  assert.deepEqual(r, { rows: [m('a')], dropped: false });
  r = bufferLive(r.rows, m('a'), 2, idOf);
  assert.deepEqual(r, { rows: [m('a')], dropped: false });
  r = bufferLive(r.rows, m('b'), 2, idOf);
  assert.equal(r.dropped, false);
  r = bufferLive(r.rows, m('c'), 2, idOf);
  assert.deepEqual(r, { rows: [m('b'), m('c')], dropped: true });
  assert.equal(bufferLive(r.rows, m(''), 2, idOf).rows, r.rows);
});

test('holdBackRows keeps EVERY pre-jump row outside the window, in order', () => {
  const local = [m('old1'), m('w1'), m('live1'), { msg_id: 'local-1' }, m('live2')];
  const window = [m('w0'), m('w1'), m('w2')];
  assert.deepEqual(holdBackRows(local, window, idOf), [m('old1'), m('live1'), { msg_id: 'local-1' }, m('live2')]);
  assert.deepEqual(holdBackRows([], window, idOf), []);
});

test('httpStatusOf parses SDK errors only', () => {
  assert.equal(httpStatusOf(new Error('API error (404): channel not found')), 404);
  assert.equal(httpStatusOf(new Error('API error (403): forbidden')), 403);
  assert.equal(httpStatusOf(new Error('Failed to fetch')), null);
  assert.equal(httpStatusOf(undefined), null);
});

test('classifyJumpFailure: plan §9 outcomes', () => {
  assert.equal(classifyJumpFailure(404, { found: false, status: 404 }), 'channel-gone');
  assert.equal(classifyJumpFailure(403, { found: true, isPublic: true }), 'no-access-joinable');
  assert.equal(classifyJumpFailure(404, { found: true, isPublic: false }), 'no-access');
  // Record lookup itself failed for another reason: do not claim "gone".
  assert.equal(classifyJumpFailure(404, { found: false, status: null }), 'error');
  assert.equal(classifyJumpFailure(500, { found: false, status: 404 }), 'error');
  assert.equal(classifyJumpFailure(null, { found: true, isPublic: true }), 'error');
});

test('jumpAccountKey: session restore and auth-ready both change the key (re-arm)', () => {
  const anon = jumpAccountKey(null, false);
  const restored = jumpAccountKey('klv1abc', false);
  const ready = jumpAccountKey('klv1abc', true);
  assert.notEqual(anon, restored);
  assert.notEqual(restored, ready);
  assert.equal(jumpAccountKey(undefined, false), anon);
  assert.equal(jumpAccountKey('klv1abc', true), ready);
  assert.notEqual(jumpAccountKey('klv1abc', true), jumpAccountKey('klv1xyz', true));
});

// ── mobile-only helpers ──

type R = { msg_id: string; timestamp: number };
const r = (id: string, ts: number): R => ({ msg_id: id, timestamp: ts });
const rid = (x: R) => x.msg_id;
const rts = (x: R) => x.timestamp;
const H = (c: string) => c.repeat(64);

test('capNewest: keeps the newest rows by timestamp, whatever the array order', () => {
  const rows = [r('new', 30), r('old', 10), r('mid', 20)];
  assert.deepEqual(capNewest(rows, 5, rts), { rows, trimmed: false });
  const c = capNewest(rows, 2, rts);
  assert.equal(c.trimmed, true);
  assert.deepEqual(c.rows.map(rid), ['mid', 'new']);
});

test('oldestRealId / newestRealId skip unconfirmed local sends', () => {
  const rows = [r('local-1', 1), r(H('b'), 20), r(H('a'), 10), r('local-2', 99)];
  assert.equal(oldestRealId(rows, rid, rts), H('a'));
  assert.equal(newestRealId(rows, rid, rts), H('b'));
  assert.equal(oldestRealId([r('local-1', 1)], rid, rts), null);
  assert.equal(newestRealId([], rid, rts), null);
});
