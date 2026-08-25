/**
 * Rules for the themed alert host's buttons. Run with:
 *   node --test src/lib/alertButtons.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveButtons, backdropButtonFor, shouldStack } from './alertButtons.ts';

test('no buttons -> a single cancel-styled dismiss button', () => {
  const resolved = resolveButtons(undefined, 'Done');
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].text, 'Done');
  assert.equal(resolved[0].style, 'cancel');
});

test('empty array is treated as no buttons', () => {
  assert.equal(resolveButtons([], 'OK').length, 1);
});

test('supplied buttons pass through untouched', () => {
  const buttons = [{ text: 'A' }, { text: 'B', style: 'cancel' as const }];
  assert.deepEqual(resolveButtons(buttons, 'Done'), buttons);
});

test('backdrop activates the cancel button when there is one', () => {
  const cancel = { text: 'Cancel', style: 'cancel' as const };
  const confirm = { text: 'Unstake', style: 'destructive' as const };
  assert.equal(backdropButtonFor([cancel, confirm]), cancel);
});

// The important one: tapping outside must never perform an action the user did
// not choose. A "fall back to the last button" rule would confirm this unstake.
test('backdrop activates NOTHING when no button is a cancel', () => {
  const view = { text: 'View transaction' };
  const confirm = { text: 'Unstake', style: 'destructive' as const };
  assert.equal(backdropButtonFor([view, confirm]), undefined);
});

test('backdrop picks the cancel regardless of position', () => {
  const view = { text: 'View transaction' };
  const done = { text: 'Done', style: 'cancel' as const };
  assert.equal(backdropButtonFor([view, done]), done);
});

test('stacks only above two buttons', () => {
  assert.equal(shouldStack([{ text: 'A' }]), false);
  assert.equal(shouldStack([{ text: 'A' }, { text: 'B' }]), false);
  assert.equal(shouldStack([{ text: 'A' }, { text: 'B' }, { text: 'C' }]), true);
});
