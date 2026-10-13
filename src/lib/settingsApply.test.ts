/**
 * `applyDecryptedSettings` — account-switch safety of the settings-sync apply.
 * Mutation-style: a fake "active account" flips mid-loop (inside one of the
 * awaited steps) and we assert nothing is written under the other account.
 * Run with: node --test src/lib/settingsApply.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDecryptedSettings, CHANNEL_ORG_KEY, HIDDEN_DMS_KEY, TOPIC_GROUPS_KEY,
  type SettingsApplyDeps,
} from './settingsApply.ts';

/** A fake world: one active account; every write is recorded WITH the account
 *  active at the moment it lands (what scope-resolved storage would do). */
function world(switchDuring?: string) {
  const state = { active: 'A' as string, gen: 0 };
  const writes: { kind: string; account: string }[] = [];
  const flip = (step: string) => {
    if (step === switchDuring) { state.active = 'B'; state.gen++; }
  };
  const deps: SettingsApplyDeps = {
    syncKeys: ['theme', 'lang'],
    // Like the real `setSetting`, the storage key resolves SYNCHRONOUSLY at
    // call time; the switch then lands while the write is in flight.
    setSetting: (k) => { writes.push({ kind: `setting:${k}`, account: state.active }); flip(`setSetting:${k}`); return Promise.resolve(); },
    ensureChannelOrgLoaded: async () => { flip('ensureOrg'); },
    applyRemoteOrg: () => { writes.push({ kind: 'org', account: state.active }); return [7, 8]; },
    addJoinedChannelsFor: async (address) => { flip('joined'); writes.push({ kind: 'joined', account: address }); },
    ensureHiddenDmsLoaded: async () => { flip('ensureHidden'); },
    applyRemoteHiddenDms: () => { writes.push({ kind: 'hidden', account: state.active }); },
    ensureTopicGroupsLoaded: async () => { flip('ensureTopics'); },
    applyRemoteTopicGroups: () => { writes.push({ kind: 'topics', account: state.active }); },
  };
  const startGen = state.gen;
  const stillValid = () => state.active === 'A' && state.gen === startGen;
  return { state, writes, deps, stillValid };
}

const blob = {
  theme: 'dark',
  [CHANNEL_ORG_KEY]: { v: 1 },
  lang: 'de',
  [HIDDEN_DMS_KEY]: { klv1x: 1 },
  [TOPIC_GROUPS_KEY]: { v: 1 },
};

test('no switch (control): everything applies, all under A', async () => {
  const w = world();
  assert.equal(await applyDecryptedSettings(blob, 'A', w.stillValid, w.deps), 'applied');
  assert.deepEqual(w.writes.map((x) => x.kind), ['setting:theme', 'org', 'joined', 'setting:lang', 'hidden', 'topics']);
  assert.ok(w.writes.every((x) => x.account === 'A'));
});

for (const step of ['setSetting:theme', 'ensureOrg', 'joined', 'setSetting:lang', 'ensureHidden', 'ensureTopics']) {
  test(`switch during ${step}: aborts, nothing is ever written under B`, async () => {
    const w = world(step);
    assert.equal(await applyDecryptedSettings(blob, 'A', w.stillValid, w.deps), 'aborted');
    assert.deepEqual(w.writes.filter((x) => x.account !== 'A'), [], JSON.stringify(w.writes));
  });
}

test('switch before start: nothing written at all', async () => {
  const w = world();
  w.state.active = 'B';
  assert.equal(await applyDecryptedSettings(blob, 'A', w.stillValid, w.deps), 'aborted');
  assert.deepEqual(w.writes, []);
});

test('joined channels go to the CAPTURED account even if scope moved during the write', async () => {
  const w = world('joined');
  await applyDecryptedSettings({ [CHANNEL_ORG_KEY]: { v: 1 } }, 'A', w.stillValid, w.deps);
  assert.deepEqual(w.writes.find((x) => x.kind === 'joined'), { kind: 'joined', account: 'A' });
});

test('objects-only mode ignores scalar keys; empty/garbage values are skipped', async () => {
  const w = world();
  w.deps.syncKeys = [];
  const r = await applyDecryptedSettings(
    { theme: 'dark', [HIDDEN_DMS_KEY]: null, [TOPIC_GROUPS_KEY]: 'x' }, 'A', w.stillValid, w.deps);
  assert.equal(r, 'nothing');
  assert.deepEqual(w.writes, []);
});

test('empty account never applies', async () => {
  const w = world();
  assert.equal(await applyDecryptedSettings(blob, '', w.stillValid, w.deps), 'aborted');
  assert.deepEqual(w.writes, []);
});
