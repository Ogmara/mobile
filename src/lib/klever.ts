/**
 * Klever blockchain API client — fetches account balances and info.
 *
 * Uses the Klever API (api.testnet.klever.org or api.mainnet.klever.org)
 * to query on-chain data. URL is configurable via settings.
 *
 * Per memory: never hardcode URLs, always user-configured.
 * Default: testnet (per testnet-first development rule).
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

export type KleverNetwork = 'testnet' | 'mainnet';

const NETWORK_KEY = 'ogmara.klever_network';

const API_URLS: Record<KleverNetwork, string> = {
  testnet: 'https://api.testnet.klever.org',
  mainnet: 'https://api.mainnet.klever.org',
};

/** Get the currently selected Klever network. */
export async function getKleverNetwork(): Promise<KleverNetwork> {
  const saved = await AsyncStorage.getItem(NETWORK_KEY).catch(() => null);
  return saved === 'mainnet' ? 'mainnet' : 'testnet';
}

/** Set the Klever network (testnet or mainnet). */
export async function setKleverNetwork(network: KleverNetwork): Promise<void> {
  await AsyncStorage.setItem(NETWORK_KEY, network);
}

/** Get the Klever API base URL for the current network. */
export async function getKleverApiUrl(): Promise<string> {
  const network = await getKleverNetwork();
  return API_URLS[network];
}

/** A staking/freeze bucket for an asset. */
export interface StakeBucket {
  /** Bucket id (hex) — referenced by unfreeze/delegate/undelegate. */
  id: string;
  /** Frozen amount (atomic). */
  balance: number;
  /** Validator owner address this bucket is delegated to, or '' if undelegated. */
  delegation: string;
  /** Validator display name, if known. */
  validatorName?: string;
  /** 4294967295 (max u32) while still staked; a real epoch once unfrozen (withdrawable later). */
  unstakedEpoch: number;
}

/** Token balance entry from the Klever API. */
export interface TokenBalance {
  assetId: string;
  assetName?: string;
  balance: number;
  precision: number;
  frozenBalance?: number;
  unfrozenBalance?: number;
  buckets?: StakeBucket[];
  /** Whether this asset supports staking (account.assets[x].stakingType). */
  stakingType?: number;
}

/** Claimable rewards for an asset (from the allowance endpoint). */
export interface AssetRewards {
  /** Claimable staking/delegation rewards (atomic). */
  stakingRewards: number;
  /** Claimable allowance/KDA-pool rewards (atomic). */
  allowance: number;
}

/** A validator available for KLV delegation. */
export interface Validator {
  /** Owner address — the delegation target. */
  address: string;
  name: string;
  /** Commission in basis points (10000 = 100%). */
  commission: number;
  totalStake: number;
  canDelegate: boolean;
  logo?: string;
}

const STAKE_EPOCH_MAX = 4294967295;
/** True when a bucket is still actively staked (not yet unfrozen). */
export function isBucketStaked(b: StakeBucket): boolean {
  return b.unstakedEpoch >= STAKE_EPOCH_MAX;
}

/** Account data from the Klever API. */
export interface KleverAccount {
  address: string;
  balance: number;
  frozenBalance: number;
  assets: Record<string, TokenBalance>;
  nonce: number;
}

/**
 * Fetch account data (balances, nonce) from the Klever API.
 *
 * Endpoint: GET /v1.0/address/{address}
 * Returns null on error (network down, invalid address, etc.)
 */
export async function fetchAccountData(address: string): Promise<KleverAccount | null> {
  try {
    const apiUrl = await getKleverApiUrl();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(`${apiUrl}/v1.0/address/${address}`, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!resp.ok) return null;

    const json = await resp.json();
    const account = json?.data?.account;
    if (!account) return null;

    // Parse token balances
    const assets: Record<string, TokenBalance> = {};
    if (account.assets) {
      for (const [assetId, assetData] of Object.entries(account.assets)) {
        const data = assetData as Record<string, unknown>;
        const rawBuckets = Array.isArray(data.buckets) ? (data.buckets as Record<string, unknown>[]) : [];
        const buckets: StakeBucket[] = rawBuckets.map((b) => ({
          id: (b.id as string) || '',
          balance: (b.balance as number) || 0,
          delegation: (b.delegation as string) || '',
          validatorName: (b.validatorName as string) || undefined,
          unstakedEpoch: (b.unstakedEpoch as number) ?? STAKE_EPOCH_MAX,
        })).filter((b) => b.id);
        assets[assetId] = {
          assetId,
          assetName: (data.assetName as string) || assetId,
          balance: (data.balance as number) || 0,
          precision: (data.precision as number) || 6,
          frozenBalance: (data.frozenBalance as number) || 0,
          unfrozenBalance: (data.unfrozenBalance as number) || 0,
          buckets,
          stakingType: (data.stakingType as number) || 0,
        };
      }
    }

    return {
      address: account.address || address,
      balance: account.balance || 0,
      frozenBalance: account.frozenBalance || 0,
      assets,
      nonce: account.nonce || 0,
    };
  } catch {
    return null;
  }
}

/** Fetch claimable rewards for an asset (staking + allowance). Best-effort. */
export async function fetchAssetRewards(address: string, assetId: string): Promise<AssetRewards> {
  try {
    const apiUrl = await getKleverApiUrl();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch(`${apiUrl}/v1.0/address/${address}/allowance?asset=${encodeURIComponent(assetId)}`, {
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return { stakingRewards: 0, allowance: 0 };
    const json = await resp.json();
    const r = json?.data?.result ?? {};
    return {
      stakingRewards: Number(r.stakingRewards) || 0,
      allowance: Number(r.allowance) || 0,
    };
  } catch {
    return { stakingRewards: 0, allowance: 0 };
  }
}

/** Fetch validators available for KLV delegation (delegatable, sorted by stake). Best-effort. */
export async function fetchValidators(): Promise<Validator[]> {
  try {
    const apiUrl = await getKleverApiUrl();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);
    const resp = await fetch(`${apiUrl}/v1.0/validator/list?limit=100`, { signal: controller.signal });
    clearTimeout(timeoutId);
    if (!resp.ok) return [];
    const json = await resp.json();
    const list: Record<string, unknown>[] = json?.data?.validators ?? [];
    return list
      .map((v) => ({
        address: (v.ownerAddress as string) || '',
        name: (v.name as string) || ((v.ownerAddress as string) || '').slice(0, 14) + '…',
        commission: Number(v.commission) || 0,
        totalStake: Number(v.totalStake) || 0,
        canDelegate: v.canDelegate !== false,
        logo: (v.logo as string) || undefined,
      }))
      .filter((v) => v.address && v.canDelegate)
      .sort((a, b) => b.totalStake - a.totalStake);
  } catch {
    return [];
  }
}

/** Format a token amount with its precision using string-based decimal shifting. */
export function formatTokenAmount(amount: number, precision: number): string {
  if (precision === 0) return amount.toString();
  const str = amount.toString().padStart(precision + 1, '0');
  const intPart = str.slice(0, str.length - precision) || '0';
  const decPart = str.slice(str.length - precision);
  // Trim trailing zeros but keep at least 2 decimal places
  const trimmed = decPart.replace(/0+$/, '').padEnd(2, '0');
  return `${intPart}.${trimmed}`;
}
