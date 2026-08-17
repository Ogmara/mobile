# Changelog

All notable changes to the Ogmara Mobile App will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.32.0] - 2026-08-17

### Security

- **Cross-network envelope replay (l2-node final pre-mainnet audit C1) —
  coordinated wire-format cutover.** Bumped `@ogmara/sdk` to 0.42.0, which
  binds every signed envelope's msg_id/signature to the target Klever
  network — matches l2-node 0.83.0's `PROTOCOL_VERSION` 1 → 2 hard cutover.
  No app-level call-site changes needed for the normal `OgmaraClient` path;
  `src/lib/deviceEnc.ts`'s two direct `buildDeviceEncBinding`/
  `buildDeviceEncRevoke` calls (built-in-wallet device-key binding/revoke —
  these build wallet-authored envelopes outside `OgmaraClient`) now pass the
  new required `network` parameter via the SDK's new
  `OgmaraClient.getNetwork()`.
- **Breaking:** hard wire-format cutover — this build only works against
  l2-node 0.83.0+; a pre-0.83.0 node rejects every envelope it sends. Ships
  together with matching bumps in `web` and `desktop`.

### Fixed

- `npm audit`: fixed 4 of the 27 flagged advisories (`ws` DoS, `js-yaml`
  quadratic-CPU) via the non-breaking `npm audit fix`. The remaining 23 are
  a previously-tracked set — all build-tooling-only, all gated behind an
  Expo SDK 57 / RN 0.86.0 major bump that needs its own dedicated migration
  session; left untouched per the no-blind-`--force` policy (unverifiable
  in this session).

## [0.31.2] - 2026-08-02

### Fixed

- **Preventive: the node's per-IP media-concurrency cap could be tripped by a
  channel with many attachments.** Found and fixed live on desktop (a
  channel with several encrypted images froze the app, see desktop
  CHANGELOG 1.50.2) — `fetchCipherWithRetry` fired one ciphertext GET per
  attachment/thumbnail with no concurrency limit, and any non-200/404 status
  (including `429 too many concurrent media requests` from the node's
  per-IP limiter, `l2-node api/media_limiter.rs`, default 4 concurrent)
  failed immediately instead of retrying. RN's `fetch` has no implicit
  per-origin concurrency cap either, so the same mismatch applies here.
  Added a `MAX_CONCURRENT_MEDIA_FETCHES = 3` slot queue, and 429 is now
  retried (honoring the node's `Retry-After` header, clamped to the
  remaining retry budget) instead of failing immediately.

### Security

- The `Retry-After` value the node returns is untrusted input; the retry
  wait is now clamped to the remaining `MEDIA_FETCH_MAX_WAIT_MS` budget so a
  large or malformed value can't stall a single attachment past the
  documented wait window (audit finding).

## [0.31.1] - 2026-08-02

### Fixed

- **Cross-node media retry budget (45s) was sometimes shorter than the
  node's own worst-case fallback.** l2-node's cross-node media fallback
  (spec 03-l2-node §3.3.1) dials up to 3 candidate peers at 5s connect / 30s
  total each — up to ~90s server-side before it even reports a miss. A 45s
  client retry budget could give up before the node's own fallback had a
  realistic chance to land, permanently failing an attachment for the rest
  of that screen's lifetime (confirmed live on desktop with the same retry
  logic — an image 404'd through the full retry window, then decoded fine
  after navigating away and back). Raised the budget to 3 minutes and the
  poll interval to 5s in `src/lib/mediaCrypto.ts`.

## [0.31.0] - 2026-08-02

### Security

- **Media encryption gate failed OPEN: private/encrypted-channel images
  could upload to IPFS as plaintext.** Found while checking mobile for the
  same class of bug just fixed on web/desktop. `ChannelMessagesScreen`'s
  `isEncrypted` was computed as `chanMeta.encryptionEnabled || isPrivate`,
  where `chanMeta` starts at hardcoded plaintext-shaped defaults
  (`{ encryptionEnabled: false, channelType: 0 }`) before the async
  channel-metadata fetch resolves — and on a fetch failure, the code
  explicitly kept those defaults ("keep defaults — plaintext path"). An
  image attached to a private channel during either window uploaded
  unencrypted. Extracted the decision into `src/lib/channelEncryption.ts`'s
  `resolveIsEncrypted()`, which fails CLOSED via a new `chanMetaResolved`
  flag: `false` until the fetch succeeds, reset on every channel switch, and
  — unlike before — never set on a fetch failure either (stays fail-closed
  for the rest of that mount rather than falling back to defaults). Also
  disabled the attach button (and guarded `handlePickMedia` itself) until
  `chanMetaResolved`, as belt-and-suspenders alongside the fail-closed
  check. DMs were verified independently: `DmConversationScreen`'s
  `handlePickMedia` calls the encrypted upload path unconditionally, no
  channel-metadata dependency at all.
- Added the first regression tests in this repo:
  `src/lib/channelEncryption.test.ts` (5 cases, `node --test`, no new
  dependency — Node 24 strips simple TS syntax natively). New `npm test`
  script; `tsconfig.json` excludes `*.test.ts` (careful to preserve Expo's
  base `exclude` list — `android`/`ios`/`node_modules`/config files — which
  a naive override would have dropped).
- **Known gap, not yet fixed (same as web/desktop):** `isPrivate` itself
  still fails open the same way while unresolved, and separately still
  drives `encFloor` (the P2d member-removal rotation-floor check) and
  `canEstablishKey`. Does **not** leak plaintext (`isEncrypted` still forces
  encryption); tracked as a follow-up across all three clients.

## [0.30.3] - 2026-07-29

### Changed

- **Shortened the public-encrypted-channel header badge** from "🔒 Encrypted
  (public by design — any member can read)" to "🔒 Encrypted · public by
  design" — matching the wording web/desktop already use
  (`channel_encrypted_public`), which mobile's longer badge had drifted from.
  The full explanation ("any member can read") now lives in the channel
  admin/settings screen instead, shown once under the channel name rather
  than repeated in the header on every visit.

## [0.30.2] - 2026-07-29

### Fixed

- **Channel name wrapped across multiple lines when the encryption badge
  text was long.** The channel header laid out the name and the encryption
  badge (`ChannelMessagesScreen`'s "🔒 Encrypted (public by design — any
  member can read)" text for public encrypted channels) side by side in one
  row, both sharing the title's `flex: 1` — a long badge squeezed the
  remaining width down until the channel name itself wrapped mid-word. Name
  and badge now stack in their own column (each `numberOfLines={1}`), so the
  name always gets the header's full width and the badge sits on its own
  line below it.

## [0.30.1] - 2026-07-29

### Fixed

- **Pinch-to-zoom didn't work at all.** `ImageViewerModal` rendered its
  `GestureDetector` inside a plain `Modal` — RN's `Modal` opens a separate
  native window on Android, outside the app's main view hierarchy, so the
  top-level `GestureHandlerRootView` (in `App.tsx`) never covered it and
  every gesture silently no-op'd. Fixed by nesting a second
  `GestureHandlerRootView` scoped to the modal's own content.
- **Native `Alert.alert()` dialogs didn't match the app's theme.** The
  project already has themed `ConfirmModal`/`PromptModal` components for
  exactly this reason. New `InfoModal` (single message + OK) fills the gap
  for simple info/error alerts. Converted the message/chat-related ones:
  `ImageViewerModal`'s save-result alert, `MessageBubble`'s delete
  confirmation (→ themed `ConfirmModal`, danger-styled), and all the
  info/error alerts in `ChannelMessagesScreen` and `DmConversationScreen`.
  Wallet/settings/news screens still use `Alert.alert` in places — left for
  a separate pass.
- **Decrypted attachments weren't cached across app restarts**, forcing a
  full re-fetch + re-decrypt of every image/video the first time a
  previously-visited conversation was reopened after a cold start (the old
  cache was an in-memory `Map`, gone on restart). New
  `src/lib/mediaDiskCache.ts` persists decrypted plaintext to a cache
  directory with a 7-day TTL (checked/enforced lazily on read via
  `expo-file-system`'s file modification time); `loadDecryptedMedia` checks
  it before hitting the network. Also folded in the same 404-retry-with-
  backoff web/desktop already had for cross-node media (was missing on
  mobile), and strengthened the cache-key fingerprint from "cid + first/last
  byte of key" to a full "cid + hex(key) + hex(nonce)" (matching web/
  desktop) — the weak version was an acceptable risk for an in-memory,
  single-session cache, but not once it became load-bearing for a
  persistent, cross-session one. `clearMediaCache()` (called on logout /
  wallet switch) now wipes the disk cache too, so a different identity never
  inherits another wallet's already-decrypted plaintext.

### Security

