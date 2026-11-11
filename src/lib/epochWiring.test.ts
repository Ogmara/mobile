/**
 * epochWiring — mobile's wiring of sdk-js 0.67.0 `establishEpochKey` (mobile
 * 0.58.0). Runs the REAL SDK protocol against a local fake node that
 * implements the l2-node 0.143.0 arbitration rule (one winner per epoch: the
 * lowest (key_ts, commitment) pair, superseding only inside the 120 s
 * finality horizon; write-once slots; a superseded loser's wraps deleted),
 * on a virtual clock.
 *
 * Pins: concurrent two-device establishment converges on ONE key; an account
 * switch mid-establish publishes nothing more; a restart resumes the persisted
 * epoch with the SAME key; follow-up rotations are gated and never happen for
 * public channels; the heal trigger is gated; the strict-policy publish path
 * (real SDK envelope builder) always carries a commitment that matches the key.
 *
 * Run with: node --test src/lib/epochWiring.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decode } from '@msgpack/msgpack';
import {
  PendingEpochKeyStore, EscalationGate, TokenBucket, computeKeyCommitment, computeChannelScope,
  compareRank, sameCandidate, keyCommitmentToHex, KeyCommitmentConflictError, KeyEnvelopeRejectedError,
  WalletSigner, OgmaraClient, buildChannelEpochKeyEnvelope, generateDeviceEncKeypair, encPublicKeyHex, unwrapConvKey,
  type KeyCommitmentInfo, type EpochKeyTarget, type PublishChannelKeyResult, type VerifiedChannelKeyWrap,
} from '@ogmara/sdk';
import {
  runEpochFlow, buildEstablishDeps, stepFor, mayRotate, effectiveFloor, withTimeout,
  EpochEvidence, EstablishingStore, DepTimeoutError, ESTABLISHING_BASE, MAX_ESTABLISHING,
  type EpochIo, type AccountEpochState, type WalletRowIo,
} from './epochWiring.ts';
import { AccountChangedError, PRIVATE_CHANNEL_ID_FLOOR } from './privateCoverCore.ts';
import type { EscalationGate as EscalationGateT } from '@ogmara/sdk';

const CH = PRIVATE_CHANNEL_ID_FLOOR + 77;
const SCOPE = computeChannelScope(CH);
const FINALITY = 120_000;
const addr = (n: string) => `klv1${n.padEnd(58, 'q')}`;
const A = addr('alice'), B = addr('bob'), M = addr('mia');
const dev = (w: string) => (w === A ? 'aa' : w === B ? 'bb' : 'cc').repeat(32);

/** Virtual clock: every sleep advances it. */
class Clock {
  t = 1_800_000_000_000;
  now = () => this.t;
  sleep = async (ms: number) => { this.t += Math.max(1, ms); await new Promise((r) => setImmediate(r)); };
}

interface Slot { key: Uint8Array; keyTs: number; c: Uint8Array; author: string }
interface Winner { keyTs: number; c: Uint8Array; author: string; at: number }

/** l2-node 0.143.0 arbitration, in memory. */
class FakeNode {
  winners = new Map<number, Winner>();
  slots = new Map<string, Slot>();
  legacy = new Set<number>();
  publishes: Array<{ author: string; target: string; epoch: number }> = [];
  readonly clock: Clock;
  finality = FINALITY;
  constructor(clock: Clock) { this.clock = clock; }

  private final(w: Winner): boolean { return this.clock.now() >= w.at + this.finality; }

  info(epoch: number): KeyCommitmentInfo {
    if (this.legacy.has(epoch)) {
      return { channel_id: CH, epoch, state: 'legacy', final: true, finality_ms: FINALITY };
    }
    const w = this.winners.get(epoch);
    if (!w) return { channel_id: CH, epoch, state: 'none', final: false, finality_ms: FINALITY };
    return {
      channel_id: CH, epoch, state: 'arbitrated', key_commitment: keyCommitmentToHex(w.c), key_ts: w.keyTs,
      author: w.author, msg_id: 'ff'.repeat(32), recorded_at: w.at, final: this.final(w), finality_ms: FINALITY,
    };
  }

