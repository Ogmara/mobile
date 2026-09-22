/**
 * Regression coverage for message-buttons payload decoding (protocol §3.3).
 * Run with: node --test src/lib/payloadDecoder.test.ts
 * (Node 24 strips simple TS type syntax natively — no build step needed.)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encode } from '@msgpack/msgpack';
import { decodeChatMessage } from './payloadDecoder.ts';

// `decodePayload()` accepts the API's actual wire shapes only (a JSON
// number-array, a base64 string, or an already-decoded object) — NOT a raw
// `Uint8Array`, which real envelopes never carry (see its own doc comment).
// `Array.from()` matches what `JSON.parse` produces for a server-serialized
// `Vec<u8>`.
function chatPayload(extra: Record<string, unknown> = {}): number[] {
  return Array.from(encode({ content: 'hi', ...extra }));
}

function button(label: string, command: string) {
  return { label, command };
}

test('decodeChatMessage extracts buttons and via_button when present', () => {
  const bytes = chatPayload({
    buttons: [{ buttons: [button('1h', '/c BTC 1h')] }],
    via_button: true,
  });
  const decoded = decodeChatMessage(bytes);
  assert.equal(decoded?.via_button, true);
  assert.equal(decoded?.buttons?.length, 1);
  assert.deepEqual(decoded?.buttons?.[0].buttons[0], { label: '1h', command: '/c BTC 1h' });
});

test('buttons is undefined and via_button is false when absent (pre-0.131 messages)', () => {
  const decoded = decodeChatMessage(chatPayload());
  assert.equal(decoded?.buttons, undefined);
  // Deliberately `false`, not `undefined` — `=== true` is an exact-type check
  // (rejects a non-boolean truthy value like the string "true"), so the
  // negative case normalizes to a real boolean too.
  assert.equal(decoded?.via_button, false);
});

test('via_button only decodes true from a literal boolean true, not a truthy non-boolean', () => {
  assert.equal(decodeChatMessage(chatPayload({ via_button: 'true' }))?.via_button, false);
  assert.equal(decodeChatMessage(chatPayload({ via_button: 1 }))?.via_button, false);
});

test('a malformed row (missing its buttons array) decodes to an empty row, not a throw', () => {
  const decoded = decodeChatMessage(chatPayload({ buttons: [{}] }));
  assert.deepEqual(decoded?.buttons, [{ buttons: [] }]);
  // The property that actually matters: a malformed `buttons` field must
  // never take the whole message's `content` down with it (both are
  // decoded by the same shared try/catch in `decodePayload`).
  assert.equal(decoded?.content, 'hi');
});

test('a non-array top-level buttons field does not blank the message content either', () => {
  const decoded = decodeChatMessage(chatPayload({ buttons: 'not-an-array' }));
  assert.equal(decoded?.buttons, undefined);
  assert.equal(decoded?.content, 'hi');
});

test('multiple rows and multiple buttons per row all decode in order', () => {
  const bytes = chatPayload({
    buttons: [
      { buttons: [button('15m', '/c BTC 15m'), button('1h', '/c BTC 1h')] },
      { buttons: [button('4h', '/c BTC 4h')] },
    ],
  });
  const rows = decodeChatMessage(bytes)?.buttons ?? [];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].buttons.length, 2);
  assert.equal(rows[1].buttons[0].label, '4h');
});

// --- Cap/sanitization re-enforcement (client mirrors the node's validation,
// since a pre-0.131 node — the entire fleet at ship time — never enforced any
// of this at encode time) ---

test('caps rows at 10 even when the wire payload claims more', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ buttons: [button('x', `/x${i}`)] }));
  const decoded = decodeChatMessage(chatPayload({ buttons: rows }));
  assert.equal(decoded?.buttons?.length, 10);
});

test('caps buttons per row at 8 even when the wire payload claims more', () => {
  const buttons = Array.from({ length: 12 }, (_, i) => button('x', `/x${i}`));
  const decoded = decodeChatMessage(chatPayload({ buttons: [{ buttons }] }));
  assert.equal(decoded?.buttons?.[0].buttons.length, 8);
});

test('caps the TOTAL button count at 40 across rows, independent of the row/per-row caps', () => {
  // 10 rows x 8/row = 80 individually-legal buttons, well over the 40 total
  // cap — this is exactly the "80 > 40" case the node-side validator (and
  // its own test suite) treats as the binding constraint.
  const rows = Array.from({ length: 10 }, (_, ri) => ({
    buttons: Array.from({ length: 8 }, (_, bi) => button('x', `/r${ri}b${bi}`)),
  }));
  const decoded = decodeChatMessage(chatPayload({ buttons: rows }));
  const total = (decoded?.buttons ?? []).reduce((n, row) => n + row.buttons.length, 0);
  assert.equal(total, 40);
});

test('a non-array top-level buttons field decodes as absent, not a throw', () => {
  assert.equal(decodeChatMessage(chatPayload({ buttons: 'not-an-array' }))?.buttons, undefined);
});

test('a non-object row (null) is treated as an empty row, not a throw', () => {
  const decoded = decodeChatMessage(chatPayload({ buttons: [null, { buttons: [button('x', '/x')] }] }));
  assert.deepEqual(decoded?.buttons?.[0], { buttons: [] });
  assert.equal(decoded?.buttons?.[1].buttons[0].label, 'x');
});

test('a non-string label/command is coerced to empty and the button is dropped, not rendered blank', () => {
  const decoded = decodeChatMessage(
    chatPayload({ buttons: [{ buttons: [{ label: { nodeType: 1 }, command: '/x' }] }] }),
  );
  assert.deepEqual(decoded?.buttons, [{ buttons: [] }]);
});

test('an empty label or command (even after sanitization strips it to empty) is dropped', () => {
  const decoded = decodeChatMessage(
    chatPayload({
      buttons: [
        {
          buttons: [
            button('', '/x'),
            button('ok', ''),
            // A label that is ONLY control/bidi codepoints sanitizes to "".
            button('‮​', '/x'),
          ],
        },
      ],
    }),
  );
  assert.deepEqual(decoded?.buttons, [{ buttons: [] }]);
});

test('label is truncated to 24 chars and command to 256, matching the node caps', () => {
  const decoded = decodeChatMessage(
    chatPayload({ buttons: [{ buttons: [button('x'.repeat(100), '/' + 'y'.repeat(500))] }] }),
  );
  assert.equal(decoded?.buttons?.[0].buttons[0].label.length, 24);
  assert.equal(decoded?.buttons?.[0].buttons[0].command.length, 256);
});

test('control and bidi codepoints are stripped from label and command (defense against a pre-0.131 node)', () => {
  const decoded = decodeChatMessage(
    chatPayload({ buttons: [{ buttons: [button('1h‮evil', '/c​BTC')] }] }),
  );
  assert.equal(decoded?.buttons?.[0].buttons[0].label, '1hevil');
  assert.equal(decoded?.buttons?.[0].buttons[0].command, '/cBTC');
});

test('ZWJ emoji sequences survive sanitization (not swept up by the bidi/control strip)', () => {
  const decoded = decodeChatMessage(
    chatPayload({ buttons: [{ buttons: [button('\u{1F468}‍\u{1F469}‍\u{1F467}', '/family')] }] }),
  );
  assert.equal(decoded?.buttons?.[0].buttons[0].label, '\u{1F468}‍\u{1F469}‍\u{1F467}');
});
