# Building the Ogmara Mobile App

## Prerequisites

- **Node.js** 22+
- **Expo CLI**: `npm install -g expo-cli`
- **EAS CLI** (for builds): `npm install -g eas-cli`
- **Android SDK** (for local Android builds) or EAS cloud build
- **Xcode** (for iOS builds, macOS only)

## Setup

```bash
git clone https://github.com/Ogmara/mobile.git
cd mobile
npm install
```

## Development

```bash
npx expo start
```

Scan the QR code with Expo Go on your device, or press `a` for Android
emulator / `i` for iOS simulator.

## Build APK (Android)

### Local build

```bash
npx expo run:android
```

### EAS build (cloud)

```bash
eas build --platform android --profile preview
```

### Release build

```bash
eas build --platform android --profile production
```

Output: `.apk` or `.aab` file.

## Build iOS

Requires macOS with Xcode installed.

```bash
npx expo run:ios
```

Or via EAS:

```bash
eas build --platform ios --profile production
```

## Install on device

### Android

```bash
adb install path/to/ogmara-*.apk
```

### iOS

Install via TestFlight or Xcode device manager.

## Features

- React Native with Expo SDK 54
- Built-in wallet (create/import/export mnemonic)
- PIN lock + biometric (Face ID / fingerprint)
- Push notifications (FCM on Android, APNs on iOS)
- Deep links
- 7 languages (EN, DE, ES, PT, JA, ZH, RU)
- Dark/light themes

## Vault safety

The mobile app uses a versioned vault storage system for wallet keys.
See the vault migration documentation before modifying any key storage
code. Breaking the vault format means users permanently lose their wallets.
