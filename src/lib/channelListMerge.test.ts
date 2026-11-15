import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMissingJoined, MAX_BY_ID_FETCHES } from './channelListMerge.ts';

const ch = (id: number) => ({ channel_id: id, slug: `c${id}` });

test('adds a joined channel that is missing from the listed page', async () => {
  const out = await mergeMissingJoined([ch(1), ch(2)], new Set([2, 4294967300]), async (id) => ch(id));
  assert.deepEqual(out.map((c) => c.channel_id), [1, 2, 4294967300]);
});

test('no fetch and the same array when everything joined is already listed', async () => {
  let calls = 0;
  const listed = [ch(1), ch(2)];
  const out = await mergeMissingJoined(listed, [1, 2], async () => { calls++; return null; });
  assert.equal(calls, 0);
  assert.equal(out, listed);
});

test('unknown, failing and duplicate lookups are skipped, listed channels are kept', async () => {
  const out = await mergeMissingJoined([ch(1)], [5, 6, 7, 5], async (id) => {
    if (id === 5) return null;
    if (id === 6) throw new Error('404');
    return ch(id);
  });
  assert.deepEqual(out.map((c) => c.channel_id), [1, 7]);
});

test('a joined set larger than the cap fans out to at most the cap', async () => {
  let calls = 0;
  const ids = Array.from({ length: 500 }, (_, i) => 1000 + i);
  await mergeMissingJoined([], ids, async (id) => { calls++; return ch(id); });
  assert.equal(calls, MAX_BY_ID_FETCHES);
});

test('garbage ids in the joined set are ignored', async () => {
  const seen: number[] = [];
  await mergeMissingJoined([], [NaN, -1, 1.5, 3 as number], async (id) => { seen.push(id); return ch(id); });
  assert.deepEqual(seen, [3]);
});

test('when over the cap the most recently joined ids are the ones fetched', async () => {
  const ids = Array.from({ length: MAX_BY_ID_FETCHES + 10 }, (_, i) => 1000 + i); // oldest first
  const seen = new Set<number>();
  await mergeMissingJoined([], ids, async (id) => { seen.add(id); return ch(id); });
  assert.ok(seen.has(ids[ids.length - 1]), 'newest joined channel must be fetched');
  assert.ok(!seen.has(ids[0]), 'oldest is shed');
  assert.equal(seen.size, MAX_BY_ID_FETCHES);
});
