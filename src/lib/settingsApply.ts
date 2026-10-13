/**
 * Apply a DECRYPTED settings-sync blob, account-safely.
 *
 * Pure orchestration with injected dependencies (no React Native imports) so
 * the account-switch behaviour is testable under plain `node --test`; the real
 * wiring lives in `settingsSync.ts`.
 *
 * The blob was decrypted with — and belongs to — the account captured when the
 * sync started. The apply loop awaits (scalar `setSetting`, cache hydration,
 * joined-set writes) between applies, and an account switch can land in any of
 * those gaps. `stillValid()` must be re-checked after EVERY await and
 * immediately before every write; on the first failure the rest is abandoned
 * (never half-applied into the other account). The `applyRemote*` calls are
 * synchronous and resolve their storage scope synchronously, so a passing
 * check directly before one is sufficient for it. Joined-channel writes go to
 * the captured account explicitly.
 */

export const CHANNEL_ORG_KEY = 'channelOrg';
export const HIDDEN_DMS_KEY = 'hiddenDms';
export const TOPIC_GROUPS_KEY = 'topicGroups';

export interface SettingsApplyDeps {
  /** Scalar synced keys (theme, lang, …). Empty for an objects-only apply. */
  syncKeys: readonly string[];
  setSetting: (key: string, value: string) => Promise<void>;
  ensureChannelOrgLoaded: () => Promise<unknown>;
  applyRemoteOrg: (raw: unknown) => number[];
  addJoinedChannelsFor: (address: string, ids: number[]) => Promise<void>;
  ensureHiddenDmsLoaded: () => Promise<unknown>;
  applyRemoteHiddenDms: (raw: unknown) => void;
  ensureTopicGroupsLoaded: () => Promise<unknown>;
  applyRemoteTopicGroups: (raw: unknown) => void;
}

export type SettingsApplyResult = 'applied' | 'nothing' | 'aborted';

/**
 * @param account     the account the blob was decrypted for (captured at start)
 * @param stillValid  true while that account is still active AND its caches
 *                    haven't been reset since the capture
 */
export async function applyDecryptedSettings(
  settings: Record<string, unknown>,
  account: string,
  stillValid: () => boolean,
  deps: SettingsApplyDeps,
): Promise<SettingsApplyResult> {
  if (!account || !stillValid()) return 'aborted';
  let applied = false;
  for (const [k, v] of Object.entries(settings)) {
    if (v === null || v === undefined) continue;
    if (deps.syncKeys.includes(k)) {
      if (!stillValid()) return 'aborted';
      await deps.setSetting(k, String(v));
      applied = true;
      continue;
    }
    if (typeof v !== 'object') continue;
    if (k === CHANNEL_ORG_KEY) {
      // Hydrate first so the LWW comparison runs against this device's real
      // on-disk state, not the module-default empty org.
      if (!stillValid()) return 'aborted';
      await deps.ensureChannelOrgLoaded();
      if (!stillValid()) return 'aborted';
      const placed = deps.applyRemoteOrg(v);
      applied = true;
      // Auto-join channels the remote org places, into the CAPTURED account.
      if (placed.length) await deps.addJoinedChannelsFor(account, placed);
    } else if (k === HIDDEN_DMS_KEY) {
      if (!stillValid()) return 'aborted';
      await deps.ensureHiddenDmsLoaded();
      if (!stillValid()) return 'aborted';
      deps.applyRemoteHiddenDms(v);
      applied = true;
    } else if (k === TOPIC_GROUPS_KEY) {
      if (!stillValid()) return 'aborted';
      await deps.ensureTopicGroupsLoaded();
      if (!stillValid()) return 'aborted';
      deps.applyRemoteTopicGroups(v);
      applied = true;
    }
  }
  return applied ? 'applied' : 'nothing';
}
