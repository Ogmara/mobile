/**
 * Multi-account index — the pure, storage-agnostic core.
 *
 * SecureStore has **no key-enumeration API**, so the index is the only way to
 * find an account's key slot. That makes the index a single point of wallet
 * loss, and it is why this module exists separately from `vault.ts`: every
 * rule here is unit-testable against in-memory fakes, including crash
 * injection, without pulling in React Native.
 *
 * The pure functions here are unit-tested directly; the storage-touching
 * logic that consumes them lives in `vault.ts` and is not.
 *
 * Defence in depth against a lost index:
 *   1. a primary index in AsyncStorage (carries labels),
 *   2. a mirror in SecureStore (addresses only, size-capped),
 *   3. a RECOVERY SCAN over `<base>::<address>` preference keys.
 * `mergeIndexes` unions all three and never silently drops an entry.
 */

/** One account as recorded in the index. */
export interface AccountEntry {
  /** Wallet address (`klv1…`). The identity everything else is keyed by. */
  a: string;
  /** User-supplied label, or null to fall back to the display name. */
  label: string | null;
  /** How the wallet is held: built-in vault, or an external K5 delegation. */
  source: 'builtin' | 'k5-delegation';
  /** For K5: the external wallet address the device key acts for. */
  external?: string;
  /** Unix ms when the account was added. */
  added: number;
}

/** SecureStore keys. `:` is ILLEGAL there (`/^[\w.-]+$/`) — use `.` only. */
export const SS = {
  legacyRaw: 'ogmara.vault.private_key',
  legacyEnc: 'ogmara.vault.encrypted_key',
  legacyMode: 'ogmara.vault.mode',
  version: 'ogmara.vault.version',
  mirror: 'ogmara.vault.accounts',
  active: 'ogmara.vault.active',
  pending: 'ogmara.vault.v3_pending',
  rawFor: (a: string) => `ogmara.vault.private_key.${a}`,
  encFor: (a: string) => `ogmara.vault.encrypted_key.${a}`,
  modeFor: (a: string) => `ogmara.vault.mode.${a}`,
  encPrivFor: (a: string) => `ogmara.e2e.enc_private_key.${a}`,
} as const;

/** AsyncStorage keys. `::` is the established scope separator there. */
export const AS = {
  primaryIndex: 'ogmara.vault.accounts.index',
  legacyWalletAddress: 'ogmara.wallet_address',
  legacyWalletSource: 'ogmara.wallet_source',
} as const;

/**
 * Hard cap on accounts.
 *
 * The SecureStore mirror must fit in one value (2048-byte limit). A bech32
 * address is ~62 chars, so 10 addresses as JSON is ~700 bytes — comfortably
 * under, with room for the quoting and commas. It also keeps the picker
 * usable.
 */
export const MAX_ACCOUNTS = 10;

/** SecureStore's own key rule. Anything else throws at the native layer. */
const SS_KEY_RE = /^[\w.-]+$/;

/** A syntactically usable wallet address that is safe as a SecureStore suffix. */
export function isValidAddress(a: unknown): a is string {
  return (
    typeof a === 'string' &&
    a.startsWith('klv1') &&
    a.length >= 40 &&
    a.length <= 80 &&
    /^[a-z0-9]+$/.test(a) &&
    SS_KEY_RE.test(SS.rawFor(a))
  );
}

/** Parse the primary index, tolerating any malformed content. */
export function parseIndex(raw: string | null): AccountEntry[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter((e) => e && isValidAddress(e.a)).map((e) => ({
      a: e.a,
      label: typeof e.label === 'string' ? e.label : null,
      source: e.source === 'k5-delegation' ? 'k5-delegation' : 'builtin',
      ...(typeof e.external === 'string' ? { external: e.external } : {}),
      added: typeof e.added === 'number' ? e.added : 0,
    }));
  } catch {
    return [];
  }
}

/** Parse the SecureStore mirror (addresses only). */
export function parseMirror(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isValidAddress) : [];
  } catch {
    return [];
  }
}

/**
 * Recover addresses from namespaced preference keys (`<base>::<address>`).
 *
 * Any account that ever stored a preference leaves these behind, so this finds
 * accounts even when BOTH indexes are gone. The caller still probes for a key
 * slot before trusting a result — a preference key alone does not prove the
 * private key is present.
 */
export function parseAddressesFromScopedKeys(keys: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of keys) {
    const i = k.lastIndexOf('::');
    if (i < 0) continue;
    const candidate = k.slice(i + 2);
    if (isValidAddress(candidate)) out.add(candidate);
  }
  return [...out];
}

/**
 * Union the three sources, preserving the richest entry for each address.
 *
 * Order matters only for metadata: the primary index has labels, so it wins on
 * conflict. Nothing is ever dropped for being absent from one source — that is
 * the whole point.
 */
export function mergeIndexes(
  primary: AccountEntry[],
  mirror: string[],
  recovered: string[],
): AccountEntry[] {
  const byAddr = new Map<string, AccountEntry>();
  for (const e of primary) byAddr.set(e.a, e);
  for (const a of [...mirror, ...recovered]) {
    if (!byAddr.has(a)) {
      byAddr.set(a, { a, label: null, source: 'builtin', added: 0 });
    }
  }
  // Order matters for more than the picker: callers CAP this list, so whatever
  // sorts last is what gets evicted.
  //
  // Entries recovered from the scan or the mirror have no timestamp
  // (`added: 0`). Sorting purely ascending therefore put those FIRST and
  // evicted every real, indexed account — turning a cap meant to bound work
  // into a way to lose accounts. Real entries (added > 0) now sort ahead of
  // timestamp-less ones, so a cap sheds unconfirmed candidates first.
  return [...byAddr.values()].sort((x, y) => {
    const xReal = x.added > 0 ? 0 : 1;
    const yReal = y.added > 0 ? 0 : 1;
    if (xReal !== yReal) return xReal - yReal;
    return x.added - y.added || x.a.localeCompare(y.a);
  });
}

/** Serialize the mirror, enforcing the size cap. */
export function serializeMirror(entries: AccountEntry[]): string {
  return JSON.stringify(entries.slice(0, MAX_ACCOUNTS).map((e) => e.a));
}
