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
  return formatFiat(value, 'usd', 1);
}

// --- Forex (USD → other currency), keyless via CoinGecko (tether ≈ USD peg) ---

export const SUPPORTED_CURRENCIES = ['usd', 'eur', 'brl', 'gbp', 'jpy', 'cny'] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];

const FOREX_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=tether&vs_currencies=usd,eur,brl,gbp,jpy,cny';
const FOREX_KEY = 'ogmara.forex.rates';
const FOREX_TTL_MS = 60 * 60 * 1000;
const CURRENCY_FRACTION: Record<string, number> = { usd: 2, eur: 2, brl: 2, gbp: 2, jpy: 0, cny: 2 };

let memForex: { ts: number; rates: Record<string, number> } | null = null;
let forexInFlight: Promise<Record<string, number>> | null = null;

/** Load USD→currency rates ({usd:1, eur:0.9, …}). Cache-first, stale-tolerant. */
export async function loadForex(): Promise<Record<string, number>> {
  if (!memForex) {
    try { const raw = await AsyncStorage.getItem(FOREX_KEY); if (raw) memForex = JSON.parse(raw); } catch { /* */ }
  }
  if (memForex && Date.now() - memForex.ts < FOREX_TTL_MS) return memForex.rates;
  if (forexInFlight) return forexInFlight;
  forexInFlight = (async () => {
    try {
      const resp = await fetchWithTimeout(FOREX_URL);
      const tether = (await resp.json())?.tether ?? {};
      const rates: Record<string, number> = { usd: 1 };
      for (const c of SUPPORTED_CURRENCIES) {
        const v = tether[c];
        if (c !== 'usd' && typeof v === 'number' && v > 0) rates[c] = v;
      }
      memForex = { ts: Date.now(), rates };
      AsyncStorage.setItem(FOREX_KEY, JSON.stringify(memForex)).catch(() => {});
      return rates;
    } catch {
      return memForex?.rates ?? { usd: 1 };
    } finally {
      forexInFlight = null;
    }
  })();
  return forexInFlight;
}

/** Format a USD value in the given currency using a USD→currency rate. */
export function formatFiat(usdValue: number, currency: string, rate: number): string {
  let v = Number.isFinite(usdValue) ? usdValue * (Number.isFinite(rate) && rate > 0 ? rate : 1) : 0;
  const code = (currency || 'usd').toLowerCase();
  const frac = CURRENCY_FRACTION[code] ?? 2;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: code.toUpperCase(),
      minimumFractionDigits: frac,
      maximumFractionDigits: v > 0 && v < 0.01 ? Math.max(frac, 6) : frac,
    }).format(v);
  } catch {
    return `${v.toFixed(frac)} ${code.toUpperCase()}`;
  }
}