- Persisting E2E-decrypted plaintext to disk (even TTL-bounded, even
  app-private) is a deliberate, real tradeoff for the offline-cache feature
  above — flagging it explicitly rather than burying it in the Fixed
  section. Mitigations: app-private cache directory (not shared/world-
  readable, same location already used for user-initiated save/share),
  7-day TTL, and a full wipe on logout/wallet switch.
- **Disk-cache filename collision caught before release.** The cache
  filename was initially derived by running the full `cid:hex(key):hex(nonce)`
  fingerprint through the existing `sanitizeFilename` helper, which caps
  length at 100 chars — for a CID + 64 hex key chars + 48 hex nonce chars
  (~170 chars total), that silently truncated away the entire nonce and part
  of the key, re-collapsing the exact cross-context collision the
  full-fingerprint upgrade above was meant to close (a sender who reuses a
  CID with a key sharing the surviving prefix could make a stale cached
  plaintext resurface under a new message, skipping decryption of the actual
  new ciphertext entirely). Fixed by hashing the full tag (SHA-256) for the
  cache filename instead of truncating it — collision resistance no longer
  depends on the tag's length.

## [0.30.0] - 2026-07-29

### Added

- **Pinch-to-zoom image viewer + save-to-device / share attachments.** The
  fullscreen image viewer (tap an image in a chat) was a plain fit-to-screen
  `Modal` with no zoom and no way to save. New `ImageViewerModal`
  (`src/components/ImageViewerModal.tsx`) adds pinch-to-zoom, double-tap to
  toggle zoom, and drag-to-pan once zoomed (via `react-native-gesture-handler`
  + `react-native-reanimated`, running on the UI thread), plus a download
  button that saves the image straight to Photos (`expo-media-library`,
  write-only/photo-only permission scope). Non-image attachments (file chips
  in both plaintext and encrypted messages) were previously inert — tapping
  one now writes it to a cache file and opens the native share sheet
  (`expo-sharing`), so "Save to Files" / share-elsewhere is one tap away for
  any file type, not just images.
- New native dependencies: `react-native-gesture-handler`, `react-native-reanimated`
  (+ babel plugin, `App.tsx` now wraps the tree in `GestureHandlerRootView`),
  `expo-media-library` (new `expo-media-library` config plugin entry in
  `app.json`, photo-only granular permission), `expo-sharing`,
  `expo-file-system` (writes the temp file both features share). Required an
  `expo prebuild --clean` to regenerate `android/` — anyone building locally
  needs to re-run prebuild before the next Gradle build picks these up.

### Security

- **Attacker-controlled filenames sanitized before touching the filesystem.**
  Both new save/share paths build a real cache-file path from peer-supplied
  data — a `MediaDescriptor.name`/attachment `filename`, or a MIME string used
  as a file extension — none of which `expo-file-system` sanitizes on its own.
  New `src/lib/sanitize.ts` (`sanitizeFilename`) strips path separators and
  control characters, caps length, and rejects a name that cleans down to a
  bare `.`/`..` (which would otherwise resolve to the cache directory itself
  or its parent). Applied in both `fileShare.ts` and `ImageViewerModal`'s
  `saveImageToDevice`.
- **`expo-media-library` requests write-only photo access, not full read.**
  `app.json`'s plugin config sets `photosPermission: false` (suppresses iOS's
  `NSPhotoLibraryUsageDescription`, full read access) since the app only ever
  calls `requestPermissionsAsync(true)` (add-only) — `savePhotosPermission`
  (`NSPhotoLibraryAddUsageDescription`) is the only one actually needed.
- Temp cache files from a save-to-Photos are deleted immediately after
  `saveToLibraryAsync` resolves (safe — it only resolves once the OS has made
  its own library copy). Share-sheet temp files are intentionally left for
  the OS's normal cache eviction instead of deleted eagerly, since
  `shareAsync` can resolve before a slower receiving app finishes reading the
  file — deleting on that timing would risk breaking the share.

npm audit: 30 pre-existing/incidental advisories, all build-tooling-only
(unchanged category from the already-tracked Expo SDK 57 migration item);
no new advisory introduced by the added runtime dependencies themselves.

## [0.29.2] - 2026-07-29

### Fixed

- **Couldn't send an attachment-only message in a channel.** The channel
  composer's send button (`ChannelMessagesScreen`) only checked
  `pendingAttachments` (the plaintext-upload queue) to decide whether to
  enable itself, never `pendingEncryptedMedia` (the encrypted-upload queue)
  — so in an encrypted channel, attaching an image with no text left the
  button disabled and unpressable. `handleSend` itself already accounted for
  both queues correctly; only the button's `disabled`/color logic was
  missing the encrypted-media check. DM composer was unaffected (it only
  ever uses the encrypted queue, so it already checked the right one).

## [0.29.1] - 2026-07-29

### Fixed

- **Attaching a file in an encrypted DM/channel crashed with "Creating blobs
  from 'ArrayBuffer' and 'ArrayBufferView' are not supported."**
  `encryptAndUploadFile` (`src/lib/mediaCrypto.ts`) built a `new Blob([cipher])`
  to carry the encrypted bytes in the upload `FormData` — React Native's `Blob`
  polyfill only accepts strings/other Blobs as parts, not an `ArrayBuffer`/
  `Uint8Array`, so every encrypted attachment attempt threw. There's no
  on-disk file for the in-memory cipher (unlike the plaintext upload paths in
  `ChannelMessagesScreen`/`ComposePostScreen`, which pass the picked asset's
  real `file://` uri), so the fix instead hands RN's networking layer a
  `data:application/octet-stream;base64,...` URI via the same
  `{ uri, type, name }` FormData shape the plaintext paths already use —
  no Blob construction at all. Plaintext attachments (public channels, news
  posts) were never affected; only encrypted-channel/DM attachments were
  broken.

## [0.29.0] - 2026-07-27

### Added

