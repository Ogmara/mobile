/**
 * keyVaultCore — account-switch safety of the E2E key-recovery vault.
 * Run with: node --test src/lib/keyVaultCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackupKeyCache, runKeyVaultRestore, runKeyVaultPublish, type OwnedKey,
} from './keyVaultCore.ts';

const keyFor = (w: string) => new Uint8Array(32).fill(w.charCodeAt(w.length - 1));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

// --- BackupKeyCache -----------------------------------------------------------

test('cache: an in-flight derivation for A is NEVER returned to B', async () => {
  const c = new BackupKeyCache();
  const dA = deferred<Uint8Array>();
  const pA = c.get('A', () => dA.promise);
  const pB = c.get('B', async () => keyFor('B'));
  assert.notEqual(pA, pB);
  dA.resolve(keyFor('A'));
  const [a, b] = await Promise.all([pA, pB]);
  assert.equal(a!.wallet, 'A');
  assert.equal(b!.wallet, 'B');
  assert.deepEqual(b!.key, keyFor('B'));
});

test('cache: same-wallet callers share one derivation', async () => {
  const c = new BackupKeyCache();
  let calls = 0;
  const d = deferred<Uint8Array>();
  const p1 = c.get('A', () => { calls++; return d.promise; });
  const p2 = c.get('A', () => { calls++; return d.promise; });
  assert.equal(p1, p2);
  d.resolve(keyFor('A'));
  await p1;
  assert.equal(calls, 1);
  // now cached
  await c.get('A', () => { calls++; return Promise.resolve(keyFor('A')); });
  assert.equal(calls, 1);
});

test('cache: clear() mid-derivation -> the result is NOT cached for anyone', async () => {
  const c = new BackupKeyCache();
  const d = deferred<Uint8Array>();
  const p = c.get('A', () => d.promise);
  c.clear();
  d.resolve(keyFor('A'));
  await p;
  let derived = false;
  await c.get('A', async () => { derived = true; return keyFor('A'); });
  assert.equal(derived, true, 'must re-derive after clear');
});

test('cache: a cached key for A is never handed to B', async () => {
  const c = new BackupKeyCache();
  await c.get('A', async () => keyFor('A'));
  const b = await c.get('B', async () => keyFor('B'));
  assert.equal(b!.wallet, 'B');
  assert.deepEqual(b!.key, keyFor('B'));
});

test('cache: a derive that throws synchronously yields null and leaves no stuck in-flight', async () => {
  const c = new BackupKeyCache();
  assert.equal(await c.get('A', () => { throw new Error('x'); }), null);
  assert.ok(await c.get('A', async () => keyFor('A')));
});

// --- restore ------------------------------------------------------------------

function env(switchDuring?: string) {
  const s = { active: 'A', gen: 0 };
  const flip = (step: string) => { if (step === switchDuring) { s.active = 'B'; s.gen++; } };
  const imported: string[] = [];
  const g0 = s.gen;
  const ctx = { account: 'A' as string | null, stillValid: () => s.active === 'A' && s.gen === g0 };
  return { s, flip, imported, ctx };
}

for (const step of ['getKey', 'fetch', 'open']) {
  test(`restore: switch during ${step} -> 'idle' (never terminal), nothing imported`, async () => {
    const w = env(step);
    const out = await runKeyVaultRestore(w.ctx, {
      getKey: async (wallet) => { w.flip('getKey'); return { key: keyFor(wallet), wallet }; },
      fetch: async () => { w.flip('fetch'); return { vaultOf: 'A' }; },
      open: (key, resp) => {
        w.flip('open');
        if (step === 'open') throw new Error('tag mismatch'); // decrypt fails because of the switch
        return { resp, key };
      },
      importKeys: () => { w.imported.push(w.s.active); },
    });
    assert.equal(out, 'idle');
    assert.deepEqual(w.imported, []);
  });
}

test("restore: a key belonging to ANOTHER wallet is rejected -> 'idle', no decrypt attempted", async () => {
  const w = env();
  let opened = false;
  const out = await runKeyVaultRestore(w.ctx, {
    getKey: async () => ({ key: keyFor('B'), wallet: 'B' }) as OwnedKey,
    fetch: async () => ({}),
    open: () => { opened = true; throw new Error('x'); },
    importKeys: () => { w.imported.push('x'); },
  });
  assert.equal(out, 'idle');
  assert.equal(opened, false);
});

test("restore: a zeroed (cleared) key is rejected -> 'idle'", async () => {
  const w = env();
  const out = await runKeyVaultRestore(w.ctx, {
    getKey: async (wallet) => ({ key: new Uint8Array(32), wallet }),
    fetch: async () => ({}),
    open: () => ({}),
    importKeys: () => { w.imported.push('x'); },
  });
  assert.equal(out, 'idle');
  assert.deepEqual(w.imported, []);
});

test("restore control: no switch -> imports under A, 'done'; genuine decrypt failure with A's own key is 'done'", async () => {
  const w = env();
  const deps = {
    getKey: async (wallet: string) => ({ key: keyFor(wallet), wallet }),
    fetch: async () => ({}),
    open: () => ({}),
    importKeys: () => { w.imported.push(w.s.active); },
  };
  assert.equal(await runKeyVaultRestore(w.ctx, deps), 'done');
  assert.deepEqual(w.imported, ['A']);
  assert.equal(await runKeyVaultRestore(w.ctx, { ...deps, open: () => { throw new Error('corrupt'); } }), 'done');
  assert.equal(await runKeyVaultRestore(w.ctx, { ...deps, fetch: async () => null }), 'done');
  assert.equal(await runKeyVaultRestore(w.ctx, { ...deps, fetch: async () => { throw new Error('net'); } }), 'idle');
});

// --- publish ------------------------------------------------------------------

function pubDeps(w: ReturnType<typeof env>, sent: { key: number; keyring: string; signer: string }[]) {
  return {
    getKey: async (wallet: string) => { w.flip('getKey'); return { key: keyFor(wallet), wallet }; },
    readKeyring: () => `keyring@${w.s.active}`,
    isEmpty: () => false,
    seal: (key: Uint8Array, kr: string) => ({ key: key[0], kr }),
    send: async (sealed: { key: number; kr: string }) => { sent.push({ key: sealed.key, keyring: sealed.kr, signer: w.s.active }); },
  };
}

test('publish: switch during the key await -> nothing sealed or sent', async () => {
  const w = env('getKey');
  const sent: any[] = [];
  assert.equal(await runKeyVaultPublish(w.ctx, pubDeps(w, sent)), false);
  assert.deepEqual(sent, []);
});

test("publish: a key for another wallet -> nothing sent", async () => {
  const w = env();
  const sent: any[] = [];
  const d = { ...pubDeps(w, sent), getKey: async () => ({ key: keyFor('B'), wallet: 'B' }) };
  assert.equal(await runKeyVaultPublish(w.ctx, d), false);
  assert.deepEqual(sent, []);
});

test("publish control: no switch -> A's keyring, sealed with A's key, signed as A", async () => {
  const w = env();
  const sent: any[] = [];
  assert.equal(await runKeyVaultPublish(w.ctx, pubDeps(w, sent)), true);
  assert.deepEqual(sent, [{ key: keyFor('A')[0], keyring: 'keyring@A', signer: 'A' }]);
});

test('publish: empty keyring -> nothing sent (no key derived)', async () => {
  const w = env();
  const sent: any[] = [];
  let derived = false;
  const d = { ...pubDeps(w, sent), isEmpty: () => true, getKey: async (wallet: string) => { derived = true; return { key: keyFor(wallet), wallet }; } };
  assert.equal(await runKeyVaultPublish(w.ctx, d), false);
  assert.equal(derived, false);
  assert.deepEqual(sent, []);
});