  async getCommitment(epoch?: number): Promise<KeyCommitmentInfo> {
    await new Promise((r) => setImmediate(r));
    if (epoch === undefined) {
      const all = [...this.winners.keys(), ...this.legacy];
      return this.info(all.length ? Math.max(...all) : 0);
    }
    return this.info(epoch);
  }

  async publish(author: string, t: EpochKeyTarget, key: Uint8Array, keyTs: number, epoch: number): Promise<PublishChannelKeyResult> {
    await new Promise((r) => setImmediate(r)); // interleave concurrent establishers
    this.publishes.push({ author, target: t.target, epoch });
    if (this.legacy.has(epoch)) throw new KeyEnvelopeRejectedError(400, 'key_commitment_required');
    const c = computeKeyCommitment(SCOPE, epoch, keyTs, key);
    const cur = this.winners.get(epoch);
    const mine = { keyTs, keyCommitment: c };
    if (!cur) {
      this.winners.set(epoch, { keyTs, c, author, at: this.clock.now() });
    } else if (!sameCandidate(mine, { keyTs: cur.keyTs, keyCommitment: cur.c })) {
      const better = compareRank(mine, { keyTs: cur.keyTs, keyCommitment: cur.c }) < 0;
      if (better && !this.final(cur)) {
        // Supersede: the loser's wraps are deleted.
        for (const [k, s] of this.slots) if (k.endsWith(`|${epoch}`) && keyCommitmentToHex(s.c) === keyCommitmentToHex(cur.c)) this.slots.delete(k);
        this.winners.set(epoch, { keyTs, c, author, at: this.clock.now() });
      } else {
        throw new KeyCommitmentConflictError({
          key_commitment: keyCommitmentToHex(cur.c), key_ts: cur.keyTs, author: cur.author,
          msg_id: 'ff'.repeat(32), final: this.final(cur),
        }, 'arbitrated', epoch);
      }
    }
    const sk = `${t.target}|${t.deviceId}|${epoch}`;
    if (this.slots.has(sk)) return { status: 'already_present' } as PublishChannelKeyResult;
    this.slots.set(sk, { key: key.slice(), keyTs, c, author });
    return { status: 'stored' } as PublishChannelKeyResult;
  }

  ownWrap(wallet: string, epoch: number): VerifiedChannelKeyWrap | null {
    const s = this.slots.get(`${wallet}|${dev(wallet)}|${epoch}`);
    if (!s) return null;
    return { key: s.key.slice(), keyCommitment: s.c, keyTs: s.keyTs, epoch, wallet: s.author, signer: s.author, msgId: 'ee'.repeat(32) };
  }

  slotKey(wallet: string, epoch: number): string | null {
    const s = this.slots.get(`${wallet}|${dev(wallet)}|${epoch}`);
    return s ? Buffer.from(s.key).toString('hex') : null;
  }
}

function memRows(): WalletRowIo & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    read: async (w, b) => data.get(`${b}::${w}`) ?? null,
    write: async (w, b, v) => { data.set(`${b}::${w}`, v); },
  };
}

