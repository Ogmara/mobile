/**
 * Adoption tests (mobile 0.58.0, sdk-js 0.68.0 FINAL keyring API): the channel
 * key store is the SHARED SDK `ChannelKeyring` behind channelKeyCore's
 * `ChannelKeyStore` adapter. The keyring's own rules are pinned by the SDK's
 * tests; these pin this app's WIRING against the real keyring and the real
 * `sealKeyVault` / `openKeyVault`: provenance mapping (`ownSlot`, `maxEpoch`,
 * `final` only from the node flag), restart re-verify, N1 bound, old-format
 * vault import, alternates + conflict, "pair lost" client state, two-step
 * export (commit only after a successful publish), pre-seal re-open + import,
 * vault_too_large surfaced as "paused", the prune ladder, and the all-clients
 * legacy decision (no legacy / unverified send fallback in this app's code).
 * Run: node --test src/lib/channelKeyStore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ChannelKeyringError,
  computeChannelScope,
  computeKeyCommitment,
  openKeyVault,
  sealKeyVault,
  type KeyVaultSyncData,
  type VaultKeyring,
} from '@ogmara/sdk';
import {
  ChannelKeyStore, legacyEnvelopeEpoch, boundedEvidence, resumePlanOpts, planBest, SEND_EPOCH_MARGIN, PRUNE_LEVELS,
  legacyMoveTarget, earlyUseAlone, ownSlotWrapOpts, MissFetchLimiter, MISS_FETCHES_PER_MIN, MAX_MISS_ENTRIES,
} from './channelKeyCore.ts';
import { createVaultController, KeyringReadError, type CapturedAccount } from './keyVaultCore.ts';

const scope = computeChannelScope(4_294_967_301);
const S = Array.from(scope, (b) => b.toString(16).padStart(2, '0')).join('');
const scope2 = computeChannelScope(4_294_967_302);
const S2 = Array.from(scope2, (b) => b.toString(16).padStart(2, '0')).join('');
const K = (n: number) => new Uint8Array(32).fill(n % 256);
const KX = (n: number) => { const k = new Uint8Array(32); new DataView(k.buffer).setUint32(0, n); k[31] = 0xa5; return k; };
const pairOf = (epoch: number, key: Uint8Array, keyTs = 1_000 + epoch, sc = scope) =>
  ({ keyTs, commitment: computeKeyCommitment(sc, epoch, keyTs, key) });
const vals = (rec: Record<string, Uint8Array>) => Object.values(rec).map((v) => v[0]).sort((a, b) => a! - b!);
const OWN = (nodeHighest = 1000) => ({ ownSlot: true, nodeHighest });
const MEMBER = (nodeHighest = 1000) => ({ ownSlot: false, nodeHighest });

function store(opts: ConstructorParameters<typeof ChannelKeyStore>[1] = {}) {
  let gen = 1;
  const s = new ChannelKeyStore(() => gen, opts);
  return { s, gen: () => gen, bump: () => { gen++; } };
}
/** prepare + commit at once (what a successful publish does). */
const exportNow = (s: ChannelKeyStore, gen = 1) => {
  const p = s.prepareExport(gen);
  s.commitExport(p.commitToken, gen);
  return p.chan;
};

test('provenance: an establish result (final) is CONFIRMED and the send key; a legacy key is neither', () => {
  const { s } = store();
  assert.equal(s.putEstablished(S, 3, K(1), pairOf(3, K(1)), true, 1), 'stored');
  assert.equal(s.isConfirmed(S, 3, K(1)), true);
  assert.equal(s.sendKey(S, 3)?.epoch, 3);
  assert.equal(s.putLegacy(S, 4, K(2), 1, 4), 'stored');
  assert.equal(s.isTrusted(S, 4, K(2)), false, 'legacy is never evidence');
  assert.equal(s.sendKey(S, 4)?.epoch, 3, 'legacy never the send key');
  assert.equal(s.latestBounded(S, 4)?.epoch, 4, 'but it is held (decrypt)');
});

test('provisional (not-final establish / early key): held, not trusted, not exported until finalised', () => {
  const { s } = store();
  s.putEstablished(S, 1, K(5), pairOf(1, K(5)), false, 1);
  assert.equal(s.isProvisional(S, 1, K(5)), true);
  assert.equal(s.isTrusted(S, 1, K(5)), false);
  assert.equal(s.sendKey(S, 1), null, 'rotations wait for FINAL');
  assert.deepEqual(Object.keys(exportNow(s)), [], 'not exported while provisional');
  assert.equal(s.notePairMatch(S, 1, K(5), pairOf(1, K(5)), false, 1), 'untrusted', 'winner, not final yet: still provisional');
  assert.equal(s.sendKey(S, 1), null);
  assert.equal(s.notePairMatch(S, 1, K(5), pairOf(1, K(5)), true, 1), 'trusted', 'node reports it final');
  assert.equal(s.isConfirmed(S, 1, K(5)), true);
  assert.ok(vals(exportNow(s)).includes(5), 'exported once final');
});

