import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMultipart, createBoundary } from './multipart.ts';

const dec = new TextDecoder();

test('encodes a file part and a text field with the boundary in the content type', () => {
  const bytes = new Uint8Array([0, 1, 2, 255, 13, 10, 45, 45]);
  const { body, contentType } = buildMultipart(
    [
      { name: 'file', filename: 'a.bin', type: 'application/octet-stream', bytes },
      { name: 'encrypted', value: '1' },
    ],
    'BOUND',
  );
  assert.equal(contentType, 'multipart/form-data; boundary=BOUND');
  const text = dec.decode(body);
  assert.match(text, /^--BOUND\r\nContent-Disposition: form-data; name="file"; filename="a\.bin"\r\nContent-Type: application\/octet-stream\r\n\r\n/);
  assert.ok(text.includes('--BOUND\r\nContent-Disposition: form-data; name="encrypted"\r\n\r\n1\r\n'));
  assert.ok(text.endsWith('--BOUND--\r\n'));
  // The binary payload (incl. CRLF and dashes) is carried byte-for-byte.
  const head = new TextEncoder().encode('--BOUND\r\nContent-Disposition: form-data; name="file"; filename="a.bin"\r\nContent-Type: application/octet-stream\r\n\r\n');
  assert.deepEqual(Array.from(body.slice(head.length, head.length + bytes.length)), Array.from(bytes));
});

test('header injection through names/types is neutralised', () => {
  const { body } = buildMultipart(
    [{ name: 'fi"le\r\nX: y', filename: 'a"\r\nContent-Type: evil', type: 'image/png\r\nX: y', bytes: new Uint8Array([1]) }],
    'B',
  );
  const text = dec.decode(body);
  const headerBlock = text.split('\r\n\r\n')[0];
  assert.equal(headerBlock.split('\r\n').length, 3, 'exactly boundary + disposition + content-type lines');
  assert.ok(!headerBlock.includes('evil\r\n'));
});

test('boundary is long and differs between calls', () => {
  const a = createBoundary();
  const b = createBoundary();
  assert.ok(a.length >= 50);
  assert.notEqual(a, b);
});

test('empty parts list still yields a terminated body', () => {
  assert.equal(dec.decode(buildMultipart([], 'Z').body), '--Z--\r\n');
});
