/**
 * Local date/time formatting — shared so every screen shows timestamps the
 * same way. Ported from the web client's `news-utils.formatLocalTime` so a
 * post reads identically across platforms.
 */

/**
 * A timestamp as the user's local date + time.
 * - today  → `14:32`
 * - older  → `Sep 1, 14:32`
 *
 * Accepts ms epoch (number) or anything `new Date()` parses.
 */
export function formatDateTime(timestamp: string | number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Date only (no time-of-day) — `Sep 1, 2026`. */
export function formatDate(timestamp: string | number | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}
