/**
 * Key-vault controller (mobile 0.57.0): never overwrite the remote vault unless
 * this session opened it with its own key, confirmed it verifiably empty, or
 * the user confirmed "Replace backup"; `backupNow` waits for restore and
 * reports honestly; coalesced re-arm; node-switch re-arm (client only, never
 * an account switch); bounded failure backoff.
 *
 * The account context is the REAL guard (accountGuard.ts) over a fake crypto
 * env, so "client only" vs "account" changes mean exactly what they mean in
 * the app. Every rule has a negative control: the same scenario against a copy
 * of the pre-fix flow (keyVault.ts + keyVaultCore.ts @ mobile 0.56.0).
 * Run: node --test src/lib/keyVaultController.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isAccountContextValid,
  isSameAccountIgnoringClient,
  type AccountContextSnapshot,
} from './accountGuard.ts';
import {
  createVaultController,
  type CapturedAccount,
  type OwnedKey,
} from './keyVaultCore.ts';

type Keyring = Record<string, number>;
interface Sealed { sealedWith: number; keyring: Keyring }
interface Client { id: string }

const keyFor = (w: string) => new Uint8Array(32).fill(w.charCodeAt(w.length - 1));

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r));
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => { open = r; });
  return { p, open };
}

/** Injected fake clock: timers only fire on `advance`. */
class Clock {
  now = 0;
  private seq = 0;
  timers = new Map<number, { at: number; fn: () => void }>();
  set = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };
  clear = (id: unknown) => { this.timers.delete(id as number); };
  async advance(ms: number): Promise<void> {
    const end = this.now + ms;
    for (;;) {
      const due = [...this.timers]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!due) break;
      this.timers.delete(due[0]);
      this.now = due[1].at;
      due[1].fn();
      await settle();
    }
    this.now = end;
    await settle();
  }
}

interface Vault {
  scheduleBackup(): void;
  tryRestore(): void;
  clearSession(): void;
  backupNow(): Promise<unknown>;
}

type Flavor = 'fixed' | 'legacy';

