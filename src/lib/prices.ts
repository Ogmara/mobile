/**
 * Token price feed (mobile) — keyless bitcoin.me source.
 *
 * `GET https://api.bitcoin.me/tokens` returns one entry per KDA with `tokenInID`
 * (e.g. "KLV", "KFI", "SAME-3LRL"), `iconURL`, `price` (USD decimal string),
 * `variationPercent` (24h move) and `sparkline7d` (7-day price points). USD only on
 * mobile (no forex). Cached in AsyncStorage with a 5-minute TTL; stale cache served
 * on failure. Mirrors desktop `prices.ts`.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const BITCOIN_ME_URL = 'https://api.bitcoin.me/tokens';
const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const STALE_GRACE_MS = 24 * 60 * 60 * 1000;
const STORAGE_KEY = 'ogmara.bitcoin_me.tokens';
const MAX_CACHED_ASSETS = 5000;
const FETCH_TIMEOUT = 10_000;

/** Per-asset price data, USD-quoted. */
export interface TokenPrice {
  assetId: string;
  /** Spot price in USD. */
  usd: number;
  /** 24h change, percent. */
  change24h: number;
  /** Logo image URL, or '' if none. */
  iconUrl: string;
  /** 7-day sparkline prices (oldest→newest), may be empty. */
  sparkline: number[];
}

interface CachedPrices { ts: number; byAsset: Record<string, TokenPrice> }

let mem: CachedPrices | null = null;
let inFlight: Promise<CachedPrices | null> | null = null;

function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchNetwork(): Promise<CachedPrices> {
  const resp = await fetchWithTimeout(BITCOIN_ME_URL);
  if (!resp.ok) throw new Error(`bitcoin.me HTTP ${resp.status}`);
  const arr = await resp.json();
  if (!Array.isArray(arr)) throw new Error('bitcoin.me did not return an array');
  const byAsset: Record<string, TokenPrice> = {};
  let count = 0;
  for (const t of arr) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const assetId = typeof o.tokenInID === 'string' ? o.tokenInID : '';
    if (!assetId) continue;
    const usd = typeof o.price === 'string' ? parseFloat(o.price) : Number(o.price);
    if (!Number.isFinite(usd)) continue;
    const change24h = typeof o.variationPercent === 'number' ? o.variationPercent : 0;
    const iconUrl = typeof o.iconURL === 'string' ? o.iconURL : '';
    let sparkline: number[] = [];
    if (Array.isArray(o.sparkline7d)) {
      sparkline = (o.sparkline7d as Array<{ price?: unknown }>)
        .map((p) => (typeof p?.price === 'string' ? parseFloat(p.price) : Number(p?.price)))
        .filter((n) => Number.isFinite(n));
    }
    byAsset[assetId] = { assetId, usd, change24h, iconUrl, sparkline };
    if (++count >= MAX_CACHED_ASSETS) break;
  }
  const fresh: CachedPrices = { ts: Date.now(), byAsset };
  mem = fresh;
  AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(fresh)).catch(() => {});
  return fresh;
}

/** Load token prices keyed by assetId, cache-first with stale fallback. */
export async function loadPrices(force = false): Promise<Record<string, TokenPrice>> {
  if (!mem) {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      if (raw) mem = JSON.parse(raw) as CachedPrices;
    } catch { /* ignore */ }
  }
  if (!force && mem && Date.now() - mem.ts < PRICE_CACHE_TTL_MS) return mem.byAsset;
  if (inFlight) { const r = await inFlight; return r?.byAsset ?? mem?.byAsset ?? {}; }
  inFlight = (async () => {
    try {
      return await fetchNetwork();
    } catch {
      if (mem && Date.now() - mem.ts < STALE_GRACE_MS) return mem;
      return null;
    } finally {
      inFlight = null;
    }
  })();
  const r = await inFlight;
  return r?.byAsset ?? mem?.byAsset ?? {};
}

/** Fiat (USD) value of a whole-token amount at the given USD price. */
export function fiatValue(wholeAmount: number, usdPrice: number): number {
  if (!Number.isFinite(wholeAmount) || !Number.isFinite(usdPrice) || usdPrice <= 0) return 0;
  return wholeAmount * usdPrice;
}

/** Format a USD value for display. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) value = 0;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: value > 0 && value < 0.01 ? 6 : 2,
    }).format(value);
  } catch {
    return `$${value.toFixed(2)}`;
  }
}
