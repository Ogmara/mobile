/**
 * Strip path separators, control chars, and cap length so an attacker-
 * controlled string (a peer-supplied `MediaDescriptor.name`/`mime`, or an
 * attachment's `filename`) can never escape the intended directory when used
 * as a single path segment (e.g. `new File(Paths.cache, name)`).
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 100);
  // A name that sanitizes down to exactly "." or ".." has no path separators
  // left to strip, but is still a traversal token on its own (resolves to
  // the cache dir itself / its parent) — reject those too.
  if (!cleaned || /^\.{1,2}$/.test(cleaned)) return 'file';
  return cleaned;
}

/**
 * Strip Unicode control codepoints and bidirectional override characters.
 * Used wherever we render attacker-influenceable text — chiefly message
 * button labels/commands (protocol §3.3), where a U+202E could visually
 * reverse the disclosed command text.
 *
 * Stripped ranges:
 *  - U+0000..U+001F, U+007F..U+009F : control characters
 *  - U+200E, U+200F                 : LRM / RLM marks
 *  - U+202A..U+202E                 : explicit bidi formatting
 *  - U+2066..U+2069                 : isolate-format bidi
 *  - U+2028, U+2029                 : line / paragraph separators
 *  - U+FEFF                         : BOM / zero-width no-break space
 */
const BIDI_AND_CONTROL_RE = new RegExp(
  '[' +
    '\\u0000-\\u001F\\u007F-\\u009F' +
    '\\u200E\\u200F' +
    '\\u202A-\\u202E' +
    '\\u2066-\\u2069' +
    '\\u2028\\u2029' +
    '\\uFEFF' +
  ']',
  'g',
);

export function stripBidi(s: string): string {
  if (!s) return '';
  return s.replace(BIDI_AND_CONTROL_RE, '');
}

/**
 * Every codepoint the node refuses in a self-declared, wallet-supplied
 * descriptor (protocol §3.11, reused verbatim for message button
 * `label`/`command`, protocol §3.3), mirrored from `@ogmara/sdk`'s
 * `FORBIDDEN_DESCRIPTOR_CHARS` — and from the equivalent, previously
 * duplicated locally in `ComposerSuggestions.tsx`.
 *
 * `stripBidi()` above is a STRICT SUBSET of this — it misses U+061C, U+200B,
 * U+2060-U+2064, U+FEFF, U+FFF9-U+FFFB and the U+E0000 tag block, which is
 * the primitive behind invisible-text smuggling. Since the whole point of
 * sanitizing here is defending against a node that never validated (any node
 * predating the field this string belongs to), a filter laxer than the
 * node's own defeats its own purpose.
 *
 * U+200C ZWNJ and U+200D ZWJ are deliberately NOT stripped — ZWJ is required
 * for emoji sequences and ZWNJ for Persian and Indic orthography, and
 * neither can reorder text.
 */
const FORBIDDEN_DESCRIPTOR_CHARS = new RegExp(
  '[' +
    '\\u0000-\\u001F\\u007F-\\u009F' +
    '\\u061C\\u200B\\u200E\\u200F' +
    '\\u2028\\u2029' +
    '\\u202A-\\u202E' +
    '\\u2060-\\u2064' +
    '\\u2066-\\u2069' +
    '\\uFEFF\\uFFF9-\\uFFFB' +
  ']|[\\u{E0000}-\\u{E007F}]',
  'gu',
);

/** Render-time sanitizer for any self-declared, wallet-supplied string. */
export function safeText(s: string | null | undefined): string {
  return stripBidi(s ?? '').replace(FORBIDDEN_DESCRIPTOR_CHARS, '');
}
