/**
 * `collectAndUploadSettings` — account-switch safety of the settings upload.
 * Mutation-style: the active account flips inside each awaited step in turn;
 * nothing may be uploaded. Control: no switch uploads A's data under A's key.
 * Run with: node --test src/lib/settingsUpload.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectAndUploadSettings, type SettingsUploadDeps } from './settingsUpload.ts';

type Payload = { key: string; settings: Record<string, unknown>; account: string };

function world(switchDuring?: string) {
  const state = { active: 'A', gen: 0 };
  const sent: { payload: Payload; signer: string }[] = [];
  const flip = (step: string) => { if (step === switchDuring) { state.active = 'B'; state.gen++; } };
  const deps: SettingsUploadDeps<Payload> = {
    // Bound to the CAPTURED account (A), as the real wiring does.
    exportKey: async () => { flip('exportKey'); return 'keyA'; },
    syncKeys: ['theme', 'lang'],
    getSetting: async (k) => { flip(`get:${k}`); return `${k}@${state.active}`; },
    objects: ['channelOrg', 'hiddenDms', 'topicGroups'].map((key) => ({
      key,
      ensureLoaded: async () => { flip(`ensure:${key}`); },
      get: () => `${key}@${state.active}`,
    })),
    encrypt: (hexKey, settings) => ({ key: hexKey, settings, account: state.active }),
    send: async (payload) => { flip('send'); sent.push({ payload, signer: state.active }); },
  };
  const startGen = state.gen;
  const stillValid = () => state.active === 'A' && state.gen === startGen;
  return { state, sent, deps, stillValid };
}

test('no switch (control): uploads A\'s data, sealed with A\'s key, signed as A', async () => {
  const w = world();
  assert.equal(await collectAndUploadSettings(w.stillValid, w.deps), true);
  assert.equal(w.sent.length, 1);
  const { payload, signer } = w.sent[0];
  assert.equal(payload.key, 'keyA');
  assert.equal(signer, 'A');
  assert.ok(Object.values(payload.settings).every((v) => String(v).endsWith('@A')));
});

const steps = ['exportKey', 'get:theme', 'get:lang', 'ensure:channelOrg', 'ensure:hiddenDms', 'ensure:topicGroups'];
for (const step of steps) {
  test(`switch during ${step}: nothing is uploaded`, async () => {
    const w = world(step);
    assert.equal(await collectAndUploadSettings(w.stillValid, w.deps), false);
    assert.deepEqual(w.sent, []);
  });
}

test('switch before start: nothing uploaded, key never exported', async () => {
  const w = world();
  let exported = false;
  w.deps.exportKey = async () => { exported = true; return 'keyA'; };
  w.state.active = 'B';
  assert.equal(await collectAndUploadSettings(w.stillValid, w.deps), false);
  assert.equal(exported, false);
  assert.deepEqual(w.sent, []);
});

test('missing key throws (surfaced to the manual-upload UI), nothing uploaded', async () => {
  const w = world();
  w.deps.exportKey = async () => null;
  await assert.rejects(collectAndUploadSettings(w.stillValid, w.deps));
  assert.deepEqual(w.sent, []);
});

test('negative control: the SAME harness catches a collector without the re-checks (it leaks)', async () => {
  // A naive collector — the pre-fix shape: export key, read everything, send.
  const naive = async (deps: SettingsUploadDeps<Payload>) => {
    const hexKey = await deps.exportKey();
    const settings: Record<string, unknown> = {};
    for (const k of deps.syncKeys) settings[k] = await deps.getSetting(k);
    for (const o of deps.objects) { await o.ensureLoaded(); settings[o.key] = o.get(); }
    await deps.send(deps.encrypt(hexKey!, settings));
    return true;
  };
  const w = world('get:theme');
  await naive(w.deps);
  assert.equal(w.sent.length, 1, 'naive collector uploads despite the switch');
  // ...sealed with A's key but carrying B's data and signed as B: the leak.
  assert.equal(w.sent[0].payload.key, 'keyA');
  assert.equal(w.sent[0].signer, 'B');
  assert.ok(Object.values(w.sent[0].payload.settings).some((v) => String(v).endsWith('@B')));
});