function world(flavor: Flavor = 'fixed') {
  const w = {
    wallet: 'A' as string | null,
    scope: 'A' as string | null,
    gen: 1,
    client: { id: 'node1' } as Client | null,
    signer: 'A' as string | null,
    /** remote vault per wallet */
    remote: new Map<string, Sealed>(),
    marker: new Map<string, boolean>(),
    fetchFails: false,
    fetchGate: null as Promise<void> | null,
    sendFails: false,
    sendGate: null as Promise<void> | null,
    keyGate: null as Promise<void> | null,
    local: {} as Keyring,
    keyCalls: 0,
    fetchCalls: 0,
    sends: [] as { as: string; client: string; sealed: Sealed }[],
    sendAttempts: 0,
  };
  const clock = new Clock();
  const snap = (): AccountContextSnapshot => ({
    wallet: w.wallet, scope: w.scope, gen: w.gen, client: w.client, signer: w.client ? w.signer : null,
  });
  /** Same shape as accountContext.captureAccountContext(). */
  const capture = (): CapturedAccount<Client | null> => {
    const start = snap();
    const stillValid = () => isAccountContextValid(start, snap());
    const ok = stillValid();
    return {
      account: ok ? start.wallet : null,
      client: start.client as Client | null,
      stillValid,
      accountStillValid: () => isSameAccountIgnoringClient(start, snap()),
    };
  };
  const io = {
    capture,
    getKey: async (wallet: string): Promise<OwnedKey | null> => {
      w.keyCalls++;
      if (w.keyGate) await w.keyGate;
      await Promise.resolve();
      return { key: keyFor(wallet), wallet };
    },
    fetch: async (client: Client | null): Promise<Sealed | null> => {
      w.fetchCalls++;
      if (!client) throw new Error('no client');
      const of = w.wallet!;
      if (w.fetchGate) await w.fetchGate;
      await Promise.resolve();
      if (w.fetchFails) throw new Error('API error (502)');
      return w.remote.get(of) ?? null;
    },
    open: (key: Uint8Array, s: Sealed): Keyring => {
      if (key[0] !== s.sealedWith) throw new Error('tag mismatch');
      return { ...s.keyring };
    },
    importKeys: (kr: Keyring) => { Object.assign(w.local, kr); return Object.keys(kr).length; },
    seenMarker: (wallet: string) => w.marker.get(wallet) ?? false,
    markSeen: (wallet: string) => { w.marker.set(wallet, true); },
    readKeyring: (): Keyring => ({ ...w.local }),
    isEmpty: (kr: Keyring) => Object.keys(kr).length === 0,
    seal: (key: Uint8Array, kr: Keyring): Sealed => ({ sealedWith: key[0], keyring: { ...kr } }),
    send: async (client: Client | null, sealed: Sealed) => {
      w.sendAttempts++;
      const as = w.signer!; // the node attributes it to the signing account
      if (w.sendGate) await w.sendGate;
      await Promise.resolve();
      if (w.sendFails) throw new Error('API error (503)');
      w.remote.set(as, sealed);
      w.sends.push({ as, client: client!.id, sealed });
    },
    setTimer: clock.set,
    clearTimer: clock.clear,
  };
  const ctl = createVaultController(io);
  const vault: Vault = flavor === 'fixed' ? ctl : createLegacyVault(io);
  const addKey = (name: string, n = 7) => {
    w.local[name] = n;
    vault.scheduleBackup();
  };
  const seedRemote = (wallet: string, keys: Keyring, sealWith = wallet) => {
    w.remote.set(wallet, { sealedWith: keyFor(sealWith)[0], keyring: { ...keys } });
  };
  /** ConnectionContext node switch: setCryptoClient(new) only. */
  const switchNode = (id: string) => { w.client = { id }; };
  /** ConnectionContext.switchAccount: resets (gen++) → scope/signer/env flip. Session clear optional. */
  const switchAccount = (next: string, clear = true) => {
    w.gen++;
    if (clear) { vault.clearSession(); w.local = {}; }
    w.wallet = next; w.scope = next; w.signer = next;
    w.gen++;
  };
  return { w, clock, ctl, vault, addKey, seedRemote, switchNode, switchAccount, capture };
}

/** What SettingsScreen does via keyVaultAccount() before opening the confirm. */
function captureFor(f: ReturnType<typeof world>): CapturedAccount<Client | null> {
  const ctx = f.capture();
  assert.ok(ctx.account, 'an account is active when the confirm opens');
  return ctx;
}

