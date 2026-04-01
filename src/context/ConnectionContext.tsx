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
import { DEFAULT_NODE_URL } from '@ogmara/sdk';
import { getSetting, setSetting } from '../lib/settings';
import { vaultInit, vaultStore, vaultGenerate, vaultGetSigner, vaultGetAddress, vaultWipe } from '../lib/vault';
import { debugLog } from '../lib/debug';

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
  /** Connect to a node URL (persists the choice). */
  connectToNode: (url: string) => Promise<void>;
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
  nodeUrl: DEFAULT_NODE_URL,
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
  const [nodeUrl, setNodeUrl] = useState<string>(DEFAULT_NODE_URL);
  const [signer, setSignerState] = useState<WalletSigner | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [walletSource, setWalletSource] = useState<WalletSource>(null);
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [peers, setPeers] = useState(0);

  const wsRef = useRef<WsSubscription | null>(null);
  const eventHandlersRef = useRef<Set<(event: WsEvent) => void>>(new Set());
  const nodeUrlRef = useRef<string>(DEFAULT_NODE_URL);
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

  async function initClient() {
    try {
      const savedUrl = await getSetting('nodeUrl').catch(() => null);
      const savedName = await getSetting('displayName').catch(() => null);
      const url = savedUrl || DEFAULT_NODE_URL;
      nodeUrlRef.current = url;
      setNodeUrl(url);
      if (savedName) setDisplayName(savedName);
      debugLog('info', `Connecting to node: ${url}`);

      const newClient = new OgmaraClient({ nodeUrl: url, timeout: 15000 });
      setClient(newClient);

      // Restore wallet if saved (non-blocking — wallet errors shouldn't prevent app start)
      await restoreWallet(newClient).catch((e) => {
        debugLog('warn', 'Wallet restore failed', e);
      });

      // Check node health (non-fatal — app works offline)
      try {
        const health = await newClient.health();
        setPeers(health.peers);
        healthConfirmedRef.current = true;
        setStatus('connected');
        debugLog('info', `Node connected, ${health.peers} peers`);
        connectWs(url);
      } catch (e) {
        debugLog('warn', 'Node unreachable, starting in offline mode', e);
        healthConfirmedRef.current = false;
        setStatus('disconnected');
      }
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
      if (savedSource === 'k5-delegation' && savedWallet) {
        setWalletSource('k5-delegation');
        setWalletAddress(savedWallet);
        if (s) s.walletAddress = savedWallet;
      } else {
        setWalletSource('builtin');
        setWalletAddress(addr);
      }
    }
  }

  const connectToNode = useCallback(async (url: string) => {
    nodeUrlRef.current = url;
    setNodeUrl(url);
    await setSetting('nodeUrl', url);

    const newClient = new OgmaraClient({ nodeUrl: url, timeout: 15000 });
    if (signerRef.current) newClient.withSigner(signerRef.current);
    setClient(newClient);
    setStatus('connecting');

    try {
      const health = await newClient.health();
      setPeers(health.peers);
      healthConfirmedRef.current = true;
      setStatus('connected');
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
      if (client && s) client.withSigner(s);
    } else {
      await vaultWipe();
      signerRef.current = null;
      setSignerState(null);
      setAddress(null);
      setWalletAddress(null);
      setWalletSource(null);
      await setSetting('walletSource', '');
      await setSetting('walletAddress', '');
      await setSetting('deviceRegistered', '');
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
    connectWs(nodeUrlRef.current);
  }, [client]);

  const registerExternalWallet = useCallback(async (
    externalAddress: string,
    walletSignatureHex: string,
    timestamp: number,
  ) => {
    const s = signerRef.current;
    if (!s || !client) throw new Error('Signer required');

    // Check cache to avoid re-registration
    const deviceAddr = vaultGetAddress();
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
