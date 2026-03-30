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

/** Token balance entry from the Klever API. */
export interface TokenBalance {
  assetId: string;
  assetName?: string;
  balance: number;
  precision: number;
  frozenBalance?: number;
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
        assets[assetId] = {
          assetId,
          assetName: (data.assetName as string) || assetId,
          balance: (data.balance as number) || 0,
          precision: (data.precision as number) || 6,
          frozenBalance: (data.frozenBalance as number) || 0,
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
