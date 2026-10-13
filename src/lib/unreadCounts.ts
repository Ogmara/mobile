/**
 * Parse the node's `GET /api/v1/channels/unread` response
 * (`OgmaraClient.getUnreadCounts()`) into a `channelId -> count` map.
 *
 * The wire shape is `{ unread: { "<channelId>": n }, mentions?: { ... } }` —
 * JSON object keys, so channel ids arrive as STRINGS. Mobile used to read a
 * `resp.channels[].unread_count` array that the node has never returned, so
 * the map was always empty and channel unread badges never rendered.
 *
 * Pure (no React Native imports) so it is testable under plain `node --test`.
 * Defensive against a malformed / hostile node response: non-object input,
 * non-integer keys and non-positive / non-finite counts are dropped, and the
 * result is a null-prototype object so a `__proto__` key can't do anything.
 */
export function parseUnreadMap(map: unknown): Record<number, number> {
  const out: Record<number, number> = Object.create(null);
  if (!map || typeof map !== 'object' || Array.isArray(map)) return out;
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (!/^\d+$/.test(k)) continue;
    const id = Number(k);
    if (!Number.isSafeInteger(id)) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) continue;
    const count = Math.floor(n);
    if (count < 1) continue;
    out[id] = count;
  }
  return out;
}

/** `resp.unread` of a `getUnreadCounts()` response; tolerates a null/garbage response. */
export function parseUnreadCounts(resp: unknown): Record<number, number> {
  return parseUnreadMap((resp as { unread?: unknown } | null | undefined)?.unread);
}