- **Delete a DM conversation** — matching the web/desktop feature shipped in
  this same release. Long-press a conversation in the DM list for a "Delete
  conversation" action (via the same `QuickMenu`/`ConfirmModal` components
  built for channel leave/delete). Per-user "hide from my list" only — DMs
  are two-wallet, so the peer's copy is untouched, and the conversation
  reappears automatically if they message again. New `src/lib/dmHide.ts`
  (AsyncStorage port of web/desktop's `dm-hide.ts`), wired into the existing
  encrypted `SettingsSync` blob exactly like `channelOrg` — no new server
  endpoint, SDK method, or protocol message type needed.

### Fixed

- **DM unread badge never cleared until app restart.** `DmListScreen.tsx`
  had no `useFocusEffect` refetch (unlike `ChatScreen.tsx`'s working
  channel-list pattern), so returning from a conversation you'd just read
  (which does correctly mark it read server-side) never refreshed the
  list's stale local `unread_count`. Added the same `useFocusEffect` →
  `onRefresh()` pattern already proven on the channel list.

## [0.28.1] - 2026-07-27

### Fixed

- **Confirm dialogs (leave/kick/ban/delete channel, delete group) now use a
  themed modal instead of the bare native OS `Alert.alert`**, which ignored
  the app's dark theme and accent colors entirely. New
  `src/components/ConfirmModal.tsx` (styled like the existing `PromptModal`)
  replaces the confirm-with-buttons usage of `Alert.alert` in
  `ChatScreen.tsx` and `ChannelAdminScreen.tsx`. Plain one-button
  notifications (save success, invite sent, error messages) are unchanged —
  only actual "are you sure?" confirmations were converted.

## [0.28.0] - 2026-07-27

### Added

- **Leave a channel** (any member) and **organize joined channels into groups
  with custom ordering** — closing a long-standing gap with web/desktop.
  Long-press a channel row for a context menu: move to group, move up/down
  within its group, leave (self-service, any member), delete (owner only,
  reusing the existing `deleteChannel` flow). A toolbar above the channel
  list adds "+ Group" and "Sort A–Z"; each group header gets a "..." menu
  (rename, move up/down, delete group). The non-mod "no access" dead end on
  the channel-settings (gear icon) screen now shows a "Leave channel" action
  instead of a blank message.
  - New `src/lib/channelOrg.ts`: port of web/desktop's `channel-org.ts` data
    model (groups + per-channel group/order placement), so the structure
    round-trips byte-for-byte with the existing cross-device sync. Backed by
    an in-memory cache hydrated once from AsyncStorage (mirroring the
    `prices.ts` memory-cache pattern), since AsyncStorage is async unlike
    web's synchronous `localStorage`.
  - `src/lib/settingsSync.ts`: `channelOrg` now rides the existing encrypted
    SettingsSync blob (LWW merge + auto-join channels placed by another
    device), matching web/desktop exactly.
  - New `src/components/PromptModal.tsx` (cross-platform name/rename dialog
    — `Alert.prompt` is iOS-only) and a bottom-anchored `anchor` variant of
    `QuickMenu` for the new per-row/per-group context menus.
  - `client.leaveChannel()` (message type `ChannelLeave`, already supported
    server-side and by the bundled SDK) is now actually called from mobile
    for the first time.

### Fixed

- **Settings sync was completely broken on mobile** — `settingsSync.ts`'s
  `uploadSettings()`/`downloadSettings()` called `getClient()` (which
  returns a `Promise`) without `await`, so every sync attempt silently threw
  and was swallowed by `SettingsScreen`'s try/catch. This affected the
  pre-existing theme/lang/notificationSound/compactLayout/fontSize sync too,
  not just the new `channelOrg` feature added in this release. Also fixed
  `encryptSettings()`'s return type (`number[]` → `Uint8Array`), which the
  Promise bug had been masking — the SDK's `syncSettings()` requires
  `Uint8Array` for `encrypted_settings`/`nonce`.
- Guarded against a cross-device data-loss race: `channelOrg`'s in-memory
  cache is now explicitly hydrated (`ensureChannelOrgLoaded()`) before every
  settings-sync upload/download, not just on first `ChatScreen` mount — the
  app's default start screen is News, so a user could otherwise open
  Settings and sync before Chat ever loaded the real on-disk state,
  uploading an empty org or letting a remote copy wrongly "win" an LWW
  comparison against the untouched default.

## [0.27.2] - 2026-07-27

### Security

- Ran `npm audit` before build; applied the non-breaking `npm audit fix` (patch/minor bumps only,
  e.g. expo 54.0.35→54.0.36, plus internal `@expo/*`/babel/metro-config/ws/tar/js-yaml/
  brace-expansion patches) and re-verified the release build succeeds. 29 advisories remain, all
  gated behind a major bump (Expo SDK 57 or React Native 0.86.0) and all in build/dev tooling
  (Metro codegen, dev-middleware, babel-jest, prebuild config-plugins) — none shipped to the
  device. Deferred: needs its own dedicated, testable upgrade session, not a blind `--force`.

### Added

- **Multi-currency wallet display.** New "Display currency" setting (USD, EUR, BRL, GBP, JPY, CNY)
  drives fiat formatting across the wallet screens. Rates are USD→currency via a keyless CoinGecko
  lookup (`tether` as a USD proxy, cached 1h in `AsyncStorage`, stale-tolerant with in-flight
  dedup), added to `src/lib/prices.ts` (`loadForex`, `formatFiat`). `formatUsd` is now a thin
  wrapper over `formatFiat(..., 'usd', 1)` for backwards compat.
- **Per-asset logos on the token detail screen** (`TokenDetailScreen.tsx`), falling back to the
  Klever assets API (`fetchAssetMeta` in `src/lib/klever.ts`) when the bitcoin.me price feed
  (`price.iconUrl`) doesn't carry a given token (it only lists traded tokens).

### Fixed

- **Asset precision from the account/assets APIs could silently become `NaN`** if either endpoint
  ever returned a non-numeric `precision` field, mangling the decimal point in displayed balances
  instead of falling back safely. `src/lib/klever.ts` now guards both `Number(...)` casts with
  `Number.isFinite`, defaulting to `0` on a bad value like the existing null-handling.
- **Wallet screen no longer shows a stray "Settings" header above a large empty gap.**
  `WalletBalanceScreen` (and the other `MoreStack` screens with their own native header —
  Bookmarks, Addressbook, Receive, TokenDetail) were nested under the "More" bottom tab, whose
  outer `Tab.Navigator` header always displayed the fixed `MoreTab` title ("Settings") regardless
  of which nested screen was focused, stacking on top of the screen's own back-arrow header.
  `TabNavigator.tsx` now computes `headerShown` for `MoreTab` from the focused nested route
  (`getFocusedRouteNameFromRoute`), hiding the outer header whenever one of those sub-screens is
  active so each renders as a clean standalone screen with only its own header.

## [0.27.1] - 2026-07-27

### Fixed

- **Channel deletion + kick/ban removal now work app-wide**, closing the limitation noted in
  0.27.0: previously `ChannelMessagesScreen`'s WS listener only reacted while that exact channel
  was the open screen, so a removal arriving while the user was elsewhere never updated the
  local joined-channels list until they happened to reopen it. New global listener in `App.tsx`
  (`AppContent`, wired to the same `navigationRef` already used for notification-tap navigation)
  handles both `channel_deleted` and kick/ban regardless of what screen is active, and still
  bounces back to the channel list if the affected channel happens to be the one currently open.
  `ChannelMessagesScreen`'s own now-redundant handling was removed to avoid a double-navigation
  when both would otherwise fire for the same event.

## [0.27.0] - 2026-07-27

### Added

- **React to channel deletion while viewing it.** New `channel_deleted` WS handler in
  `ChannelMessagesScreen` (bundled SDK 0.41.0) drops a deleted channel from the local
  joined-channels list and navigates back if the user has it open. Narrower than web/desktop:
  mobile has no app-wide persistent WS listener (unlike their always-mounted `Sidebar`), so a
  deletion that arrives while the user is elsewhere won't remove it from the channel list until
  they happen to reopen it — the same pre-existing limitation kick/ban already has here. A full
  fix needs a navigation ref + a global listener; tracked as a follow-up, not done in this pass.

## [0.26.1] - 2026-07-26

### Fixed

- **Private-channel "waiting for the channel key" could stick forever after a cross-node
  join.** Same fix as web 0.61.2 / desktop 1.46.2: `ChannelMessagesScreen`'s late-key-arrival
  poll gave up after ~36s (12 ticks × 3s) with no way to resume short of leaving and
  reopening the channel. Live testnet diagnosis (darkw0rld + freeweb) confirmed the node-side
  federation stack delivers the key correctly, but the full cross-node round trip can take
  longer than that. Extended the give-up budget and renewed it on the existing
  `channel_members_changed` WS event, which the screen already handles.

### Security

- **Dependency scan (`npm audit`) — 19 advisories found (1 critical, 6 high, 11 moderate, 1
  low), all in the Expo/React Native/Metro dev-and-build toolchain (`tar`, `undici`, `uuid`
  transitively via `xcode`/`@expo/config-plugins`, `ws`), none in runtime app code shipped to
  the device. A plain `npm audit fix` (no `--force`) was tried and made things WORSE — it
  reshuffled the lockfile, raised the count to 29, and pulled in `react-native@0.86.0`
  transitively, a breaking bump. Reverted immediately. Per the project's mobile dependency
  policy, this toolchain can't be build-verified in this session (no Expo/Metro dev server or
  device available), so no fix was force-applied. **Deferred to a session where the mobile
  build can be tested end-to-end** — flagging explicitly rather than leaving unmentioned.

## [0.26.0] - 2026-06-15

### Added

- **P5 encrypted media (spec 04 §9).** Attachments in encrypted DMs, private channels,
  and public encrypted channels are now end-to-end encrypted: the file bytes are
  encrypted with a fresh per-file key BEFORE the IPFS upload, so the node only ever
  stores opaque ciphertext. The per-file key + nonce ride INSIDE the message ciphertext
  as a `MediaDescriptor`; only a stripped `{ cid, size }` reaches the wire.
  - New `src/lib/mediaCrypto.ts`: `encryptAndUploadFile` (read bytes → SDK `encryptFile`
    → upload the cipher with an `encrypted=1` form field), `loadDecryptedMedia`
    (fetch ciphertext → SDK `decryptMedia` → `data:` URI, cached by cid), and Hermes-safe
    base64 codecs.
  - `MessageBubble` renders encrypted attachments via a new `EncryptedAttachment` view:
    a placeholder while decrypting, the decrypted image/file on success, and a
    "🔒 encrypted attachment" fallback on failure.
  - `ChannelMessagesScreen` and `DmConversationScreen` now encrypt-on-send (passing
    `media` descriptors to the encrypted builders) and decrypt-on-render. The DM screen
    gains its first attachment picker. The plaintext upload path is preserved for
    non-encrypted channels.
  - `buildEncryptedChannelMsg` / `buildEncryptedDm` accept `media`; the decrypt wrappers
    (`decryptChannelMessage` / `decryptDmMessage`) surface the content `media[]`.
  - i18n: `e2e_decrypting` + `e2e_attachment` strings added for all 7 languages.

### Notes

- Files are buffered fully in memory and capped at 50 MB (`MAX_ENCRYPTED_MEDIA_BYTES`);
  streaming encryption is post-MVP.
- Upload of the encrypted bytes uses a `Blob` built from the cipher in a multipart
  `FormData` (no `expo-file-system` dependency was added). Rendering uses `data:` URIs
  rather than temp files. Both paths are typecheck-clean but **device runtime
  verification is still pending** (Expo/Metro device build not runnable in this session) —
  consistent with the existing mobile E2E "device runtime-verify pending" status.

## [0.26.0] - 2026-06-15

### Changed

