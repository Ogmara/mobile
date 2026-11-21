/**
 * Inbound deep links: every link resolves through `resolveInboundPath`
 * (SDK `parsePermalink` for chat / news / join) before React Navigation's real
 * `getStateFromPath` maps it to a screen. Run with:
 *   node --test src/lib/deepLinkPaths.test.ts
 *
 * For an `ogmara://` link React Navigation strips the prefix before calling
 * `getStateFromPath`, so the path under test is what follows `ogmara://`; for
 * `https://ogmara.org/app/#/…` it is `/#/…`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getStateFromPath } from '@react-navigation/core';
import {
  linkingConfig, normalizeLinkPath, resolveInboundPath, pathFromInboundUrl, chatPushTarget, permalinkFromRoute,
} from './deepLinkPaths.ts';
import { buildChatShareUrl, buildNewsShareUrl, buildChannelInviteUrl } from './share.ts';

const INV = 'AbC-_9xyZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTU';
const NODE = 'https://node.example.org:41721';
const A = 'a'.repeat(64);
const U = 'F'.repeat(64);

/** Resolve an inbound path the way deepLinks.ts does, to the leaf route. */
function leaf(path: string): { name: string; params?: Record<string, unknown> } | undefined {
  const resolved = resolveInboundPath(path);
  if (!resolved) return undefined;
  let state: any = getStateFromPath(resolved, linkingConfig as any);
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
  assert.equal(normalizeLinkPath('#/join/1'), 'join/1');
  assert.equal(normalizeLinkPath('join/1'), 'join/1');
  assert.equal(normalizeLinkPath('/#join/1'), 'join/1');
  // https form without the hash route is not the share base
  assert.equal(normalizeLinkPath('/join/1'), null);
  assert.equal(normalizeLinkPath('/?x=1#/join/1'), null);
});

test('chat permalink: lands on ChannelMessages with a lower-cased msgId', () => {
  const r = leaf(`chat/12?msg=${U}`);
  assert.equal(r?.name, 'ChannelMessages');
  assert.equal(r?.params?.channelId, '12');
  assert.equal(r?.params?.msgId, U.toLowerCase());
  assert.equal(r?.params?.fromLink, '1');
  // https form (prefix `https://ogmara.org/app` stripped by React Navigation)
  assert.equal(leaf(`/#/chat/12?msg=${A}`)?.params?.msgId, A);
  // non-hash https paths are rejected (exact base `…/app/#/` only)
  assert.equal(resolveInboundPath(`/app/#/chat/12?msg=${A}`), null);
  assert.equal(resolveInboundPath(`/chat/12?msg=${A}`), null);
});

test('channel/ is an alias of chat/ (push + older links), with and without msg', () => {
  const r = leaf('channel/5');
  assert.equal(r?.name, 'ChannelMessages');
  assert.equal(r?.params?.channelId, '5');
  assert.equal(r?.params?.msgId, undefined);
  assert.equal(leaf(`channel/5?msg=${A}`)?.params?.msgId, A);
  assert.equal(resolveInboundPath('channel/5'), 'chat/5?fromLink=1');
  assert.equal(r?.params?.fromLink, '1');
  // the alias also matches directly in the route table
  const s: any = getStateFromPath('channel/9', linkingConfig as any);
  assert.ok(JSON.stringify(s).includes('ChannelMessages'));
});

test('a malformed target is dropped, the channel still opens; never echoed', () => {
  const r = leaf('chat/7?msg=nothex');
  assert.equal(r?.name, 'ChannelMessages');
  assert.equal(r?.params?.channelId, '7');
  assert.equal(r?.params?.msgId, undefined);
  assert.equal(r?.params?.msg, undefined);
  // a raw `msgId=` / `fromLink=` supplied by the link itself never reaches the screen
  assert.equal(leaf(`chat/7?msgId=${A}`)?.params?.msgId, undefined);
  assert.equal(leaf('chat/7?fromLink=0')?.params?.fromLink, '1');
  assert.equal(r?.params?.fromLink, '1');
  // repeated keys rejected by the parser → bare channel
  assert.equal(leaf(`chat/7?msg=${A}&msg=${A}`)?.params?.msgId, undefined);
});