test('final ONLY from the node flag: a wrap put without final is trusted but never the send key', () => {
  const { s } = store();
  s.putWrap(S, 2, K(2), pairOf(2, K(2)), 1, OWN());
  assert.equal(s.isTrusted(S, 2, K(2)), true);
  assert.equal(s.isConfirmed(S, 2, K(2)), false);
  assert.equal(s.sendKey(S, 2), null);
  s.putWrap(S, 2, K(2), pairOf(2, K(2)), 1, { ...OWN(), final: true });
  assert.equal(s.sendKey(S, 2)?.epoch, 2);
});

test('restart: every key comes back as `vault` — not trusted, no send key, rotation base 0, until the own wrap re-verifies', () => {
  const a = store();
  a.s.putEstablished(S, 7, K(7), pairOf(7, K(7)), true, 1);
  const rec = exportNow(a.s);
  const b = store();
  b.s.importVault(rec, 1);
  assert.deepEqual(b.s.keysAt(S, 7).map((k) => k[0]), [7], 'decrypts');
  assert.equal(b.s.sendKey(S, 7), null);
  assert.equal(b.s.latestTrusted(S, 7), null);
  assert.equal(b.s.notePairMatch(S, 7, K(7), pairOf(7, K(7)), true, 1), 'needs_author_proof');
  assert.equal(b.s.sendKey(S, 7), null);
  // reverifyOwnWrap → fetchChannelKey re-puts the SAME bytes as our own-slot `wrap` …
  assert.equal(b.s.putWrap(S, 7, K(7), pairOf(7, K(7)), 1, OWN(7)), 'stored');
  assert.equal(b.s.info(S, 7, K(7))?.own, true, 'ownSlot: ours');
  // … and the node's final pair is recorded again.
  assert.equal(b.s.notePairMatch(S, 7, K(7), pairOf(7, K(7)), true, 1), 'trusted');
  assert.equal(b.s.sendKey(S, 7)?.epoch, 7);
  assert.equal(b.s.latestTrusted(S, 7)?.epoch, 7);
});

test('NEGATIVE CONTROL: another member\'s wrap without ownSlot is refused at a full member cap; ownSlot and held bytes are not', () => {
  const { s } = store({ maxMemberEpochsPerScope: 2 });
  assert.equal(s.putWrap(S, 1, KX(1), pairOf(1, KX(1)), 1, MEMBER()), 'stored');
  assert.equal(s.putWrap(S, 2, KX(2), pairOf(2, KX(2)), 1, MEMBER()), 'stored');
  assert.equal(s.putWrap(S, 3, KX(3), pairOf(3, KX(3)), 1, MEMBER()), 'refused', 'member cap reached');
  assert.equal(s.putWrap(S, 3, KX(3), pairOf(3, KX(3)), 1, OWN()), 'stored', 'our own slot wrap authored by us: never member-capped');
  assert.equal(s.putWrap(S, 2, KX(2), pairOf(2, KX(2)), 1, MEMBER()), 'stored', 're-put of held bytes is never capped');
});

test('NEGATIVE CONTROL: node-served / member flood above nodeHighest + 256 is refused (own keys are not)', () => {
  const { s } = store();
  const nodeHighest = 3;
  const over = nodeHighest + SEND_EPOCH_MARGIN + 1;
  assert.equal(s.putLegacy(S, over, KX(over), 1, nodeHighest), 'refused');
  assert.equal(s.putWrap(S, over, KX(over), pairOf(over, KX(over)), 1, MEMBER(nodeHighest)), 'refused');
  assert.equal(s.putLegacy(S, over - 1, KX(over - 1), 1, nodeHighest), 'stored', 'at the bound');
  assert.equal(s.putWrap(S, over + 5, KX(9), pairOf(over + 5, KX(9)), 1, OWN(nodeHighest)), 'stored', 'own: no ceiling');
  assert.equal(s.holds(S, over), false);
});

