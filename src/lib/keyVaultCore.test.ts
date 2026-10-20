/**
 * keyVaultCore — account-switch safety of the E2E key-recovery vault, plus the
 * 0.57.0 outcome semantics (stale / unreadable / missing / blocked).
 * Controller-level tests live in keyVaultController.test.ts.
 * Run with: node --test src/lib/keyVaultCore.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BackupKeyCache, makeEnsureBackupKey, runKeyVaultRestore, runKeyVaultPublish, type OwnedKey,
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
  const marker = new Map<string, boolean>();
  const marks = {
    seenMarker: (wallet: string): boolean | null => marker.get(wallet) ?? false,
    markSeen: (wallet: string) => { marker.set(wallet, true); },
  };
  return { s, flip, imported, ctx, marker, marks };
}

for (const step of ['getKey', 'fetch', 'open']) {
  test(`restore: switch during ${step} -> 'stale' (never terminal), nothing imported or marked`, async () => {
    const w = env(step);
    const out = await runKeyVaultRestore(w.ctx, {
      ...w.marks,
      getKey: async (wallet) => { w.flip('getKey'); return { key: keyFor(wallet), wallet }; },
      fetch: async () => { w.flip('fetch'); return { vaultOf: 'A' }; },
      open: (key, resp) => {
        w.flip('open');
        if (step === 'open') throw new Error('tag mismatch'); // decrypt fails because of the switch
        return { resp, key };
      },
      importKeys: () => { w.imported.push(w.s.active); },
    });
    assert.equal(out, 'stale');
    assert.deepEqual(w.imported, []);
    assert.equal(w.marker.size, 0);
  });
}

test('restore: switch during the key await -> no GET at all (stale before fetch)', async () => {
  const w = env('getKey');
  let fetched = 0;
  const out = await runKeyVaultRestore(w.ctx, {
    ...w.marks,
    getKey: async (wallet: string) => { w.flip('getKey'); return { key: keyFor(wallet), wallet }; },
    fetch: async () => { fetched++; return {}; },
    open: () => ({}),
    importKeys: () => {},
  });
  assert.equal(out, 'stale');
  assert.equal(fetched, 0);
});

test('publish: switch during the key await -> keyring never read or sealed', async () => {
  const w = env('getKey');
  let sealed = 0;
  const d = { ...pubDeps(w, []), seal: (key: Uint8Array, kr: string) => { sealed++; return { key: key[0], kr }; } };
  assert.equal(await runKeyVaultPublish(w.ctx, d), 'stale');
  assert.equal(sealed, 0);
});

test("restore: a key belonging to ANOTHER wallet is rejected -> 'idle', no decrypt attempted", async () => {
  const w = env();
  let opened = false;
  const out = await runKeyVaultRestore(w.ctx, {
    ...w.marks,
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
    ...w.marks,
    getKey: async (wallet) => ({ key: new Uint8Array(32), wallet }),
    fetch: async () => ({}),
    open: () => ({}),
    importKeys: () => { w.imported.push('x'); },
  });
  assert.equal(out, 'idle');
  assert.deepEqual(w.imported, []);
});

test("restore control: no switch -> imports under A, 'done', marks A's vault seen", async () => {
  const w = env();
  const deps = {
    ...w.marks,
    getKey: async (wallet: string) => ({ key: keyFor(wallet), wallet }),
    fetch: async () => ({}),
    open: () => ({}),
    importKeys: () => { w.imported.push(w.s.active); },
  };
  assert.equal(await runKeyVaultRestore(w.ctx, deps), 'done');
  assert.deepEqual(w.imported, ['A']);
  assert.equal(w.marker.get('A'), true);
  assert.equal(await runKeyVaultRestore(w.ctx, { ...deps, fetch: async () => { throw new Error('net'); } }), 'idle');
});

// 0.57.0: was 'done' (terminal) — the next backup then overwrote a vault this
// session could not read. Now it blocks until the user decides.
test("restore: a genuine decrypt failure under A's OWN key is 'unreadable', not 'done'", async () => {
  const w = env();
  const out = await runKeyVaultRestore(w.ctx, {
    ...w.marks,
    getKey: async (wallet: string) => ({ key: keyFor(wallet), wallet }),
    fetch: async () => ({}),
    open: () => { throw new Error('corrupt / unsupported format_version'); },
    importKeys: () => { w.imported.push('x'); },
  });
  assert.equal(out, 'unreadable');
  assert.deepEqual(w.imported, []);
  assert.equal(w.marker.size, 0);
});

test("restore: 404 is 'done' only without the keyVaultSeen marker; marker set -> 'missing'; marker unreadable -> 'idle'", async () => {
  const w = env();
  const deps = {
    ...w.marks,
    getKey: async (wallet: string) => ({ key: keyFor(wallet), wallet }),
    fetch: async () => null,
    open: () => ({}),
    importKeys: () => {},
  };
  assert.equal(await runKeyVaultRestore(w.ctx, deps), 'done');
  w.marker.set('A', true);
  assert.equal(await runKeyVaultRestore(w.ctx, deps), 'missing');
  // the marker is read for the CAPTURED wallet only
  let asked: string | null = null;
  assert.equal(await runKeyVaultRestore(w.ctx, { ...deps, seenMarker: (x: string) => { asked = x; return false; } }), 'done');
  assert.equal(asked, 'A');
  assert.equal(await runKeyVaultRestore(w.ctx, { ...deps, seenMarker: async () => null }), 'idle');
});

test("restore: account switch while reading the marker -> 'stale'", async () => {
  const w = env();
  const out = await runKeyVaultRestore(w.ctx, {
    ...w.marks,
    getKey: async (wallet: string) => ({ key: keyFor(wallet), wallet }),
    fetch: async () => null,
    open: () => ({}),
    importKeys: () => {},
    seenMarker: async () => { w.s.active = 'B'; w.s.gen++; return false; },
  });
  assert.equal(out, 'stale');
});

// --- publish ------------------------------------------------------------------

function pubDeps(w: ReturnType<typeof env>, sent: { key: number; keyring: string; signer: string }[]) {
  return {
    canPublish: () => true,
    markSeen: w.marks.markSeen,
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
  assert.equal(await runKeyVaultPublish(w.ctx, pubDeps(w, sent)), 'stale');
  assert.deepEqual(sent, []);
});

test("publish: a key for another wallet -> nothing sent", async () => {
  const w = env();
  const sent: any[] = [];
  const d = { ...pubDeps(w, sent), getKey: async () => ({ key: keyFor('B'), wallet: 'B' }) };
  assert.equal(await runKeyVaultPublish(w.ctx, d), 'unavailable');
  assert.deepEqual(sent, []);
});

test("publish control: no switch -> A's keyring, sealed with A's key, signed as A", async () => {
  const w = env();
  const sent: any[] = [];
  assert.equal(await runKeyVaultPublish(w.ctx, pubDeps(w, sent)), 'published');
  assert.deepEqual(sent, [{ key: keyFor('A')[0], keyring: 'keyring@A', signer: 'A' }]);
  assert.equal(w.marker.get('A'), true, 'a published vault is marked seen');
});

test('publish: canPublish is re-checked AFTER the key await (restore reset while deriving) -> blocked, nothing sent', async () => {
  const w = env();
  const sent: any[] = [];
  let allowed = true;
  const d = {
    ...pubDeps(w, sent),
    canPublish: () => allowed,
    getKey: async (wallet: string) => { allowed = false; return { key: keyFor(wallet), wallet }; },
  };
  assert.equal(await runKeyVaultPublish(w.ctx, d), 'blocked');
  assert.deepEqual(sent, []);
});

test('publish: a throwing send -> failed, not marked seen', async () => {
  const w = env();
  const d = { ...pubDeps(w, []), send: async () => { throw new Error('API error (503)'); } };
  assert.equal(await runKeyVaultPublish(w.ctx, d), 'failed');
  assert.equal(w.marker.size, 0);
});

test('publish: empty keyring -> nothing sent (no key derived)', async () => {
  const w = env();
  const sent: any[] = [];
  let derived = false;
  const d = { ...pubDeps(w, sent), isEmpty: () => true, getKey: async (wallet: string) => { derived = true; return { key: keyFor(wallet), wallet }; } };
  assert.equal(await runKeyVaultPublish(w.ctx, d), 'empty');
  assert.equal(derived, false);
  assert.deepEqual(sent, []);
});

// --- ensureBackupKey: signer must be the wallet's own key (mobile (d)) ---------

function keyEnv(over: Partial<{ wallet: string | null; signer: { address: string; id: string } | null; e2e: boolean }> = {}) {
  const st = { wallet: 'A' as string | null, signer: { address: 'A', id: 'sigA' } as { address: string; id: string } | null, e2e: true, ...over };
  const signedWith: string[] = [];
  const envDeps = {
    e2eAvailable: () => st.e2e,
    walletAddress: () => st.wallet,
    signer: () => st.signer,
    derive: async (s: { address: string; id: string }) => { signedWith.push(s.id); return keyFor(s.address); },
  };
  return { st, signedWith, envDeps };
}

/** Pre-0.57.0 ensureBackupKey (keyVault.ts @ 0.56.0): no signer check, re-reads the env signer. */
function legacyEnsure(cache: BackupKeyCache, e: ReturnType<typeof keyEnv>) {
  return (wallet: string) => {
    if (!e.envDeps.e2eAvailable() || !wallet || e.envDeps.walletAddress() !== wallet) return Promise.resolve(null);
    return cache.get(wallet, () => e.envDeps.derive(e.envDeps.signer()!));
  };
}

