/**
 * Collect, encrypt and upload the settings-sync blob, account-safely.
 *
 * Pure orchestration with injected dependencies (no React Native imports) so
 * the account-switch behaviour is testable under plain `node --test`; the real
 * wiring lives in `settingsSync.ts`.
 *
 * An upload already running when the user switches accounts used to export the
 * key first, then await ~8 more reads (settings, cache hydration), then sign
 * `syncSettings` with whatever signer the SHARED client held by then. The
 * outcomes were all wrong: account A's data sealed with B's key and posted as
 * A (undecryptable on A's devices), B's data under A's key, mixed blobs, or
 * freshly-reset EMPTY caches uploaded over the real synced state.
 *
 * Here: the key comes from `exportKey`, which the caller binds to the captured
 * account's OWN key (never "whoever is active"), and `stillValid()` is
 * re-checked after EVERY await and immediately before the signed upload. Any
 * failure returns `false` with nothing sent — never a partial upload.
 */

export interface SettingsUploadDeps<P> {
  /** Key of the CAPTURED account only (null if unavailable). */
  exportKey: () => Promise<string | null>;
  /** Scalar synced keys (theme, lang, …). */
  syncKeys: readonly string[];
  getSetting: (key: string) => Promise<string | null>;
  /** Object-valued caches: hydrate (async) then snapshot (sync), per blob key. */
  objects: ReadonlyArray<{ key: string; ensureLoaded: () => Promise<unknown>; get: () => unknown }>;
  /** Synchronous: derive key, encrypt, stamp `updated_at`. */
  encrypt: (hexKey: string, settings: Record<string, unknown>) => P;
  /** The signed upload. */
  send: (payload: P) => Promise<void>;
}

export async function collectAndUploadSettings<P>(
  stillValid: () => boolean,
  deps: SettingsUploadDeps<P>,
): Promise<boolean> {
  if (!stillValid()) return false;
  const hexKey = await deps.exportKey();
  if (!hexKey) throw new Error('Cannot export wallet key for encryption');
  if (!stillValid()) return false;

  const settings: Record<string, unknown> = {};
  for (const key of deps.syncKeys) {
    const v = await deps.getSetting(key);
    if (!stillValid()) return false;
    settings[key] = v;
  }
  for (const o of deps.objects) {
    // Must be hydrated first: an un-loaded cache is the module default (empty)
    // and uploading it would silently wipe the real synced state.
    await o.ensureLoaded();
    if (!stillValid()) return false;
    settings[o.key] = o.get();
  }

  const payload = deps.encrypt(hexKey, settings);
  if (!stillValid()) return false;
  await deps.send(payload);
  return true;
}
