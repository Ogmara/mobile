/**
 * Recent on-chain transactions for an address, from the Klever API.
 *
 * `GET {api}/v1.0/address/{addr}/transactions?limit=N` → recent txs. The Klever
 * tx model is contract-based and complex; we surface a minimal, robust summary
 * (hash, time, direction, counterparty) and link out to the explorer for detail.
 */

import { getKleverApiUrl } from './klever';

export interface TxSummary {
  hash: string;
  /** Unix ms. */
  timestamp: number;
  /** 'in' = received, 'out' = sent, 'self'/'other' = neither side is us. */
  direction: 'in' | 'out' | 'other';
  /** The other party's address (best-effort), or ''. */
  counterparty: string;
  /** Contract/operation label (e.g. "Transfer", "SmartContract"), best-effort. */
  kind: string;
  /** Native Klever contract type number (0=Transfer, 4=Freeze, 5=Unfreeze, 6=Delegate,
   *  7=Undelegate, 8=Withdraw, 9=Claim, 63=SmartContract), or -1 if unknown. */
  contractType: number;
}

const FETCH_TIMEOUT = 12_000;

function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Fetch the most recent transactions for `address` (best-effort, never throws). */
export async function fetchRecentTransactions(address: string, limit = 20): Promise<TxSummary[]> {
  try {
    const api = await getKleverApiUrl();
    const resp = await fetchWithTimeout(
      `${api}/v1.0/address/${encodeURIComponent(address)}/transactions?limit=${limit}`,
    );
    if (!resp.ok) return [];
    const json = await resp.json();
    const list: any[] = json?.data?.transactions ?? json?.transactions ?? [];
    if (!Array.isArray(list)) return [];
    return list.map((tx) => normalizeTx(tx, address)).filter(Boolean) as TxSummary[];
  } catch {
    return [];
  }
}

function normalizeTx(tx: any, me: string): TxSummary | null {
  const hash = typeof tx?.hash === 'string' ? tx.hash : (typeof tx?.txHash === 'string' ? tx.txHash : '');
  if (!hash) return null;
  const sender = typeof tx?.sender === 'string' ? tx.sender : '';
  // Receiver lives in the first contract's parameter (shape varies by version).
  let receiver = '';
  const c = Array.isArray(tx?.contract) ? tx.contract[0] : undefined;
  const params = c?.parameter ?? c?.Parameter ?? {};
  receiver = params?.toAddress || params?.receiver || tx?.receiver || '';
  const rawTs = tx?.timestamp ?? tx?.blockTimestamp ?? 0;
  // Klever timestamps are seconds; normalize to ms.
  const timestamp = rawTs > 1e12 ? rawTs : rawTs * 1000;
  let direction: TxSummary['direction'] = 'other';
  if (sender === me) direction = 'out';
  else if (receiver === me) direction = 'in';
  const contractType = Number(c?.type ?? c?.contractType ?? -1);
  const kind = (c?.typeString || tx?.typeString || 'Transaction') as string;
  return {
    hash,
    timestamp,
    direction,
    counterparty: direction === 'out' ? receiver : sender,
    kind: String(kind),
    contractType: Number.isFinite(contractType) ? contractType : -1,
  };
}
