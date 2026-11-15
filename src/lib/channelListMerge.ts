/**
 * Channel-list completion.
 *
 * `GET /channels` is paged, so a joined channel (notably a freshly created or
 * synced private one) that falls outside the first page never shows up even
 * though its id is in the joined set. This merges such channels in by
 * fetching them individually.
 */

/** Hard cap on by-id fetches per list load (a runaway joined set must not fan out). */
export const MAX_BY_ID_FETCHES = 40;

/** Run `fn` over `items` with at most `limit` in flight. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Return `listed` plus every joined channel id that `listed` lacks (most
 * recently joined first, up to the cap), fetched
 * with `fetchOne` (which returns null / throws for an unknown or inaccessible
 * channel; those are skipped). Never duplicates, never drops a listed channel.
 */
export async function mergeMissingJoined<C extends { channel_id: number }>(
  listed: C[],
  joinedIds: Iterable<number>,
  fetchOne: (id: number) => Promise<C | null>,
): Promise<C[]> {
  const have = new Set(listed.map((c) => c.channel_id));
  const missing: number[] = [];
  // Newest first (a Set keeps insertion order, so the most recently joined id
  // is last): when the cap bites, shed the OLDEST joined channels, never the
  // one just created.
  for (const id of [...joinedIds].reverse()) {
    if (Number.isSafeInteger(id) && id >= 0 && !have.has(id) && !missing.includes(id)) missing.push(id);
    if (missing.length >= MAX_BY_ID_FETCHES) break;
  }
  if (!missing.length) return listed;
  const fetched = await mapLimit(missing, 4, async (id) => {
    try { return await fetchOne(id); } catch { return null; }
  });
  const extra = fetched.filter((c): c is C => !!c && !have.has(c.channel_id));
  return extra.length ? [...listed, ...extra] : listed;
}
