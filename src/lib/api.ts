/**
 * SDK client singleton — connects to the user's home L2 node.
 *
 * Initializes the OgmaraClient from @ogmara/sdk. The node URL is read
 * from settings (ogmara.node_url), defaulting to a local dev node.
 */

import { OgmaraClient } from '@ogmara/sdk';
import { getSetting } from './settings';

const DEFAULT_NODE_URL = 'http://localhost:41721';

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