- **Wallet hero + actions redesign ("Minimal premium").** The hero card is now a subtle
  dark gradient with a thin accent top-glow and a hairline border (no more flat blue block);
  Send / Receive / Manage are airy **outline "ghost" pills** with accent icons instead of
  filled circles.

### Added

- **24h portfolio change %** — value-weighted ▲/▼ indicator next to the balance (from
  bitcoin.me 24h data).
- **Currency switcher** — `USD ▾` chip opens a picker (USD/EUR/BRL/GBP/JPY/CNY); fiat values
  convert via keyless CoinGecko forex rates (`loadForex`/`formatFiat`), persisted in settings.
- **Tap balance to hide** — tap the balance to blur all amounts (`••••`) for shoulder-surfing
  privacy; an eye icon shows the state.

(Localized across all 7 languages. The token-detail/staking screen still displays USD.)

## [0.25.3] - 2026-06-15

### Fixed

- **Non-KLV token precision was wrong.** `fetchAccountData` defaulted precision to `6`
  (`|| 6`), which both mis-defaulted absent values AND turned a real precision of `0`
  (e.g. FLIPPY) into `6` — mis-scaling balances by 10⁶. Now uses the API precision verbatim,
  defaulting to `0` only when truly absent (per the "always check precision via API" rule).
- **Non-KLV token logos were missing.** The Klever account endpoint carries no logo and
  bitcoin.me only lists traded tokens. Added `fetchAssetMeta` (`/v1.0/assets/{id}` → logo +
  authoritative precision), used as the logo source for tokens lacking a bitcoin.me icon
  (wallet hub + staking hub).

### Changed

- **Recent Activity icons** drop the colored circle backgrounds — the type symbol is shown
  on its own in the type's accent color, for a cleaner look.

## [0.25.2] - 2026-06-15

### Changed

- **Recent Activity labels transactions by type** instead of generic "Sent"/"Received".
  Stake/Unstake/Delegate/Undelegate/Withdraw/Claim/Contract-call each get their own label,
  glyph and accent (from the native Klever contract type), so staking actions are no longer
  confusingly shown as "Sent". `txHistory` now captures the contract type. Localized (7 langs).

## [0.25.1] - 2026-06-15

### Fixed

- **KLV delegation failed with "could not create reward address from provided param."**
  The Delegate contract used `toAddress` for the validator, but the Klever `/transaction/send`
  API uses `receiver` for the address field (same convention as Transfer). Switched the
  Delegate payload to `{ bucketID, receiver }`.

## [0.25.0] - 2026-06-15

### Added

- **Staking, delegation & rewards hub.** Tapping a token in the wallet opens a new
  `TokenDetailScreen` where users can:
  - **Stake (freeze)** an asset, and **claim** staking/delegation rewards
    (`/address/{addr}/allowance` → claimable amount).
  - For **KLV**: **delegate** a bucket to a validator (picked from `/validator/list`,
    shown with logo, name, commission, total stake), **undelegate**, **unstake**
    (unfreeze), and **withdraw** matured funds.
  - Per-bucket status (staked / delegated to <validator> / unfreezing).
  - All actions are native Klever contracts via `kleverTx` (Freeze/Unfreeze/Delegate/
    Undelegate/Withdraw/Claim = types 4/5/6/7/8/9), built+signed+broadcast through the
    verified `/transaction/send` → decode → sign → broadcast flow. `klever.ts` gained
    `StakeBucket`/`Validator` types, bucket parsing, `fetchAssetRewards`, `fetchValidators`.
  - Fully localized across the 7 languages.

> Note: tested against Klever **testnet**. Verify on testnet before mainnet use — the node
> simulates and rejects malformed contract payloads on `/transaction/send`, so a bad action
> fails safely (nothing is broadcast).

## [0.24.0] - 2026-06-15

### Changed

- **Explorer links now use Ogmara's own explorer (kleverchain.org)** instead of kleverscan.
  All deep links use the documented query-param routes: transactions
  (`/transactions?hash=`), wallet (`/wallet?address=`), staking (`/staking?address=`),
  reconciliation (`/reconciliation?address=`), contracts (`/contracts?address=`).
  `&network=testnet` is appended on testnet. New helpers `getExplorerAddressUrl` /
  `getExplorerStakingUrl` / `getExplorerReconciliationUrl` / `getExplorerContractUrl`.

### Added

- **Staked balances in the wallet hub.** Frozen/staked amounts (KLV freeze + per-KDA
  staking) are now included so the **total portfolio value sums correctly**: the hero card
  shows "🔒 incl. \$X staked", and each asset row shows its 🔒 staked amount under the
  available balance. New Manage actions: **Staking overview** and **View on explorer**
  (deep-link to kleverchain.org for the connected address). Fully localized (7 languages).

## [0.23.2] - 2026-06-15

### Fixed