let keySeq = 0;
function member(wallet: string, node: FakeNode, clock: Clock, rows = memRows(), over: Partial<EpochIo> = {}) {
  const valid = { v: true };
  const io: EpochIo = {
    channelId: CH,
    self: { wallet, deviceId: dev(wallet), signingAddress: wallet, encPub: new Uint8Array(32).fill(7) },
    stillValid: () => valid.v,
    getCommitment: (e) => node.getCommitment(e),
    fetchOwnWrap: async (e) => node.ownWrap(wallet, e),
    isSelfBound: async () => true,
    listTargets: async () => [A, B, M].map((w) => ({ target: w, deviceId: dev(w), encPub: new Uint8Array(32).fill(9) })),
    publish: (t, key, keyTs, e) => node.publish(wallet, t, key, keyTs, e),
    peerCommitments: async () => [],
    newKey: () => { const k = new Uint8Array(32); k.fill((++keySeq % 250) + 1); k[0] = keySeq & 0xff; k[1] = wallet.charCodeAt(4); return k; },
    now: clock.now,
    sleep: clock.sleep,
    yieldToUi: async () => {},
    log: () => {},
    ...over,
  };
  const st: AccountEpochState = {
    wallet,
    pending: new PendingEpochKeyStore(),
    gate: new EscalationGate(clock.now),
    bucket: new TokenBucket(clock.now, clock.sleep, 100, 100),
    evidence: new EpochEvidence(),
    establishing: new EstablishingStore(rows),
  };
  return { io, st, valid, rows };
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

// --- Concurrency ------------------------------------------------------------------

test('two devices establishing the same epoch concurrently converge on ONE key, both confirmed', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const a = member(A, node, clock);
  const b = member(B, node, clock);
  const [ra, rb] = await Promise.all([
    runEpochFlow(a.io, a.st, { epoch: 2, epochKnownToExist: false, mayRotate: true }),
    runEpochFlow(b.io, b.st, { epoch: 2, epochKnownToExist: false, mayRotate: true }),
  ]);
  assert.equal(ra.kind, 'key');
  assert.equal(rb.kind, 'key');
  if (ra.kind !== 'key' || rb.kind !== 'key') return;
  assert.equal(ra.epoch, rb.epoch);
  assert.equal(hex(ra.key), hex(rb.key), 'no fork');
  assert.ok(ra.confirmed && rb.confirmed, 'both wait for FINAL');
  assert.deepEqual(new Set([ra.role, rb.role]), new Set(['established', 'adopted']));
  // Every member device holds the winner at that epoch.
  for (const w of [A, B, M]) assert.equal(node.slotKey(w, ra.epoch), hex(ra.key), `slot of ${w.slice(0, 9)}`);
  // Terminal → nothing left to resume; authenticated evidence noted.
  assert.deepEqual(await a.st.establishing.list(A), []);
  assert.equal(a.st.evidence.highest(CH), ra.epoch);
});

test('an account switch mid-establish publishes NOTHING more and returns aborted', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const a = member(A, node, clock);
  let afterFlip = 0;
  const inner = a.io.publish;
  a.io.publish = async (t, key, keyTs, e, o) => {
    if (!a.valid.v) afterFlip++;
    const r = await inner(t, key, keyTs, e, o);
    a.valid.v = false; // the switch lands right after the first publish
    return r;
  };
  const r = await runEpochFlow(a.io, a.st, { epoch: 1, epochKnownToExist: false, mayRotate: true });
  assert.equal(r.kind, 'aborted');
  assert.equal(afterFlip, 0, 'no publish after the account changed');
  assert.equal(node.publishes.length, 1);
  // The epoch stays persisted for THAT wallet (resumed when it comes back).
  assert.deepEqual(await a.st.establishing.list(A), [{ channelId: CH, epoch: 1, isPrivate: false, known: false }]);
});

test('guard: a dep is never called once the account is invalid; deps time out', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const a = member(A, node, clock, memRows(), { depTimeoutMs: 20 });
  let calls = 0;
  a.io.getCommitment = async () => { calls++; return new Promise<KeyCommitmentInfo>(() => {}); };
  const deps = buildEstablishDeps(a.io, a.st, 1, { epoch: 1, epochKnownToExist: false, mayRotate: true });
  await assert.rejects(deps.getCommitment(1), DepTimeoutError);
  a.valid.v = false;
  await assert.rejects(deps.getCommitment(1), AccountChangedError);
  assert.equal(calls, 1);
  assert.equal(deps.isFatalError!(new AccountChangedError()), true);
  assert.equal(deps.isFatalError!(new Error('x')), false);
  await assert.rejects(withTimeout(new Promise(() => {}), 5, 'x'), DepTimeoutError);
});

// --- Restart resume ------------------------------------------------------------------