// --- the pre-fix flow (mobile 0.56.0 keyVault.ts + keyVaultCore.ts), deps injected --

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function createLegacyVault(d: any): Vault {
  let restoreState: 'idle' | 'inflight' | 'done' = 'idle';
  let restoreRun = 0;
  let pendingBackup = false;
  let publishing = false;
  let timer: unknown = null;
  const usable = (o: OwnedKey | null, w: string) => !!o && o.wallet === w && o.key.some((b) => b !== 0);
  async function legacyRestore(ctx: CapturedAccount<Client | null>): Promise<'done' | 'idle'> {
    const wallet = ctx.account;
    if (!wallet || !ctx.stillValid()) return 'idle';
    const owned = await d.getKey(wallet);
    if (!usable(owned, wallet) || !ctx.stillValid()) return 'idle';
    let resp: Sealed | null;
    try { resp = await d.fetch(ctx.client); } catch { return 'idle'; }
    if (!ctx.stillValid()) return 'idle';
    if (resp) {
      let kr: Keyring;
      try { kr = d.open(owned!.key, resp); } catch { return ctx.stillValid() ? 'done' : 'idle'; }
      if (!ctx.stillValid()) return 'idle';
      d.importKeys(kr);
    }
    return 'done';
  }
  async function legacyPublish(ctx: CapturedAccount<Client | null>): Promise<boolean> {
    const wallet = ctx.account;
    if (!wallet || !ctx.stillValid()) return false;
    if (d.isEmpty(d.readKeyring())) return false;
    const owned = await d.getKey(wallet);
    if (!usable(owned, wallet) || !ctx.stillValid()) return false;
    const kr = d.readKeyring();
    if (d.isEmpty(kr)) return false;
    const sealed = d.seal(owned!.key, kr);
    if (!ctx.stillValid()) return false;
    await d.send(ctx.client, sealed);
    return true;
  }
  async function publishBackup(): Promise<void> {
    if (publishing) return;
    const ctx = d.capture();
    if (!ctx.account || !ctx.client) return;
    publishing = true;
    try { await legacyPublish(ctx); } catch { /* swallowed */ } finally { publishing = false; }
  }
  function tryRestore(): void {
    if (restoreState !== 'idle') return;
    restoreState = 'inflight';
    const run = restoreRun;
    const ctx = d.capture();
    void (async () => {
      let outcome: 'done' | 'idle' = 'idle';
      try { outcome = await legacyRestore(ctx); } catch { outcome = 'idle'; } finally {
        if (run === restoreRun) {
          restoreState = outcome;
          if (outcome === 'done' && pendingBackup) { pendingBackup = false; scheduleBackup(); }
        }
      }
    })();
  }
  function scheduleBackup(): void {
    if (restoreState !== 'done') { pendingBackup = true; tryRestore(); return; }
    if (timer) d.clearTimer(timer);
    timer = d.setTimer(() => { timer = null; void publishBackup(); }, 4_000);
  }
  return {
    scheduleBackup,
    tryRestore,
    clearSession() {
      restoreRun++; restoreState = 'idle'; pendingBackup = false;
      if (timer) { d.clearTimer(timer); timer = null; }
    },
    async backupNow() {
      if (restoreState !== 'done') tryRestore();
      await publishBackup();
    },
  };
}

// --- (1) backupNow never publishes before restore ---------------------------------

test('backupNow before restore with a fetch failure: nothing sent, result restore-failed (negative: 0.56.0 sends)', async () => {
  const f = world();
  f.seedRemote('A', { old1: 1, old2: 2 });
  f.w.local = { fresh: 9 };
  f.w.fetchFails = true;
  assert.equal(await f.ctl.backupNow(), 'restore-failed');
  await settle();
  assert.equal(f.w.sendAttempts, 0);
  assert.deepEqual(f.w.remote.get('A')!.keyring, { old1: 1, old2: 2 }, 'remote untouched');

  const l = world('legacy');
  l.seedRemote('A', { old1: 1, old2: 2 });
  l.w.local = { fresh: 9 };
  l.w.fetchFails = true;
  await l.vault.backupNow();
  await settle();
  assert.equal(l.w.sends.length, 1, 'legacy overwrote the remote');
  assert.deepEqual(l.w.remote.get('A')!.keyring, { fresh: 9 }, 'legacy lost old1/old2');
});

test('backupNow during an in-flight restore: ONE fetch, the published keyring is a superset of the remote one (negative: 0.56.0 publishes local-only)', async () => {
  const f = world();
  f.seedRemote('A', { old1: 1, old2: 2 });
  f.w.local = { fresh: 9 };
  const g = gate();
  f.w.fetchGate = g.p;
  f.ctl.tryRestore();
  const p = f.ctl.backupNow();
  await settle();
  assert.equal(f.w.sendAttempts, 0, 'nothing sent while restore is in flight');
  g.open();
  assert.equal(await p, 'published');
  assert.equal(f.w.fetchCalls, 1);
  assert.equal(f.w.sends.length, 1);
  assert.deepEqual(f.w.sends[0].sealed.keyring, { old1: 1, old2: 2, fresh: 9 });

  const l = world('legacy');
  l.seedRemote('A', { old1: 1, old2: 2 });
  l.w.local = { fresh: 9 };
  const lg = gate();
  l.w.fetchGate = lg.p;
  l.vault.tryRestore();
  await l.vault.backupNow();
  assert.deepEqual(l.w.sends[0].sealed.keyring, { fresh: 9 }, 'legacy: remote keys lost');
  lg.open();
  await settle();
});

