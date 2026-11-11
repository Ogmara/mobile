/**
 * Pre-seal re-open of the remote vault (mobile 0.58.0), from audit round r103
 * probes A1-A5, against the REAL SDK keyring + seal / open: first backup on a
 * 404 without marker publishes; a 404 after the marker (node lost it) blocks
 * with `missing` until Replace; an unreadable marker or a fetch error sends
 * nothing; Replace is refused when not blocked.
 * Run: node --test src/lib/keyVaultRefresh.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeChannelScope, computeKeyCommitment, openKeyVault, sealKeyVault, ChannelKeyringError, type KeyVaultSyncData, type VaultKeyring } from '@ogmara/sdk';
import { ChannelKeyStore } from './channelKeyCore.ts';
import { createVaultController, KeyringReadError, type CapturedAccount } from './keyVaultCore.ts';
const scope = computeChannelScope(4_294_967_301);
const S = Array.from(scope, (b) => b.toString(16).padStart(2, '0')).join('');
const K = (n: number) => new Uint8Array(32).fill(n);
const pairOf = (e: number, k: Uint8Array) => ({ keyTs: 1000 + e, commitment: computeKeyCommitment(scope, e, 1000 + e, k) });
function world() {
  const bk = K(77); let gen = 1; const s = new ChannelKeyStore(() => gen);
  const remote: { data: KeyVaultSyncData | null } = { data: null };
  const sends: VaultKeyring[] = []; let marker: boolean | null = false; let fetchThrows = false;
  const acct: CapturedAccount<{ id: string }> = { account: 'A', client: { id: 'n' }, stillValid: () => true, accountStillValid: () => true };
  const commits = new WeakMap<VaultKeyring, () => boolean>();
  const ctl = createVaultController<{ id: string }, KeyVaultSyncData, KeyVaultSyncData, VaultKeyring>({
    capture: () => acct, getKey: async () => ({ key: bk, wallet: 'A' }),
    fetch: async () => { if (fetchThrows) throw new Error('502'); return remote.data; },
    open: (k, r) => openKeyVault(k, r), importKeys: (kr) => s.importVault(kr.chan, gen),
    seenMarker: () => marker, markSeen: () => { if (marker !== null) marker = true; },
    readKeyring: () => { try { const g = gen; const p = s.prepareExport(g); const kr = { conv: {}, chan: p.chan }; commits.set(kr, () => s.commitExport(p.commitToken, g)); return kr; } catch (e) { if (e instanceof ChannelKeyringError) throw new KeyringReadError(e.code); throw e; } },
    committed: (kr) => commits.get(kr)?.() ?? false, isEmpty: (kr) => Object.keys(kr.chan).length === 0, hasKeys: () => s.hasContent,
    seal: sealKeyVault, send: async (_c, sealed) => { remote.data = sealed; sends.push(openKeyVault(bk, sealed)); },
    setTimer: () => 0, clearTimer: () => {}, refreshBeforeSeal: true,
  });
  return { s, ctl, remote, sends, setMarker: (v: boolean | null) => { marker = v; }, throwFetch: (v: boolean) => { fetchThrows = v; } };
}
test('A1: first-ever backup (404, no marker) publishes', async () => {
  const w = world(); w.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published'); assert.equal(w.sends.length, 1);
});
test('A2: 404 on pre-seal re-read after marker set -> blocked missing, nothing sent; Replace publishes', async () => {
  const w = world(); w.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published');
  w.remote.data = null; // node lost it
  w.s.putEstablished(S, 2, K(2), pairOf(2, K(2)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'blocked'); assert.equal(w.sends.length, 1);
  assert.equal(w.ctl.status().blockReason, 'missing');
  assert.equal(await w.ctl.backupNow(), 'blocked'); assert.equal(w.sends.length, 1, 'stays blocked');
  assert.equal(await w.ctl.replace(), 'published'); assert.equal(w.sends.length, 2);
});
test('A3: marker unreadable on pre-seal 404 -> failed, nothing sent', async () => {
  const w = world(); w.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published');
  w.remote.data = null; w.setMarker(null);
  w.s.putEstablished(S, 2, K(2), pairOf(2, K(2)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'failed'); assert.equal(w.sends.length, 1);
});
test('A4: pre-seal fetch throw -> failed, retry scheduled, nothing sent', async () => {
  const w = world(); w.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published'); w.throwFetch(true);
  w.s.putEstablished(S, 2, K(2), pairOf(2, K(2)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'failed'); assert.equal(w.sends.length, 1);
  assert.equal(w.ctl.status().failStreak, 1);
});
test('A5: Replace refused when not blocked', async () => {
  const w = world(); w.s.putEstablished(S, 1, K(1), pairOf(1, K(1)), true, 1);
  assert.equal(await w.ctl.backupNow(), 'published');
  assert.equal(await w.ctl.replace(), 'blocked');
});
