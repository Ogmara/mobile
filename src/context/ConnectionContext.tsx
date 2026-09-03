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
import {
  vaultInit,
  vaultStore,
  vaultGenerate,
  vaultGetSigner,
  vaultWipe,
  vaultActivate,
  vaultAddAccount,
  vaultRemoveAccount,
  vaultListAccounts,
} from '../lib/vault';
import type { AccountEntry } from '../lib/vaultAccounts';
import { debugLog } from '../lib/debug';
import {
  setWalletScope,
  wipeWalletScope,
  runWalletScopeMigrationOnce,
  runWalletSwitchResets,
} from '../lib/walletScope';
import { setCryptoEnv, setCryptoClient, clearCryptoEnv } from '../lib/cryptoEnv';
import { setContractAddress } from '../lib/kleverTx';
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
  /** Re-read the active account's display name into the header. */
  refreshProfile: () => Promise<void>;
  peers: number;
  /** Connect to a node URL (persists the choice). Pass pin=true for an explicit
   *  user choice so the auto best-ping optimizer won't override it. */
  connectToNode: (url: string, pin?: boolean) => Promise<void>;
  /** Store a private key in the vault and activate the wallet. Pass null to wipe. */
  setWallet: (privateKeyHex: string | null) => Promise<void>;
  /** Generate a new random wallet in the vault. */
  generateWallet: () => Promise<void>;
  /** Every account held on this device. */
  accounts: AccountEntry[];
  /** Reload the account list (after add or remove). Renaming is not
   *  implemented — `AccountEntry.label` is reserved but never written, so the
   *  list falls back to each account's display name. */
  refreshAccounts: () => Promise<void>;
  /** Switch to another held account. Keeps both accounts' data. */
  switchAccount: (address: string) => Promise<void>;
  /** Create a new account additively and switch to it. */
  createAccount: () => Promise<string>;
  /** Import a key as a new account and switch to it. */
  addAccount: (privateKeyHex: string) => Promise<string>;
  /** Permanently remove an account and its local data. Unrecoverable. */
  removeAccount: (address: string) => Promise<void>;
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
  refreshProfile: async () => {},
  peers: 0,
  connectToNode: async () => {},
  setWallet: async () => {},
  generateWallet: async () => {},
  accounts: [],
  refreshAccounts: async () => {},
  switchAccount: async () => {},
  createAccount: async () => '',
  addAccount: async () => '',
  removeAccount: async () => {},
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
  const [accounts, setAccounts] = useState<AccountEntry[]>([]);
  /**
   * Indirection so `setWallet` can hand over to another account.
   * `switchAccount` is declared after it, so a direct reference would be a
   * use-before-initialization inside that callback's closure.
   */
  const switchAccountRef = useRef<((addr: string) => Promise<void>) | null>(null);

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

      // Every on-chain action (register, createChannel, device delegation,
      // governance votes) invokes the KApp contract, and invokeContract() throws
      // "Smart contract address not configured" until this is set. Web and
      // desktop do the same at startup; mobile does it per-connect because the
      // node URL — and therefore the network and its contract — can change at
      // runtime. Non-fatal: an unreachable stats endpoint must not drop an
      // otherwise-healthy connection, it only leaves on-chain actions disabled.
      c.networkStats().then((stats: any) => {
        if (stats?.contract_address) {
          setContractAddress(stats.contract_address);
          debugLog('info', `SC address set: ${String(stats.contract_address).slice(0, 12)}...`);
        } else {
          debugLog('warn', 'Node reported no contract_address; on-chain actions unavailable');
        }
      }).catch((e: unknown) => {
        debugLog('warn', 'networkStats failed; on-chain actions unavailable', e);
      });

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
      // Claim the pre-namespacing global keys for whoever owned them, once,
      // BEFORE any wallet is restored or created this session. Doing it later
      // would let a freshly created wallet inherit the previous account's data.
      await runWalletScopeMigrationOnce();
      // NOTE: `displayName` is per-wallet, so it cannot be read until
      // `restoreWallet` has set the scope — it is loaded further down.
      let url = (await getSetting('nodeUrl').catch(() => null)) || '';

      // No node yet (fresh install) → discover one from the on-chain SC registry
      // (no hardcoded seed). Best-effort; may land '' if nothing is reachable.
      if (!url) {
        try { url = (await bootstrapNodeSelection()).chosen; } catch { /* offline */ }
      }
      nodeUrlRef.current = url;
      setNodeUrl(url);
      debugLog('info', `Connecting to node: ${url || '(none discovered)'}`);

      let newClient = new OgmaraClient({ nodeUrl: url, timeout: 15000 });
      setClient(newClient);

      // Restore wallet if saved (non-blocking — wallet errors shouldn't prevent app start)
      await restoreWallet(newClient).catch((e) => {
        debugLog('warn', 'Wallet restore failed', e);
      });

      // Only NOW is the per-wallet scope set, so the display name is readable.
      // Reading it before `restoreWallet` returned null on every launch and
      // left the drawer header blank for anyone whose name is local-only.
      const savedName = await getSetting('displayName').catch(() => null);
      if (savedName) setDisplayName(savedName);
      // Populate the account picker once the scope is known.
      void refreshAccounts();

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
      // Point per-wallet storage at this account BEFORE anything reads it —
      // profile, channels, topic groups and mutes all resolve through it, and
      // an unscoped read returns nothing rather than the previous account's
      // data. Then adopt any pre-namespacing values into this wallet, once.
      setWalletScope(wAddr);
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
      // Re-point per-wallet storage before any read for the new account.
      setWalletScope(addr);
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
      // Wipe this account's locally cached state BEFORE dropping the scope —
      // afterwards there is no address to resolve the keys from. Namespacing
      // alone would keep the data addressable on the device forever; wiping
      // here means a deliberate sign-out leaves nothing behind, while merely
      // SWITCHING wallets still preserves each account's own data.
      // Disconnect removes THIS account, not every wallet on the device.
      //
      // `vaultWipe()` became total when multi-account landed — it deletes every
      // account's key slots. The two callers still say "the wallet", singular,
      // and are two taps with no per-account export gate, so a user holding
      // several wallets would have lost all of them here. Scope it to the
      // active account and hand over to the next held one, matching what the
      // Accounts screen's remove already does.
      const heldNow = await vaultListAccounts().catch(() => [] as AccountEntry[]);
      const active = walletAddress;
      const survivors = heldNow.filter(
        (e: AccountEntry) => e.a !== active && e.source !== 'k5-delegation',
      );

      // Order matters. If the process dies mid-way, wiping prefs FIRST leaves a
      // still-usable wallet with reset preferences; wiping key material first
      // would leave an unreachable account's data behind. Key material goes
      // last. `wipeDeviceEncKey` WRITES empty markers, so it must precede the
      // scope wipe or it recreates the breadcrumbs the wipe just removed.
      await wipeDeviceEncKey().catch(() => {});
      await wipeWalletScope();
      if (active) {
        await vaultRemoveAccount(active);
      } else {
        // No active account to scope to — fall back to the total wipe.
        await vaultWipe();
      }
      setWalletScope(null);
      await wipeDeviceEncKey().catch(() => {});
      signerRef.current = null;
      setSignerState(null);
      setAddress(null);
      setWalletAddress(null);
      setWalletSource(null);
      // The header renders this next to the burger menu. `removeAccount`
      // cleared it; this path did not, so after a disconnect the app showed a
      // name for an account that no longer existed — and kept showing it
      // through wallet creation, until a restart happened to reload state.
      setDisplayName(null);
      await setSetting('walletSource', '');
      await setSetting('walletAddress', '');
      await setSetting('deviceRegistered', '');
      // Clear all E2E session state so a different account can't read this one's keys.
      clearCryptoEnv();
      if (survivors.length > 0) {
        // Another wallet is still held — activate it instead of leaving the
        // app signed out, which would misrepresent what just happened.
        try {
          await switchAccountRef.current?.(survivors[0].a);
          void refreshAccounts();
          return;
        } catch {
          /* fall through to the signed-out state */
        }
      }
      void refreshAccounts();
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

  /**
   * Drop every trace of the current account from memory.
   *
   * AWAITED, not fire-and-forget: `clearKeyVaultSession` also cancels the
   * debounced key-vault backup, and an armed timer surviving a switch would
   * seal account A's keyring under account B's backup key. The same applies to
   * the settings-sync uploads cancelled by the scope resets.
   */
  const refreshAccounts = useCallback(async () => {
    setAccounts(await vaultListAccounts().catch(() => [] as AccountEntry[]));
  }, []);

  const tearDownAccountSession = useCallback(async () => {
    // Close the socket first. `setWalletAddress` remounts the whole tree, so a
    // socket left open would deliver the PREVIOUS account's frames into the
    // new account's freshly mounted screens.
    wsRef.current?.close();
    wsRef.current = null;
    clearCryptoEnv();
    await Promise.all([
      import('../lib/dmCrypto').then(({ clearDmKeyCache }) => clearDmKeyCache()),
      import('../lib/channelCrypto').then(({ clearChannelKeyCache }) => clearChannelKeyCache()),
      import('../lib/keyVault').then(({ clearKeyVaultSession }) => clearKeyVaultSession()),
      import('../lib/mediaCrypto').then(({ clearMediaCache }) => clearMediaCache()),
    ]).catch(() => {});
  }, []);

  /**
   * Switch to another account already held on this device.
   *
   * Explicitly does NOT wipe: that is what makes this different from signing
   * out. Each account's preferences, channels and topic follows stay on disk
   * under its own namespace and come back when it is selected again.
   *
   * Ordering is load-bearing. The scope flip and `setCryptoEnv` must land in
   * the SAME synchronous block, because anything reading between them would
   * see one account's scope with another account's signer.
   */
  const switchAccount = useCallback(async (addr: string) => {
    if (!addr || addr === walletAddress) return;

    // A K5 entry's indexed address is the local DEVICE key, while the identity
    // and all stored data live under the EXTERNAL wallet. Activating it as a
    // built-in wallet would persist the device address as the wallet address,
    // destroy the delegation, and orphan every `::<external>` namespace.
    // Refuse rather than corrupt it.
    const entry = (await vaultListAccounts().catch(() => [] as AccountEntry[]))
      .find((e: AccountEntry) => e.a === addr);
    if (entry?.source === 'k5-delegation') throw new Error('K5_NOT_SWITCHABLE');

    // Cancel any armed settings/key-vault upload BEFORE activating: activation
    // moves the vault's active account, and a timer firing between that and
    // the scope flip would encrypt the old account's data with the new
    // account's key.
    runWalletSwitchResets();

    // Load the key BEFORE tearing anything down. Tearing down first and then
    // failing to activate left cryptoEnv cleared and every key cache dropped
    // while the scope still pointed at the old account — E2E dead for the rest
    // of the session, recoverable only by restarting.
    const loaded = await vaultActivate(addr);
    if (!loaded) throw new Error('That account could not be unlocked on this device');
    await tearDownAccountSession();
    const s = vaultGetSigner();

    // Scope, signer and cryptoEnv land together. `setWalletAddress` remounts
    // the whole tree (App.tsx keys on it), so an await between the scope flip
    // and `withSigner` would let remounted screens fetch — signed as the
    // PREVIOUS account — while the UI already shows the new one.
    setWalletScope(loaded);          // synchronous; also resets the caches
    signerRef.current = s;
    if (client && s) client.withSigner(s);
    setCryptoEnv({ signer: s, walletAddress: loaded, client, walletSource: 'builtin' });
    setSignerState(s);
    setAddress(loaded);
    setWalletAddress(loaded);
    setWalletSource('builtin');
    // Persistence trails; it does not gate correctness of the live session.
    await setSetting('walletSource', 'builtin');
    await setSetting('walletAddress', loaded);

    // The display name is per-account, so re-read it under the new scope.
    setDisplayName(await getSetting('displayName').catch(() => null));
    void ensureDeviceEncBinding().catch((e) => debugLog('warn', 'enc binding failed', e));
    connectWs(nodeUrlRef.current);
    void refreshAccounts();
  }, [client, walletAddress, tearDownAccountSession, refreshAccounts]);

  switchAccountRef.current = switchAccount;

  /** Add an account from an existing key and switch to it. */
  const addAccount = useCallback(async (privateKeyHex: string) => {
    const addr = await vaultAddAccount(privateKeyHex);
    await switchAccount(addr);
    return addr;
  }, [switchAccount]);

  /**
   * Create a brand-new account ADDITIVELY and switch to it.
   *
   * Deliberately not `generateWallet`, which is the single-wallet onboarding
   * path: it overwrites the legacy anchor and — critically — skips
   * `tearDownAccountSession`, so the previous account's DM/channel key caches
   * and any armed key-vault backup would survive into the new account. The
   * next backup would then seal the PREVIOUS account's keyring under the NEW
   * account's key and upload it to the node.
   */
  const createAccount = useCallback(async () => {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const hex = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    return addAccount(hex);
  }, [addAccount]);

  /**
   * Permanently remove one account from this device.
   *
   * Destructive and unrecoverable without a key backup — the caller is
   * responsible for the export gate.
   */
  const removeAccount = useCallback(async (addr: string) => {
    // Exclude K5 rows: `switchAccount` refuses them, and it would throw AFTER
    // the removal had already committed — leaving the app with no signer.
    const others = (await vaultListAccounts()).filter(
      (e: AccountEntry) => e.a !== addr && e.source !== 'k5-delegation',
    );
    if (addr === walletAddress) {
      await tearDownAccountSession();
      setWalletScope(addr);          // scope the wipe at the right account
      // Order matters: `wipeDeviceEncKey` WRITES empty markers
      // (`ogmara.e2e.device_id::<addr>` etc.), so running it after the scope
      // wipe would recreate the very breadcrumbs the wipe just removed — and
      // the recovery scan would then resurrect the removed address.
      await wipeDeviceEncKey().catch(() => {});
      await wipeWalletScope();
    } else {
      await wipeWalletScope(addr);
    }
    await vaultRemoveAccount(addr);
    await refreshAccounts();
    if (addr === walletAddress) {
      if (others.length > 0) {
        await switchAccount(others[0].a);
      } else {
        setWalletScope(null);
        signerRef.current = null;
        setSignerState(null);
        setAddress(null);
        setWalletAddress(null);
        setWalletSource(null);
        setDisplayName(null);
        await setSetting('walletSource', '');
        await setSetting('walletAddress', '');
        connectWs(nodeUrlRef.current);
      }
    }
  }, [walletAddress, switchAccount, tearDownAccountSession, refreshAccounts]);

  const generateWallet = useCallback(async () => {
    const addr = await vaultGenerate();
    const s = vaultGetSigner();
    // A brand-new account starts with an empty namespace — nothing to migrate.
    setWalletScope(addr);
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

    // Point per-wallet storage at the EXTERNAL address, before the first
    // per-wallet write below. Without this the live session keeps writing
    // under the built-in device address while `restoreWallet` scopes to the
    // external one — so everything configured in this session would vanish on
    // the next launch (unreachable, not deleted) and be left behind forever by
    // a later disconnect, which wipes only the external address's namespace.
    setWalletScope(externalAddress);

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

  /**
   * Re-read the active account's display name.
   *
   * The header renders it, and it is written by the profile editor rather than
   * by this context — without a way to pull it back in, a rename showed up
   * only after the next app launch.
   */
  const refreshProfile = useCallback(async () => {
    setDisplayName(await getSetting('displayName').catch(() => null));
  }, []);

  const onWsEvent = useCallback((handler: (event: WsEvent) => void) => {
    eventHandlersRef.current.add(handler);
    return () => {
      eventHandlersRef.current.delete(handler);
    };
  }, []);

  return (
    <ConnectionContext.Provider
      value={{
        client, status, nodeUrl, signer, address, walletAddress, walletSource,
        displayName, peers, connectToNode, setWallet, generateWallet,
        registerExternalWallet, onWsEvent, refreshProfile,
        accounts, refreshAccounts, switchAccount, createAccount, addAccount, removeAccount,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}

/** Access connection state and SDK client. */
export function useConnection() {
  return useContext(ConnectionContext);
}
