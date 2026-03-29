// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const config = getDefaultConfig(__dirname);

// Resolve @ogmara/sdk from the local sdk-js directory
// (Metro doesn't follow npm file: symlinks by default)
const sdkPath = path.resolve(__dirname, '../sdk-js');

config.watchFolders = [sdkPath];

config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  path.resolve(sdkPath, 'node_modules'),
];

module.exports = config;
