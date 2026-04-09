/**
 * Klever transaction builder — build, sign, and broadcast Klever
 * blockchain transactions directly from the mobile app.
 *
 * Ported from desktop/src/lib/klever.ts. Uses the vault's WalletSigner
 * for Ed25519 signing. No browser extension or K5 wallet needed.
 *
 * On-chain operations: user registration, channel creation, tipping,
 * token transfers, device delegation, governance voting, key rotation.
 */

import { vaultGetSigner } from './vault';
import { getKleverNetwork } from './klever';
import type { KleverNetwork } from './klever';

// --- Network Configuration ---

interface KleverProvider {
  api: string;
  node: string;
}

const PROVIDERS: Record<KleverNetwork, KleverProvider> = {
  testnet: {
    api: 'https://api.testnet.klever.org',
    node: 'https://node.testnet.klever.org',
  },
  mainnet: {
    api: 'https://api.klever.org',
    node: 'https://node.klever.org',
  },
};

/** Ogmara KApp smart contract address. Set via setContractAddress(). */
let scAddress = '';

/** Set the smart contract address (called after fetching node stats). */
export function setContractAddress(address: string): void {
  if (address && address.startsWith('klv1') && address.length >= 40) {
    scAddress = address;
  }
}

/** Get the Kleverscan explorer base URL for the current network. */
export async function getExplorerUrl(): Promise<string> {
  const network = await getKleverNetwork();
  return network === 'testnet'
    ? 'https://testnet.kleverscan.org'
    : 'https://kleverscan.org';
}

/** Get the explorer URL for a specific transaction hash. */
export async function getExplorerTxUrl(txHash: string): Promise<string> {
  const base = await getExplorerUrl();
  return `${base}/transaction/${txHash}`;
}

// --- Helpers ---

const FETCH_TIMEOUT = 15_000;

function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
  return fetch(url, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
}

/** Minimum 2 seconds between TX submissions. */
let lastTxTime = 0;
function checkTxRateLimit(): void {
  const now = Date.now();
  if (now - lastTxTime < 2000) {
    throw new Error('Please wait a moment before sending another transaction');
  }
  lastTxTime = now;
}