test('ensureBackupKey: refuses (no signature, no key) when the signer is not the wallet', async () => {
  const e = keyEnv({ signer: { address: 'B', id: 'sigB' } });
  const ensure = makeEnsureBackupKey(new BackupKeyCache(), e.envDeps);
  assert.equal(await ensure('A'), null);
  assert.deepEqual(e.signedWith, []);
  // negative control: the old path derives "A's" backup key from B's signature
  const old = await legacyEnsure(new BackupKeyCache(), e)('A');
  assert.ok(old);
  assert.deepEqual(old!.key, keyFor('B'));
  assert.deepEqual(e.signedWith, ['sigB']);
});

test('ensureBackupKey: signs with exactly the checked signer; refuses without signer / e2e / for another wallet', async () => {
  const e = keyEnv();
  const ensure = makeEnsureBackupKey(new BackupKeyCache(), e.envDeps);
  assert.equal(await ensure('B'), null, 'not the crypto-env wallet');
  const got = await ensure('A');
  assert.equal(got!.wallet, 'A');
  assert.deepEqual(e.signedWith, ['sigA']);
  const e2 = keyEnv({ signer: null });
  assert.equal(await makeEnsureBackupKey(new BackupKeyCache(), e2.envDeps)('A'), null);
  const e3 = keyEnv({ e2e: false });
  assert.equal(await makeEnsureBackupKey(new BackupKeyCache(), e3.envDeps)('A'), null);
  assert.deepEqual([...e2.signedWith, ...e3.signedWith], []);
});