// --- (3) blocked / nothing / failed ------------------------------------------------

test('unreadable remote under our own key: backupNow -> blocked, no send; scheduled backups never send (negative: 0.56.0 overwrote it)', async () => {
  const f = world();
  f.seedRemote('A', { x: 1 }, 'Z'); // sealed under a key that isn't A's
  f.w.local = { fresh: 9 };
  assert.equal(await f.ctl.backupNow(), 'blocked');
  assert.equal(f.ctl.status().restore, 'blocked');
  assert.equal(f.ctl.status().blockReason, 'unreadable');
  f.addKey('k2');
  f.addKey('k3');
  await f.clock.advance(60_000);
  assert.equal(f.w.sendAttempts, 0);
  assert.equal(f.w.fetchCalls, 1, 'blocked: no GET loop');

  const l = world('legacy');
  l.seedRemote('A', { x: 1 }, 'Z');
  l.addKey('fresh');
  await settle();
  await l.clock.advance(5_000);
  assert.equal(l.w.sends.length, 1, 'legacy overwrote an unreadable vault');
});

test('404 + keyVaultSeen marker -> blocked:missing, no send; 404 without marker -> verifiably empty, publishes', async () => {
  const f = world();
  f.w.marker.set('A', true);
  f.w.local = { k: 1 };
  assert.equal(await f.ctl.backupNow(), 'blocked');
  assert.equal(f.ctl.status().blockReason, 'missing');
  assert.equal(f.w.sendAttempts, 0);

  const g = world();
  g.w.local = { k: 1 };
  assert.equal(await g.ctl.backupNow(), 'published');
  assert.equal(g.w.marker.get('A'), true, 'publish marks the vault seen');
});

test("blocked -> Replace publishes exactly once; Replace when not blocked is refused; Retry re-runs restore", async () => {
  const f = world();
  f.seedRemote('A', { x: 1 }, 'Z');
  f.w.local = { fresh: 9 };
  assert.equal(await f.ctl.ensureRestored(), 'blocked');
  f.ctl.retry();
  await settle();
  assert.equal(f.w.fetchCalls, 2, 'Retry fetched again');
  assert.equal(f.ctl.status().restore, 'blocked');
  assert.equal(await f.ctl.replace(), 'published');
  await f.clock.advance(60_000);
  assert.equal(f.w.sends.length, 1);
  assert.deepEqual(f.w.sends[0].sealed.keyring, { fresh: 9 });

  const g = world();
  g.w.local = { fresh: 9 };
  assert.equal(await g.ctl.replace(), 'blocked', 'nothing to replace before restore ran');
  assert.equal(g.w.sendAttempts, 0);
});

test('backupNow results: empty keyring -> nothing; throwing send -> failed (+ bounded backoff 3x, reset by clearSession); signed out -> unavailable', async () => {
  const f = world();
  assert.equal(await f.ctl.backupNow(), 'nothing');
  assert.equal(f.w.sendAttempts, 0);

  const g = world();
  g.w.local = { k: 1 };
  g.w.sendFails = true;
  assert.equal(await g.ctl.backupNow(), 'failed');
  await g.clock.advance(60 * 60_000);
  assert.equal(g.w.sendAttempts, 4, '1 + 3 automatic retries, then stop');
  await g.clock.advance(60 * 60_000);
  assert.equal(g.w.sendAttempts, 4);
  assert.equal(g.ctl.status().failStreak, 3);
  g.ctl.clearSession();
  assert.equal(g.ctl.status().failStreak, 0);

  const h = world();
  h.w.wallet = null; h.w.scope = null;
  assert.equal(await h.ctl.backupNow(), 'unavailable');
});

// --- coalescing ----------------------------------------------------------------------

