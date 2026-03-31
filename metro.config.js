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
// that the SDK uses at runtime.
config.resolver.extraNodeModules = {
  '@noble/ed25519': path.resolve(mobileModules, '@noble/ed25519'),
  '@noble/hashes': path.resolve(mobileModules, '@noble/hashes'),
  '@noble/ciphers': path.resolve(mobileModules, '@noble/ciphers'),
  '@msgpack/msgpack': path.resolve(mobileModules, '@msgpack/msgpack'),
};

config.resolver.nodeModulesPaths = [
  mobileModules,
];

module.exports = config;