test('N1: a hostile legacy key at epoch 100000 + restart never becomes evidence, send, cover or rotation-base key', () => {
  const a = store();
  a.s.putEstablished(S, 3, K(3), pairOf(3, K(3)), true, 1);
  assert.equal(a.s.putLegacy(S, 100000, K(9), 1, 3), 'refused', 'above the ceiling: not even held now');
  a.s.putLegacy(S, 200, K(9), 1, 3); // within the bound: held, never trusted
  const nodeHighest = 3;
  assert.equal(a.s.sendKey(S, nodeHighest)?.epoch, 3);
  assert.equal(a.s.isTrusted(S, 200, K(9)), false);
  const b = store();
  b.s.importVault(exportNow(a.s), 1);
  b.s.putWrap(S, 3, K(3), pairOf(3, K(3)), 1, OWN(nodeHighest));
  b.s.notePairMatch(S, 3, K(3), pairOf(3, K(3)), true, 1);
  assert.equal(b.s.latestTrusted(S, nodeHighest)?.epoch, 3);
  assert.equal(b.s.sendKey(S, nodeHighest)?.epoch, 3);
  const hostilePair = { keyTs: 1, commitment: computeKeyCommitment(scope, 200, 1, K(9)) };
  assert.notEqual(b.s.notePairMatch(S, 200, K(9), hostilePair, true, 1), 'trusted', 'a node-matched pair is not author proof');
  assert.equal(boundedEvidence(100000, 3, nodeHighest), 3);
  assert.equal(boundedEvidence(nodeHighest + SEND_EPOCH_MARGIN, 3, nodeHighest), nodeHighest + SEND_EPOCH_MARGIN);
});

test('legacy envelope epoch binding: requested epoch must match; for "latest" the node label must agree with the envelope', () => {
  assert.equal(legacyEnvelopeEpoch(5, 5, 5), 5);
  assert.equal(legacyEnvelopeEpoch(5, 6, 5), null, 'envelope for another epoch');
  assert.equal(legacyEnvelopeEpoch(undefined, 6, 6), 6);
  assert.equal(legacyEnvelopeEpoch(undefined, 6, undefined), 6);
  assert.equal(legacyEnvelopeEpoch(undefined, 6, 100000), null, 'node label disagrees');
  assert.equal(legacyEnvelopeEpoch(undefined, -1, undefined), null);
  assert.equal(legacyEnvelopeEpoch(undefined, '6', undefined), null);
});

test('LEGACY decision (all clients): a legacy epoch is never sent under — whoever may establish moves (gated), others wait', () => {
  const base = { bestEpoch: 4, eFloor: 0, rotateAllowed: false, usable: false, pair: 'legacy' as const, authorVerified: false, fallbackEpoch: null };
  assert.deepEqual(planBest({ ...base, mayMove: true }), { do: 'move' });
  assert.deepEqual(planBest({ ...base, mayMove: false }), { do: 'waiting' });
  assert.deepEqual(planBest({ ...base, eFloor: 9, rotateAllowed: true, mayMove: true }), { do: 'rotate', epoch: 9 });
  // The move target is never best + 1: above the trusted base, the node's highest and the authenticated highest.
  assert.equal(legacyMoveTarget(3, 10, 7), 11);
  assert.equal(legacyMoveTarget(12, 10, 7), 13);
  assert.equal(legacyMoveTarget(0, 4, 20), 21);
  // Wiring: this app's code never calls the legacy / unverified send fallbacks.
  const strip = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const f of ['channelCrypto.ts', 'channelKeyCore.ts']) {
    const src = strip(readFileSync(new URL(`./${f}`, import.meta.url), 'utf8'));
    assert.ok(!/bestForSendLegacy/.test(src), `${f}: bestForSendLegacy absent`);
    assert.ok(!/allowUnverified/.test(src), `${f}: allowUnverified absent`);
    assert.ok(!/legacySendable/.test(src), `${f}: legacySendable workaround removed`);
  }
});

test('verified over legacy: a verified wrap of a different key promotes itself; both decrypt; reported as mismatch', () => {
  const { s } = store();
  assert.equal(s.putLegacy(S, 5, K(1), 1, 5), 'stored');
  assert.equal(s.putWrap(S, 5, K(2), pairOf(5, K(2)), 1, OWN(5)), 'mismatch');
  assert.deepEqual(s.keysAt(S, 5).map((k) => k[0]), [2, 1], 'verified primary, legacy kept as alternate');
  assert.equal(s.isTrusted(S, 5, K(2)), true);
  assert.equal(s.isTrusted(S, 5, K(1)), false);
  assert.equal(s.putLegacy(S, 5, K(3), 1, 5), 'refused', 'commitment-less duplicate (no fallback)');
  assert.equal(s.keysAt(S, 5).length, 2);
});

