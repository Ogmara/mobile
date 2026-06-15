/**
 * Connection context — manages L2 node connection state and wallet auth.
 *
 * Provides the SDK client, WebSocket subscription, connection status,
 * and wallet signer to all screens. Handles node failover and reconnection.
 */

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { OgmaraClient, WsSubscription, subscribe, buildDeviceClaim, type WsEvent } from '@ogmara/sdk';
import type { WalletSigner } from '@ogmara/sdk';
import { getSetting, setSetting } from '../lib/settings';
import { bootstrapNodeSelection, rememberNetwork, recordKnownNode, getAvailableNodes } from '../lib/api';
import { vaultInit, vaultStore, vaultGenerate, vaultGetSigner, vaultWipe } from '../lib/vault';
import { debugLog } from '../lib/debug';
import { setCryptoEnv, setCryptoClient, clearCryptoEnv } from '../lib/cryptoEnv';
import { ensureDeviceEncBinding, wipeDeviceEncKey } from '../lib/deviceEnc';
// Side-effect import: registers the key-vault backup/restore listeners (P3) into the
// dm/channel crypto caches at app start.
import '../lib/keyVault';

type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

type WalletSource = 'builtin' | 'k5-delegation' | null;

interface ConnectionContextValue {
  client: OgmaraClient | null;
  status: ConnectionStatus;
  nodeUrl: string;
  signer: WalletSigner | null;
  address: string | null;
  /** The wallet address (on-chain identity). Same as address for built-in wallets. */
  walletAddress: string | null;
  walletSource: WalletSource;
  displayName: string | null;
  peers: number;
  /** Connect to a node URL (persists the choice). Pass pin=true for an explicit
   *  user choice so the auto best-ping optimizer won't override it. */
  connectToNode: (url: string, pin?: boolean) => Promise<void>;
  /** Store a private key in the vault and activate the wallet. Pass null to wipe. */
  setWallet: (privateKeyHex: string | null) => Promise<void>;
  /** Generate a new random wallet in the vault. */
  generateWallet: () => Promise<void>;
  /**
   * Register a device key under an external wallet (K5).
   * Requires the wallet signature over the device claim string.
   */
  registerExternalWallet: (
    externalAddress: string,
    walletSignatureHex: string,
    timestamp: number,
  ) => Promise<void>;
  /** Subscribe to a WebSocket event handler. Returns unsubscribe function. */
  onWsEvent: (handler: (event: WsEvent) => void) => () => void;
}

