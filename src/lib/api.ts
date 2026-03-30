/**
 * SDK client singleton — connects to the user's home L2 node.
 *
 * Initializes the OgmaraClient from @ogmara/sdk. The node URL is read
 * from settings (ogmara.node_url), defaulting to a local dev node.
 */

import { OgmaraClient, DEFAULT_NODE_URL, discoverAndPingNodes, type NodeWithPing } from '@ogmara/sdk';
import { getSetting, setSetting } from './settings';

let client: OgmaraClient | null = null;

/** Get or create the shared SDK client instance. */
export async function getClient(): Promise<OgmaraClient> {
  if (client) return client;

  const nodeUrl = (await getSetting('nodeUrl')) || DEFAULT_NODE_URL;
  client = new OgmaraClient({ nodeUrl, timeout: 15000 });
  return client;
}

/** Reset the client (e.g., when node URL changes). */
export function resetClient(): void {
  client = null;
}

/** Switch to a different node URL. */
export async function switchNode(nodeUrl: string): Promise<void> {
  await setSetting('nodeUrl', nodeUrl);
  resetClient();
}

/** Get the current node URL. */
export async function getCurrentNodeUrl(): Promise<string> {
  return (await getSetting('nodeUrl')) || DEFAULT_NODE_URL;
}

/** Discover available nodes with ping times, sorted by latency. */
export async function getAvailableNodes(): Promise<NodeWithPing[]> {
  const currentUrl = await getCurrentNodeUrl();
  return discoverAndPingNodes(currentUrl);
}
