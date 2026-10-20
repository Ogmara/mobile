/**
 * `isSameAccount` — guard for async flows that sign/persist after an await.
 * Run with: node --test src/lib/accountGuard.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSameAccount, isAccountContextValid, isSameAccountIgnoringClient } from './accountGuard.ts';

test('unchanged wallet + signer -> same', () => {
  assert.equal(isSameAccount({ wallet: 'klv1a', signer: 'klv1a' }, { wallet: 'klv1a', signer: 'klv1a' }), true);
});

test('K5 account: signer is the device key, not the wallet — still same', () => {
  assert.equal(isSameAccount({ wallet: 'klv1ext', signer: 'klv1dev' }, { wallet: 'klv1ext', signer: 'klv1dev' }), true);
});

test('wallet switched, or signer swapped, or either cleared -> not same', () => {
  const start = { wallet: 'klv1a', signer: 'klv1a' };
  assert.equal(isSameAccount(start, { wallet: 'klv1b', signer: 'klv1a' }), false);
  assert.equal(isSameAccount(start, { wallet: 'klv1a', signer: 'klv1b' }), false);
  assert.equal(isSameAccount(start, { wallet: null, signer: 'klv1a' }), false);
  assert.equal(isSameAccount(start, { wallet: 'klv1a', signer: undefined }), false);
});

test('an empty start snapshot never counts as same (no wallet = nothing to sign as)', () => {
  assert.equal(isSameAccount({ wallet: null, signer: null }, { wallet: null, signer: null }), false);
  assert.equal(isSameAccount({ wallet: '', signer: 'x' }, { wallet: '', signer: 'x' }), false);
});

test('switch mid-await: a flow resuming after withSigner() mutated the client aborts', async () => {
  // Model the real shapes: a live wallet ref and a client whose signer is
  // swapped IN PLACE (ConnectionContext.switchAccount -> client.withSigner).
  const walletRef = { current: 'klv1a' as string | null };
  const client = { address: 'klv1a' as string | undefined };
  const live = () => ({ wallet: walletRef.current, signer: client.address });
  const signed: string[] = [];

  const flow = async (slowStep: Promise<void>) => {
    const start = live();
    await slowStep;                         // e.g. federateChannel()
    if (!isSameAccount(start, live())) return 'aborted';
    signed.push(client.address!);           // e.g. joinChannel() — signs as client.address
    return 'joined';
  };

  let release!: () => void;
  const pending = flow(new Promise<void>((r) => { release = r; }));
  // Account switch lands while the flow is suspended.
  walletRef.current = 'klv1b';
  client.address = 'klv1b';
  release();
  assert.equal(await pending, 'aborted');
  assert.deepEqual(signed, [], 'nothing may be signed as the NEW account');

  // Control: no switch -> proceeds as the starting account.
  walletRef.current = 'klv1a'; client.address = 'klv1a';
  assert.equal(await flow(Promise.resolve()), 'joined');
  assert.deepEqual(signed, ['klv1a']);
});

// --- isAccountContextValid (settings sync + key vault) ------------------------

const client = {};
const builtin = { wallet: 'klv1a', scope: 'klv1a', gen: 3, client, signer: 'klv1a' };
// K5: crypto env AND storage scope are the EXTERNAL wallet; the signer is the
// local device key (ConnectionContext registerExternalWallet / restoreWallet).
const k5 = { wallet: 'klv1ext', scope: 'klv1ext', gen: 3, client, signer: 'klv1dev' };

test('context: built-in and K5 accounts both validate (sync does not no-op for K5)', () => {
  assert.equal(isAccountContextValid(builtin, { ...builtin }), true);
  assert.equal(isAccountContextValid(k5, { ...k5 }), true);
});

test('context: any drift invalidates', () => {
  for (const live of [
    { ...k5, wallet: 'klv1b' }, { ...k5, scope: 'klv1b' }, { ...k5, gen: 4 },
    { ...k5, client: {} }, { ...k5, signer: 'klv1other' }, { ...k5, signer: null },
  ]) {
    assert.equal(isAccountContextValid(k5, live), false, JSON.stringify(live));
  }
});

test('context: an incomplete or inconsistent START never validates', () => {
  assert.equal(isAccountContextValid({ ...k5, wallet: null }, { ...k5, wallet: null }), false);
  assert.equal(isAccountContextValid({ ...k5, signer: null }, { ...k5, signer: null }), false);
  // scope pointing at the device key instead of the wallet = not one account
  assert.equal(isAccountContextValid({ ...k5, scope: 'klv1dev' }, { ...k5, scope: 'klv1dev' }), false);
});

// --- isSameAccountIgnoringClient (key-vault node-switch re-arm, 0.57.0) -------

test('account-level: a client swap (node switch) keeps the account; every other drift does not', () => {
  assert.equal(isSameAccountIgnoringClient(k5, { ...k5, client: {} }), true);
  // ...while the strict guard still rejects the swapped client
  assert.equal(isAccountContextValid(k5, { ...k5, client: {} }), false);
  for (const live of [
    { ...k5, wallet: 'klv1b' }, { ...k5, scope: 'klv1b' }, { ...k5, gen: 4 },
    { ...k5, signer: 'klv1other' }, { ...k5, signer: null },
  ]) {
    assert.equal(isSameAccountIgnoringClient(k5, live), false, JSON.stringify(live));
  }
  assert.equal(isSameAccountIgnoringClient({ ...k5, wallet: null }, { ...k5, wallet: null }), false);
  assert.equal(isSameAccountIgnoringClient({ ...k5, scope: 'klv1dev' }, { ...k5, scope: 'klv1dev' }), false);
});
