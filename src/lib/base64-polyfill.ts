/**
 * Minimal global `atob`/`btoa` polyfill for Hermes.
 *
 * Hermes does not reliably provide `atob`/`btoa`. The SDK's SC node discovery
 * (`sc_discovery.ts` → `base64ToBytes` uses bare `atob`) and DM payload decoding
 * depend on them, so install a pure-JS implementation if the runtime lacks one.
 * Standard base64 only (no URL-safe variant); pure ASCII in/out, matching the
 * browser semantics the SDK expects. Must be imported before any SDK usage.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function polyAtob(input: string): string {
  const str = String(input).replace(/=+$/, '');
  let output = '';
  if (str.length % 4 === 1) {
    throw new Error("Failed to execute 'atob': invalid base64 length");
  }
  let bc = 0;
  let bs = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charAt(i);
    const idx = B64.indexOf(ch);
    if (idx === -1) continue; // skip whitespace/garbage like the browser does
    bs = bc % 4 ? bs * 64 + idx : idx;
    if (bc++ % 4) {
      output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
    }
  }
  return output;
}

function polyBtoa(input: string): string {
  const str = String(input);
  let output = '';
  for (let block = 0, charCode, i = 0, map = B64; str.charAt(i | 0) || ((map = '='), i % 1); output += map.charAt(63 & (block >> (8 - (i % 1) * 8)))) {
    charCode = str.charCodeAt((i += 3 / 4));
    if (charCode > 0xff) {
      throw new Error("Failed to execute 'btoa': character out of range");
    }
    block = (block << 8) | charCode;
  }
  return output;
}

const g = globalThis as unknown as { atob?: (s: string) => string; btoa?: (s: string) => string };
if (typeof g.atob !== 'function') g.atob = polyAtob;
if (typeof g.btoa !== 'function') g.btoa = polyBtoa;
