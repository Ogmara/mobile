# Changelog

All notable changes to the Ogmara Mobile App will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.5] - 2026-03-29

### Fixed
- Wallet creation "crypto.subtle must be defined" — root cause was
  `@noble/ed25519` v2.x uses `crypto.subtle` for SHA-512 internally.
  Fixed by configuring `ed.etc.sha512Sync` and `ed.etc.sha512Async`
  to use `@noble/hashes/sha512` (pure JS) at app startup, before
  any ed25519 operations occur.

## [0.4.4] - 2026-03-29

### Fixed
- Wallet creation crash "crypto.subtle must be defined" — `randomBytes`
  was imported from `@noble/ciphers/webcrypto` which requires SubtleCrypto.
  Replaced with `crypto.getRandomValues` (available via polyfill).
  Audited all imports to confirm no remaining webcrypto dependencies.

## [0.4.3] - 2026-03-29

### Fixed
- Tab bar icons were missing (placeholder rectangles) — added Ionicons
  from @expo/vector-icons: newspaper, chatbubbles, mail, search, ellipsis

## [0.4.2] - 2026-03-29

### Fixed
- **CRITICAL: App crash on startup** — `crypto.subtle` (SubtleCrypto) is not
  available in React Native Hermes engine. Replaced PBKDF2 and AES-256-GCM
  with `@noble/hashes` (pbkdf2) and `@noble/ciphers` (gcm) which are pure JS
  and work in all environments.
- Global error handler now wrapped in try/catch — won't crash if ErrorUtils
  is unavailable. Removed `promise/rejection-tracking` require (fragile).

### Changed
- `deriveKeyFromPin()` now returns `Uint8Array` instead of `CryptoKey`
- `encryptWithKey()` / `decryptWithKey()` accept `Uint8Array` keys
- Vault `vaultUnlockWithPin()`, `vaultEncryptWithPin()`, `vaultDecryptToRaw()`
  all updated to use `Uint8Array` key type

## [0.4.1] - 2026-03-29

### Added
- Concept-3 logo (purple-blue monogram "O") for all icon assets:
  app icon (1024px), adaptive icon, splash screen, favicon
- Debug mode with in-app log viewer
  - Captures info/warn/error logs in memory (500 entries max)
  - Debug Logs screen accessible from Settings → About
  - Toggle on/off, export logs via share sheet, clear logs
  - Global error handler catches unhandled JS errors and promise rejections
  - Default: ON in development, OFF in production
- Version number displayed in Settings (0.4.1)

### Fixed
- App crash on first start when no L2 node is running — now starts
  gracefully in offline mode with "disconnected" status
- Node health check failure is non-fatal (app works without node)
- Wallet restore failure is non-fatal (app works without wallet)
- WebSocket connect wrapped in try/catch (no crash on connection error)
- All init paths logged to debug console for diagnostics

### Changed
- ConnectionContext: all async operations wrapped with individual
  try/catch blocks and debug logging (no single failure crashes the app)

## [0.4.0] - 2026-03-29

### Added
- Reusable UI components:
  - `SkeletonLoader` — animated pulsing placeholder with configurable rows/avatar
  - `ErrorState` — error message with retry button
  - `MessageBubble` — chat message with long-press context menu
    (Reply, Tip, Delete for own messages) using ActionSheet (iOS) / Alert (Android)
- DM Conversation screen — bubble-style E2E message view with real-time
  WebSocket updates, send input, own/peer message alignment
- Compose Post screen — title, content, tags input with submit to SDK
- Deep link handling (`ogmara://` URL scheme):
  - `ogmara://channel/{id}` → ChannelMessages
  - `ogmara://news/{msgId}` → NewsDetail
  - `ogmara://dm/{address}` → DmConversation
  - `ogmara://user/{address}` → UserProfile
  - React Navigation linking config integrated in App.tsx
- EAS build configuration (`eas.json`):
  - Development: APK with dev client
  - Preview: APK for internal distribution
  - Production: AAB for Play Store, iOS auto-increment
- FAB on NewsFeed now navigates to ComposePost screen

### Changed
- DmTab navigator now includes DmConversation screen (was missing)
- NewsTab navigator now includes ComposePost screen

## [0.3.1] - 2026-03-29

### Added
- Vault migration system (`vaultMigration.ts`) — versioned storage format
  with forward-migration on every app launch
  - `VAULT_VERSION` constant tracks storage format
  - `runVaultMigrations()` runs safely on every launch
  - `verifyVaultIntegrity()` checks stored data health on startup
  - `getVaultDiagnostics()` for support/debugging (never exposes keys)
  - Documents all SecureStore key names per version
  - Documents encryption parameters per version (KDF, cipher, IV size)
- App.tsx runs vault migration + integrity check before any vault access
- Spec update (05-clients.md 5.5.2): Update Safety & Vault Migration rules
- CLAUDE.md: "Wallet Safety (CRITICAL)" section — mandatory rules for
  vault storage changes (never rename keys, always version, always migrate)