test('restart: the persisted epoch is resumed with the SAME key and the remaining members get it', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const rows = memRows();
  const a1 = member(A, node, clock, rows);
  // "Crash" right after the own-device publish (the app is killed).
  const inner = a1.io.publish;
  a1.io.publish = async (t, key, keyTs, e, o) => {
    const r = await inner(t, key, keyTs, e, o);
    if (t.target === A) a1.valid.v = false;
    return r;
  };
  assert.equal((await runEpochFlow(a1.io, a1.st, { epoch: 3, epochKnownToExist: false, mayRotate: true })).kind, 'aborted');
  const winnerKey = node.slotKey(A, 3);
  assert.ok(winnerKey);
  assert.equal(node.slotKey(M, 3), null, 'M not covered before the crash');

  // Restart: fresh memory (empty pending store), same persisted rows.
  const a2 = member(A, node, clock, rows);
  const todo = await a2.st.establishing.list(A);
  assert.deepEqual(todo, [{ channelId: CH, epoch: 3, isPrivate: false, known: false }]);
  const r = await runEpochFlow(a2.io, a2.st, { epoch: todo[0]!.epoch, epochKnownToExist: false, mayRotate: true });
  assert.equal(r.kind, 'key');
  if (r.kind !== 'key') return;
  assert.equal(hex(r.key), winnerKey, 'the SAME key, not a second one for the epoch');
  assert.equal(node.slotKey(M, 3), winnerKey);
  assert.equal(node.slotKey(B, 3), winnerKey);
  assert.deepEqual(await a2.st.establishing.list(A), [], 'cleared after the terminal outcome');
});

// --- Early use ---------------------------------------------------------------------------

test('early use only when asked (first key of a new channel): our key before FINAL, same pair after', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const a = member(A, node, clock, memRows(), { listTargets: async () => [{ target: A, deviceId: dev(A), encPub: new Uint8Array(32).fill(9) }] });
  let early: { key: string; final: boolean } | null = null;
  const r = await runEpochFlow(a.io, a.st, {
    epoch: 1, epochKnownToExist: false, mayRotate: true, earlyUse: true,
    onEarlyKey: (u) => { early = { key: hex(u.key), final: node.info(1).final }; },
  });
  assert.ok(early, 'early key delivered');
  assert.equal(early!.final, false, 'before the epoch was final');
  assert.equal(r.kind, 'key');
  if (r.kind === 'key') assert.equal(hex(r.key), early!.key);

  const clock2 = new Clock();
  const node2 = new FakeNode(clock2);
  const b = member(B, node2, clock2);
  let called = false;
  await runEpochFlow(b.io, b.st, { epoch: 1, epochKnownToExist: false, mayRotate: true, onEarlyKey: () => { called = true; } });
  assert.equal(called, false, 'rotations / joins never get early use');
});

// --- Rotation gating ------------------------------------------------------------------

test('C: rotation is allowed only for private-range ids or pinned channels; public floor is 0', () => {
  assert.equal(mayRotate(5, false), false);
  assert.equal(mayRotate(5, true), true);
  assert.equal(mayRotate(PRIVATE_CHANNEL_ID_FLOOR + 1, false), true);
  assert.equal(effectiveFloor(5, 7, false), 0);
  assert.equal(effectiveFloor(5, 7, true), 7);
  assert.equal(effectiveFloor(PRIVATE_CHANNEL_ID_FLOOR + 1, 7, false), 7);
  assert.equal(effectiveFloor(PRIVATE_CHANNEL_ID_FLOOR + 1, -3, false), 0);
});

test('a LEGACY epoch: rotation through the gate where allowed; a public channel publishes nothing', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  node.legacy.add(4);
  const a = member(A, node, clock);
  const r = await runEpochFlow(a.io, a.st, { epoch: 4, epochKnownToExist: true, mayRotate: true });
  assert.equal(r.kind, 'key');
  if (r.kind === 'key') assert.equal(r.epoch, 5, 'moved to the next epoch');
  // A second legacy hit within 10 min is gated (no rotation storm).
  node.legacy.add(6);
  const before = node.publishes.length;
  const r2 = await runEpochFlow(a.io, a.st, { epoch: 6, epochKnownToExist: true, mayRotate: true });
  assert.ok(r2.kind === 'key' || r2.kind === 'pending');
  if (r2.kind === 'pending') assert.match(r2.reason, /gated/);
  if (r2.kind === 'pending') assert.equal(node.publishes.length, before);

  // Public channel: no rotation at all.
  const clock3 = new Clock();
  const node3 = new FakeNode(clock3);
  node3.legacy.add(2);
  const p = member(B, node3, clock3);
  const r3 = await runEpochFlow({ ...p.io, channelId: CH }, p.st, { epoch: 2, epochKnownToExist: true, mayRotate: false });
  assert.equal(r3.kind, 'problem');
  if (r3.kind === 'problem') assert.equal(r3.code, 'legacy');
  assert.equal(node3.publishes.length, 0);
});

