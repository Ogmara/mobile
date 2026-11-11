/**
 * channelKeyCore — the pure decision cores behind channelCrypto.ts (mobile
 * 0.58.0): cross-client peer rule, heal trigger + persisted ledger,
 * floor-rotation coalescing, send / seed / cover / resume decisions,
 * early-use scope. Run with: node --test src/lib/channelKeyCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyCommitmentInfo } from '@ogmara/sdk';
import {
  classifyPeerResults, httpStatusOf, PeerCommitmentsUnavailableError, shouldRebuildPeers, MAX_PEER_REBUILDS,
  PEER_REBUILD_AFTER_MS, shouldHeal, HealLedger, HEAL_LEDGER_BASE, FloorRotationQueue, FLOOR_ROTATION_SPACING_MS,
  planBest, planNewerLatest, planSeed, earlyUseAllowed, planCover, resumeOpts, planHeal, statusAfterFlow,
  statusMessageKey, HEAL_RETRY_AFTER_MS, MAX_HEAL_TRIES, type HealInput,
  shouldTakeGate, epochWithinNodeBound, floorTrust, NODE_EPOCH_MAX_AHEAD, ResumeBudget,
} from './channelKeyCore.ts';
import type { WalletRowIo } from './epochWiring.ts';

const info = (epoch: number): KeyCommitmentInfo => ({ channel_id: 1, epoch, state: 'arbitrated', final: true, finality_ms: 120_000 });
const ok = (v: KeyCommitmentInfo): PromiseSettledResult<KeyCommitmentInfo> => ({ status: 'fulfilled', value: v });
const err = (e: unknown): PromiseSettledResult<KeyCommitmentInfo> => ({ status: 'rejected', reason: e });
const api = (code: number) => new Error(`API error (${code}): x`);

// --- Peer rule --------------------------------------------------------------------------

test('peer rule: no peers, or every peer 403/404 → []', () => {
  assert.deepEqual(classifyPeerResults([]), []);
  assert.deepEqual(classifyPeerResults([err(api(404)), err(api(403))]), []);
});

test('peer rule: at least one commitment → those answers (failures ignored)', () => {
  assert.deepEqual(classifyPeerResults([err(api(500)), ok(info(3)), err(api(404)), err(new Error('timeout'))]), [info(3)]);
});

test('peer rule: no commitment and at least one FAILURE (401/5xx/network/timeout/PoW) → throw', () => {
  for (const f of [api(401), api(503), new Error('Network request failed'), new Error('peer proof-of-work not solved')]) {
    assert.throws(() => classifyPeerResults([err(api(404)), err(f)]), PeerCommitmentsUnavailableError);
  }
});

test('httpStatusOf reads the SDK error text and a status field', () => {
  assert.equal(httpStatusOf(api(404)), 404);
  assert.equal(httpStatusOf({ status: 403 }), 403);
  assert.equal(httpStatusOf(new Error('boom')), null);
  assert.equal(httpStatusOf(null), null);
});

test('W5: an unreachable peer at build time → bounded, spaced rebuilds', () => {
  assert.equal(shouldRebuildPeers({ unreachable: 1, builtAt: 0, rebuilds: 0 }, PEER_REBUILD_AFTER_MS), true);
  assert.equal(shouldRebuildPeers({ unreachable: 1, builtAt: 0, rebuilds: 0 }, PEER_REBUILD_AFTER_MS - 1), false);
  assert.equal(shouldRebuildPeers({ unreachable: 0, builtAt: 0, rebuilds: 0 }, 10 * PEER_REBUILD_AFTER_MS), false);
  assert.equal(shouldRebuildPeers({ unreachable: 2, builtAt: 0, rebuilds: MAX_PEER_REBUILDS }, 10 * PEER_REBUILD_AFTER_MS), false);
});

// --- Heal -----------------------------------------------------------------------------------

const heal = (o: Partial<HealInput> = {}): boolean => shouldHeal({
  messageEpoch: 5, latestHeldEpoch: 5, latestConfirmed: true, rotateAllowed: true, establishing: false, healedUpTo: 0, ...o,
});

test('heal: only a message at our LATEST confirmed epoch heals', () => {
  assert.equal(heal(), true);
  assert.equal(heal({ messageEpoch: 4 }), false, 'an older confirmed epoch does not heal');
  assert.equal(heal({ latestConfirmed: false }), false);
  assert.equal(heal({ rotateAllowed: false }), false, 'public channel');
  assert.equal(heal({ establishing: true }), false);
  assert.equal(heal({ latestHeldEpoch: null }), false);
});

function memRows(): WalletRowIo & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, read: async (w, b) => data.get(`${b}::${w}`) ?? null, write: async (w, b, v) => { data.set(`${b}::${w}`, v); } };
}

test('after a heal the old message does not heal again — not after the rotation, not after a restart', async () => {
  const rows = memRows();
  const ledger = new HealLedger(rows);
  const W = 'klv1w';
  let now = 1_000;
  assert.equal(heal({ healedUpTo: await ledger.healedUpTo(W, 9, now) }), true);
  assert.equal(await ledger.record(W, 9, 5, now), true);
  // After the rotation our latest is 6: the message at 5 is history.
  assert.equal(heal({ latestHeldEpoch: 6, healedUpTo: await ledger.healedUpTo(W, 9, now) }), false);
  await ledger.complete(W, 9, 5);
  // After a restart the cache may again end at 5 (vault lacks 6): the ledger blocks it — for good once done.
  const restarted = new HealLedger(rows);
  now += 10 * HEAL_RETRY_AFTER_MS;
  assert.equal(heal({ healedUpTo: await restarted.healedUpTo(W, 9, now) }), false);
  assert.ok(rows.data.has(`${HEAL_LEDGER_BASE}::${W}`));
  // A NEWER epoch can still heal.
  assert.equal(heal({ messageEpoch: 6, latestHeldEpoch: 6, healedUpTo: await restarted.healedUpTo(W, 9, now) }), true);
});

test('W-B: an UNFINISHED heal blocks that epoch only until its retry time, at most MAX_HEAL_TRIES times', async () => {
  const rows = memRows();
  const W = 'klv1w';
  let now = 5_000;
  let ledger = new HealLedger(rows);
  assert.equal(await ledger.record(W, 9, 5, now), true); // app killed before the flow ran
  ledger = new HealLedger(rows); // restart
  assert.equal(heal({ healedUpTo: await ledger.healedUpTo(W, 9, now + 1) }), false, 'no remount loop');
  now += HEAL_RETRY_AFTER_MS;
  assert.equal(heal({ healedUpTo: await ledger.healedUpTo(W, 9, now) }), true, 'retry allowed after the wait');
  for (let i = 1; i < MAX_HEAL_TRIES; i++) {
    await ledger.record(W, 9, 5, now);
    now += HEAL_RETRY_AFTER_MS;
  }
  assert.equal(heal({ healedUpTo: await ledger.healedUpTo(W, 9, now) }), false, 'tries spent → stop');
  // complete() only finishes the SAME epoch.
  const l2 = new HealLedger(memRows());
  await l2.record(W, 1, 3, 0);
  await l2.complete(W, 1, 2);
  assert.equal(await l2.healedUpTo(W, 1, HEAL_RETRY_AFTER_MS), 2, 'still retryable');
  await l2.complete(W, 1, 3);
  assert.equal(await l2.healedUpTo(W, 1, HEAL_RETRY_AFTER_MS * 9), 3);
});

test('planHeal: target past all evidence; never a target when shouldHeal says no', () => {
  const i: HealInput = { messageEpoch: 5, latestHeldEpoch: 5, latestConfirmed: true, rotateAllowed: true, establishing: false, healedUpTo: 0 };
  assert.equal(planHeal(i, 7), 8);
  assert.equal(planHeal(i, 0), 6);
  assert.equal(planHeal({ ...i, rotateAllowed: false }, 0), null);
  assert.equal(planHeal({ ...i, healedUpTo: 5 }, 0), null);
});

test('gate token: spent only when a plan really starts (not on a join, not when already at the epoch)', () => {
  assert.equal(shouldTakeGate({ joining: false, alreadyAt: false }), true);
  assert.equal(shouldTakeGate({ joining: true, alreadyAt: false }), false);
  assert.equal(shouldTakeGate({ joining: false, alreadyAt: true }), false);
});

test('heal ledger: a read error fails closed (no heal, record refused)', async () => {
  const bad = new HealLedger({ read: async () => { throw new Error('io'); }, write: async () => {} });
  assert.equal(await bad.healedUpTo('klv1w', 1, 0), Number.POSITIVE_INFINITY);
  assert.equal(heal({ healedUpTo: await bad.healedUpTo('klv1w', 1, 0) }), false);
  assert.equal(await bad.record('klv1w', 1, 3, 0), false);
});

// --- Floor-driven rotation coalescing (W6) ---------------------------------------------------------

test('W6: one rotation in flight + ONE queued follow-up (highest floor), spacing between starts', () => {
  const q = new FloorRotationQueue();
  let now = 1_000_000;
  const s1 = q.request(7, 3, now);
  assert.equal(s1.action, 'start');
  const t1 = s1.action === 'start' ? s1.token : -1;
  assert.deepEqual(q.request(7, 3, now), { action: 'ignored' }, 'same floor while in flight');
  assert.deepEqual(q.request(7, 4, now), { action: 'queued', delayMs: null });
  assert.deepEqual(q.request(7, 6, now), { action: 'queued', delayMs: null });
  assert.deepEqual(q.request(7, 5, now), { action: 'ignored' }, 'lower than the queued one');
  now += 1_000;
  assert.equal(q.finish(7, now, t1 + 999), null, 'a stale token releases nothing');
  const next = q.finish(7, now, t1);
  assert.deepEqual(next, { floor: 6, delayMs: FLOOR_ROTATION_SPACING_MS - 1_000 });
  assert.equal(q.takeQueued(7, now), null, 'spacing not over yet');
  now += FLOOR_ROTATION_SPACING_MS;
  const tq = q.takeQueued(7, now);
  assert.equal(tq?.floor, 6);
  assert.equal(q.takeQueued(7, now), null, 'only one follow-up');
  q.finish(7, now, tq!.token);
  // Within the spacing a new floor is queued with a delay, not started.
  const r = q.request(7, 9, now + 10);
  assert.equal(r.action, 'queued');
  if (r.action === 'queued') assert.equal(r.delayMs, FLOOR_ROTATION_SPACING_MS - 10);
  // Another channel is independent; junk floors are ignored.
  assert.equal(q.request(8, 1, now).action, 'start');
  assert.deepEqual(q.request(8, 0, now), { action: 'ignored' });
  assert.deepEqual(q.request(8, Number.NaN, now), { action: 'ignored' });
});

// --- Send / seed / cover / resume -----------------------------------------------------------------

test('planBest: a HELD epoch is always known (B2); floors, usable keys, unreadable node', () => {
  const base = { bestEpoch: 4, eFloor: 0, rotateAllowed: true, usable: false, mayMove: false, authorVerified: true, fallbackEpoch: null as number | null };
  assert.deepEqual(planBest({ ...base, pair: 'none' }), { do: 'settle', epoch: 4, known: true });
  assert.deepEqual(planBest({ ...base, pair: 'other' }), { do: 'settle', epoch: 4, known: true });
  assert.deepEqual(planBest({ ...base, pair: 'ours-pending' }), { do: 'settle', epoch: 4, known: true });
  assert.deepEqual(planBest({ ...base, pair: 'ours-final' }), { do: 'use' });
  assert.deepEqual(planBest({ ...base, pair: 'legacy' }), { do: 'waiting' }, 'legacy: never sent under');
  assert.deepEqual(planBest({ ...base, usable: true, pair: null }), { do: 'use' });
  assert.deepEqual(planBest({ ...base, pair: null }), { do: 'waiting' });
  assert.deepEqual(planBest({ ...base, eFloor: 6, pair: null }), { do: 'rotate', epoch: 6 });
  assert.deepEqual(planBest({ ...base, eFloor: 6, rotateAllowed: false, pair: null }), { do: 'waiting' });
});

test('planNewerLatest / planSeed / earlyUseAllowed', () => {
  assert.equal(planNewerLatest({ latestState: 'arbitrated', fetchedKey: true, haveBest: true, canEstablish: true }), 'use-fetched');
  assert.equal(planNewerLatest({ latestState: 'arbitrated', fetchedKey: false, haveBest: true, canEstablish: true }), 'adopt');
  assert.equal(planNewerLatest({ latestState: 'arbitrated', fetchedKey: false, haveBest: false, canEstablish: true }), 'keep');
  assert.equal(planNewerLatest({ latestState: 'legacy', fetchedKey: false, haveBest: true, canEstablish: true }), 'keep');
  assert.deepEqual(planSeed({ latestState: 'arbitrated', latestEpoch: 3, target: 1 }), { do: 'adopt', epoch: 3 });
  assert.deepEqual(planSeed({ latestState: 'legacy', latestEpoch: 3, target: 1 }), { do: 'seed', epoch: 4, gated: true });
  assert.deepEqual(planSeed({ latestState: 'none', latestEpoch: 0, target: 2 }), { do: 'seed', epoch: 2, gated: false });
  assert.equal(earlyUseAllowed({ epoch: 1, latestState: 'none', soleMember: true }), true);
  assert.equal(earlyUseAllowed({ epoch: 2, latestState: 'none', soleMember: true }), false, 'rotations never');
  assert.equal(earlyUseAllowed({ epoch: 1, latestState: 'none', soleMember: false }), false, 'other members present');
  assert.equal(earlyUseAllowed({ epoch: 1, latestState: 'legacy', soleMember: true }), false);
});

test('planCover: publish only with our pair; legacy rotates only where allowed; public no-op', () => {
  assert.equal(planCover('ours', true), 'publish');
  assert.equal(planCover('legacy', true), 'rotate');
  assert.equal(planCover('legacy', false), 'skip');
  assert.equal(planCover('none', true), 'skip');
  assert.equal(planCover('other', false), 'adopt');
  assert.equal(planCover(null, true), 'retry');
});

test('resumeOpts: persisted mode wins; holding a key makes the epoch known', () => {
  assert.deepEqual(resumeOpts({ isPrivate: true, known: false }, false), { isPrivate: true, known: false });
  assert.deepEqual(resumeOpts({}, true), { isPrivate: false, known: true });
  assert.deepEqual(resumeOpts({ known: true }, false), { isPrivate: false, known: true });
});

test('N2: an old account\'s rotation finishing after a switch cannot release the NEW account\'s start', () => {
  const q = new FloorRotationQueue();
  const old = q.request(7, 3, 0);
  q.clear(); // account switch
  const neu = q.request(7, 2, 0);
  assert.equal(neu.action, 'start');
  assert.equal(q.finish(7, 1, old.action === 'start' ? old.token : -1), null);
  assert.deepEqual(q.request(7, 5, 2), { action: 'queued', delayMs: null }, 'the new start is still in flight');
});

test('W-A: exhausted resumes leave a PROBLEM that sticks, never "re-keying…" forever', () => {
  assert.deepEqual(statusAfterFlow({ kind: 'pending', epoch: 4 }, 'exhausted'), { state: 'problem', code: 'failed', detail: 'resume_exhausted' });
  assert.deepEqual(statusAfterFlow({ kind: 'key', epoch: 4, confirmed: false, incomplete: false }, 'exhausted'),
    { state: 'problem', code: 'failed', detail: 'resume_exhausted' });
  assert.deepEqual(statusAfterFlow({ kind: 'pending', epoch: 4 }, 'scheduled'), { state: 'rekeying', epoch: 4 });
  assert.deepEqual(statusAfterFlow({ kind: 'pending', epoch: 4 }, 'already'), { state: 'rekeying', epoch: 4 });
  assert.deepEqual(statusAfterFlow({ kind: 'key', epoch: 4, confirmed: true, incomplete: true }, 'exhausted'), { state: 'idle' });
  assert.deepEqual(statusAfterFlow({ kind: 'problem', code: 'no_rotate', detail: 'node_lagging' }, null),
    { state: 'problem', code: 'no_rotate', detail: 'node_lagging' });
});

test('W-C: status → message; a public channel whose epoch the node lacks says "switch node"', () => {
  assert.equal(statusMessageKey({ state: 'idle' }), null);
  assert.equal(statusMessageKey({ state: 'rekeying', epoch: 2 }), 'e2e_channel_rekeying');
  assert.equal(statusMessageKey({ state: 'problem', code: 'no_rotate', detail: 'node_lagging' }), 'e2e_channel_key_node_behind');
  assert.equal(statusMessageKey({ state: 'problem', code: 'node_lagging_unrecoverable' }), 'e2e_channel_key_node_behind');
  assert.equal(statusMessageKey({ state: 'problem', code: 'epoch_too_high' }), 'e2e_channel_key_node_behind');
  assert.equal(statusMessageKey({ state: 'problem', code: 'no_rotate', detail: 'escalate' }), 'e2e_channel_key_failed');
  assert.equal(statusMessageKey({ state: 'problem', code: 'failed' }), 'e2e_channel_key_failed');
});

// --- Round-4 amendment: node bound, floors, budget, keyring ------------------------------------------

test('unified guard: no plan beyond the node\'s highest + 256; a hostile floor is never trusted', () => {
  assert.equal(epochWithinNodeBound(3 + NODE_EPOCH_MAX_AHEAD, 3), true);
  assert.equal(epochWithinNodeBound(4 + NODE_EPOCH_MAX_AHEAD, 3), false);
  assert.equal(epochWithinNodeBound(100000, 3), false);
  assert.equal(epochWithinNodeBound(1, 0), true);
  assert.equal(epochWithinNodeBound(0, 0), false);
  assert.equal(floorTrust(5, 3), 'ok');
  assert.equal(floorTrust(3 + NODE_EPOCH_MAX_AHEAD + 1, 3), 'hostile');
  assert.equal(floorTrust(100000, 3), 'hostile');
  assert.equal(floorTrust(0, 3), 'none');
  assert.equal(floorTrust(7, null), 'unknown');
});

test('resume budget: only a COMPLETE result resets it; uncovered outcomes keep counting', () => {
  const b = new ResumeBudget(3);
  assert.equal(b.take(1), 0);
  assert.equal(b.take(1), 1);
  // (an incomplete / unconfirmed outcome does NOT call complete)
  assert.equal(b.take(1), 2);
  assert.equal(b.take(1), null, 'bounded');
  b.complete(1);
  assert.equal(b.take(1), 0);
  assert.equal(b.take(2), 0, 'per channel');
});