test('alternates + conflict: a second trusted key never replaces a confirmed one; "pair lost" is client state', () => {
  const { s } = store();
  s.putEstablished(S, 2, K(1), pairOf(2, K(1)), true, 1);
  assert.equal(s.putWrap(S, 2, K(2), pairOf(2, K(2), 5), 1, MEMBER()), 'mismatch', 'kept as alternate (gated heal)');
  assert.deepEqual(s.keysAt(S, 2).map((k) => k[0]), [1, 2]);
  assert.equal(s.sendKey(S, 2)?.key[0], 1);
  s.markLost(S, 2, K(1));
  assert.equal(s.isConfirmed(S, 2, K(1)), false);
  assert.equal(s.anyConfirmed(S, 2), false);
  assert.equal(s.sendKey(S, 2), null, 'not sent under until re-checked');
  assert.equal(s.notePairMatch(S, 2, K(1), pairOf(2, K(1)), true, 1), 'trusted');
  assert.equal(s.isConfirmed(S, 2, K(1)), true);
  const k = s.keysAt(S, 2)[0]!;
  k.fill(0);
  assert.equal(s.keysAt(S, 2)[0]![0], 1, 'copies: byte comparison, not references');
});

test('account generation: a put / import / export / prune for a previous account is dropped', () => {
  const st = store();
  st.bump();
  assert.equal(st.s.putWrap(S, 1, K(1), pairOf(1, K(1)), 1, OWN()), 'dropped');
  assert.equal(st.s.importVault({ [`${S}:1`]: K(1) }, 1), 0);
  assert.throws(() => st.s.prepareExport(1), (e: unknown) => e instanceof ChannelKeyringError && e.code === 'stale');
  assert.equal(st.s.nextPrunePlan(1), null);
  assert.equal(st.s.holds(S, 1), false);
});

test('OLD-format mobile vault (S:E, #alt1..4, ~n, unknown names) imports and re-exports without losing a value', () => {
  const old: Record<string, Uint8Array> = {
    [`${S}:3`]: K(31), [`${S}:3#alt1`]: K(32), [`${S}:3#alt2`]: K(33), [`${S}:4~1`]: K(41),
    'zzz-unknown': K(90), [`${S}:6#future-alias`]: K(66), [`${S}:5#alt7`]: K(57), 'abc:1': K(11),
  };
  const { s } = store();
  s.importVault(old, 1);
  const out = exportNow(s);
  for (const v of Object.values(old)) assert.ok(Object.values(out).some((x) => x[0] === v[0]), `value ${v[0]} kept`);
  assert.deepEqual([...out['zzz-unknown']!], [...K(90)], 'unknown names verbatim');
  const t = store();
  t.s.importVault(out, 1);
  assert.deepEqual(vals(exportNow(t.s)), vals(out));
});

test('cached-before-restore key survives the next backup (real seal / open), and so does the vault\'s different key', () => {
  const bk = K(200);
  const remote = store();
  remote.s.putEstablished(S, 3, K(7), pairOf(3, K(7)), true, 1);
  remote.s.putEstablished(S, 2, K(8), pairOf(2, K(8)), true, 1);
  const sealed = sealKeyVault(bk, { conv: {}, chan: exportNow(remote.s) });
  const { s } = store();
  s.putEstablished(S, 3, K(1), pairOf(3, K(1), 9), true, 1);
  s.importVault(openKeyVault(bk, sealed).chan, 1);
  const next = openKeyVault(bk, sealKeyVault(bk, { conv: {}, chan: exportNow(s) })).chan;
  const v = vals(next);
  assert.ok(v.includes(1) && v.includes(7) && v.includes(8), 'union: nothing dropped');
});

test('vault_too_large is surfaced as a refused export (never a silent shrink)', () => {
  const { s } = store({ maxVaultBytes: 200 });
  for (let e = 1; e <= 6; e++) s.putEstablished(S, e, K(e), pairOf(e, K(e)), true, 1);
  assert.throws(() => s.prepareExport(1), (e: unknown) => e instanceof ChannelKeyringError && e.code === 'vault_too_large');
});

// --- prune ladder -----------------------------------------------------------------------------