test('stepFor: SDK-gated outcomes rotate only where allowed; surfaced codes', () => {
  const info = { channel_id: CH, epoch: 3, state: 'arbitrated', final: true, finality_ms: FINALITY } as KeyCommitmentInfo;
  assert.deepEqual(stepFor({ kind: 'escalate', epoch: 3, winner: info }, true), { do: 'rotate', epoch: 4, gated: true, reason: 'escalate' });
  const noRot = stepFor({ kind: 'escalate', epoch: 3, winner: info }, false);
  assert.equal(noRot.do, 'result');
  if (noRot.do === 'result') assert.equal((noRot.result as { code: string }).code, 'no_rotate');
  assert.deepEqual(stepFor({ kind: 'split', epoch: 3, home: info, peer: info }, true), { do: 'rotate', epoch: 4, gated: true, reason: 'split' });
  assert.deepEqual(stepFor({ kind: 'node_lagging', epoch: 3, highestEpochSeen: 9, recoveryEpoch: 10 }, true),
    { do: 'rotate', epoch: 10, gated: true, reason: 'node_lagging' });
  const unrec = stepFor({ kind: 'node_lagging', epoch: 3, highestEpochSeen: 900, recoveryEpoch: 901, unrecoverableHere: true }, true);
  assert.equal(unrec.do === 'result' && (unrec.result as { code: string }).code, 'node_lagging_unrecoverable');
  const high = stepFor({ kind: 'failed', epoch: 3, reason: 'key_epoch_too_far', retryable: false, epochTooHigh: true }, true);
  assert.equal(high.do === 'result' && (high.result as { code: string }).code, 'epoch_too_high');
  const ex = stepFor({ kind: 'unconfirmed_exhausted', epoch: 3, calls: 5, lastReason: 'not_final' }, true);
  assert.deepEqual(ex, { do: 'rotate', epoch: 4, gated: false, reason: 'unconfirmed_exhausted' });
  const nb = stepFor({ kind: 'needs_binding', epoch: 3 }, true);
  assert.equal(nb.do === 'result' && nb.clear, false, 'needs_binding keeps the epoch for the resume after re-binding');
  const w = stepFor({ kind: 'waiting', epoch: 3, reason: 'not_final' }, true);
  assert.equal(w.do === 'result' && w.result.kind, 'pending');
});

// --- Strict policy (real SDK builder) --------------------------------------------------------

