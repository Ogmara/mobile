# Changelog

All notable changes to the Ogmara Mobile App will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