test('ten key changes during one in-flight publish -> exactly 1 follow-up containing the new key (negative: 0.56.0 drops it)', async () => {
  for (const flavor of ['fixed', 'legacy'] as const) {
    const f = world(flavor);
    f.addKey('k0');
    await settle(); // restore: 404, no marker -> done; publish armed
    const g = gate();
    f.w.sendGate = g.p;
    await f.clock.advance(4_000); // publish #1 in flight
    for (let i = 1; i <= 10; i++) { f.addKey(`k${i}`); await f.clock.advance(4_000); }
    g.open();
    f.w.sendGate = null;
    await settle();
    await f.clock.advance(60_000);
    if (flavor === 'fixed') {
      assert.equal(f.w.sends.length, 2, 'one follow-up');
      assert.ok('k10' in f.w.sends[1].sealed.keyring);
    } else {
      assert.equal(f.w.sends.length, 1, 'legacy: the new keys were never backed up');
    }
  }
});

test('double restore trigger -> one fetch; a backup requested during restore waits, then publishes once', async () => {
  const f = world();
  const g = gate();
  f.w.fetchGate = g.p;
  f.ctl.tryRestore();
  f.ctl.tryRestore();
  f.addKey('k1');
  const a = f.ctl.ensureRestored();
  await settle();
  assert.equal(f.w.fetchCalls, 1);
  g.open();
  assert.equal(await a, 'done');
  await f.clock.advance(4_000);
  assert.equal(f.w.sends.length, 1);
});

test('an armed timer that fires while restore left `done` derives no key and sends nothing (controller gate)', async () => {
  const f = world();
  f.addKey('k1');
  await settle(); // done (404, no marker); publish timer armed
  const g = gate();
  f.w.fetchGate = g.p;
  const r = f.ctl.restoreNow(); // manual re-fetch: state inflight
  await settle();
  const keyCalls = f.w.keyCalls;
  await f.clock.advance(4_000); // the armed timer fires now
  assert.equal(f.w.keyCalls, keyCalls, 'no key derivation for a publish that is not allowed');
  assert.equal(f.w.sendAttempts, 0);
  assert.equal(f.ctl.status().pendingBackup, true, 'the intent survives');
  g.open();
  f.w.fetchGate = null;
  await r;
  await f.clock.advance(4_000);
  assert.equal(f.w.sends.length, 1, 'published once restore is done again');
});

test('backupNow waiting behind an in-flight publish re-checks the gate before its own publish', async () => {
  const f = world();
  f.addKey('k1');
  await settle();
  const sg = gate();
  f.w.sendGate = sg.p;
  await f.clock.advance(4_000); // publish #1 in flight (send gated)
  const b = f.ctl.backupNow(); // restore done -> waits for #1
  await settle();
  const fg = gate();
  f.w.fetchGate = fg.p;
  const r = f.ctl.restoreNow(); // state -> inflight while backupNow waits
  await settle();
  const keyCalls = f.w.keyCalls;
  sg.open();
  f.w.sendGate = null;
  assert.equal(await b, 'blocked');
  assert.equal(f.w.keyCalls, keyCalls, 'no second publish attempted');
  assert.equal(f.w.sends.length, 1);
  fg.open();
  await r;
});

test('a restore superseded by clearSession (same account) writes no state', async () => {
  const f = world();
  const g = gate();
  f.w.fetchGate = g.p;
  f.ctl.tryRestore();
  await settle();
  f.ctl.clearSession();
  g.open();
  f.w.fetchGate = null;
  await settle();
  assert.equal(f.ctl.status().restore, 'idle');
});

test('Restore pressed while a publish is deriving its key: the publish is blocked after the key await, then re-armed', async () => {
  const f = world();
  f.addKey('k1');
  await settle();
  const g = gate();
  f.w.keyGate = g.p;
  await f.clock.advance(4_000); // publish waits for the key
  const r = f.ctl.restoreNow(); // re-fetch: state inflight
  g.open();
  f.w.keyGate = null;
  await settle();
  assert.equal(f.w.sendAttempts, 0, 'runPublish re-checked canPublish after the key await');
  assert.deepEqual(await r, { kind: 'none' });
  await f.clock.advance(4_000);
  assert.equal(f.w.sends.length, 1, 'pending backup re-armed after restore');
});