test('strict policy: every publish is a real 0x61 with key_commitment + key_ts that hash to the wrapped key', async () => {
  // The SDK envelope builder stamps with the REAL clock (key_ts <= envelope
  // timestamp), so this test runs on real time with an instantly-final node.
  const clock = new Clock();
  clock.now = () => Date.now();
  clock.sleep = async (ms) => { await new Promise((r) => setTimeout(r, Math.min(ms, 2))); };
  const node = new FakeNode(clock);
  node.finality = 0;
  const signer = await WalletSigner.generate();
  signer.network = 'testnet';
  const members = [signer.address, addr('m2')];
  const encs = new Map(members.map((w) => [w, generateDeviceEncKeypair()]));
  let checked = 0;
  const me = member(signer.address, node, clock, memRows(), {
    listTargets: async () => members.map((w) => ({
      target: w, deviceId: dev(w), encPub: Uint8Array.from(Buffer.from(encPublicKeyHex(encs.get(w)!.privateKey), 'hex')),
    })),
    fetchOwnWrap: async (e) => node.ownWrap(signer.address, e),
    // The same shape channelCrypto.ts publishes with (buildChannelEpochKeyEnvelope → bytes).
    publish: async (t, key, keyTs, e) => {
      const bytes = await buildChannelEpochKeyEnvelope(signer, { channelId: CH, epoch: e, key, keyTs, target: t.target, deviceId: t.deviceId, encPub: t.encPub });
      const env = decode(bytes) as { payload: Uint8Array };
      const p = decode(env.payload) as Record<string, unknown>;
      assert.ok(p.key_commitment instanceof Uint8Array, 'commitment present (no 400 key_commitment_required)');
      assert.equal(p.key_ts, keyTs);
      const unwrapped = unwrapConvKey({ ephPub: p.eph_pub as Uint8Array, nonce: p.nonce as Uint8Array, wrapped: p.wrapped as Uint8Array },
        encs.get(t.target)!.privateKey, SCOPE);
      assert.equal(hex(computeKeyCommitment(SCOPE, e, keyTs, unwrapped)), hex(p.key_commitment as Uint8Array));
      checked++;
      return node.publish(signer.address, t, key, keyTs, e);
    },
  });
  me.io.self = {
    wallet: signer.address, deviceId: dev(signer.address), signingAddress: signer.address,
    encPub: Uint8Array.from(Buffer.from(encPublicKeyHex(encs.get(signer.address)!.privateKey), 'hex')),
  };
  const r = await runEpochFlow(me.io, me.st, { epoch: 1, epochKnownToExist: false, mayRotate: true });
  assert.equal(r.kind, 'key');
  assert.ok(checked >= 2);
});

// --- Persisted epoch store --------------------------------------------------------------------

test('EstablishingStore: per wallet, epoch numbers only, clear only the same epoch, bounded, read error tolerated', async () => {
  const rows = memRows();
  const s = new EstablishingStore(rows);
  await s.set(A, 10, 2);
  await s.set(A, 11, 5);
  await s.set(B, 10, 9);
  await s.clear(A, 11, 4); // a different epoch: kept
  assert.deepEqual(await s.list(A), [{ channelId: 10, epoch: 2, isPrivate: false, known: false }, { channelId: 11, epoch: 5, isPrivate: false, known: false }]);
  await s.clear(A, 11, 5);
  assert.deepEqual(await s.list(A), [{ channelId: 10, epoch: 2, isPrivate: false, known: false }]);
  assert.deepEqual(await s.list(B), [{ channelId: 10, epoch: 9, isPrivate: false, known: false }]);
  assert.deepEqual(JSON.parse(rows.data.get(`${ESTABLISHING_BASE}::${A}`)!), { '10': { e: 2, p: false, k: false } }, 'no key material, only numbers');
  // A fresh instance (restart) reads the same rows.
  assert.deepEqual(await new EstablishingStore(rows).list(A), [{ channelId: 10, epoch: 2, isPrivate: false, known: false }]);
  // Cap.
  const big = new EstablishingStore(memRows());
  for (let i = 1; i <= MAX_ESTABLISHING + 5; i++) await big.set(A, i, 1);
  assert.equal((await big.list(A)).length, MAX_ESTABLISHING);
  // Read error: set/clear do not throw, list rejects (resume skipped).
  const bad = new EstablishingStore({ read: async () => { throw new Error('io'); }, write: async () => {} });
  await bad.set(A, 1, 1);
  await bad.clear(A, 1, 1);
  await assert.rejects(bad.list(A));
});

test('EpochEvidence keeps the max per channel and ignores junk', () => {
  const e = new EpochEvidence();
  e.note(1, 3);
  e.note(1, 2);
  e.note(1, Number.NaN);
  e.note(-1, 9);
  assert.equal(e.highest(1), 3);
  assert.equal(e.highest(2), 0);
});

// --- Round-2 audit pins (B2, M3, M4, M10, M11, M24, evidence rule) ------------------------------

test('M3: highestEpochSeen is exactly the account evidence, and it stops key creation on a lagging node', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const a = member(A, node, clock);
  a.st.evidence.note(CH, 5);
  const deps = buildEstablishDeps(a.io, a.st, 3, { epoch: 3, epochKnownToExist: false, mayRotate: false });
  assert.equal(deps.highestEpochSeen, 5);
  // Node has nothing at 3, we have authenticated evidence of 5: no key at 3.
  const r = await runEpochFlow(a.io, a.st, { epoch: 3, epochKnownToExist: false, mayRotate: false });
  assert.equal(r.kind, 'problem');
  assert.equal(node.publishes.length, 0, 'nothing published on the lagging node');
});

