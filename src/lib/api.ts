/**
 * SDK client singleton + decentralized node discovery.
 *
 * There is NO hardcoded seed node. The bootstrap seed comes from on-chain SC
 * discovery (`discoverNodesViaSc` → getActiveNodes/getNodeMetadata on the Klever
 * KApp), unioned with peers advertised by the current node and the user's
 * previously-used nodes. `bootstrapNodeSelection()` lands the best-ping node on a
 * fresh install before any data fetch. Mirrors desktop `src/lib/api.ts`.
 */

import {
  OgmaraClient,
  discoverAndPingNodes,
  discoverNodesViaSc,
  pingNode,
  type NodeWithPing,
  type ScNetwork,
} from '@ogmara/sdk';
import { getSetting, setSetting } from './settings';

let client: OgmaraClient | null = null;

/** Get or create the shared SDK client instance (no hardcoded default node). */
export async function getClient(): Promise<OgmaraClient> {
  if (client) return client;
  const nodeUrl = (await getSetting('nodeUrl')) || '';
  client = new OgmaraClient({ nodeUrl, timeout: 15000 });
  return client;
}

/** Reset the client (e.g., when node URL changes). */
export function resetClient(): void {
  client = null;
}

/** The current node URL, or '' if none selected yet (fresh install before bootstrap). */
export async function getCurrentNodeUrl(): Promise<string> {
  return (await getSetting('nodeUrl')) || '';
}

/** Network the cold-boot SC node discovery targets. Persisted from the connected
 *  node's /health.network; defaults to testnet during the testnet phase. */
async function discoveryNetwork(): Promise<ScNetwork> {
  return (await getSetting('kleverNetwork')) === 'mainnet' ? 'mainnet' : 'testnet';
}

/** Persist the Klever network reported by the connected node so the next cold boot
 *  queries the right on-chain registry. */
export async function rememberNetwork(network: string | undefined): Promise<void> {
  if (network === 'mainnet' || network === 'testnet') {
    await setSetting('kleverNetwork', network);
  }
}

// ── Known-node memory (picker history) ─────────────────────────────────

/** URLs the user has successfully switched to in the past. */
export async function getKnownNodes(): Promise<string[]> {
  const raw = await getSetting('knownNodes');
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((u) => typeof u === 'string') : [];
  } catch {
    return [];
  }
}

/** Record a URL in the picker's known-node memory (idempotent). */
export async function recordKnownNode(url: string): Promise<void> {
  if (!url) return;
  const known = await getKnownNodes();
  if (known.includes(url)) return;
  known.push(url);
  await setSetting('knownNodes', JSON.stringify(known));
}

export async function removeKnownNode(url: string): Promise<void> {
  const known = await getKnownNodes();
  const next = known.filter((u) => u !== url);
  if (next.length !== known.length) await setSetting('knownNodes', JSON.stringify(next));
}

/** Switch to a different node URL (records it as a known node). */
export async function switchNode(nodeUrl: string): Promise<void> {
  await setSetting('nodeUrl', nodeUrl);
  await recordKnownNode(nodeUrl);
  resetClient();
}

// ── Discovery ──────────────────────────────────────────────────────────

/** Drop SC-registered nodes whose last on-chain anchor is older than this. A node
 *  doesn't auto-deregister when it goes offline, so the client applies the staleness
 *  filter. Never-anchored nodes (lastAnchorAt === 0) are kept (may be coming online). */
const SC_MAX_ANCHOR_AGE_SECS = 7 * 24 * 60 * 60;

/**
 * Discover available nodes with ping times, sorted by latency. UNION of three
 * decentralized sources, deduped by hostname, current node first:
 *  1. `discoverAndPingNodes` — the current node + peers it advertises (skipped on a
 *     fresh install with no current node).
 *  2. `discoverNodesViaSc` — the ON-CHAIN registry (getActiveNodes → getNodeMetadata →
 *     derived HTTPS endpoint). The decentralized seed that replaced the dead hardcoded
 *     `DEFAULT_NODE_URL`. Best-effort: a Klever RPC hiccup just yields no SC seeds.
 *  3. known nodes — every URL the user has switched to before.
 *
 * `allowPrivateHosts` is enabled so a user can connect to their own L2 node on the LAN.
 */
export async function getAvailableNodes(): Promise<NodeWithPing[]> {
  const currentUrl = await getCurrentNodeUrl();
  const opts = { allowPrivateHosts: true };

  const discovered = currentUrl
    ? await discoverAndPingNodes(currentUrl, opts).catch(() => [] as NodeWithPing[])
    : [];
  const discoveredUrls = new Set(discovered.map((n) => n.url));

  const nowSecs = Math.floor(Date.now() / 1000);
  const scNodes = await discoverNodesViaSc(await discoveryNetwork()).catch(() => []);
  const scUrls = scNodes
    .filter((n) => !!n.endpoint)
    .filter((n) => !n.lastAnchorAt || nowSecs - n.lastAnchorAt <= SC_MAX_ANCHOR_AGE_SECS)
    .map((n) => n.endpoint as string);

  const extras: string[] = [];
  const pushExtra = (url: string) => {
    if (!url || discoveredUrls.has(url) || url === currentUrl || extras.includes(url)) return;
    extras.push(url);
  };
  for (const url of scUrls) pushExtra(url);
  for (const url of await getKnownNodes()) pushExtra(url);

  const extraPings = await Promise.all(
    extras.map(async (url) => ({ url, ping: await pingNode(url, 5000, opts) })),
  );

  // Hostname-level dedup: keep the current URL, else the lowest ping per host.
  const merged = [...discovered, ...extraPings];
  const byHost = new Map<string, NodeWithPing>();
  for (const n of merged) {
    let host: string;
    try { host = new URL(n.url).hostname; } catch { host = n.url; }
    const existing = byHost.get(host);
    if (!existing) { byHost.set(host, n); continue; }
    if (n.url === currentUrl) { byHost.set(host, n); continue; }
    if (existing.url === currentUrl) continue;
    if (n.ping < existing.ping) byHost.set(host, n);
  }

  // Sort: reachable first, then by latency.
  return [...byHost.values()].sort((a, b) => {
    if (a.ping === Infinity && b.ping !== Infinity) return 1;
    if (a.ping !== Infinity && b.ping === Infinity) return -1;
    return a.ping - b.ping;
  });
}

export type BootstrapReason = 'saved' | 'best-ping' | 'no-candidates';
export interface BootstrapResult { chosen: string; reason: BootstrapReason }

/**
 * Pick a node on cold boot when none is saved (or the saved one is unreachable):
 * discover candidates (SC registry + peers + known) and land on the lowest finite
 * ping, persisting it. Must run BEFORE any data fetch on a fresh install.
 */
export async function bootstrapNodeSelection(): Promise<BootstrapResult> {
  const candidates = await getAvailableNodes().catch(() => [] as NodeWithPing[]);
  const reachable = candidates.filter((c) => c.ping !== Infinity);
  if (reachable.length > 0) {
    const best = reachable[0].url; // already sorted by ping
    await switchNode(best);
    return { chosen: best, reason: 'best-ping' };
  }
  return { chosen: await getCurrentNodeUrl(), reason: 'no-candidates' };
}