const ConnectionContext = createContext<ConnectionContextValue>({
  client: null,
  status: 'disconnected',
  nodeUrl: '',
  signer: null,
  address: null,
  walletAddress: null,
  walletSource: null,
  displayName: null,
  peers: 0,
  connectToNode: async () => {},
  setWallet: async () => {},
  generateWallet: async () => {},
  registerExternalWallet: async () => {},
  onWsEvent: () => () => {},
});

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const [client, setClient] = useState<OgmaraClient | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [nodeUrl, setNodeUrl] = useState<string>('');
  const [signer, setSignerState] = useState<WalletSigner | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletSource, setWalletSource] = useState<WalletSource>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [peers, setPeers] = useState(0);

  const wsRef = useRef<WsSubscription | null>(null);
  const eventHandlersRef = useRef<Set<(event: WsEvent) => void>>(new Set());
  const nodeUrlRef = useRef<string>('');
  const signerRef = useRef<WalletSigner | null>(null);
  /** True once health check confirms the node is reachable. WS state
   *  should not downgrade to 'reconnecting' while this is set. */
  const healthConfirmedRef = useRef(false);

  // Initialize client on mount
  useEffect(() => {
    initClient();
    return () => {
      wsRef.current?.close();
    };
  }, []);

  // Pause/resume WebSocket on app background/foreground
  useEffect(() => {
    const handleAppState = (nextState: AppStateStatus) => {
      if (nextState === 'active') {
        connectWs(nodeUrlRef.current);
      } else if (nextState === 'background') {
        wsRef.current?.close();
        wsRef.current = null;
      }
    };
    const sub = AppState.addEventListener('change', handleAppState);
    return () => sub.remove();
  }, []);

  /** Connect a client, confirm health, persist the node's network, wire WS + profile.
   *  Returns true on a confirmed-healthy node. */
  async function confirmAndWire(c: OgmaraClient, url: string, savedName: string | null): Promise<boolean> {
    try {
      const health = await c.health();
      setPeers(health.peers);
      healthConfirmedRef.current = true;
      setStatus('connected');
      // Persist the network the node reports so the next cold-boot SC discovery
      // targets the right on-chain registry.
      await rememberNetwork((health as any).network).catch(() => {});
      debugLog('info', `Node connected, ${health.peers} peers`);
      connectWs(url);

      const addr = signerRef.current?.walletAddress || signerRef.current?.address;
      if (addr && !savedName) {
        c.getUserProfile(addr).then((resp: any) => {
          const name = resp?.user?.display_name;
          if (name) { setDisplayName(name); setSetting('displayName', name); }
        }).catch(() => {});
      }
      return true;
    } catch (e) {
      debugLog('warn', 'Node health check failed', e);
      return false;
    }
  }

  /** After connecting to a (possibly stale/slow) saved node, discover candidates in
   *  the background and switch to a meaningfully-faster one — unless the user pinned a
   *  node explicitly. This is what keeps the app on the FASTEST node without blocking
   *  cold start on full discovery. Best-effort, runs once per launch. */
  async function maybeOptimizeNode(currentUrl: string): Promise<void> {
    try {
      if ((await getSetting('nodePinned')) === '1') return; // honor explicit choice
      const nodes = await getAvailableNodes();
      const reachable = nodes.filter((n) => n.ping !== Infinity);
      if (reachable.length === 0) return;
      const best = reachable[0]; // getAvailableNodes sorts ascending by ping
      const cur = nodes.find((n) => n.url === currentUrl);
      const curPing = cur?.ping ?? Infinity;
      // Switch only when clearly faster (≥120ms better) to avoid flapping on noise.
      if (best.url !== currentUrl && best.ping + 120 < curPing) {
        debugLog('info', `Auto-switching to faster node ${best.url} (${best.ping}ms vs ${curPing}ms)`);
        await connectToNode(best.url); // no pin — this is an automatic choice
      }
    } catch { /* best-effort */ }
  }

  async function initClient() {
    try {
      const savedName = await getSetting('displayName').catch(() => null);
      let url = (await getSetting('nodeUrl').catch(() => null)) || '';

      // No node yet (fresh install) → discover one from the on-chain SC registry
      // (no hardcoded seed). Best-effort; may land '' if nothing is reachable.
      if (!url) {
        try { url = (await bootstrapNodeSelection()).chosen; } catch { /* offline */ }
      }
      nodeUrlRef.current = url;
      setNodeUrl(url);
      if (savedName) setDisplayName(savedName);
      debugLog('info', `Connecting to node: ${url || '(none discovered)'}`);

      let newClient = new OgmaraClient({ nodeUrl: url, timeout: 15000 });
      setClient(newClient);

      // Restore wallet if saved (non-blocking — wallet errors shouldn't prevent app start)
      await restoreWallet(newClient).catch((e) => {
        debugLog('warn', 'Wallet restore failed', e);
      });

      if (await confirmAndWire(newClient, url, savedName)) {
        // Connected to the saved node fast; now upgrade to the fastest in the
        // background (no-op if pinned or already fastest).
        if (url) void maybeOptimizeNode(url);
        return;
      }

      // Saved node unreachable → try SC discovery to land a live one.
      try {
        const res = await bootstrapNodeSelection();
        if (res.reason === 'best-ping' && res.chosen && res.chosen !== url) {
          url = res.chosen;
          nodeUrlRef.current = url;
          setNodeUrl(url);
          newClient = new OgmaraClient({ nodeUrl: url, timeout: 15000 });
          if (signerRef.current) newClient.withSigner(signerRef.current);
          setClient(newClient);
          setCryptoClient(newClient);
          if (await confirmAndWire(newClient, url, savedName)) return;
        }
      } catch { /* discovery failed */ }

      debugLog('warn', 'No reachable node — starting in offline mode');
      healthConfirmedRef.current = false;
      setStatus('disconnected');
    } catch (e) {
      debugLog('error', 'Client init failed', e);
      setStatus('disconnected');
    }
  }

  function connectWs(nodeUrl: string) {
    try {
      wsRef.current?.close();
      wsRef.current = subscribe({
        nodeUrl,
        signer: signerRef.current ?? undefined,
        autoReconnect: true,
        reconnectDelay: 1000,
        maxReconnectDelay: 30000,
        onEvent: (event) => {
          eventHandlersRef.current.forEach((handler) => handler(event));
        },
        onStateChange: (connected) => {
          if (connected) {
            setStatus('connected');
          } else if (!healthConfirmedRef.current) {
            // Only show 'reconnecting' if the node was never confirmed healthy
            setStatus('reconnecting');
          }
        },
      });
      debugLog('info', 'WebSocket subscription started');
    } catch (e) {
      debugLog('error', 'WebSocket subscribe failed', e);
    }
  }

  async function restoreWallet(c: OgmaraClient) {
    const addr = await vaultInit();
    if (addr) {
      const s = vaultGetSigner();
      signerRef.current = s;
      setSignerState(s);
      setAddress(addr);
      if (s) c.withSigner(s);

      // Restore wallet source and external address if previously set
      const savedSource = await getSetting('walletSource');
      const savedWallet = await getSetting('walletAddress');
      const isK5 = savedSource === 'k5-delegation' && !!savedWallet;
      const wAddr = isK5 ? (savedWallet as string) : addr;
      const src: WalletSource = isK5 ? 'k5-delegation' : 'builtin';
      if (isK5) {
        setWalletSource('k5-delegation');
        setWalletAddress(savedWallet);
        if (s) s.walletAddress = savedWallet as string;
      } else {
        setWalletSource('builtin');
        setWalletAddress(addr);
      }
      // E2E: expose the live signer/client to the crypto libs and publish this
      // device's enc-key binding (P0). Best-effort + idempotent; no-op for K5.
      setCryptoEnv({ signer: s, walletAddress: wAddr, client: c, walletSource: src });
      void ensureDeviceEncBinding().catch((e) => debugLog('warn', 'enc binding failed', e));
    }
  }

  const connectToNode = useCallback(async (url: string, pin?: boolean) => {
    nodeUrlRef.current = url;
    setNodeUrl(url);
    await setSetting('nodeUrl', url);
    await recordKnownNode(url).catch(() => {}); // picker memory
    if (pin) await setSetting('nodePinned', '1'); // explicit choice — don't auto-override

    const newClient = new OgmaraClient({ nodeUrl: url, timeout: 15000 });
    if (signerRef.current) newClient.withSigner(signerRef.current);
    setClient(newClient);
    // Point the crypto libs at the freshly-created (signer-bound) client.
    setCryptoClient(newClient);
    // Device-enc bindings are per-node — re-publish on the new node so peers can wrap
    // keys to this device here too. Idempotent + registry-verified (no-op if already bound).
    if (signerRef.current) void ensureDeviceEncBinding().catch(() => {});
    setStatus('connecting');

    try {
      const health = await newClient.health();
      setPeers(health.peers);
      healthConfirmedRef.current = true;
      setStatus('connected');
      // Persist the network for the next cold-boot SC discovery.
      await rememberNetwork((health as any).network).catch(() => {});
      connectWs(url);
    } catch {
      healthConfirmedRef.current = false;
      setStatus('disconnected');
    }
  }, []);

  const setWallet = useCallback(async (privateKeyHex: string | null) => {
    if (privateKeyHex) {
      const addr = await vaultStore(privateKeyHex);
      const s = vaultGetSigner();
      signerRef.current = s;
      setSignerState(s);
      setAddress(addr);
      setWalletAddress(addr);
      setWalletSource('builtin');
      await setSetting('walletSource', 'builtin');
      await setSetting('walletAddress', addr);
      if (client && s) client.withSigner(s);
      setCryptoEnv({ signer: s, walletAddress: addr, client, walletSource: 'builtin' });
      void ensureDeviceEncBinding().catch((e) => debugLog('warn', 'enc binding failed', e));
    } else {
      await vaultWipe();
      await wipeDeviceEncKey().catch(() => {});
      signerRef.current = null;
      setSignerState(null);
      setAddress(null);
      setWalletAddress(null);
      setWalletSource(null);
      await setSetting('walletSource', '');
      await setSetting('walletAddress', '');
      await setSetting('deviceRegistered', '');
      // Clear all E2E session state so a different account can't read this one's keys.
      clearCryptoEnv();
      Promise.all([
        import('../lib/dmCrypto').then(({ clearDmKeyCache }) => clearDmKeyCache()),
        import('../lib/channelCrypto').then(({ clearChannelKeyCache }) => clearChannelKeyCache()),
        import('../lib/keyVault').then(({ clearKeyVaultSession }) => clearKeyVaultSession()),
        // P5: drop any decrypted media plaintext cached this session.
        import('../lib/mediaCrypto').then(({ clearMediaCache }) => clearMediaCache()),
      ]).catch(() => {});
    }
    connectWs(nodeUrlRef.current);
  }, [client]);

  const generateWallet = useCallback(async () => {
    const addr = await vaultGenerate();
    const s = vaultGetSigner();
    signerRef.current = s;
    setSignerState(s);
    setAddress(addr);
    setWalletAddress(addr);
    setWalletSource('builtin');
    await setSetting('walletSource', 'builtin');
    await setSetting('walletAddress', addr);
    if (client && s) client.withSigner(s);
    setCryptoEnv({ signer: s, walletAddress: addr, client, walletSource: 'builtin' });
    void ensureDeviceEncBinding().catch((e) => debugLog('warn', 'enc binding failed', e));
    connectWs(nodeUrlRef.current);
  }, [client]);

  const registerExternalWallet = useCallback(async (
    externalAddress: string,
    walletSignatureHex: string,
    timestamp: number,
  ) => {
    const s = signerRef.current;
    if (!s || !client) throw new Error('Signer required');

    // Check cache to avoid re-registration (use ogd1 device address for consistency)
    const deviceAddr = s.deviceAddress;
    const cacheKey = `${externalAddress}:${deviceAddr}`;
    const cached = await getSetting('deviceRegistered');
    if (cached !== cacheKey) {
      await client.registerDevice(walletSignatureHex, externalAddress, timestamp);
      await setSetting('deviceRegistered', cacheKey);
    }

    s.walletAddress = externalAddress;
    setWalletAddress(externalAddress);
    setWalletSource('k5-delegation');
    await setSetting('walletSource', 'k5-delegation');
    await setSetting('walletAddress', externalAddress);
    // Expose to crypto libs for completeness. E2E is gated off for K5 (the device key
    // can't sign wallet-bound claims), so binding/encryption no-op and DMs stay plaintext.
    setCryptoEnv({ signer: s, walletAddress: externalAddress, client, walletSource: 'k5-delegation' });
  }, [client]);

  const onWsEvent = useCallback((handler: (event: WsEvent) => void) => {
    eventHandlersRef.current.add(handler);
    return () => {
      eventHandlersRef.current.delete(handler);
    };
  }, []);

  return (
    <ConnectionContext.Provider
      value={{ client, status, nodeUrl, signer, address, walletAddress, walletSource, displayName, peers, connectToNode, setWallet, generateWallet, registerExternalWallet, onWsEvent }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}

/** Access connection state and SDK client. */
export function useConnection() {
  return useContext(ConnectionContext);
}