// --- (4) node switch vs account switch -------------------------------------------------

test('node switch mid-publish (client only): nothing sent on the old client, re-armed once on the new one (negative: 0.56.0 never re-arms)', async () => {
  for (const flavor of ['fixed', 'legacy'] as const) {
    const f = world(flavor);
    f.addKey('k1');
    await settle();
    const g = gate();
    f.w.keyGate = g.p;
    await f.clock.advance(4_000); // publish waits for the key
    f.switchNode('node2');
    g.open();
    f.w.keyGate = null;
    await settle();
    assert.equal(f.w.sendAttempts, 0, `${flavor}: stale client -> nothing sent`);
    await f.clock.advance(60_000);
    if (flavor === 'fixed') {
      assert.equal(f.w.sends.length, 1, 'exactly one re-armed publish');
      assert.equal(f.w.sends[0].client, 'node2');
    } else {
      assert.equal(f.w.sends.length, 0, 'legacy: the backup was silently dropped');
    }
  }
});

test('account switch mid-publish: no re-arm, A\'s keyring never reaches B', async () => {
  const f = world();
  f.addKey('kA');
  await settle();
  const g = gate();
  f.w.keyGate = g.p;
  await f.clock.advance(4_000);
  // No session clear: test the controller's own re-arm decision in the window.
  f.switchAccount('B', false);
  const fetchBefore = f.w.fetchCalls;
  g.open();
  f.w.keyGate = null;
  await settle();
  await f.clock.advance(60_000);
  assert.equal(f.w.sendAttempts, 0);
  assert.equal(f.w.fetchCalls, fetchBefore, 'no re-armed restore/publish for B');
  assert.equal(f.clock.timers.size, 0);
});

test('node switch during restore: retried once on the new client, ensureRestored still resolves done', async () => {
  const f = world();
  f.seedRemote('A', { old: 1 });
  const g = gate();
  f.w.fetchGate = g.p;
  const p = f.ctl.ensureRestored();
  await settle();
  f.switchNode('node2');
  f.w.fetchGate = null;
  g.open();
  assert.equal(await p, 'done');
  assert.equal(f.w.fetchCalls, 2);
  assert.deepEqual(f.w.local, { old: 1 });
});

test('account switch with clearSession: the old run writes nothing, B restores for itself', async () => {
  const f = world();
  f.seedRemote('A', { a: 1 });
  f.seedRemote('B', { b: 2 });
  const g = gate();
  f.w.fetchGate = g.p;
  f.ctl.tryRestore();
  await settle();
  f.switchAccount('B');
  g.open();
  f.w.fetchGate = null;
  await settle();
  assert.deepEqual(f.w.local, {}, "A's keys never imported into B's session");
  assert.equal(f.ctl.status().restore, 'idle');
  assert.equal(await f.ctl.ensureRestored(), 'done');
  assert.deepEqual(f.w.local, { b: 2 });
});

test('restoreNow reports restored N / none / failed / blocked, and a failed re-fetch keeps the session done', async () => {
  const f = world();
  f.seedRemote('A', { a: 1, b: 2 });
  assert.deepEqual(await f.ctl.restoreNow(), { kind: 'restored', n: 2 });
  f.w.fetchFails = true;
  assert.deepEqual(await f.ctl.restoreNow(), { kind: 'failed' });
  assert.equal(f.ctl.status().restore, 'done', 'transient failure does not downgrade done');

  const g = world();
  assert.deepEqual(await g.ctl.restoreNow(), { kind: 'none' });
  const h = world();
  h.seedRemote('A', { a: 1 }, 'Z');
  assert.deepEqual(await h.ctl.restoreNow(), { kind: 'blocked', reason: 'unreadable' });
  const i = world();
  i.w.fetchFails = true;
  assert.deepEqual(await i.ctl.restoreNow(), { kind: 'failed' });
});

// --- W1: "Replace backup" is bound to the account the user confirmed for -----