function stringToHex(str: string): string {
  return Array.from(new TextEncoder().encode(str))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function numberToHex(n: number): string {
  if (n === 0) return '00';
  const hex = n.toString(16);
  return hex.length % 2 === 0 ? hex : '0' + hex;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('Invalid hex string');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Parse Klever node error responses into user-friendly messages. */
export function parseKleverError(rawText: string, status: number): string {
  const lower = rawText.toLowerCase();

  if (lower.includes('insufficient') || lower.includes('balance') || lower.includes('not enough')) {
    return 'Insufficient KLV balance for this transaction';
  }
  if (lower.includes('nil address') || lower.includes('getexistingaccount') || status === 404) {
    return 'Account not found on-chain. Send KLV to this address first.';
  }
  if (lower.includes('nonce')) {
    return 'Nonce mismatch — try again in a few seconds';
  }
  if (lower.includes('signature')) {
    return 'Signature verification failed';
  }
  try {
    const parsed = JSON.parse(rawText);
    const msg = parsed?.error || parsed?.data?.error || parsed?.message;
    if (msg) return String(msg).slice(0, 200);
  } catch { /* not JSON */ }
  return rawText.slice(0, 200) || `Transaction failed (HTTP ${status})`;
}

// --- Nonce Tracking ---

const nonceCache: Record<string, { nonce: number; ts: number }> = {};

async function getAccountNonce(address: string, provider: KleverProvider): Promise<number> {
  const resp = await fetchWithTimeout(`${provider.api}/v1.0/address/${address}`);
  if (resp.status === 404) return 0;
  if (!resp.ok) throw new Error(`Failed to fetch nonce (HTTP ${resp.status})`);
  const rawBody = await resp.text();
  let data: any;
  try { data = JSON.parse(rawBody); } catch { data = null; }
  const apiNonce: number = data?.data?.account?.nonce ?? data?.data?.account?.Nonce ?? 0;

  const cached = nonceCache[address];
  if (cached && cached.ts > Date.now() - 30_000) {
    return Math.max(apiNonce, cached.nonce + 1);
  }
  return apiNonce;
}

function recordUsedNonce(address: string, nonce: number): void {
  nonceCache[address] = { nonce, ts: Date.now() };
}

// --- Core TX Builder ---

function requireSigner() {
  const signer = vaultGetSigner();
  if (!signer) throw new Error('Wallet not available — unlock your vault first');
  return signer;
}

/**
 * Build, sign, and broadcast a transaction via the Klever node API.
 *
 * Flow:
 * 1. POST contract payload to /transaction/send → get unsigned TX
 * 2. Get TX hash via /transaction/decode
 * 3. Ed25519 sign the hash bytes
 * 4. POST signed TX to /transaction/broadcast
 *
 * @returns Transaction hash
 */
export async function buildSignBroadcast(
  contracts: Array<{ type: number; payload: Record<string, unknown> }>,
  data?: string[],
): Promise<string> {
  checkTxRateLimit();
  const signer = requireSigner();
  const network = await getKleverNetwork();
  const provider = PROVIDERS[network];

  // Step 1: Get unsigned TX
  const kleverContracts = contracts.map((c) => ({
    ...c.payload,
    contractType: c.type,
  }));
  const senderAddr = signer.walletAddress || signer.address;
  const usedNonce = await getAccountNonce(senderAddr, provider);
  const sendBody: Record<string, unknown> = {
    type: contracts[0].type,
    sender: senderAddr,
    nonce: usedNonce,
    contracts: kleverContracts,
  };
  if (data && data.length > 0) {
    sendBody.data = data;
  }

  const sendResp = await fetchWithTimeout(`${provider.node}/transaction/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sendBody),
  });
  const sendText = await sendResp.text().catch(() => '');
  let sendData: any;
  try { sendData = JSON.parse(sendText); } catch { sendData = null; }

  const rawTx = sendData?.data?.result;
  if (!rawTx?.RawData && !rawTx?.rawData) {
    if (!sendResp.ok || sendData?.error) {
      throw new Error(parseKleverError(sendText, sendResp.status));
    }
    throw new Error('Node did not return a transaction to sign');
  }

  // Step 2: Get TX hash
  let txHash = sendData?.data?.txHash || '';
  if (!txHash) {
    const decodeResp = await fetchWithTimeout(`${provider.node}/transaction/decode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rawTx),
    });
    if (decodeResp.ok) {
      const decodeData = await decodeResp.json();
      txHash = decodeData?.data?.tx?.hash || '';
    }
  }
  if (!txHash) {
    throw new Error('Could not obtain TX hash for signing');
  }

  // Step 3: Sign with Ed25519
  const hashRawBytes = hexToBytes(txHash);
  const sigBytes = await signer.signRawHash(hashRawBytes);
  const sigBase64 = btoa(String.fromCharCode(...sigBytes));

  // Step 4: Broadcast
  rawTx.Signature = [sigBase64];
  const broadcastResp = await fetchWithTimeout(`${provider.node}/transaction/broadcast`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tx: rawTx }),
  });
  const broadcastText = await broadcastResp.text().catch(() => '');
  let broadcastData: any;
  try { broadcastData = JSON.parse(broadcastText); } catch { broadcastData = {}; }

  if (!broadcastResp.ok || broadcastData?.error) {
    throw new Error(parseKleverError(broadcastText, broadcastResp.status));
  }
  const broadcastHash = broadcastData?.data?.txsHashes?.[0]
    || broadcastData?.data?.txHash
    || txHash;

  recordUsedNonce(senderAddr, usedNonce);
  return broadcastHash;
}

// --- Smart Contract Invocations ---

async function invokeContract(params: {
  functionName: string;
  args: string[];
  value?: number;
}): Promise<string> {
  if (!scAddress) {
    throw new Error('Smart contract address not configured');
  }
  const callData = [params.functionName, ...params.args].join('@');
  const payload: Record<string, unknown> = {
    scType: 0,
    address: scAddress,
    callValue: params.value ? { KLV: params.value.toString() } : {},
  };
  return buildSignBroadcast(
    [{ type: 63, payload }],
    [btoa(callData)],
  );
}