- **Root cause of the dark/unscannable QR (and washed-out cards): platform force-dark.**
  The Android `DayNight` theme had no `forceDarkAllowed` override, so on a dark system
  (notably MIUI's aggressive force-dark) the OS auto-inverted light surfaces — turning the
  white QR card gray (unscannable) and desaturating the accent hero card. Added
  `android:forceDarkAllowed=false` to the app theme (the app ships its own Modern dark
  theme); white renders true white and accents render at full saturation. Status-bar color
  updated to the Modern dark `#0E1621`.

### Changed

- **Wallet hero card now uses a top→bottom gradient** (lighter accent → accent → deeper),
  rendered dependency-free via a pure-JS `Gradient` component (flex colour bands), with a
  subtle elevation shadow and a pill-style copy-address chip.
- **Send / Receive / Manage actions** redesigned with filled accent circles and proper
  Ionicons (arrow-up / qr-code / settings) instead of plain text glyphs.

## [0.23.1] - 2026-06-15

### Fixed

- **Receive QR was dark/smeared and hard to scan.** The QR cells used a fractional pixel
  size, so adjacent modules overlapped (black bled over white) with no clean quiet zone.
  `QrCode` now uses integer cell sizes, centers the grid, and renders a proper 4-module
  white quiet zone — crisp black-on-white, reliably scannable.

## [0.23.0] - 2026-06-15

### Added

- **Redesigned wallet — "Portfolio Hero" hub.** The wallet is now a single modern screen:
  - Gradient hero card showing **total portfolio value in USD** + KLV balance + tappable
    (copy) address, with circular **Send / Receive / Manage** actions.
  - **Assets list** with token logos, balances, **USD value**, and a **7-day sparkline** per
    token — sourced from the keyless `api.bitcoin.me/tokens` feed (`src/lib/prices.ts`,
    AsyncStorage-cached). Sparklines render with plain Views (`Sparkline.tsx`, no chart dep).
  - **Receive screen** with a scannable QR of your address + copy/share (`ReceiveScreen.tsx`,
    `QrCode.tsx` using the pure-JS `qrcode-generator` — no native module).
  - **Recent activity**: last on-chain transactions from the Klever API
    (`src/lib/txHistory.ts`), each linking to the explorer.
  - **Inline management** behind Manage: on-chain register, export private key (with warning),
    disconnect — no longer a separate screen. The Settings wallet row now opens this hub when
    a wallet is connected.

## [0.22.4] - 2026-06-15

### Fixed

- **CRITICAL: wallet failed to load on launch ("no wallet" despite the key being present).**
  The vault was never changed and the key was never lost (`getVaultDiagnostics` confirmed
  `rawKey: true` in SecureStore). Root cause: a **duplicate `@noble/ed25519`** got installed
  in `sdk-js/node_modules` (via an `npm install` in the SDK), and `metro.config`'s
  `extraNodeModules` only dedupes when no local copy exists. The SDK then loaded an
  **unpatched** ed25519 instance (missing the Hermes `sha512Async` polyfill), so
  `WalletSigner.fromHex` → `getPublicKeyAsync` threw and `vaultInit` silently returned null
  on restore. Fix: `metro.config` now forces `@noble/*` + `@msgpack/msgpack` to a single
  shared instance via a `resolveRequest` override (no longer dependent on manually deleting
  the SDK's copy), guaranteeing the polyfill applies to the instance the SDK uses. Reinstall
  over the top (same signing key) and the existing wallet loads again — no re-import needed.

## [0.22.3] - 2026-06-15

### Fixed

- **Keyboard overlapped the channel composer.** `ChannelMessagesScreen` used
  `KeyboardAvoidingView behavior="padding"` on Android (broken under edge-to-edge); now
  uses the same `behavior="height"` + offset as the working DM screen, so the input rises
  above the keyboard.
- **Channel/DM delete (and edit/react) failed silently.** These caught the error and only
  logged it, so a node rejection looked like "nothing happened". They now show an alert,
  with a clear message when the node requires a **verified wallet** or is busy with
  **proof-of-work** (`verify_wallet_required` / `pow_busy`), via a shared `chatErrors` mapper.
- **"Too many pending challenges" (503) when sending in a channel.** Root-caused in the SDK
  (bumped to **@ogmara/sdk 0.39.0**): a burst of writes each solved its own PoW challenge on
  slow Hermes. The SDK now dedupes/serializes the solve so a burst collapses to one
  challenge — sends/edits/deletes go through reliably instead of erroring after a long wait.

## [0.22.2] - 2026-06-15

### Fixed

- **Search results were dead — tapping a channel did nothing.** `SearchTab` was registered
  as a bare screen, not a stack, so every `navigate()` from search (channel, post, profile)
  silently failed. Wrapped Search in its own stack navigator (`SearchHome` + `ChannelMessages`
  + `ChannelJoin` + `NewsDetail` + `UserProfile` + `FollowList`).
- **Join from search.** Tapping a channel in search now joins it (adds it to the Chat list
  via `addJoinedChannel`) and opens it.

### Added

- **Channel logos in search results** (`logo_cid` → circular avatar, channel-initial
  fallback instead of `#`), matching the chat list; member count shown in the subtitle.

## [0.22.1] - 2026-06-15

### Added

- **Channel logos in the chat list.** `ChatScreen` now renders the channel's `logo_cid`
  (node-enriched IPFS image) as a circular avatar, falling back to the channel's initial
  instead of a generic `#`. Matches the desktop Modern look.

### Fixed

- **Always connect to the fastest node, not a stale slow one.** After connecting to the
  saved node (fast cold start), `ConnectionContext` now runs a background best-ping pass
  (`maybeOptimizeNode`) and silently switches to a meaningfully-faster reachable node
  (≥120 ms better) — unless the user explicitly pinned one in the picker. Previously a
  slow node persisted across upgrades was kept forever, making the whole app feel slow.
  An explicit pick in the node picker now pins the choice (`connectToNode(url, pin=true)`)
  so the optimizer won't override it.

## [0.22.0] - 2026-06-15

### Changed

- **Decentralized (SC-driven) node discovery — removed the last static seed.** Mobile now
  bootstraps nodes the same way web/desktop do: from the on-chain Klever KApp registry
  (`getActiveNodes`/`getNodeMetadata` via `discoverNodesViaSc`), unioned with peers the
  current node advertises and the user's previously-used nodes — no hardcoded seed.
  - `src/lib/api.ts`: rewrote `getAvailableNodes()` to that 3-source union (staleness-filtered
    to a 7-day anchor window, hostname-deduped, reachable-first); added
    `bootstrapNodeSelection()` (best-ping landing on a fresh install), known-node memory
    (`getKnownNodes`/`recordKnownNode`/`removeKnownNode`, persisted in `ogmara.known_nodes`),
    and `discoveryNetwork()`/`rememberNetwork()` (persists the connected node's
    `/health.network` into `ogmara.klever_network`, default testnet, so the next cold boot
    queries the right registry).
  - `src/context/ConnectionContext.tsx`: boot now runs `bootstrapNodeSelection()` when no node
    is saved, and falls back to SC discovery when a saved node is unreachable; persists the
    network from `/health`. Default node URL is `''` (the dead `node.ogmara.org`/`DEFAULT_NODE_URL`
    seed is gone).
  - `src/components/NodeSelector.tsx`: no longer injects the empty default node; shows the
    SC-discovered list with a "no nodes found" empty state, and **switches the live connection
    via `connectToNode`** (previously the picker only updated a setting, so a node change needed
    an app restart and didn't rebind device keys).

## [0.21.0] - 2026-06-15

### Added

- **End-to-end encryption (E2E P0–P4) — desktop parity, mainnet gate.** Ported the
  full encryption stack to mobile (built-in wallets):
  - **P0 device keys** (`src/lib/deviceEnc.ts`): per-install X25519 enc keypair stored in
    `expo-secure-store` under a separate `ogmara.e2e.*` namespace (the wallet vault's
    `ogmara.vault.*` keys are never touched); wallet-signed binding published + verified
    on every login (idempotent, best-effort), stale-key revoke on rotation.
  - **P1 encrypted DMs** (`src/lib/dmCrypto.ts` + `DmConversationScreen`): per-sender
    `conv_key`s wrapped to every device of both participants; encrypt-on-send,
    decrypt-on-render with "waiting for key" / "can't decrypt" states; encrypted edits;
    late-device cover on incoming DMs; distinct messaging when a recipient hasn't enabled
    encryption.
  - **P2 private + P4 public encrypted channels** (`src/lib/channelCrypto.ts` +
    `ChannelMessagesScreen`): group epoch keys, mod-gated seeding for private / any-member
    seeding for public, auto-join encrypted public channels, key rotation on
    `channel_members_changed` (P2d/P4 floor), 🔒 indicators.
  - **P3 key recovery vault** (`src/lib/keyVault.ts` + Settings → "Encryption & Key
    Backup"): symmetric content keys sealed under a wallet-derived backup key and synced
    to the node; restore-before-backup ordering; auto-restore on decrypt-miss; manual
    back-up / restore / self-check. Wallet private keys are NEVER placed in the vault.
  - New `src/lib/cryptoEnv.ts` exposes the live signer/client to the React-free crypto
    libs; `src/lib/e2eDebug.ts` is an on-device trace recorder.
  - **K5 (external wallet) E2E is intentionally gated off** for now (the delegated device
    key can't sign wallet-bound claims); DMs fall back with a clear message. Fast-follow.
- **Cross-node federation** for private channels: new `ChannelJoinScreen` previews a
  channel from an invite's `?node=` host hint and federates it to the user's home node on
  join (no node switch); `src/lib/share.ts` builds canonical invite links matching
  web/desktop; "Share invite link" action in channel admin; `join/:channelId` deep-link
  route (hash-URL tolerant via `getStateFromPath`).

### Changed

- **Modern design is now the only mobile style.** Color tokens (`src/theme/tokens.ts`)
  switched to the desktop "Modern" Telegram-blue palette (light + dark); message bubbles
  use the Modern tail-corner treatment; splash/adaptive-icon and Android notification
  channel colors realigned. Spacing/typography/radius scales unchanged (project rule).
- Channel deletion now drops the channel from the local joined set and returns to the
  channel list immediately after the gossiped `ChannelDelete` succeeds.

### Security

- New E2E key material lives in an isolated `ogmara.e2e.*` SecureStore/AsyncStorage
  namespace; the tested wallet vault format/keys are untouched (no `VAULT_VERSION` change).
- **Dependency audit:** no new runtime dependencies were added in this release. Ran
  `npm audit fix` (non-breaking, lockfile-only) which cleared the **critical** (`shell-quote`)
  and **high** (`@xmldom/xmldom`) advisories plus 2 moderates (`ws`, `brace-expansion`) —
  16 → 12 advisories, release APK rebuilt + verified afterward. The remaining **12 moderate**
  advisories are all in the **Expo SDK 54 build/dev toolchain** (`@expo/*`, `expo`,
  `expo-asset`/`-constants`/`-notifications`, `postcss`, `uuid`, `xcode`); npm gates every fix
  behind an `expo` 54→56 **major migration** (RN bump + native-module updates + `android/`
  regen) which is out of scope here and can't be done by a blind `--force`. **Deferred** to a
  dedicated Expo-SDK-upgrade pass per the project's "never fix-force blind on an untestable
  mobile toolchain" rule. Real-world severity is low: all are build-time tooling except the
  `uuid` bounds check, whose vulnerable `buf` code path the app never calls.

### Known issues

- Pre-existing TypeScript errors (not introduced here) in `src/lib/settingsSync.ts` (stale
  SDK method names / `getClient()` await) and snake_case-vs-camelCase channel payloads in
  `ChannelAdminScreen`/`CreateChannelScreen` — flagged for a follow-up SDK-alignment pass.

## [0.20.0] - 2026-06-08

### Security

- **Host-bound auth (audit 2026-06-07, fix-plan B1.3/B1.2).** Adopted sdk-js
  ≥0.25.0. Media uploads now obtain auth headers via the new public
  `OgmaraClient.authHeaders()` (host-bound + nonced); `vaultSignRequest` takes a
  `NodeBinding`. Push-gateway registration now signs a `signPushClaim`
  (gateway-host + nonce bound) and the register/unregister helpers take a
  `WalletSigner`. **Requires l2-node ≥0.61.0 and push-gateway ≥0.5.0.**

## [0.19.2] - 2026-04-06

### Fixed
- New users no longer see all public channels — only the default "ogmara"
  channel is shown. Added joined-channel tracking via AsyncStorage so other
  channels appear only after joining via Search.

## [0.19.1] - 2026-04-05

### Fixed
- K5 delegation cache key now uses `signer.deviceAddress` (ogd1...) instead of
  vault address (klv1...), matching the L2 node's device identity format

## [0.19.0] - 2026-04-05

### Added
- **Settings sync** (`settingsSync.ts`) — Cross-device encrypted settings sync
  via L2 node. Uses HKDF-SHA256 + AES-256-GCM from `@noble/hashes` and
  `@noble/ciphers` (Hermes-compatible, no `crypto.subtle` needed). Syncs
  theme, language, notification sound, compact layout, and font size.
  Upload/Download buttons in Settings screen.
- **Enhanced search** — SearchScreen rebuilt with filter tabs (All / Posts /
  Channels). Uses i18n for all strings including placeholder and empty states.
  Tab selection filters results client-side after searching.
- **Media upload in chat** — Attachment button (📎) in channel message input
  bar. Pick images/videos via `expo-image-picker`, upload to IPFS via
  `client.uploadMedia()`, attach CID to outgoing messages. Attachment preview
  chips with remove button above the input bar.

### Changed
- **SettingsScreen** — New "Settings Sync" section with Upload/Download buttons
  (visible when wallet is connected). Downloads refresh local settings state.
- **ChannelMessagesScreen** — Input bar now has 📎 (media) and 😀 (emoji)
  buttons. Attachments passed to `client.sendMessage()` options. Upload
  progress indicated by dimmed attachment button.
- **SearchScreen** — Complete rewrite with filter tab bar, i18n strings,
  cleaner result rendering.

## [0.18.0] - 2026-04-05

### Added
- **Emoji picker** — New EmojiPicker component with 7 categories (Smileys,
  Gestures, Hearts, Objects, Nature, Food, Flags) matching desktop. Slide-up
  modal with category tabs and tap-to-insert. Emoji button added to chat
  input bar in ChannelMessagesScreen.
- **Unread message counts** — ChatScreen now fetches per-channel unread counts
  via `client.getUnreadCounts()` and displays badges (1-99+) on channel rows.
  Refreshes on each channel list load.
- **Appearance settings** — New "Appearance" section in SettingsScreen with:
  - Font size selector (Small / Medium / Large) with visual "A" size indicators
  - Compact layout toggle (ON/OFF)
  - Media auto-load selector (Always / Wi-Fi / Never)
  All settings persisted to AsyncStorage via existing settings keys.

### Changed
- **SettingsScreen** — "Security" and "Preferences" section headers now use
  i18n `t()` calls. New Appearance section between Preferences and Security.
- **ChatScreen** — Channel rows now show unread badge and use i18n for member
  count label.

## [0.17.0] - 2026-04-05

### Added
- **Klever transaction builder** (`kleverTx.ts`) — Full standalone TX building,
  signing, and broadcasting ported from desktop. Supports: build/sign/broadcast
  flow via Klever node API, local nonce tracking to prevent TX collisions,
  2-second rate limiting, smart contract invocation, and user-friendly error
  parsing. All on-chain operations now work directly from the mobile app.
- **On-chain user registration** — WalletScreen now has "Register On-Chain"
  button that calls the Ogmara smart contract's `register` function (~4.4 KLV).
  Shows confirmation dialog with cost, broadcasts TX, and links to Kleverscan.
- **KLV tipping** — New TipDialog component for sending KLV tips to message
  authors. Amount input with validation, optional note, transaction broadcast
  with Kleverscan link. Wired into ChannelMessagesScreen via MessageBubble's
  `onTip` callback.
- **Token transfers** — WalletBalanceScreen now has "Send" buttons on the KLV
  balance card and each token row. Modal dialog for recipient address and amount
  input. Broadcasts transfer TX and links to explorer.
- **Smart contract operations** — All Ogmara SC functions available:
  `registerUser`, `createChannelOnChain`, `getChannelIdFromTx`, `sendTip`,
  `sendTransfer`, `delegateDevice`, `revokeDevice`, `voteOnProposal`,
  `updatePublicKey`. Ready for UI wiring in future phases.
- **Kleverscan integration** — `getExplorerUrl()` and `getExplorerTxUrl()`
  generate correct links for testnet/mainnet. Used in tip confirmations,
  registration success, and transfer receipts.
- **26 new i18n keys** across all 7 languages for tipping, registration,
  and transfer UI (182 translations total).

### Changed
- **WalletScreen** — Added on-chain registration button with ActivityIndicator
  and confirmation flow. "View Balance" button label now uses i18n.
- **WalletBalanceScreen** — Added send functionality with modal dialog for each
  token. Address validation (klv1...) before broadcast.

## [0.16.0] - 2026-04-05

### Added
- **Follow list screen** — New FollowListScreen with Followers/Following tab
  switcher. Shows user avatars, display names, and follow/unfollow toggle
  buttons. Accessible by tapping follower/following counts on any profile.
- **Notifications screen** — In-app notification center showing mentions,
  replies, follows, and DMs. Polls every 30 seconds for new notifications.
  Tapping a notification navigates to the relevant screen. Accessible via
  the quick menu (bell icon).
- **Personal feed toggle** — NewsFeedScreen now shows All/Following toggle
  when wallet is connected. "Following" mode fetches posts only from
  followed users via `client.getFeed()`.
- **Real follower/following counts** — UserProfileScreen now fetches actual
  counts from the API instead of showing hardcoded zeros.
- **Unfollow support** — Follow button on UserProfileScreen now toggles
  between Follow/Unfollow with optimistic count updates.
- **Follow status detection** — UserProfileScreen checks if current user
  is already following the viewed profile and shows correct initial state.

### Changed
- **UserProfileScreen** — Stats row (followers/following) now tappable,
  navigating to FollowListScreen. Follow button supports toggle. Hardcoded
  "Edit Profile" and "No posts yet" strings replaced with i18n `t()` calls.
- **QuickMenu** — Items now use i18n labels. "Followed" entry replaced with
  "Notifications" entry pointing to the new NotificationsScreen.
- **TabNavigator** — FollowListScreen registered in News, Chat, DM, and
  More stacks. NotificationsScreen registered in More stack.

## [0.15.0] - 2026-04-05

### Added
- **News post editing** — ComposePostScreen now accepts edit params via navigation.
  When `editMsgId` is provided, pre-fills title/content/tags and calls
  `client.editNews()` instead of `client.postNews()`. Submit button shows "Save"
  in edit mode. Media attachments disabled during edit (protocol limitation).
- **News post deletion** — NewsDetailScreen shows edit/delete buttons for own posts.
  Edit button visible within 30-minute window, delete always available for author.
  Delete shows confirmation dialog, then calls `client.deleteNews()`.
- **Channel admin screen** — New ChannelAdminScreen with full moderation controls:
  edit channel info (name/description), add/remove moderators, kick/ban members,
  unban users, unpin messages, invite users, and delete channel (owner only).
  Accessible via ⚙ icon in channel message header.
- **Private channel creation** — CreateChannelScreen now supports type 2 (Private)
  channels alongside Public (0) and Read-Public (1). Three-button type selector
  with hint text for private channels explaining invitation-based access.
- **Channel admin navigation** — Settings gear icon in channel header navigates to
  ChannelAdminScreen. Only visible when wallet is connected.

### Changed
- **CreateChannelScreen** refactored from raw envelope building + fetch to using
  `client.createChannel()` SDK method. Cleaner, consistent with other screens.
- **ComposePostScreen** converted from `useNavigation()` to typed screen props
  (`NativeStackScreenProps`) for proper route param typing.
- **All hardcoded UI strings** in ComposePost and CreateChannel replaced with
  i18n `t()` calls. 29 new translation keys added across all 7 languages.

## [0.14.0] - 2026-04-05

### Added
- **Chat message actions** — Edit (30-min window), delete, reply-to with context
  bar, and emoji reactions (👍 👎 ❤️ 🔥 😂) on channel messages. Full long-press
  action sheet with platform-native presentation (ActionSheetIOS / Alert).
- **DM message actions** — Edit, delete, and emoji reactions on direct messages,
  matching channel message functionality.
- **Reaction badges** — Inline reaction count display below messages with tap-to-add
  and "+" button for adding new reactions.
- **Reply context UI** — Tappable reply preview bar above message bubbles showing
  the original author and message preview. Reply composition bar above input with
  dismiss button.
- **Edit mode UI** — Warning-colored context bar above input showing original content
  when editing a message. Send button changes to "Save" label during edit mode.
- **Message date grouping** — Date separator labels (Today / Yesterday / full date)
  inserted between message groups from different days.
- **Author grouping** — Consecutive messages from the same author within a 2-minute
  window are grouped, hiding the duplicate author name for cleaner display.
- **Deleted message state** — Deleted messages render as italicized "[This message
  was deleted]" placeholder instead of being removed from the list.
- **Edited indicator** — Messages that have been edited show "(edited)" label next
  to the timestamp.
- **WebSocket edit/delete handling** — Real-time ChatEdit, ChatDelete,
  DirectMessageEdit, and DirectMessageDelete events update messages in-place.
- **Optimistic updates** — Edit, delete, and react operations update the UI
  instantly before server confirmation.
- **Mark channel/DM read** — Automatic read marking on channel/DM entry and
  on receiving new messages while viewing.

### Changed
- **MessageBubble** rewritten with full action support — now accepts structured
  props for content, author label, reply context, grouping state, and all action
  callbacks. Decoding moved to parent screen for consistency.
- **ChannelMessagesScreen** rebuilt with FlatList section items (date separators +
  message items), proper message deduplication, optimistic message filtering,
  and bounded local message array (200 max).
- **DmConversationScreen** rebuilt with same architecture as ChannelMessagesScreen
  including date grouping, author grouping, and edit/delete/react support.

### Fixed
- **Unbounded message arrays** — Both chat and DM screens now cap local messages
  at 200 entries to prevent memory growth in long sessions.

## [0.13.1] - 2026-04-02

### Fixed
- **Private channels not visible on mobile** — ChatScreen fetched channels
  before the wallet signer was restored, so auth headers were never sent.
  Now depends on `signer` signal to re-fetch after wallet restoration.

## [0.13.0] - 2026-04-01

### Added
- **Device-to-wallet identity mapping** (Phase 7) — ConnectionContext now supports
  external wallet binding via `registerExternalWallet()`. When K5 provides a wallet
  signature over the device claim, the device key is registered on the L2 node.
  Wallet source (`builtin` / `k5-delegation`) and address persisted to AsyncStorage.
  Registration cached to avoid re-submission. `walletAddress` and `walletSource`
  exposed in context for UI consumption.

## [0.12.0] - 2026-03-31

### Added
- **Russian Language** — 7th language (Русский) added to i18n
  - Full translation of all 100+ UI strings
  - Language selector updated with Русский option
  - Auto-detection from OS locale for Russian-speaking users

## [0.11.1] - 2026-03-31

### Fixed
- Bookmarks page shows error details when load fails (was silently empty)
- Back navigation from Bookmarks/Addressbook now shows header with back
  button instead of being trapped in the screen
- All tabs reset to root screen on tap (News→NewsFeed, Chat→ChannelList,
  DMs→DmList, More→Settings) — previously got stuck on sub-screens
- Profile avatar now shows on news feed cards (useUserDisplay loads local
  avatar URI from settings for own posts)
- Channel creation sends envelope via /messages endpoint (node's /channels
  POST returns 405, but process_message handles ChannelCreate)

### Changed
- News card layout: reactions row right-aligned, action buttons (Reply,
  Repost, Bookmark) on separate row below, left-aligned

## [0.11.0] - 2026-03-31

### Added
- **Reply system** — news detail has reply input that sends proper `NewsComment`
  (msg_type 0x23) envelopes with `post_id` reference to parent post. Reply
  button added to news feed cards.
- **User profile improvements** — shows avatar, display name, bio, post count,
  follower/following stats. Lists user's posted news below profile info.
  Own profile loads from local settings; edit button navigates to Settings.
- **Profile picture** — tap avatar in Settings (edit mode) to pick image from
  gallery. Stored locally as URI (IPFS upload when node supports it).
- **Channel creation** — FAB on Chat tab opens create channel screen with slug,
  display name, description, type (public/read-only). Sends ChannelCreate
  envelope to L2 node. TODO: integrate SC call for on-chain channel_id.
- **User cache** — local address-to-profile mapping in AsyncStorage. Resolves
  own display name on news posts. Foundation for showing other users' names
  when /users/:address endpoint is deployed.
- **Username on news posts** — own posts show display name with mini avatar
  instead of truncated wallet address.

### Fixed
- Keyboard overlapping input in channel messages — changed to `behavior="padding"`
  with increased offset
- Channel list shows "0 members" label instead of bare "0"

## [0.10.2] - 2026-03-31

### Added
- **Reply input** on news detail screen — text input with "Send Reply" button
- Repost/bookmark now show success/failure alert feedback
- Channel header shows #channelName at top of message view
- Chat messages display as bubbles (own = right/purple, peer = left/grey)

### Fixed
- "More" tab landing on Bookmarks instead of Settings — added tab press
  listener to reset MoreStack to Settings when tab is tapped
- **Channel messages showing raw bytes** — same payload decoding issue as
  news feed. Messages now properly decoded from MessagePack.
- **DM messages showing raw bytes** — same fix applied to DmConversation
- **Keyboard overlapping input** on Android — both channel and DM screens
  now use `behavior="height"` with proper offset on Android
- Channel list now shows "0 members" label instead of just "0"
- WebSocket message handler now decodes msgpack payloads (was trying
  JSON.parse on binary data)
- Bookmark/repost errors shown to user instead of failing silently

## [0.10.1] - 2026-03-31

### Fixed
- App crash on startup — `getSetting('displayName')` used a key not in
  the KEYS map, causing `AsyncStorage.getItem(undefined)` which crashes
  with "bind value at index 1 is null". Added `displayName` to settings
  KEYS map.

## [0.10.0] - 2026-03-31

### Added
- **Addressbook** — local contact list (AsyncStorage). Add contacts with
  klv1 address + display name, tap to open DM, long-press to remove.
  Accessible from quick menu.
- **Username in header** — display name shown next to burger menu icon
  when the user has set one in Settings profile
- **User profile page** — shows avatar, address (tap to copy), bio,
  follower/following/post counts (when API available), Follow + DM buttons.
  Gracefully handles missing /users/:address endpoint (no crash).

### Fixed
- **Bookmarks not loading** — missing `signer` dependency in useApi hook.
  Added signer, useFocusEffect refresh, payload decoding, envelope
  normalization. Bookmarks now properly sync with the node.
- **Tapping author address crashed** — UserProfile tried API fetch that
  returned 404. Now catches and shows address-only fallback view.
- **Repost/react/bookmark error handling** — errors logged to debug
  console instead of crashing with hex validation error.
- Profile save now persists display name to local settings for header

## [0.9.0] - 2026-03-31

### Added
- **Quick menu** (burger icon, top-right) — fast access to Followed (feed),
  Bookmarks, Addressbook (DMs), and Wallet balance from any tab
- **Search functionality** — search news by tag, channels by name/slug,
  or enter a klv1 address to navigate directly to user profile
- **New DM flow** — FAB on Messages tab opens address input modal to
  start a conversation with any klv1 address
- Conversations in DM list now tappable (navigate to DmConversation)

### Fixed
- News detail 404 — post data now passed from feed (avoids single-post
  endpoint which is not deployed). Shows title, content, tags, reactions.
- Chat channels not loading on first visit — added `useFocusEffect` to
  refresh when tab gains focus (fixes timing issue with async connection)
- News detail now decodes MessagePack payload and shows proper title,
  content, tags, author, and date instead of raw bytes

## [0.8.3] - 2026-03-31

### Fixed
- "Invalid hex string" error on reactions/bookmarks/reposts — L2 node API
  returns `msg_id` as a JSON number array `[74,2,122,...]` (serialized
  `[u8; 32]`), not a hex string. Added `envelopeNormalizer.ts` to convert
  byte arrays to hex strings when loading envelopes from the API.
- Media upload now catches "Network request failed" in addition to 404
  (the endpoint doesn't exist yet, so fetch fails at network level)
- Reactions, bookmarks, reposts now log errors to debug console instead
  of silently swallowing them — debug logs screen will show failures

## [0.8.2] - 2026-03-31

### Added
- Payload decoder (`payloadDecoder.ts`) — decodes MessagePack bytes from
  API envelope responses into human-readable title/content/tags
- News feed auto-refresh on screen focus (loads new posts after composing)

### Fixed
- News posts showed raw payload bytes as decimal numbers instead of the
  actual title and content text. Now properly decodes MessagePack payload.
- News card now displays title (bold, large) separately from body text
- Media upload gracefully handles 404 (node endpoint not deployed yet) —
  shows "Media upload unavailable" and submits post without attachments
- Reaction errors silently swallowed for 404 (endpoint not deployed yet)

## [0.8.1] - 2026-03-31

### Fixed
- "crypto.subtle must be defined" on wallet import/create — adding
  @msgpack/msgpack to SDK caused npm to reinstall @noble/ed25519 in
  sdk-js/node_modules, creating a duplicate unpatched instance. Removed
  SDK's @noble copies and added @msgpack/msgpack to Metro extraNodeModules.
- "signature verification failed for both formats" on post/message send —
  SDK v0.6.1 fix: msg_type sent as variant name string ("NewsPost") instead
  of numeric discriminant (0x20) to match rmp-serde enum deserialization.

## [0.8.0] - 2026-03-31

### Added
- **Media attachments in Compose Post** — pick images/videos from gallery
  (expo-image-picker), preview thumbnails, upload via SDK, attach to post
  - Multi-select up to 10 files, remove individual attachments
  - Automatic upload before post submission
  - Image thumbnails and video icon previews

### Changed
- Updated to SDK v0.6.0 — all write endpoints now send proper MessagePack
  Envelope bytes instead of JSON (fixes "expected struct Envelope" error)
- `postNews` call updated for new SDK signature (no channelId parameter)

## [0.7.8] - 2026-03-31

### Fixed
- Default node was hardcoded to `localhost:41721` in ConnectionContext
  instead of using SDK's `DEFAULT_NODE_URL` (`node.ogmara.org`). This
  caused permanent "Reconnecting..." status on fresh installs.
- WebSocket disconnect no longer overrides "connected" status when the
  health check already confirmed the node is reachable. WS is for
  real-time events, not the connection status authority.

### Changed
- Node URL section in Settings now shows "Connected to node.ogmara.org"
  (with actual URL) instead of generic "Connected" text.
- Connection context exposes `nodeUrl` for display purposes.

## [0.7.7] - 2026-03-31

### Fixed
- Node ping false positives — `pingNode` now validates the health response
  body (must contain `version` field), not just HTTP 200. Prevents any
  random web server from appearing as a valid node.
- Default node (`node.ogmara.org`) always shown in NodeSelector even when
  node discovery fails or returns no results.
- Manual URL input auto-strips trailing `/api` suffix (SDK appends
  `/api/v1/...` automatically, so double-path was breaking connections).
- Unreachable nodes now shown in list (greyed out, sorted to bottom)
  instead of being silently filtered out.

### Changed
- Error message for invalid nodes: "Not an Ogmara node (no valid
  /api/v1/health response)" instead of generic "Node unreachable".

## [0.7.6] - 2026-03-31

### Changed
- Node selector repositioned from bottom sheet to centered modal —
  keyboard no longer overlaps the URL input field
- KeyboardAvoidingView wraps the modal for proper input visibility
- "Node unreachable" error shown when entering a dead/invalid URL

### Added
- Delete node: tap ✕ button or long-press any non-active node to remove it
  (confirmation dialog). Active node cannot be deleted (switch first).
- Hint text at bottom of node list ("Long-press or tap ✕ to remove")

## [0.7.5] - 2026-03-30

### Fixed
- Balance screen crash — React hooks violation: `useState` was called after
  conditional early returns, causing "Rendered more hooks" error. Moved all
  hooks before conditional returns.
- PIN verification took ~83 seconds — PBKDF2 600k iterations in pure-JS
  Hermes is far too slow for mobile. Reduced to 10,000 iterations (~1.4s).
  Security maintained by SecureStore hardware backing + escalating cooldowns.
- PIN verification on lock screen appeared frozen — added "Verifying PIN..."
  loading screen during key derivation.

### Security
- Vault format v2: PBKDF2 iterations 600k → 10k (mobile-appropriate).
  Auto-migration on first successful PIN unlock after update — re-derives
  key with new count, re-encrypts verify token and vault key. One-time
  slow unlock (~83s) with "Upgrading security..." message, then fast forever.
- Iteration count now stored in SecureStore (`ogmara.app_lock.kdf_iterations`)
  for forward-compatible migration.

## [0.7.4] - 2026-03-30

### Added
- "Balance" link in Settings profile card (next to Edit) for quick access
- Tap-to-copy wallet address on Balance screen ("Copied!" feedback)

## [0.7.3] - 2026-03-30

### Fixed
- PIN setup froze the app — PBKDF2 600k iterations ran synchronously on
  the JS thread. Now wrapped in setTimeout to yield to UI first, with
  a "Securing your PIN..." loading screen during key derivation.
- Settings PIN status not updating after setup — used `useFocusEffect`
  to refresh security state when returning from PinSetup screen.

## [0.7.2] - 2026-03-30

### Security
- Private key clipboard wiped on "Hide Key" and after 60s auto-hide (W1)
- Revealed key state + timer cleared on component unmount (W2)
- Mainnet switch requires confirmation dialog (W6)

### Fixed
- Klever API fetch now has 10s timeout (W4, prevents infinite spinner)
- Token balance formatting uses string-based decimal shift instead of
  floating-point division (W5, correct for large balances)

## [0.7.1] - 2026-03-30

### Added
- Wallet Balance screen — displays KLV balance, frozen balance, and all
  token holdings from the Klever blockchain API
  - Purple balance card with KLV amount and address
  - Token list with asset names, IDs, and formatted amounts
  - Pull-to-refresh, loading indicator, network error banner
- Klever API client (`klever.ts`) — fetches account data from Klever API
  - Supports testnet and mainnet endpoints
  - `fetchAccountData()`, `formatTokenAmount()`
  - Network preference persisted in AsyncStorage
- Testnet/Mainnet switcher in Debug screen
  - Toggle buttons: yellow (Testnet) / green (Mainnet)
  - Persists selection, affects wallet balance queries
  - Default: Testnet (per testnet-first development rule)
- "View Balance" button on Wallet screen navigates to WalletBalance

## [0.7.0] - 2026-03-30

### Added

- **Node Anchor Verification Badges** — Ionicons checkmark-circle badge for
  nodes that anchor L2 state on-chain
- `AnchorBadge` component — renders green checkmark for verified/active nodes
- Anchor badge shown in NodeSelector modal next to each node URL
- Anchor badge shown in Settings connection row when connected
- 2 new i18n keys across all 6 languages (`anchor_verified`, `anchor_active`)

## [0.6.1] - 2026-03-30

### Fixed
- Connection row in Settings was not tappable (used View instead of
  TouchableOpacity) — now opens NodeSelector modal on tap
- Section label changed from "Connected" to "Node URL" for clarity

## [0.6.0] - 2026-03-30

### Added
- **Message Rendering**
  - FormattedText component — renders bold, italic, underline, code, strikethrough
  - Auto-detected URLs open in system browser via Linking
  - Inline image display for IPFS attachments
  - Non-image attachments as tappable file links
- **Formatting Toolbar**
  - FormatToolbar component — floating bar for B/I/U/Code/Strikethrough
  - Applies Markdown markers around selected text
- **Node Selector**
  - NodeSelector modal (bottom sheet) with discovered nodes and ping latency
  - Manual "Add custom node" input field
  - Auto-sorts by latency, persists user selection
- **Default Node**
  - Changed from localhost:41721 to node.ogmara.org

## [0.5.0] - 2026-03-30

### Added
- **News Engagement**
  - Reaction buttons on news feed cards (👍 👎 ❤️ 🔥 😂) with live counts
  - Repost button with visual feedback on news feed and detail screens
  - Bookmark/save button with toggle state on both screens
  - NewsCard component with full engagement action bar
- **News Detail**
  - Large reaction buttons with counts
  - Repost and bookmark actions below post content
- **Bookmarks Screen**
  - New BookmarksScreen accessible from More tab
  - Pull-to-refresh, tap-to-navigate to detail
- **Chat Enhancements**
  - Reply-to indicator bar above input with cancel button
  - Reply state management in ChannelMessagesScreen
- **i18n**
  - 15+ new translation keys for engagement and channel admin features (en locale)
- **Navigation**
  - Bookmarks route added to MoreStack
  - ChannelAdminParamList type for future channel admin screen

## [0.4.9] - 2026-03-29

### Changed
- Settings: Start Screen, Theme, and Language all use compact dropdown
  modals (one row each with current value + arrow, tap opens picker)
- Settings: grouped Start Screen, Theme, Language under "Preferences" card
- Profile edit placeholder changed from "Address" to "Username"

## [0.4.8] - 2026-03-29

### Added
- User profile section in Settings (visible when wallet connected)
  - Avatar with initial letter, display name, address
  - Edit mode: name + bio text inputs, save to L2 node via SDK
- Language picker as modal dropdown (clean single-row selector)
  - Shows current language name (e.g., "Deutsch" not "DE")
  - Tap opens modal with all 6 languages

### Changed
- Language selection replaced from full list to compact dropdown
- Settings sections reordered: Profile → Start Screen → Theme →
  Language → Security → Wallet → Connection → About

## [0.4.7] - 2026-03-29

### Added
- Private key backup: "Reveal Private Key" button on wallet screen
  - Warning dialog before reveal (never share, never enter on websites)
  - Key displayed in monospace with selectable text
  - Copy to clipboard button with "Copied!" feedback
  - "Hide Key" button to dismiss
  - Auto-hides after 60 seconds for safety
- `vaultExportKey()` — controlled export function in the vault module

## [0.4.6] - 2026-03-29

### Fixed
- Wallet creation STILL failing with crypto.subtle — root cause was Metro
  bundling two separate copies of @noble/ed25519 (mobile's + SDK's).
  Our sha512 patch only applied to one copy. Fix:
  1. Removed SDK's node_modules/@noble copies (Metro resolves from mobile's)
  2. Moved ed25519 config from import-time to runtime (`patchEd25519()`)
     called in init(), after all modules are loaded
  3. Downgraded @noble/hashes to v1.8.0 (v2 uses package exports that
     Metro can't resolve via file-based fallback)

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