/** Both accounts' vaults are unreadable here, so both reach `blocked`. */
function twoBlockedAccounts() {
  const f = world();
  f.seedRemote('A', { onlyInA: 1 }, 'Z');
  f.seedRemote('B', { onlyInB: 2 }, 'Z');
  return f;
}

test('Replace: account switch while the confirm is open -> stale, nothing sent, B\'s vault untouched (negative: an unbound call overwrites it)', async () => {
  const f = twoBlockedAccounts();
  f.w.local = { a: 1 };
  assert.equal(await f.ctl.ensureRestored(), 'blocked');
  // SettingsScreen captures the account BEFORE opening the confirm.
  const forA = captureFor(f);
  f.switchAccount('B');
  f.w.local = { b: 2 };
  assert.equal(await f.ctl.ensureRestored(), 'blocked', 'B is blocked too');
  const bBefore = structuredClone(f.w.remote.get('B'));
  // The user now presses Replace in the dialog opened for A.
  assert.equal(await f.ctl.replace(forA), 'stale');
  await f.clock.advance(60 * 60_000);
  assert.equal(f.w.sendAttempts, 0, 'nothing published');
  assert.deepEqual(f.w.remote.get('B'), bBefore, "B's remote vault untouched");
  assert.equal(f.ctl.status().restore, 'blocked', 'B stays blocked, waiting for ITS user');

  // Negative control: the pre-fix call shape (account captured after the confirm).
  const g = twoBlockedAccounts();
  g.w.local = { a: 1 };
  assert.equal(await g.ctl.ensureRestored(), 'blocked');
  g.switchAccount('B');
  g.w.local = { b: 2 };
  assert.equal(await g.ctl.ensureRestored(), 'blocked');
  assert.equal(await g.ctl.replace(), 'published', 'unbound call acts for whoever is active');
  assert.deepEqual(g.w.remote.get('B')?.keyring, { b: 2 }, "B's vault overwritten without B's confirmation");
});

test('Replace: an A->B->A round trip while the confirm is open is also stale', async () => {
  const f = twoBlockedAccounts();
  f.w.local = { a: 1 };
  assert.equal(await f.ctl.ensureRestored(), 'blocked');
  const forA = captureFor(f);
  f.switchAccount('B');
  f.switchAccount('A');
  f.w.local = { a: 1 };
  assert.equal(await f.ctl.ensureRestored(), 'blocked');
  assert.equal(await f.ctl.replace(forA), 'stale');
  assert.equal(f.w.sendAttempts, 0);
});

test('Replace: a node switch alone (same account) while the confirm is open still publishes, on the NEW node', async () => {
  const f = twoBlockedAccounts();
  f.w.local = { a: 1 };
  assert.equal(await f.ctl.ensureRestored(), 'blocked');
  const forA = captureFor(f);
  f.switchNode('node2');
  assert.equal(await f.ctl.replace(forA), 'published');
  assert.equal(f.w.sends.length, 1);
  assert.equal(f.w.sends[0].as, 'A');
  assert.equal(f.w.sends[0].client, 'node2');
  assert.deepEqual(f.w.remote.get('A')?.keyring, { a: 1 });
});

test('Replace: account switch while waiting for an in-flight publish -> stale, no second send', async () => {
  const f = world();
  f.addKey('k1');
  await settle();
  const g = gate();
  f.w.sendGate = g.p;
  await f.clock.advance(4_000); // A's debounced publish is now in flight (gated)
  assert.equal(f.w.sendAttempts, 1);
  // A re-fetch now finds an unreadable vault -> blocked while the publish flies.
  f.seedRemote('A', { other: 1 }, 'Z');
  assert.deepEqual(await f.ctl.restoreNow(), { kind: 'blocked', reason: 'unreadable' });
  const forA = captureFor(f);
  const p = f.ctl.replace(forA);
  await settle();
  f.switchAccount('B', false);
  f.w.sendGate = null;
  g.open();
  assert.equal(await p, 'stale');
  await settle();
  assert.equal(f.w.sendAttempts, 1, 'only the flight that was already running');
});