test('invalid channel ids / unknown routes are rejected outright', () => {
  for (const p of ['chat/0', 'chat/07', 'chat/-1', 'chat/1e3', 'chat/9007199254740993', `chat/7/x?msg=${A}`, 'channel/abc', 'evil/1', '', 'join/0']) {
    assert.equal(resolveInboundPath(p), null, p);
  }
  assert.equal(resolveInboundPath('x'.repeat(9000)), null);
});

test('news post + comment permalinks', () => {
  const r = leaf(`news/${U}`);
  assert.equal(r?.name, 'NewsDetail');
  assert.equal(r?.params?.msgId, U.toLowerCase());
  const c = leaf(`news/${A}?c=${U}`);
  assert.equal(c?.name, 'NewsDetail');
  assert.equal(c?.params?.commentId, U.toLowerCase());
  // bad comment id → post only
  const bad = leaf(`news/${A}?c=zz`);
  assert.equal(bad?.params?.msgId, A);
  assert.equal(bad?.params?.commentId, undefined);
  assert.equal(resolveInboundPath('news/zz'), null);
  assert.equal(leaf('news')?.name, 'NewsFeed');
});

test('join: unsafe node / inv are dropped by the parser; legacy double-encoded node recovered', () => {
  const r = leaf('join/77?node=javascript%3Aalert(1)');
  assert.equal(r?.name, 'ChannelJoin');
  assert.equal(r?.params?.node, undefined);
  assert.equal(leaf('join/77?node=https%3A%2F%2Fogmara.org%40evil.example')?.params?.node, undefined);
  const legacy = leaf(`join/77?node=${encodeURIComponent(encodeURIComponent(NODE))}`);
  assert.equal(legacy?.params?.node, NODE);
});

test('non-permalink routes pass through without their query', () => {
  assert.equal(leaf('user/klv1abc')?.name, 'UserProfile');
  assert.equal(leaf('dm/klv1abc')?.name, 'DmConversation');
  assert.equal(resolveInboundPath('dm/klv1abc?evil=1'), 'dm/klv1abc');
  assert.equal(leaf('settings')?.name, 'Settings');
  assert.equal(resolveInboundPath('dm/klv1abc/../x'), null);
});

test('the config has no conflicting patterns: every documented link resolves without throwing', () => {
  assert.equal(leaf('user/klv1abc')?.name, 'UserProfile');
  assert.equal(leaf(`news/${A}`)?.name, 'NewsDetail');
  assert.equal(leaf('dm/klv1abc')?.name, 'DmConversation');
  assert.equal(leaf('chat/5')?.name, 'ChannelMessages');
  assert.equal(leaf('channels')?.name, 'ChannelList');
});

test('every link this client builds resolves back to its target', () => {
  const via = (url: string) => leaf(pathFromInboundUrl(url)!);
  const chat = via(buildChatShareUrl(9, A)!);
  assert.equal(chat?.name, 'ChannelMessages');
  assert.equal(chat?.params?.msgId, A);
  const news = via(buildNewsShareUrl(A, U)!);
  assert.equal(news?.params?.commentId, U.toLowerCase());
  const join = via(buildChannelInviteUrl(3, NODE)!);
  assert.equal(join?.params?.node, NODE);
  assert.equal(pathFromInboundUrl('https://ogmara.org.evil.tld/app/#/chat/1'), null);
  assert.equal(pathFromInboundUrl('http://ogmara.org/app/#/chat/1'), null);
  assert.equal(pathFromInboundUrl('https://ogmara.org/#/chat/1'), null);
  assert.equal(pathFromInboundUrl('https://ogmara.org/app/chat/1'), null);
  assert.equal(pathFromInboundUrl('https://ogmara.org/application#/chat/1'), null);
  assert.equal(pathFromInboundUrl('https://ogmara.org/app/#/chat/1'), '/#/chat/1');
});

test('mention push target: validated through the permalink parser', () => {
  assert.deepEqual(chatPushTarget('12', U), { channelId: 12, msgId: U.toLowerCase() });
  assert.deepEqual(chatPushTarget(12, 'nope'), { channelId: 12 });
  assert.deepEqual(chatPushTarget(12, undefined), { channelId: 12 });
  assert.deepEqual(chatPushTarget('12', `${A}&msg=${A}`), { channelId: 12 });
  assert.equal(chatPushTarget('0', A), null);
  assert.equal(chatPushTarget('12abc', A), null);
  assert.equal(chatPushTarget(undefined, A), null);
  assert.equal(permalinkFromRoute(`chat/1?msg=${A}`)?.kind, 'chat');
});