test('prune ladder: dry runs change nothing; levels go least-risky first; own keys and the newest 16 epochs stay', () => {
  assert.deepEqual([...PRUNE_LEVELS], ['nodeServed', 'memberWraps', 'restoredAlternates', 'restoredPrimaries']);
  const { s } = store();
  s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  // Restored backup: primaries + alternates at old epochs.
  const rec: Record<string, Uint8Array> = {};
  for (let e = 2; e <= 30; e++) { rec[`${S}:${e}`] = KX(e); rec[`${S}:${e}#alt5`] = KX(1000 + e); }
  s.importVault(rec, 1);
  // Node-served keys (no author vouched) at further epochs.
  for (let e = 31; e <= 60; e++) s.putLegacy(S, e, KX(5000 + e), 1, 60);
  const before = s.size;
  const p1 = s.nextPrunePlan(1)!;
  assert.equal(p1.level, 'nodeServed');
  assert.ok(p1.result.byClass.nodeServed.count > 0);
  assert.equal(p1.result.byClass.restoredPrimaries.count, 0, 'the default never touches restored primaries');
  assert.equal(s.size, before, 'dry run: nothing removed');
  assert.equal(s.applyPrune(p1, 1)!.removedCount, p1.result.removedCount, 'removes exactly what the preview showed');
  assert.equal(s.holds(S, 60), true, 'newest epochs kept');
  const p2 = s.nextPrunePlan(1)!;
  assert.equal(p2.level, 'restoredAlternates', 'no member flood here: next level');
  assert.ok(p2.result.byClass.ownAlternatesAtRisk.count >= 0);
  s.applyPrune(p2, 1);
  const p3 = s.nextPrunePlan(1)!;
  assert.equal(p3.level, 'restoredPrimaries', 'last resort comes last');
  s.applyPrune(p3, 1);
  assert.equal(s.isConfirmed(S, 1, K(1)), true, 'own key never pruned');
  assert.equal(s.nextPrunePlan(1), null, 'nothing left to remove');
});

test('prune ladder: member flood level targets only the most flooded channel', () => {
  const { s } = store();
  s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  s.putEstablished(S2, 1, K(2), pairOf(1, K(2), 1001, scope2), true, 1);
  for (let e = 2; e <= 40; e++) s.putWrap(S, e, KX(e), pairOf(e, KX(e)), 1, MEMBER());
  for (let e = 2; e <= 20; e++) s.putWrap(S2, e, KX(100 + e), pairOf(e, KX(100 + e), 1000 + e, scope2), 1, MEMBER());
  const p = s.nextPrunePlan(1, 'memberWraps')!;
  assert.equal(p.level, 'memberWraps');
  assert.deepEqual(p.scopes, [S]);
  s.applyPrune(p, 1);
  assert.ok(s.holds(S2, 2), 'the other channel is untouched');
});

// --- the backup path: real keyring + real seal/open through the vault controller -------------------

