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

### Local Gradle build — the workflow we actually use on this machine

The native `android/` project is checked in (bare workflow), so APKs are built
directly with Gradle and renamed to carry the version, e.g. `ogmara-0.21.0-dev.apk`.

Prerequisites already present on the build machine:
- `ANDROID_HOME=/home/maik/Android/Sdk`, JDK 17.
- The native project is signed for both debug and release with the bundled
  **debug keystore** (`android/app/debug.keystore`) — so a `release` APK is still
  debug-signed and installs directly via `adb` (no Play upload key needed for testing).

**Step 1 — keep versions in sync (MANDATORY, per CLAUDE.md).** Bump all three before building:
- `package.json` `"version"` and `app.json` `expo.version`
- `android/app/build.gradle` → `versionName` (matches the above) **and** `versionCode`
  (monotonically increasing integer — bump it every build that goes on a device).

> These do NOT auto-sync in the bare workflow. For 0.21.0 they are already set to
> `versionName "0.21.0"` / `versionCode 21`.

**Step 2 — install JS deps (links the local SDK via `file:../sdk-js`):**
```bash
cd /home/maik/projects/Ogmara/mobile
npm install
# Belt-and-suspenders @noble single-instance for Metro (metro.config already dedupes,
# but this removes any duplicate the SDK's own install pulled in):
rm -rf ../sdk-js/node_modules/@noble
```

**Step 3 — build with Gradle:**
```bash
cd android
./gradlew assembleRelease     # optimized, debug-signed → app/build/outputs/apk/release/app-release.apk
# (or ./gradlew assembleDebug → app/build/outputs/apk/debug/app-debug.apk for a plain debug build)
```
First clean build is slow (Hermes + native). For a from-scratch build add `./gradlew clean` first.

**Step 4 — name the artifact with the version (mandatory):**
```bash
cp app/build/outputs/apk/release/app-release.apk ../ogmara-0.21.0-dev.apk
```

**Step 5 — install on a connected device:**
```bash
adb install -r ../ogmara-0.21.0-dev.apk     # -r reinstalls over the previous version
```

> **Vault note for testers:** because the release APK is debug-signed (same signing key
> as prior `-dev` builds), `adb install -r` upgrades in place and the existing wallet
> vault (`ogmara.vault.*`) plus the new E2E keys (`ogmara.e2e.*`) survive the upgrade.
> A *signing-key change* (or uninstall) would wipe both — keep using the same keystore.

### Expo dev client (alternative local run)

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
