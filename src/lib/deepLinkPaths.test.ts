/**
 * Join deep links keep `node` + `inv` intact through the linking config.
 * Run with: node --test src/lib/deepLinkPaths.test.ts
 *
 * Uses @react-navigation/core's real `getStateFromPath` (the function
 * `deepLinks.ts` wraps) with the app's real `linkingConfig`. For an
 * `ogmara://` link React Navigation strips the prefix before calling it, so
 * the path under test is what follows `ogmara://`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStateFromPath } from '@react-navigation/core';
import { linkingConfig, normalizeLinkPath } from './deepLinkPaths.ts';

const INV = 'AbC-_9xyZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU';
const NODE = 'https://node.example.org:41721';

/** Resolve a path to the leaf route `{ name, params }` it lands on. */
function leaf(path: string): { name: string; params?: Record<string, unknown> } | undefined {
  let state: any = getStateFromPath(normalizeLinkPath(path), linkingConfig as any);
  let route: any;
  while (state) {
    route = state.routes[state.index ?? state.routes.length - 1];
    state = route?.state;
  }
  return route;
}

test('ogmara://join/{id}?inv=…&node=… lands on ChannelJoin with inv and node intact', () => {
  const r = leaf(`join/4294979641?inv=${INV}&node=${encodeURIComponent(NODE)}`);
  assert.equal(r?.name, 'ChannelJoin');
  assert.equal(r?.params?.channelId, '4294979641');
  assert.equal(r?.params?.inv, INV);
  assert.equal(r?.params?.node, NODE);
});

test('param order does not matter; inv without node still arrives', () => {
  const r1 = leaf(`join/77?node=${encodeURIComponent(NODE)}&inv=${INV}`);
  assert.equal(r1?.params?.inv, INV);
  assert.equal(r1?.params?.node, NODE);
  const r2 = leaf(`join/77?inv=${INV}`);
  assert.equal(r2?.name, 'ChannelJoin');
  assert.equal(r2?.params?.inv, INV);
  assert.equal(r2?.params?.node, undefined);
});

test('hash-route form normalises to the same ChannelJoin params', () => {
  const r = leaf(`/#/join/4294979641?node=${encodeURIComponent(NODE)}&inv=${INV}`);
  assert.equal(r?.name, 'ChannelJoin');
  assert.equal(r?.params?.inv, INV);
  assert.equal(r?.params?.node, NODE);
});

test('negative control: a non-join path never yields ChannelJoin / inv', () => {
  const r = leaf(`channel/77?inv=${INV}`);
  assert.equal(r?.name, 'ChannelMessages');
  assert.notEqual(r?.name, 'ChannelJoin');
  assert.equal(normalizeLinkPath('#/join/1'), 'join/1');
  assert.equal(normalizeLinkPath('join/1'), 'join/1');
});

test('the config has no conflicting patterns: every documented link resolves without throwing', () => {
  // Regression: a duplicate `user/:address` (NewsTab + ChatTab) made
  // getStateFromPath throw for EVERY path, so no deep link worked at all.
  assert.equal(leaf('user/klv1abc')?.name, 'UserProfile');
  assert.equal(leaf('news/ab12')?.name, 'NewsDetail');
  assert.equal(leaf('dm/klv1abc')?.name, 'DmConversation');
  assert.equal(leaf('channel/5')?.name, 'ChannelMessages');
  assert.equal(leaf('settings')?.name, 'Settings');
});