test('B2: a HELD key at an epoch the node reports `none` → node_lagging; nothing is published at that epoch', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const a = member(A, node, clock);
  const r = await runEpochFlow(a.io, a.st, { epoch: 4, epochKnownToExist: true, mayRotate: false });
  assert.equal(r.kind, 'problem');
  if (r.kind === 'problem') assert.equal(r.code, 'no_rotate');
  assert.equal(node.publishes.length, 0);
  // Where rotation is allowed it moves PAST the epoch (gated) — still nothing at 4.
  const b = member(B, node, clock);
  const r2 = await runEpochFlow(b.io, b.st, { epoch: 4, epochKnownToExist: true, mayRotate: true });
  assert.equal(r2.kind, 'key');
  assert.ok(!node.publishes.some((p) => p.epoch === 4), 'no second key created at the held epoch');
});

test('evidence rule: a hostile legacy wrap at epoch 100000 + restart does not raise highestEpochSeen', async () => {
  // (The keyring side of this rule — a legacy / vault key is never TRUSTED —
  // is pinned against the real SDK keyring in channelKeyStore.test.ts.)
  // After the restart the evidence is empty (nothing above came in), so a
  // normal rotation at epoch 2 still creates its key.
  const clock = new Clock();
  const node = new FakeNode(clock);
  const a = member(A, node, clock);
  assert.equal(a.st.evidence.highest(CH), 0);
  const r = await runEpochFlow(a.io, a.st, { epoch: 2, epochKnownToExist: false, mayRotate: true });
  assert.equal(r.kind, 'key');
  if (r.kind === 'key') assert.equal(r.epoch, 2);
});

test('M4: early use only on the FIRST hop (never after a follow-up rotation)', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  node.legacy.add(1);
  const a = member(A, node, clock, memRows(), { listTargets: async () => [{ target: A, deviceId: dev(A), encPub: new Uint8Array(32).fill(9) }] });
  let called = false;
  const r = await runEpochFlow(a.io, a.st, { epoch: 1, epochKnownToExist: false, mayRotate: true, earlyUse: true, onEarlyKey: () => { called = true; } });
  assert.equal(r.kind, 'key');
  if (r.kind === 'key') assert.equal(r.epoch, 2);
  assert.equal(called, false);
});

test('M10: at most ONE follow-up rotation per call (hop cap), even when the gate would allow more', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  node.legacy.add(4);
  node.legacy.add(5);
  const a = member(A, node, clock);
  // A gate that always allows, so only the hop cap can stop the chain.
  a.st.gate = { tryEscalate: () => true, remainingMs: () => 0 } as unknown as EscalationGateT;
  const r = await runEpochFlow(a.io, a.st, { epoch: 4, epochKnownToExist: true, mayRotate: true });
  assert.equal(r.kind, 'pending');
  if (r.kind === 'pending') assert.match(r.reason, /^hop_cap/);
  assert.ok(!node.publishes.some((p) => p.epoch >= 6), 'never reached epoch 6');
});

test('M11: a rotation the SDK did not gate (legacy) is refused by a spent gate, nothing published', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  node.legacy.add(4);
  const a = member(A, node, clock);
  assert.equal(a.st.gate.tryEscalate(CH), true); // spent within the 10 min window
  const r = await runEpochFlow(a.io, a.st, { epoch: 4, epochKnownToExist: true, mayRotate: true });
  assert.equal(r.kind, 'pending');
  if (r.kind === 'pending') assert.match(r.reason, /^gated:legacy/);
  assert.equal(node.publishes.length, 0);
});

test('M24: a key returned after the account changed is zeroed (aborted)', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const a = member(A, node, clock);
  const key = new Uint8Array(32).fill(5);
  const r = await runEpochFlow(a.io, a.st, { epoch: 1, epochKnownToExist: false, mayRotate: true }, async () => {
    a.valid.v = false; // the switch lands while the SDK call finishes
    return { kind: 'established', epoch: 1, key, keyTs: 1, keyCommitment: new Uint8Array(32).fill(1), confirmed: true, uncovered: [], rejected: [] };
  });
  assert.equal(r.kind, 'aborted');
  assert.ok(key.every((b) => b === 0), 'key bytes wiped');
});

