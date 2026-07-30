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
