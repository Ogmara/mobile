// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Resolve @ogmara/sdk from the local sdk-js directory
// (Metro doesn't follow npm file: symlinks by default)
const sdkPath = path.resolve(__dirname, '../sdk-js');
const mobileModules = path.resolve(__dirname, 'node_modules');

config.watchFolders = [sdkPath];

// CRITICAL: Force all shared dependencies to resolve from mobile's
// node_modules, not the SDK's. This ensures our polyfill patches
// (e.g., ed.etc.sha512Async) apply to the SAME module instance
// that the SDK uses at runtime. If the SDK loaded its OWN @noble/ed25519
// copy, it would be UNPATCHED → getPublicKeyAsync throws → WalletSigner.fromHex
// fails → the wallet silently won't load on launch ("no wallet" despite the key
// being present in SecureStore). This caused a wallet-restore regression once
// `sdk-js/node_modules/@noble` got re-created by an `npm install` in sdk-js.
const FORCED_SINGLETONS = [
  '@noble/ed25519',
  '@noble/hashes',
  '@noble/ciphers',
  '@msgpack/msgpack',
];

config.resolver.extraNodeModules = {
  '@noble/ed25519': path.resolve(mobileModules, '@noble/ed25519'),
  '@noble/hashes': path.resolve(mobileModules, '@noble/hashes'),
  '@noble/ciphers': path.resolve(mobileModules, '@noble/ciphers'),
  '@msgpack/msgpack': path.resolve(mobileModules, '@msgpack/msgpack'),
};

config.resolver.nodeModulesPaths = [
  mobileModules,
];

// extraNodeModules is only a FALLBACK — it does not override a copy that already
// exists in sdk-js/node_modules. So force these singletons unconditionally by
// rewriting the resolution origin to mobile's root, guaranteeing a single shared
// instance regardless of whether the SDK has its own copy installed. This makes
// the dedup robust (no reliance on manually deleting sdk-js/node_modules/@noble).
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (FORCED_SINGLETONS.some((p) => moduleName === p || moduleName.startsWith(p + '/'))) {
    const forcedContext = {
      ...context,
      originModulePath: path.join(mobileModules, 'index.js'),
    };
    const resolve = defaultResolveRequest || context.resolveRequest;
    return resolve(forcedContext, moduleName, platform);
  }
  return (defaultResolveRequest || context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