### Security
- Vault format versioned (v1) — future updates can safely migrate
- Integrity check on every launch warns on corrupt data (never crashes)
- Migration pattern: write new → verify → delete old (never data loss)

## [0.3.0] - 2026-03-29

### Added
- App lock with PIN code (spec 05-clients.md 5.6.1)
  - 6-digit PIN setup with confirm step
  - PIN hash stored in SecureStore (never plaintext)
  - Lock screen with number pad UI
  - Escalating cooldowns after 5 failed attempts (30s → 600s)
  - Enable/disable from Settings
- Biometric authentication (spec 05-clients.md 5.6.2)
  - Face ID (iOS) and Fingerprint (Android) support
  - Biometric prompt on lock screen (falls back to PIN)
  - Enable/disable toggle in Settings (requires PIN first)
  - Uses expo-local-authentication
- Auto-lock on app background (spec 05-clients.md 5.6.3)
  - Configurable timeout (default: 5 minutes)
  - Tracks time in background, locks if timeout exceeded
- Push notification infrastructure (spec 05-clients.md section 6)
  - FCM (Android) and APNs (iOS) device token retrieval
  - Push gateway registration with wallet auth headers
  - Android notification channels: mentions + DMs
  - Notification tap handler with deep navigation
  - Foreground notification display configuration
- PIN setup screen with number pad and confirm flow
- Security section in Settings (PIN toggle, biometric toggle)
- Push notification data parser for mention/DM navigation

### Changed
- App.tsx now manages lock state with auto-lock on background
- Settings screen includes Security and push sections

### Security
- PIN hashing uses PBKDF2-SHA256 with 600,000 iterations (not plain SHA-256)
- Private key encrypted with PIN-derived AES-256-GCM key before storage
  (vault supports raw and encrypted modes)
- Vault encrypts key on PIN setup, decrypts back to raw on PIN removal
- Biometric auth limited to 3 attempts before requiring PIN (spec 5.6.2)
- Failed PIN attempts + cooldown stored in SecureStore (not AsyncStorage)
- Notification tap navigation deferred while app is locked (pending nav queue)
- PIN removal requires current PIN verification

## [0.2.0] - 2026-03-29

### Added
- ConnectionProvider context — manages L2 node connection, WebSocket,
  and wallet auth state across the entire app
  - Auto-connects to saved node URL on launch
  - Health check with peer count
  - WebSocket with exponential backoff, auto-pause on app background
  - Wallet restoration from SecureStore on launch
- Built-in wallet (WalletScreen)
  - Create new Ed25519 key pair
  - Import from 64-char hex private key
  - Private key stored in expo-secure-store (Keychain/Keystore)
  - Disconnect with confirmation dialog
- Stack navigators inside each tab for drill-down navigation
  - News → NewsDetail → UserProfile
  - Chat → ChannelMessages → UserProfile
  - DMs → (DM conversation) → UserProfile
  - More → Settings → Wallet / UserProfile
- NewsFeedScreen connected to SDK (listNews, pull-to-refresh, card layout)
  - Tap post → NewsDetail, tap author → UserProfile
- ChatScreen connected to SDK (listChannels, channel list with member counts)
  - Tap channel → ChannelMessages with real-time WS updates
  - Message input bar with send button (requires wallet)
- DmListScreen connected to SDK (getDmConversations)
  - Unread count badges, peer avatars, wallet required prompt
- NewsDetailScreen — single post view with comments
- ChannelMessagesScreen — inverted message list, real-time via WebSocket,
  keyboard-avoiding input bar
- UserProfileScreen — avatar, display name, bio, follower/following/post
  counts, follow and DM action buttons
- useApi hook — lightweight data fetching with loading/error/refresh states
- Wallet and connection status sections in Settings screen
- Navigation type definitions for all stack param lists

## [0.1.0] - 2026-03-29

### Added
- Expo SDK 54 project with React Native 0.81 (New Architecture enabled)
- Bottom tab navigation: News (default), Chat, DMs, Search, More
  - Default start screen configurable via settings (`ogmara.default_start_screen`)
  - React Navigation v7 (bottom tabs + native stack)
- Theme system matching web/desktop design tokens
  - Light, dark, and system (auto) modes
  - Persisted via AsyncStorage (`ogmara.theme`)
- Internationalization (i18n) with 6 languages
  - English, German, Spanish, Portuguese, Japanese, Chinese (Simplified)
  - Auto-detect from OS locale, fallback to English
  - react-i18next + i18next
- Core screen shells: NewsFeed, Chat, DmList, Search, Settings
- Settings screen with start screen picker, theme selector, language selector
- SDK integration layer with polyfills (crypto.getRandomValues, TextEncoder)
- Local settings persistence via AsyncStorage (spec 06-frontend.md section 4.1)
- Deep link scheme registered (`ogmara://`)
- Android package: org.ogmara.app, iOS bundle: org.ogmara.app