// --- On-Chain Operations ---

/** Register user on the Ogmara smart contract. Cost: ~4.4 KLV. */
export async function registerUser(publicKeyHex: string): Promise<string> {
  return invokeContract({
    functionName: 'register',
    args: [stringToHex(publicKeyHex)],
  });
}

/** Create a channel on-chain. Cost: ~4.8 KLV. Returns TX hash. */
export async function createChannelOnChain(slug: string, channelType: number): Promise<string> {
  return invokeContract({
    functionName: 'createChannel',
    args: [stringToHex(slug), numberToHex(channelType)],
  });
}

/** Wait for TX to confirm, then query SC for assigned channel_id. */
export async function getChannelIdFromTx(txHash: string, slug: string): Promise<number> {
  const network = await getKleverNetwork();
  const provider = PROVIDERS[network];
  const maxAttempts = 20;
  const delay = 2000;

  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetchWithTimeout(`${provider.api}/v1.0/transaction/${txHash}`);
      if (!resp.ok) { await sleep(delay); continue; }
      const data = await resp.json();
      const tx = data?.data?.transaction;
      if (!tx || !tx.status) { await sleep(delay); continue; }
      if (tx.status === 'fail') throw new Error(tx.resultCode || 'Transaction failed');
      if (tx.status === 'success') break;
      await sleep(delay);
    } catch (e: any) {
      if (e.message?.includes('failed')) throw e;
      await sleep(delay);
    }
  }

  const slugHex = Array.from(new TextEncoder().encode(slug))
    .map((b) => b.toString(16).padStart(2, '0')).join('');
  const vmResp = await fetchWithTimeout(`${provider.node}/vm/hex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scAddress, funcName: 'getChannelBySlug', args: [slugHex] }),
  });
  if (!vmResp.ok) throw new Error('Failed to query SC for channel ID');
  const vmData = await vmResp.json();
  const hexResult = vmData?.data?.data;
  if (!hexResult) throw new Error('Channel not found in SC after creation');
  return parseInt(hexResult, 16);
}

/** Send a KLV tip. Amount in KLV (not atomic). */
export async function sendTip(
  recipient: string,
  amountKlv: number,
  note?: string,
): Promise<string> {
  const amountAtomic = Math.round(amountKlv * 1_000_000);
  const txData = note ? [btoa(note.slice(0, 128))] : undefined;
  return buildSignBroadcast(
    [{ type: 0, payload: { receiver: recipient, amount: amountAtomic, kda: 'KLV' } }],
    txData,
  );
}

/** Send a token transfer (KLV or KDA). Amount in atomic units. */
export async function sendTransfer(
  recipient: string,
  assetId: string,
  amount: number,
): Promise<string> {
  return buildSignBroadcast([{
    type: 0,
    payload: { receiver: recipient, amount, kda: assetId },
  }]);
}

/** Delegate a device key. Cost: ~4.5 KLV. */
export async function delegateDevice(
  devicePubKeyHex: string,
  permissions: number,
  expiresAt: number,
): Promise<string> {
  return invokeContract({
    functionName: 'delegateDevice',
    args: [devicePubKeyHex, numberToHex(permissions), numberToHex(expiresAt)],
  });
}

/** Revoke a device delegation. */
export async function revokeDevice(devicePubKeyHex: string): Promise<string> {
  return invokeContract({
    functionName: 'revokeDevice',
    args: [devicePubKeyHex],
  });
}

/** Vote on a governance proposal. */
export async function voteOnProposal(proposalId: number, support: boolean): Promise<string> {
  return invokeContract({
    functionName: 'vote',
    args: [numberToHex(proposalId), support ? '01' : '00'],
  });
}

/** Rotate the user's public key on-chain. */
export async function updatePublicKey(newPublicKeyHex: string): Promise<string> {
  return invokeContract({
    functionName: 'updatePublicKey',
    args: [newPublicKeyHex],
  });
}