test('W4: persisted establishments keep their resume mode; bare numbers still parse', async () => {
  const rows = memRows();
  const s = new EstablishingStore(rows);
  await s.set(A, 7, 3, { isPrivate: true, known: true });
  assert.deepEqual(await new EstablishingStore(rows).list(A), [{ channelId: 7, epoch: 3, isPrivate: true, known: true }]);
  rows.data.set(`${ESTABLISHING_BASE}::${B}`, JSON.stringify({ '9': 4 }));
  assert.deepEqual(await new EstablishingStore(rows).list(B), [{ channelId: 9, epoch: 4, isPrivate: false, known: false }]);
  // runEpochFlow persists the request's mode.
  const clock = new Clock();
  const node = new FakeNode(clock);
  const r2 = memRows();
  const a = member(A, node, clock, r2);
  a.valid.v = true;
  const inner = a.io.publish;
  a.io.publish = async (t, k, ts, e, o) => { const x = await inner(t, k, ts, e, o); a.valid.v = false; return x; };
  await runEpochFlow(a.io, a.st, { epoch: 2, epochKnownToExist: false, mayRotate: true, isPrivate: true });
  assert.deepEqual(await new EstablishingStore(r2).list(A), [{ channelId: CH, epoch: 2, isPrivate: true, known: false }]);
});

test('N3: the SDK still has the per-instance PoW solver the peer probes replace (a rename must fail loudly)', () => {
  assert.equal(typeof (OgmaraClient.prototype as unknown as Record<string, unknown>).ensurePowSolved, 'function');
});

test('N6: runEpochFlow persists `known` with the epoch (restart resumes it as known)', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const rows = memRows();
  const a = member(A, node, clock, rows);
  const r = await runEpochFlow(a.io, a.st, { epoch: 3, epochKnownToExist: true, mayRotate: true, isPrivate: false },
    async () => ({ kind: 'waiting', epoch: 3, reason: 'not_final' }));
  assert.equal(r.kind, 'pending');
  assert.deepEqual(await new EstablishingStore(rows).list(A), [{ channelId: CH, epoch: 3, isPrivate: false, known: true }]);
  // A follow-up rotation is persisted as NOT known.
  const rows2 = memRows();
  const b = member(B, node, clock, rows2);
  let calls = 0;
  await runEpochFlow(b.io, b.st, { epoch: 3, epochKnownToExist: true, mayRotate: true }, async () => {
    calls++;
    return calls === 1 ? { kind: 'legacy', epoch: 3 } : { kind: 'waiting', epoch: 4, reason: 'not_final' };
  });
  assert.deepEqual(await new EstablishingStore(rows2).list(B), [{ channelId: CH, epoch: 4, isPrivate: false, known: false }]);
});

test('unified guard: a plan beyond the node\'s highest + 256 publishes and persists NOTHING (hostile floor / planted key)', async () => {
  const clock = new Clock();
  const node = new FakeNode(clock);
  const rows = memRows();
  const a = member(A, node, clock, rows);
  // Node highest is 0: epoch 257 is out of bound (e.g. a hostile key_epoch_floor of 100000 → target 100000).
  for (const epoch of [257, 100000]) {
    const r = await runEpochFlow(a.io, a.st, { epoch, epochKnownToExist: false, mayRotate: true });
    assert.equal(r.kind, 'problem');
    if (r.kind === 'problem') assert.equal(r.code, 'epoch_too_high');
  }
  assert.equal(node.publishes.length, 0);
  assert.deepEqual(await a.st.establishing.list(A), []);
  // A follow-up rotation that would land out of bound is refused too.
  const r2 = await runEpochFlow(a.io, a.st, { epoch: 256, epochKnownToExist: false, mayRotate: true });
  assert.equal(r2.kind, 'key', 'highest + 256 is still allowed');
});
