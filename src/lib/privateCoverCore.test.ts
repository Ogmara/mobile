/**
 * privateCoverCore — verify-before-cover for private channels (mobile 0.58.0):
 * fail-closed filtering, self always covered, creator pin + seen-removal
 * persistence per wallet, account switches mid-flow publishing and writing
 * NOTHING, the private id namespace, bound-only wrapping, early stop + offset
 * rotation, binding-verdict cache. (Epoch establishment moved to the SDK's
 * `establishEpochKey`; its wiring is pinned by epochWiring.test.ts.)
 * Run with: node --test src/lib/privateCoverCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PchanTrustState, PchanTrustStore, resolvePrivateTargets, publishToTargets, decideCoverMode, CoverBackoff,
  BindingVerdictCache, AccountChangedError, CoverSkippedError, guarded, isPrivateRangeId,
  coveredWallets, coverThrottleMs,
  channelTrustKey, PIN_STORE_BASE, SEEN_STORE_BASE, VERIFY_CHUNK, MAX_SEEN_PER_CHANNEL, MAX_KEYS_PER_MEMBER,
  SEEN_INDEX_BASE, MAX_SEEN_TOTAL, MAX_SEEN_CHANNELS, seenChannelBase, selectBoundRows,
  BUDGET_BACKOFF_MIN_MS, BUDGET_BACKOFF_MAX_MS, PRIVATE_CHANNEL_ID_FLOOR, COVER_THROTTLE_PRIVATE_MS,
  COVER_THROTTLE_PUBLIC_MS,
  type PrivateTargetDeps, type FilterResultLike, type FilterOptionsLike, type EncKeyRow, type TrustStorageIo,
  type CoverTarget,
} from './privateCoverCore.ts';
import { PRIVATE_CHANNEL_ID_FLOOR as INVITE_FLOOR } from './privateInvite.ts';
import { withRetry } from './e2eDebug.ts';
import { resolveCoverType } from './channelEncryption.ts';

// Fake klv1 addresses (format-checked only by the core; real verification is the SDK's job).
const addr = (n: number | string) => `klv1${String(n).padStart(58, 'q')}`;
const SELF = addr('self');
const CREATOR = addr('creator');
const NET = 'testnet';
const CH = PRIVATE_CHANNEL_ID_FLOOR + 4242;

function memIo(initial: Record<string, string> = {}) {
  const data = new Map<string, string>(Object.entries(initial));
  const writes: string[] = [];
  const io: TrustStorageIo = {
    read: async (w, b) => data.get(`${b}::${w}`) ?? null,
    write: async (w, b, v) => { writes.push(`${b}::${w}`); data.set(`${b}::${w}`, v); },
    remove: async (w, b) => { writes.push(`-${b}::${w}`); data.delete(`${b}::${w}`); },
  };
  return { io, data, writes };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

const keysFor = (w: string): EncKeyRow[] => [
  { device_id: `${w}-dev`, enc_pub: 'aa'.repeat(32), created_at: 1, ts: 1, bound: true, wallet_signature: 'sig' },
];

interface Harness {
  deps: PrivateTargetDeps;
  filterCalls: { wallets: string[]; opts: FilterOptionsLike }[];
  encKeyCalls: string[];
  bindingCalls: number;
  valid: { v: boolean };
}

function harness(over: Partial<PrivateTargetDeps> & {
  verdicts?: (w: string) => true | string;
  creator?: string;
} = {}): Harness {
  const h: Harness = { deps: undefined as never, filterCalls: [], encKeyCalls: [], bindingCalls: 0, valid: { v: true } };
  const verdicts = over.verdicts ?? (() => true);
  h.deps = {
    self: SELF,
    network: NET,
    channelId: CH,
    stillValid: () => h.valid.v,
    members: [],
    filter: async (wallets, opts): Promise<FilterResultLike> => {
      h.filterCalls.push({ wallets, opts });
      const verified: string[] = [];
      const rejected: { wallet: string; reason: string }[] = [];
      for (const w of wallets) {
        const v = verdicts(w);
        if (v === true) verified.push(w);
        else rejected.push({ wallet: w, reason: v });
      }
      return {
        verified, rejected, creator: opts.pinnedCreator ?? over.creator ?? CREATOR,
        incomplete: rejected.some((r) => r.reason.startsWith('fetch_failed')),
      };
    },
    getEncKeys: async (w) => { h.encKeyCalls.push(w); return keysFor(w); },
    verifyBinding: async () => { h.bindingCalls++; return 'bound'; },
    bindingCache: new BindingVerdictCache(),
    store: new PchanTrustStore(memIo().io),
    yieldToUi: async () => {},
    log: () => {},
    ...over,
  };
  return h;
}

// --- Filtering ------------------------------------------------------------------

test('only verified members (plus self) get enc keys fetched and targeted', async () => {
  const good = addr(1), bad = addr(2);
  const h = harness({ members: [good, bad], verdicts: (w) => (w === good ? true : 'join_invalid:bad_signature') });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.deepEqual(h.encKeyCalls, [SELF, good], 'unverified member enc keys must never be fetched');
  assert.deepEqual(r.targets.map((t) => t.target).sort(), [SELF, good].sort());
  assert.equal(r.rejectedCount, 1);
});

test('self is always covered and never sent to the verifier, even if not listed', async () => {
  const h = harness({ members: [addr(1), SELF], verdicts: () => 'unavailable:no_join' });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.ok(h.filterCalls.every((c) => !c.wallets.includes(SELF)));
  assert.deepEqual(r.targets.map((t) => t.target), [SELF]);
});

test('a filter that throws fails CLOSED (nobody but self covered)', async () => {
  const h = harness({ members: [addr(1)], filter: async () => { throw new Error('boom'); } });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.deepEqual(r.targets.map((t) => t.target), [SELF]);
  assert.equal(r.incomplete, true);
});

test('filter verdicts for wallets outside the asked chunk are ignored', async () => {
  const intruder = addr(99);
  const h = harness({
    members: [addr(1)],
    filter: async () => ({ verified: [addr(1), intruder], rejected: [], creator: CREATOR, incomplete: false }),
  });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.ok(!r.targets.some((t) => t.target === intruder));
});

test('B2: invalid AND unbound enc-key rows are never wrapped to (self included)', async () => {
  const m = addr(1);
  const h = harness({
    members: [m],
    getEncKeys: async (w) => [
      { device_id: `${w}-a`, enc_pub: 'aa'.repeat(32), bound: true, ts: 5 },
      { device_id: `${w}-b`, enc_pub: 'bb'.repeat(32), bound: false },
      { device_id: `${w}-c`, enc_pub: 'cc'.repeat(32), bound: true, ts: 6 },
    ],
    verifyBinding: async (row) => (row.device_id.endsWith('-a') ? 'invalid' : row.bound ? 'bound' : 'unbound'),
  });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.deepEqual(r.targets.map((t) => t.deviceId).sort(), [`${m}-c`, `${SELF}-c`].sort());
});

test('B2: two bound rows for one device are ordered by the SIGNED ts, not node created_at', async () => {
  const h = harness({
    members: [],
    getEncKeys: async () => [
      { device_id: 'dev', enc_pub: '11'.repeat(32), bound: true, ts: 100, created_at: 1 },
      { device_id: 'dev', enc_pub: '22'.repeat(32), bound: true, ts: 50, created_at: 999_999 },
    ],
  });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.equal(r.targets.length, 1);
  assert.equal(r.targets[0]!.encPub, '11'.repeat(32));
});

test('F: newer UNBOUND junk rows cannot push a member\'s bound rows out of the examined window', async () => {
  // Bound rows first, THEN the cap (node cap is 10 per wallet).
  assert.equal(MAX_KEYS_PER_MEMBER, 10);
  const junk: EncKeyRow[] = Array.from({ length: 20 }, (_, i) => (
    { device_id: `junk${i}`, enc_pub: 'bb'.repeat(32), bound: false, created_at: 1000 + i }));
  const real: EncKeyRow = { device_id: 'real', enc_pub: 'cc'.repeat(32), bound: true, ts: 5, created_at: 1, wallet_signature: 's' };
  const picked = selectBoundRows([...junk, real]);
  assert.deepEqual(picked.map((r) => r.device_id), ['real']);
  const h = harness({ members: [], getEncKeys: async () => [...junk, real] });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.equal(h.bindingCalls, 1, 'only the bound row is verified');
  assert.deepEqual(r.targets.map((t) => t.deviceId), ['real']);
});

test('F: selectBoundRows keeps the newest 10 bound rows and drops malformed ones', () => {
  const rows = [
    ...Array.from({ length: 15 }, (_, i) => ({ device_id: `d${i}`, enc_pub: 'aa'.repeat(32), bound: true, created_at: i })),
    { device_id: 7, enc_pub: 'aa', bound: true },
    null,
  ];
  const picked = selectBoundRows(rows);
  assert.equal(picked.length, 10);
  assert.equal(picked[0]!.device_id, 'd14');
  assert.ok(!picked.some((r) => r.device_id === 'd4'));
  assert.deepEqual(selectBoundRows('nope'), []);
});

test('W3: at most MAX_KEYS_PER_MEMBER rows are examined per member', async () => {
  const rows: EncKeyRow[] = Array.from({ length: 40 }, (_, i) => (
    { device_id: `d${i}`, enc_pub: 'aa'.repeat(32), bound: true, ts: i, created_at: i }));
  const h = harness({ members: [], getEncKeys: async () => rows });
  await resolvePrivateTargets(h.deps);
  assert.equal(h.bindingCalls, MAX_KEYS_PER_MEMBER);
});

test('W3: binding verdicts are cached across passes; yields every N fresh verifications', async () => {
  const rows: EncKeyRow[] = Array.from({ length: 8 }, (_, i) => (
    { device_id: `d${i}`, enc_pub: 'aa'.repeat(32), bound: true, ts: i, wallet_signature: `s${i}` }));
  const members = Array.from({ length: 4 }, (_, i) => addr(i + 1));
  let yields = 0;
  const cache = new BindingVerdictCache();
  const h = harness({ members, getEncKeys: async () => rows, bindingCache: cache, yieldToUi: async () => { yields++; } });
  await resolvePrivateTargets(h.deps);
  assert.equal(h.bindingCalls, 40); // 5 wallets x 8 rows
  assert.ok(yields >= 2, 'yields between fresh binding verifications');
  await resolvePrivateTargets(h.deps);
  assert.equal(h.bindingCalls, 40, 'second pass is served from the verdict cache');
  // A changed signature is a different key → verified again.
  rows[0] = { ...rows[0]!, wallet_signature: 'other' };
  await resolvePrivateTargets(h.deps);
  assert.equal(h.bindingCalls, 45);
});

test('W3: binding cache is a bounded LRU', () => {
  const c = new BindingVerdictCache(2);
  c.set('a', 'bound'); c.set('b', 'bound'); c.get('a'); c.set('c', 'invalid');
  assert.equal(c.size, 2);
  assert.equal(c.get('b'), undefined);
  assert.equal(c.get('a'), 'bound');
});

test('large channels are verified in bounded chunks that share one creator', async () => {
  const members = Array.from({ length: VERIFY_CHUNK * 2 + 5 }, (_, i) => addr(i + 1));
  let yields = 0;
  const h = harness({ members, yieldToUi: async () => { yields++; } });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.equal(h.filterCalls.length, 3);
  assert.ok(h.filterCalls.every((c) => c.wallets.length <= VERIFY_CHUNK));
  assert.equal(h.filterCalls[0]!.opts.pinnedCreator, undefined);
  assert.equal(h.filterCalls[1]!.opts.pinnedCreator, CREATOR, 'later chunks are pinned to the first chunk creator');
  assert.equal(h.filterCalls[2]!.opts.pinnedCreator, CREATOR);
  assert.ok(yields >= 2, 'yields to the UI between chunks');
  assert.ok(h.filterCalls.every((c) => c.opts.allowUnderivedCreator === false));
});

// --- W2: early stop + rotation ---------------------------------------------------

test('W2: the pass STOPS at the first fetch failure (no further member-proofs requests)', async () => {
  const members = Array.from({ length: VERIFY_CHUNK * 3 }, (_, i) => addr(i + 1));
  const h = harness({ members, verdicts: () => 'fetch_failed:429' });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.equal(h.filterCalls.length, 1);
  assert.equal(r.stoppedEarly, true);
  assert.equal(r.incomplete, true);
  assert.equal(r.nextOffset, 0, 'nothing processed → offset does not advance');
});

test('W2: an `incomplete` chunk without fetch_failed reasons also stops the pass', async () => {
  const members = Array.from({ length: VERIFY_CHUNK * 2 }, (_, i) => addr(i + 1));
  const h = harness({ members });
  h.deps.filter = async (w) => { h.filterCalls.push({ wallets: w, opts: {} as never }); return { verified: [], rejected: [], incomplete: true }; };
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.equal(h.filterCalls.length, 1);
});

test('W2: uncovered members are verified first; the offset rotates the tail into reach', async () => {
  const members = Array.from({ length: VERIFY_CHUNK * 2 }, (_, i) => addr(i + 1));
  const covered = new Set(members.slice(0, VERIFY_CHUNK));
  const h = harness({ members, covered });
  let calls = 0;
  h.deps.filter = async (w, o) => {
    calls++;
    h.filterCalls.push({ wallets: w, opts: o });
    if (calls > 1) return { verified: [], rejected: w.map((x) => ({ wallet: x, reason: 'fetch_failed:429' })), incomplete: true };
    return { verified: w, rejected: [], creator: CREATOR, incomplete: false };
  };
  const r1 = await resolvePrivateTargets(h.deps);
  assert.ok(r1);
  assert.ok(h.filterCalls[0]!.wallets.every((w) => !covered.has(w)), 'uncovered first');
  assert.equal(r1.nextOffset, VERIFY_CHUNK);

  // A channel where EVERY pass dies after one chunk still reaches its tail.
  const all = Array.from({ length: 250 }, (_, i) => addr(i + 1));
  const seen = new Set<string>();
  let offset = 0;
  for (let pass = 0; pass < 4; pass++) {
    let n = 0;
    const hp = harness({ members: all, startOffset: offset });
    hp.deps.filter = async (w) => {
      n++;
      if (n > 1) return { verified: [], rejected: w.map((x) => ({ wallet: x, reason: 'fetch_failed:429' })), incomplete: true };
      for (const x of w) seen.add(x);
      return { verified: w, rejected: [], creator: CREATOR, incomplete: false };
    };
    const r = await resolvePrivateTargets(hp.deps);
    offset = r!.nextOffset;
  }
  assert.equal(seen.size, 250, 'every member was verified by some pass');
});

test('W2: private cover passes are throttled to 60 s, public stay at 10 s', () => {
  assert.equal(coverThrottleMs(true), COVER_THROTTLE_PRIVATE_MS);
  assert.equal(COVER_THROTTLE_PRIVATE_MS, 60_000);
  assert.equal(coverThrottleMs(false), COVER_THROTTLE_PUBLIC_MS);
  assert.equal(COVER_THROTTLE_PUBLIC_MS, 10_000);
});

test('coveredWallets extracts wallets from target keys', () => {
  assert.deepEqual([...coveredWallets([`${SELF}:dev1`, `${SELF}:dev2`, `${addr(1)}:x`])].sort(), [SELF, addr(1)].sort());
});

// --- Account switch -----------------------------------------------------------------

test('switch DURING verification: returns null, no enc keys, no writes, nothing published', async () => {
  const mem = memIo();
  const gate = deferred<void>();
  const h = harness({ members: [addr(1)], store: new PchanTrustStore(mem.io) });
  const inner = h.deps.filter;
  h.deps.filter = async (w, o) => { await gate.promise; return inner(w, o); };
  const p = resolvePrivateTargets(h.deps);
  await new Promise((r) => setTimeout(r, 0));
  h.valid.v = false; // account switched while the verifier ran
  gate.resolve();
  const r = await p;
  assert.equal(r, null);
  assert.deepEqual(h.encKeyCalls, []);
  assert.deepEqual(mem.writes, [], 'no pin / seen-removal write for the old account');
});

test('account already invalid at entry: nothing is fetched, verified or written', async () => {
  const mem = memIo();
  const h = harness({ members: [addr(1)], store: new PchanTrustStore(mem.io) });
  h.valid.v = false;
  assert.equal(await resolvePrivateTargets(h.deps), null);
  assert.equal(h.filterCalls.length, 0);
  assert.deepEqual(h.encKeyCalls, []);
  assert.deepEqual(mem.writes, []);
  let published = 0;
  assert.equal(await publishToTargets([{ target: SELF, deviceId: 'd', encPub: 'aa', createdAt: 0 }],
    () => false, async () => { published++; }, () => {}), null);
  assert.equal(published, 0);
});

test('switch between enc-key fetches stops before returning targets', async () => {
  const h = harness({ members: [addr(1), addr(2)] });
  const inner = h.deps.getEncKeys;
  h.deps.getEncKeys = async (w) => { const k = await inner(w); if (w === SELF) h.valid.v = false; return k; };
  assert.equal(await resolvePrivateTargets(h.deps), null);
});

test('switch during the LAST getEncKeys that returns [] still aborts', async () => {
  const last = addr(2);
  const h = harness({ members: [addr(1), last] });
  h.deps.getEncKeys = async (w) => {
    h.encKeyCalls.push(w);
    if (w === last) { h.valid.v = false; return []; }
    return keysFor(w);
  };
  assert.equal(await resolvePrivateTargets(h.deps), null);
});

test('switch between chunks aborts the remaining chunks', async () => {
  const members = Array.from({ length: VERIFY_CHUNK + 1 }, (_, i) => addr(i + 1));
  const h = harness({ members });
  h.deps.yieldToUi = async () => { h.valid.v = false; };
  assert.equal(await resolvePrivateTargets(h.deps), null);
  assert.equal(h.filterCalls.length, 1);
});

test('publishToTargets re-checks the account before EVERY publish', async () => {
  const valid = { v: true };
  const published: string[] = [];
  const targets = [1, 2, 3].map((i) => ({ target: addr(i), deviceId: `d${i}`, encPub: 'aa', createdAt: 0 }));
  const n = await publishToTargets(targets, () => valid.v, async (t) => {
    published.push(t.target);
    if (published.length === 1) valid.v = false;
  }, () => {});
  assert.equal(n, null);
  assert.deepEqual(published, [addr(1)]);
});

test('publishToTargets: validity flipping inside onPublished stops the next publish', async () => {
  const valid = { v: true };
  const published: string[] = [];
  const targets = [1, 2].map((i) => ({ target: addr(i), deviceId: `d${i}`, encPub: 'aa', createdAt: 0 }));
  const n = await publishToTargets(targets, () => valid.v, async (t) => { published.push(t.target); },
    () => { valid.v = false; });
  assert.equal(n, null);
  assert.deepEqual(published, [addr(1)]);
});

test('publishToTargets: flipping on the LAST target reports an abort (not success)', async () => {
  const valid = { v: true };
  const targets = [1, 2].map((i) => ({ target: addr(i), deviceId: `d${i}`, encPub: 'aa', createdAt: 0 }));
  const done: string[] = [];
  const n = await publishToTargets(targets, () => valid.v, async (t) => { if (t.target === addr(2)) valid.v = false; },
    (t) => { done.push(t.target); });
  assert.equal(n, null);
  assert.deepEqual(done, [addr(1)], 'the last target is not recorded as covered');
});

test('W4: a switch during a 429 retry sleep publishes nothing on the retry', async () => {
  const valid = { v: true };
  let attempts = 0;
  let sent = 0;
  const p = withRetry(guarded(() => valid.v, async () => {
    attempts++;
    if (attempts === 1) {
      setTimeout(() => { valid.v = false; }, 50); // switch lands during the backoff sleep
      throw new Error('HTTP 429 Too Many Requests');
    }
    sent++;
  }), 'publish channel key');
  await assert.rejects(p, AccountChangedError);
  assert.equal(sent, 0);
  // Through publishToTargets: aborted, nothing recorded.
  const v2 = { v: true };
  let tries = 0;
  const n = await publishToTargets([{ target: addr(1), deviceId: 'd', encPub: 'aa', createdAt: 0 }], () => v2.v,
    (t) => withRetry(guarded(() => v2.v, async () => {
      tries++;
      if (tries === 1) { setTimeout(() => { v2.v = false; }, 50); throw new Error('429'); }
      void t;
    }), 'publish'), () => { throw new Error('must not be recorded'); });
  assert.equal(n, null);
  assert.equal(tries, 1);
});

test('a store reset (switch) during the run orphans its state: nothing persisted', async () => {
  const mem = memIo();
  const store = new PchanTrustStore(mem.io);
  const h = harness({ members: [addr(1)], store });
  const inner = h.deps.filter;
  h.deps.filter = async (w, o) => { store.reset(); return inner(w, o); };
  assert.equal(await resolvePrivateTargets(h.deps), null);
  assert.deepEqual(mem.writes, []);
});

// --- Persistence -------------------------------------------------------------------

test('creator is pinned when no pin was passed, and passed as the pin next time', async () => {
  const mem = memIo();
  const store = new PchanTrustStore(mem.io);
  const h1 = harness({ members: [addr(1)], store });
  await resolvePrivateTargets(h1.deps);
  const pins = JSON.parse(mem.data.get(`${PIN_STORE_BASE}::${SELF}`)!);
  assert.equal(pins[channelTrustKey(NET, CH)], CREATOR);

  const store2 = new PchanTrustStore(mem.io); // fresh process: reloaded from disk
  const h2 = harness({ members: [addr(1)], store: store2, creator: addr('other') });
  await resolvePrivateTargets(h2.deps);
  assert.equal(h2.filterCalls[0]!.opts.pinnedCreator, CREATOR);
});

test('an existing pin is never overwritten', () => {
  const s = new PchanTrustState();
  assert.equal(s.pinIfAbsent('k', CREATOR), 'pinned');
  assert.equal(s.pinIfAbsent('k', addr('evil')), 'exists');
  assert.equal(s.pin('k'), CREATOR);
});

test('N2: a concurrent pass that pinned a DIFFERENT creator discards this pass', async () => {
  const store = new PchanTrustStore(memIo().io);
  const h = harness({ members: [addr(1)], store });
  const inner = h.deps.filter;
  h.deps.filter = async (w, o) => {
    (await store.load(SELF)).pinIfAbsent(channelTrustKey(NET, CH), addr('concurrent'));
    return inner(w, o);
  };
  assert.equal(await resolvePrivateTargets(h.deps), null);
});

test('N7: refusals by the caps are logged', async () => {
  const logs: string[] = [];
  const st = new PchanTrustState();
  for (let i = 0; i < 4096; i++) st.pins.set(`x:${i}`, CREATOR);
  const store = new PchanTrustStore(memIo().io);
  const h = harness({ members: [addr(1)], store, log: (s) => { logs.push(s); } });
  const real = await store.load(SELF);
  for (const [k, v] of st.pins) real.pins.set(k, v);
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r, 'a pin refused by the cap does not fail the pass');
  assert.ok(logs.some((l) => l.includes('pin refused')));
});

test('pins and seen removals are per WALLET namespace', async () => {
  const mem = memIo();
  const store = new PchanTrustStore(mem.io);
  const h = harness({ members: [addr(1)], store });
  await resolvePrivateTargets(h.deps);
  const st = await store.load(addr('other-wallet'));
  assert.equal(st.pin(channelTrustKey(NET, CH)), undefined);
});

test('seen removals: verifier gets a copy incl. persisted entries; merge is union/max', async () => {
  const victim = addr(7);
  const key = channelTrustKey(NET, CH);
  const mem = memIo({ [`${SEEN_STORE_BASE}::${SELF}`]: JSON.stringify({ [key]: { [victim]: 500 } }) });
  const store = new PchanTrustStore(mem.io);
  const later = addr(8);
  const h = harness({ members: [addr(1)], store });
  const inner = h.deps.filter;
  h.deps.filter = async (w, o) => {
    assert.equal(o.seenRemovals.get(victim), 500);
    o.seenRemovals.set(victim, 400); // a LOWER value must not regress the stored max
    o.seenRemovals.set(later, 900);
    return inner(w, o);
  };
  await resolvePrivateTargets(h.deps);
  // F: migrated into ONE ROW PER CHANNEL + index; the old blob is removed.
  const row = JSON.parse(mem.data.get(`${seenChannelBase(key)}::${SELF}`)!);
  assert.deepEqual(row, { [victim]: 500, [later]: 900 });
  assert.deepEqual(JSON.parse(mem.data.get(`${SEEN_INDEX_BASE}::${SELF}`)!), { [key]: 2 });
  assert.equal(mem.data.has(`${SEEN_STORE_BASE}::${SELF}`), false);
});

test('F: per-channel seen rows — only the touched channel is read and written', async () => {
  const key = channelTrustKey(NET, CH);
  const other = channelTrustKey(NET, CH + 1);
  const mem = memIo({
    [`${seenChannelBase(key)}::${SELF}`]: JSON.stringify({ [addr(7)]: 500 }),
    [`${seenChannelBase(other)}::${SELF}`]: JSON.stringify({ [addr(9)]: 100 }),
    [`${SEEN_INDEX_BASE}::${SELF}`]: JSON.stringify({ [key]: 1, [other]: 1 }),
  });
  const reads: string[] = [];
  const store = new PchanTrustStore({ ...mem.io, read: async (w, b) => { reads.push(b); return mem.io.read(w, b); } });
  const h = harness({ members: [addr(1)], store });
  const inner = h.deps.filter;
  h.deps.filter = async (w, o) => {
    assert.equal(o.seenRemovals.get(addr(7)), 500, 'persisted row reaches the verifier');
    o.seenRemovals.set(addr(8), 900);
    return inner(w, o);
  };
  await resolvePrivateTargets(h.deps);
  assert.ok(!reads.includes(seenChannelBase(other)), 'other channels are not read');
  assert.ok(!mem.writes.includes(`${seenChannelBase(other)}::${SELF}`), 'other channels are not rewritten');
  assert.deepEqual(JSON.parse(mem.data.get(`${seenChannelBase(key)}::${SELF}`)!), { [addr(7)]: 500, [addr(8)]: 900 });
  assert.deepEqual(JSON.parse(mem.data.get(`${SEEN_INDEX_BASE}::${SELF}`)!), { [key]: 2, [other]: 1 });
});

test('F: a row missing from the index (crash between writes) is still read, never overwritten by a subset', async () => {
  const key = channelTrustKey(NET, CH);
  const mem = memIo({ [`${seenChannelBase(key)}::${SELF}`]: JSON.stringify({ [addr(7)]: 500 }) });
  const h = harness({ members: [addr(1)], store: new PchanTrustStore(mem.io) });
  const inner = h.deps.filter;
  h.deps.filter = async (w, o) => { o.seenRemovals.set(addr(8), 900); return inner(w, o); };
  await resolvePrivateTargets(h.deps);
  assert.deepEqual(JSON.parse(mem.data.get(`${seenChannelBase(key)}::${SELF}`)!), { [addr(7)]: 500, [addr(8)]: 900 });
});

test('F: a seen-row READ error skips the pass and writes nothing', async () => {
  const key = channelTrustKey(NET, CH);
  const mem = memIo();
  const store = new PchanTrustStore({
    ...mem.io,
    read: async (w, b) => { if (b === seenChannelBase(key)) throw new Error('io'); return mem.io.read(w, b); },
  });
  const h = harness({ members: [addr(1)], store });
  await assert.rejects(resolvePrivateTargets(h.deps), CoverSkippedError);
  assert.equal(h.filterCalls.length, 0);
  assert.equal(mem.writes.length, 0);
});

test('F: the wallet-wide seen cap keeps each channel\'s NEWEST entries', () => {
  const s = new PchanTrustState();
  const perCh = MAX_SEEN_PER_CHANNEL;
  const full = Math.floor(MAX_SEEN_TOTAL / perCh); // channels that exactly fill the cap
  assert.ok(full < MAX_SEEN_CHANNELS);
  for (let c = 0; c < full; c++) {
    const m = new Map<string, number>();
    for (let i = 0; i < perCh; i++) m.set(addr(`${c}x${i}`), i);
    s.mergeSeen(`k${c}`, m);
  }
  const fresh = new Map<string, number>([[addr('n1'), 1]]);
  const out = s.mergeSeen('knew', fresh);
  assert.equal(out.changed, false);
  assert.equal(out.channelRefused, true, 'a new channel past the wallet-wide cap is refused');
  // An existing channel still accepts newer removals by evicting its own oldest.
  const s2 = new PchanTrustState();
  s2.mergeSeen('a', new Map([[addr(1), 1], [addr(2), 2]]));
  const r2 = s2.mergeSeen('a', new Map([[addr(3), 3]]));
  assert.equal(r2.changed, true);
  assert.equal(s2.seen.get('a')!.size, 3);
});

test('a storage READ error skips the pass (CoverSkippedError) and never overwrites stored pins', async () => {
  const mem = memIo({ [`${PIN_STORE_BASE}::${SELF}`]: JSON.stringify({ [channelTrustKey(NET, 1)]: CREATOR }) });
  let fail = true;
  const store = new PchanTrustStore({
    read: async (w, b) => { if (fail) throw new Error('io'); return mem.io.read(w, b); },
    write: mem.io.write,
  });
  const h = harness({ members: [addr(1)], store });
  await assert.rejects(resolvePrivateTargets(h.deps), CoverSkippedError);
  assert.deepEqual(mem.writes, []);
  fail = false; // a failed load is not memoized: the next pass reads the real state
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  const pins = JSON.parse(mem.data.get(`${PIN_STORE_BASE}::${SELF}`)!);
  assert.equal(pins[channelTrustKey(NET, 1)], CREATOR, 'the pre-existing pin survived');
  assert.equal(pins[channelTrustKey(NET, CH)], CREATOR);
});

test('N1: a load waits for queued writes before reading', async () => {
  const gate = deferred<void>();
  const data = new Map<string, string>();
  const store = new PchanTrustStore({
    read: async (w, b) => data.get(`${b}::${w}`) ?? null,
    write: async (w, b, v) => { await gate.promise; data.set(`${b}::${w}`, v); },
  });
  const st = new PchanTrustState();
  st.pinIfAbsent('k', CREATOR);
  void store.persist(SELF, st);
  const loading = store.load(SELF);
  gate.resolve();
  assert.equal((await loading).pin('k'), CREATOR);
});

test('corrupt persisted JSON is tolerated (dropped), malformed entries filtered', () => {
  const s = PchanTrustState.fromJson('{not json', JSON.stringify({ k: { [addr(1)]: 5, bogus: 7, [addr(2)]: -1 } }));
  assert.equal(s.pins.size, 0);
  assert.deepEqual([...s.seen.get('k')!], [[addr(1), 5]]);
});

test('seen removals per channel are capped to the newest timestamps', () => {
  const s = new PchanTrustState();
  const m = new Map<string, number>();
  for (let i = 0; i < MAX_SEEN_PER_CHANNEL + 10; i++) m.set(addr(i), i);
  const out = s.mergeSeen('k', m);
  assert.equal(out.dropped, 10);
  const kept = s.seen.get('k')!;
  assert.equal(kept.size, MAX_SEEN_PER_CHANNEL);
  assert.ok(!kept.has(addr(0)));
  assert.ok(kept.has(addr(MAX_SEEN_PER_CHANNEL + 9)));
});

test('a load finishing after reset() is not current for the next account generation', async () => {
  const gate = deferred<void>();
  const mem = memIo();
  const store = new PchanTrustStore({ read: async (w, b) => { await gate.promise; return mem.io.read(w, b); }, write: mem.io.write });
  const p = store.load(SELF);
  store.reset();
  gate.resolve();
  const st = await p;
  assert.equal(await store.isCurrent(SELF, st), false);
});

// --- Cover mode (W1 / B1) ------------------------------------------------------------

const PUB = 77; // a valid public id (< floor)

test('W1: an unknown network skips cover entirely, private or public', async () => {
  const load = async () => new PchanTrustState();
  await assert.rejects(decideCoverMode(false, 'x', PUB, load), CoverSkippedError);
  await assert.rejects(decideCoverMode(true, 'x', CH, load), CoverSkippedError);
  await assert.rejects(decideCoverMode(false, null, PUB, load), CoverSkippedError);
  await assert.rejects(resolvePrivateTargets(harness({ network: 'x' }).deps), CoverSkippedError);
});

test('W1: a pin under EITHER network forces verification, whatever network the node reports now', async () => {
  const s = new PchanTrustState();
  s.pinIfAbsent(channelTrustKey('mainnet', PUB), CREATOR);
  assert.equal(await decideCoverMode(false, 'testnet', PUB, async () => s), 'private');
  assert.equal(await decideCoverMode(false, 'testnet', PUB + 1, async () => s), 'public');
});

test('W1: a trust-state load error skips the pass instead of treating the channel as public', async () => {
  await assert.rejects(decideCoverMode(false, 'testnet', PUB, async () => { throw new Error('io'); }), CoverSkippedError);
});

test('B1: an id in the private namespace is always verified, even if the node calls it public', async () => {
  const load = async () => new PchanTrustState();
  assert.equal(await decideCoverMode(false, 'testnet', PRIVATE_CHANNEL_ID_FLOOR, load), 'private');
  assert.equal(await decideCoverMode(false, 'testnet', CH, load), 'private');
  assert.equal(await decideCoverMode(false, 'testnet', PUB, load), 'public');
  assert.equal(await decideCoverMode(true, 'testnet', PUB, load), 'private');
  assert.equal(isPrivateRangeId(PRIVATE_CHANNEL_ID_FLOOR - 1), false);
  assert.equal(isPrivateRangeId(PRIVATE_CHANNEL_ID_FLOOR), true);
  assert.equal(isPrivateRangeId(0), true, 'not a valid public id → fail closed');
  assert.equal(isPrivateRangeId(1.5), true);
  assert.equal(PRIVATE_CHANNEL_ID_FLOOR, INVITE_FLOOR, 'mirrors privateInvite.ts');
});

test('coverType: null while the channel record is unresolved', () => {
  assert.equal(resolveCoverType(false, false), null);
  assert.equal(resolveCoverType(false, true), null);
  assert.equal(resolveCoverType(true, true), true);
  assert.equal(resolveCoverType(true, false), false);
});

// --- Backoff -------------------------------------------------------------------------

test('budget exhaustion backs the channel off (60 s doubling to 10 min), clean pass resets', () => {
  const b = new CoverBackoff();
  b.record(1, true, 0);
  assert.equal(b.blocked(1, BUDGET_BACKOFF_MIN_MS - 1), true);
  assert.equal(b.blocked(1, BUDGET_BACKOFF_MIN_MS), false);
  for (let i = 0; i < 10; i++) b.record(1, true, 0);
  assert.equal(b.blocked(1, BUDGET_BACKOFF_MAX_MS - 1), true);
  assert.equal(b.blocked(1, BUDGET_BACKOFF_MAX_MS), false);
  b.record(1, false, 0);
  assert.equal(b.blocked(1, 1), false);
  assert.equal(b.blocked(2, 0), false);
});

test('budget exhaustion is reported by resolvePrivateTargets', async () => {
  const h = harness({ members: [addr(1)], verdicts: () => 'verification_budget_exhausted' });
  const r = await resolvePrivateTargets(h.deps);
  assert.ok(r);
  assert.equal(r.budgetExhausted, true);
});

// --- Seen-removals migration safety (round-2 audit: M18 / M19 / M21) ------------------------------

test('M18: a failing row write keeps the old blob (it is the only other copy)', async () => {
  const key = channelTrustKey(NET, CH);
  const mem = memIo({ [`${SEEN_STORE_BASE}::${SELF}`]: JSON.stringify({ [key]: { [addr(7)]: 500 } }) });
  const store = new PchanTrustStore({
    ...mem.io,
    write: async (w, b, v) => { if (b === seenChannelBase(key)) throw new Error('disk full'); return mem.io.write(w, b, v); },
  });
  const state = await store.load(SELF);
  await store.persist(SELF, state);
  assert.equal(mem.data.has(`${SEEN_STORE_BASE}::${SELF}`), true, 'legacy blob not removed');
  assert.ok(state.dirtySeen.has(key), 'row stays dirty for the next pass');
  assert.equal(state.legacySeenPending, true);
});

test('M19: migration never overwrites a FULLER per-channel row', async () => {
  const key = channelTrustKey(NET, CH);
  const mem = memIo({
    [`${SEEN_STORE_BASE}::${SELF}`]: JSON.stringify({ [key]: { [addr(7)]: 100 } }),
    [`${seenChannelBase(key)}::${SELF}`]: JSON.stringify({ [addr(7)]: 900, [addr(8)]: 800 }),
  });
  const store = new PchanTrustStore(mem.io);
  const state = await store.load(SELF);
  await store.persist(SELF, state);
  assert.deepEqual(JSON.parse(mem.data.get(`${seenChannelBase(key)}::${SELF}`)!), { [addr(7)]: 900, [addr(8)]: 800 });
  assert.equal(mem.data.has(`${SEEN_STORE_BASE}::${SELF}`), false);
});

test('M21: a row that was never read from disk is never written (it would replace the disk row with a subset)', async () => {
  const key = channelTrustKey(NET, CH);
  const mem = memIo({ [`${seenChannelBase(key)}::${SELF}`]: JSON.stringify({ [addr(7)]: 900 }) });
  const store = new PchanTrustStore(mem.io);
  const state = await store.load(SELF);
  state.mergeSeen(key, new Map([[addr(8), 50]])); // merged WITHOUT ensureSeen
  await store.persist(SELF, state);
  assert.deepEqual(JSON.parse(mem.data.get(`${seenChannelBase(key)}::${SELF}`)!), { [addr(7)]: 900 }, 'disk row untouched');
  assert.ok(state.dirtySeen.has(key), 'kept dirty until read');
  await store.ensureSeen(SELF, state, key);
  await store.persist(SELF, state);
  assert.deepEqual(JSON.parse(mem.data.get(`${seenChannelBase(key)}::${SELF}`)!), { [addr(7)]: 900, [addr(8)]: 50 });
});