function vaultWorld(opts: ConstructorParameters<typeof ChannelKeyStore>[1] = {}) {
  const bk = K(77);
  const st = store(opts);
  const remote: { data: KeyVaultSyncData | null } = { data: null };
  const sends: VaultKeyring[] = [];
  let fetchFails = false;
  let sendFails = false;
  let corrupt = false;
  let valid = true;
  let staleSeal = false;
  let staleCommit = false;
  let fetches = 0;
  const timers: Array<() => void> = [];
  const acct: CapturedAccount<{ id: string }> = {
    account: 'A', client: { id: 'n' }, stillValid: () => valid, accountStillValid: () => valid,
  };
  const commits = new WeakMap<VaultKeyring, () => boolean>();
  const ctl = createVaultController<{ id: string }, KeyVaultSyncData, KeyVaultSyncData, VaultKeyring>({
    capture: () => acct,
    getKey: async () => ({ key: bk, wallet: 'A' }),
    fetch: async () => {
      fetches++;
      if (fetchFails) throw new Error('API error (502)');
      return remote.data;
    },
    open: (key, resp) => {
      if (corrupt) throw new Error('tag mismatch');
      return openKeyVault(key, resp);
    },
    importKeys: (kr) => st.s.importVault(kr.chan, st.gen()),
    seenMarker: () => remote.data !== null,
    markSeen: () => {},
    readKeyring: () => {
      try {
        // Same as keyVault.ts / channelCrypto prepareChannelKeyExport: the generation is captured at prepare time.
        const g = st.gen();
        const p = st.s.prepareExport(g);
        const kr: VaultKeyring = { conv: {}, chan: p.chan };
        commits.set(kr, () => st.s.commitExport(p.commitToken, g));
        return kr;
      } catch (e) {
        if (e instanceof ChannelKeyringError) throw new KeyringReadError(e.code);
        throw e;
      }
    },
    committed: (kr) => {
      if (staleCommit) st.bump();
      return commits.get(kr)?.() ?? false;
    },
    isEmpty: (kr) => Object.keys(kr.chan).length === 0,
    hasKeys: () => st.s.hasContent,
    seal: (key, kr) => {
      const out = sealKeyVault(key, kr);
      if (staleSeal) valid = false; // the account switches while sealing
      return out;
    },
    send: async (_c, sealed) => {
      if (sendFails) throw new Error('API error (503)');
      remote.data = sealed;
      sends.push(openKeyVault(bk, sealed));
    },
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    refreshBeforeSeal: true,
  });
  return {
    st, ctl, remote, sends, bk,
    failFetch: (v: boolean) => { fetchFails = v; },
    failSend: (v: boolean) => { sendFails = v; },
    corruptRemote: (v: boolean) => { corrupt = v; },
    staleOnSeal: (v: boolean) => { staleSeal = v; },
    staleOnCommit: (v: boolean) => { staleCommit = v; },
    fetchCount: () => fetches,
    flushTimers: async () => {
      while (timers.length) timers.shift()!();
      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

test('NEGATIVE CONTROL: a failed publish commits nothing; a successful one commits', async () => {
  const w = vaultWorld();
  w.st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  w.failSend(true);
  assert.equal(await w.ctl.backupNow(), 'failed');
  assert.equal(w.st.s.info(S, 1, K(1))?.persisted, false, 'nothing marked backed up');
  w.failSend(false);
  assert.equal(await w.ctl.backupNow(), 'published');
  assert.equal(w.st.s.info(S, 1, K(1))?.persisted, true);
});

test('pre-seal re-open + import: a key another device backed up AFTER our restore is never overwritten', async () => {
  const w = vaultWorld();
  w.st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published');
  const other = store();
  other.s.importVault(openKeyVault(w.bk, w.remote.data!).chan, 1);
  other.s.putEstablished(S, 2, K(2), pairOf(2, K(2)), true, 1);
  w.remote.data = sealKeyVault(w.bk, { conv: {}, chan: exportNow(other.s) });
  w.st.s.putEstablished(S, 3, K(3), pairOf(3, K(3)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published');
  const last = vals(w.sends.at(-1)!.chan);
  assert.ok(last.includes(1) && last.includes(2) && last.includes(3), `union, got ${last}`);
});

test('pre-seal re-open: a failed fetch sends NOTHING; an unreadable remote blocks backups (never overwritten)', async () => {
  const w = vaultWorld();
  w.st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published');
  const n = w.sends.length;
  w.failFetch(true);
  w.st.s.putEstablished(S, 2, K(2), pairOf(2, K(2)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'failed');
  assert.equal(w.sends.length, n);
  w.failFetch(false);
  w.corruptRemote(true);
  assert.equal(await w.ctl.backupNow(), 'blocked');
  assert.equal(w.sends.length, n);
  assert.equal(w.ctl.status().restore, 'blocked');
  assert.equal(w.ctl.status().blockReason, 'unreadable');
});

test('vault_too_large through the controller: backup PAUSED, surfaced in status, nothing sent, cleared by a later publish', async () => {
  const w = vaultWorld({ maxVaultBytes: 200 });
  for (let e = 1; e <= 6; e++) w.st.s.putEstablished(S, e, K(e), pairOf(e, K(e)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'paused');
  assert.equal(w.ctl.status().paused, 'vault_too_large');
  assert.equal(w.sends.length, 0);
  assert.equal(w.ctl.status().failStreak, 0, 'not treated as a retryable failure');
  w.st.s.clear();
  w.st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published');
  assert.equal(w.ctl.status().paused, null);
});

test('prune → backup end to end: pruned keys do NOT come back through the pre-seal re-import of the remote vault', async () => {
  const w = vaultWorld();
  w.st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  for (let e = 2; e <= 40; e++) w.st.s.putLegacy(S, e, KX(e), 1, 40);
  assert.equal(await w.ctl.backupNow(), 'published');
  const before = w.sends.at(-1)!.chan;
  assert.ok(Object.keys(before).some((n) => n.includes('#ns')), 'node-served keys were backed up as #ns');
  const plan = w.st.s.nextPrunePlan(1)!;
  assert.equal(plan.level, 'nodeServed');
  const removed = w.st.s.applyPrune(plan, 1)!.removedCount;
  assert.ok(removed > 0);
  assert.equal(await w.ctl.backupNow(), 'published', 'the remote (still holding them) is re-imported first');
  const after = w.sends.at(-1)!.chan;
  assert.equal(Object.keys(before).length - Object.keys(after).length, removed, 'the new backup is smaller by exactly the pruned keys');
  assert.equal(w.st.s.holds(S, 2), false, 'not re-imported');
  assert.ok(vals(after).includes(1), 'own key kept');
});

test('replace (user-confirmed) skips the pre-seal re-open of the unreadable remote', async () => {
  const w = vaultWorld();
  w.st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published');
  w.corruptRemote(true);
  w.st.s.putEstablished(S, 2, K(2), pairOf(2, K(2)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'blocked');
  assert.equal(await w.ctl.replace(), 'published');
  assert.ok(vals(w.sends.at(-1)!.chan).includes(2));
});

test('W1: a resume never carries the plan\'s gate / beforeStart (and never early use)', () => {
  let gateCalls = 0;
  const plan = { isPrivate: true, known: true, earlyUse: true, gate: () => { gateCalls++; return true; }, beforeStart: async () => true };
  const r = resumePlanOpts(plan);
  assert.deepEqual(Object.keys(r).sort(), ['earlyUse', 'isPrivate', 'known']);
  assert.deepEqual(r, { isPrivate: true, known: true, earlyUse: false });
  assert.equal(gateCalls, 0);
});

// --- audit round r103: B1 / B2 / W1-W5 ---------------------------------------------------------

test('B1 REGRESSION (14 vs 44): keys arriving after the confirm never get pruned — apply returns "changed", removes nothing', () => {
  const { s } = store();
  const rec: Record<string, Uint8Array> = {};
  for (let e = 1; e <= 30; e++) rec[`${S}:${e}`] = KX(e);
  s.importVault(rec, 1);
  const plan = s.nextPrunePlan(1, 'restoredPrimaries')!;
  const confirmed = plan.result.removedCount;
  assert.equal(confirmed, 14, '30 restored primaries, the newest 16 kept');
  // A background re-import lands while the confirm is open.
  const rec2: Record<string, Uint8Array> = {};
  for (let e = 31; e <= 60; e++) rec2[`${S}:${e}`] = KX(e);
  s.importVault(rec2, 1);
  const before = s.size;
  assert.equal(s.applyConfirmedPrune(plan, 1), 'changed');
  assert.equal(s.size, before, 'nothing removed');
  // The re-shown plan is applied exactly as confirmed.
  const again = s.nextPrunePlan(1, 'restoredPrimaries')!;
  assert.equal(again.result.removedCount, 44);
  const r = s.applyConfirmedPrune(again, 1);
  assert.ok(r !== 'changed' && r !== null && r.removedCount === again.result.removedCount);
});

test('B1: counts the same → applied exactly; LOWER → applied (fewer); a memberWraps plan without scopes is refused; stale → changed', () => {
  const { s } = store();
  for (let e = 1; e <= 40; e++) s.putLegacy(S, e, KX(e), 1, 40);
  const plan = s.nextPrunePlan(1)!;
  assert.equal(s.pruneGrew(plan, 1), false, 'nothing changed');
  // Lower: one of the node-served keys becomes ours (verified own-slot wrap) before the apply.
  s.putWrap(S, 1, KX(1), pairOf(1, KX(1)), 1, OWN(40));
  assert.equal(s.pruneGrew(plan, 1), false, 'fewer is not growth');
  const r = s.applyConfirmedPrune(plan, 1);
  assert.ok(r !== 'changed' && r !== null);
  assert.equal(r.removedCount, plan.result.removedCount - 1);
  assert.equal(s.holds(S, 1), true, 'the now-own key stays');
  assert.equal(s.pruneGrew(plan, 2), true, 'stale generation counts as changed (never applied)');
  assert.throws(() => s.applyPrune({ level: 'memberWraps', result: plan.result }, 1));
});

test('B2 storm bound: 100 re-decrypt ticks (3 s) of one missing epoch → <= 3 fetches per minute; bounded across many epochs', () => {
  const l = new MissFetchLimiter();
  const perMinute = new Map<number, number>();
  for (let tick = 0; tick < 100; tick++) {
    const now = tick * 3_000;
    if (l.take(`${S}:7`, now)) perMinute.set(Math.floor(now / 60_000), (perMinute.get(Math.floor(now / 60_000)) ?? 0) + 1);
  }
  for (const n of perMinute.values()) assert.ok(n <= MISS_FETCHES_PER_MIN, `per minute ${n}`);
  assert.ok([...perMinute.values()].reduce((a, b) => a + b, 0) <= MISS_FETCHES_PER_MIN * 6, 'about 5 minutes of ticks');
  // A member posting many distinct epochs: each epoch is bounded, and the map is too.
  for (let e = 0; e < MAX_MISS_ENTRIES + 500; e++) l.take(`${S}:${e}`, 0);
  assert.ok(l.size <= MAX_MISS_ENTRIES);
  l.clear();
  assert.equal(l.size, 0);
});

test('W1 / M25: "already rotated" counts only FINAL trusted keys (latestTrusted finalOnly)', () => {
  const { s } = store();
  s.putEstablished(S, 3, K(3), pairOf(3, K(3)), true, 1);
  s.putWrap(S, 5, K(5), pairOf(5, K(5)), 1, MEMBER(5)); // trusted, NOT final
  assert.equal(s.latestTrusted(S, 5)?.epoch, 5);
  assert.equal(s.latestTrusted(S, 5, true)?.epoch, 3, 'finalOnly');
});

test('W2: early use only when the VERIFIED, complete target set is our own wallet alone', () => {
  const me = 'klv1me';
  assert.equal(earlyUseAlone([{ target: me }, { target: me }], false, me), true);
  assert.equal(earlyUseAlone([], false, me), false, 'empty is NOT alone');
  assert.equal(earlyUseAlone([{ target: me }], true, me), false, 'incomplete pass');
  assert.equal(earlyUseAlone([{ target: me }, { target: 'klv1other' }], false, me), false);
});

test('W3: an unverifiable best key falls back to the trusted final send key; never settles on it', () => {
  const base = { bestEpoch: 9, eFloor: 0, rotateAllowed: true, usable: false, mayMove: true };
  assert.deepEqual(planBest({ ...base, pair: 'none', authorVerified: false, fallbackEpoch: 3 }), { do: 'fallback' });
  assert.deepEqual(planBest({ ...base, pair: 'none', authorVerified: false, fallbackEpoch: null }), { do: 'waiting' });
  assert.deepEqual(planBest({ ...base, pair: 'legacy', authorVerified: false, fallbackEpoch: 3 }), { do: 'fallback' });
  assert.deepEqual(planBest({ ...base, pair: 'legacy', authorVerified: false, fallbackEpoch: 3, eFloor: 5 }), { do: 'move' }, 'fallback below the floor is not used');
  assert.deepEqual(planBest({ ...base, pair: 'ours-pending', authorVerified: true, fallbackEpoch: 3 }), { do: 'settle', epoch: 9, known: true }, 'our own pending rotation waits for FINAL');
  // The store side: a node-served key at a higher epoch does not hide the trusted final key.
  const { s } = store();
  s.putEstablished(S, 3, K(3), pairOf(3, K(3)), true, 1);
  s.putLegacy(S, 9, K(9), 1, 9);
  assert.equal(s.latestBounded(S, 9)?.epoch, 9);
  assert.equal(s.sendKey(S, 9)?.epoch, 3);
});

test('M11: ownSlot exactly when the wrap\'s verified author is our wallet', () => {
  assert.deepEqual(ownSlotWrapOpts('klv1me', 'klv1me', 5), { ownSlot: true, nodeHighest: 5 });
  assert.deepEqual(ownSlotWrapOpts('klv1other', 'klv1me', 5), { ownSlot: false, nodeHighest: 5 });
  assert.equal(ownSlotWrapOpts('', '', 5).ownSlot, true, 'the caller guarantees a non-empty wallet');
});

test('M23: a stale commit is refused (false) and the publish is reported "stale", not success', async () => {
  const st = store();
  st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  const p = st.s.prepareExport(1);
  st.bump();
  assert.equal(st.s.commitExport(p.commitToken, 1), false);
  const w = vaultWorld();
  w.st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  w.staleOnCommit(true);
  assert.equal(await w.ctl.backupNow(), 'stale');
  assert.equal(w.st.s.info(S, 1, K(1))?.persisted, false);
});

test('M26: the account changing during the seal → stale, nothing sent', async () => {
  const w = vaultWorld();
  w.st.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  w.staleOnSeal(true);
  assert.equal(await w.ctl.backupNow(), 'stale');
  assert.equal(w.sends.length, 0);
});

test('W4: while paused (vault_too_large) a key change triggers NO automatic fetch / open; a manual backup resumes', async () => {
  const w = vaultWorld({ maxVaultBytes: 200 });
  for (let e = 1; e <= 6; e++) w.st.s.putEstablished(S, e, K(e), pairOf(e, K(e)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'paused');
  const fetches = w.fetchCount();
  w.ctl.scheduleBackup();
  await w.flushTimers();
  assert.equal(w.fetchCount(), fetches, 'no automatic re-fetch while paused');
  assert.equal(w.ctl.status().pendingBackup, true, 'the intent is kept');
  // Manual backup while still too large: the side-effect-free pre-check stops it before any network.
  assert.equal(await w.ctl.backupNow(), 'paused');
  assert.equal(w.fetchCount(), fetches, 'pre-check: no fetch while the export is still refused');
});

test('B1: growth in ANY class (e.g. more of the user\'s own at-risk alternates) counts as changed, even with equal totals', () => {
  const { s } = store();
  for (let e = 1; e <= 40; e++) s.putLegacy(S, e, KX(e), 1, 40);
  const plan = s.nextPrunePlan(1)!;
  const shown = structuredClone(plan.result);
  shown.byClass.nodeServed.count -= 1; // the confirm showed one fewer of this class
  assert.equal(s.pruneGrew({ ...plan, result: shown }, 1), true);
  assert.equal(s.applyConfirmedPrune({ ...plan, result: shown }, 1), 'changed');
});
