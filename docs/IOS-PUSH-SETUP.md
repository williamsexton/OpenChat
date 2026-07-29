# iOS push notifications — setup and the open decision

Written 2026-07-28, the day the Apple Developer account was purchased. Android
push works and was verified on a physical Pixel; this describes what iOS needs
and, more importantly, the one question that is not yet settled.

## The unresolved question: which token type

This is the part to decide before writing more code, because the two answers
lead to different work.

`expo-notifications`' `getDevicePushTokenAsync()` returns an **APNs** token on
iOS. Our server sends through **FCM HTTP v1**, which expects **FCM registration
tokens**. Post an APNs token to `/api/devices` and it registers happily, then
never receives anything — a silent failure of exactly the kind that already cost
this project a completed-but-inert notification system.

### Option A — Firebase iOS SDK (recommended)

Add the Firebase iOS SDK so the client obtains an **FCM** token on both
platforms. FCM then relays to APNs on Apple's side.

- Server needs **no change**: `FcmPushTransport` already declares and forwards an
  `apns` block, which is precisely FCM's mechanism for iOS delivery.
- Requires `GoogleService-Info.plist` and Firebase pods (Podfile currently has
  zero Firebase pods).
- One token type, one transport, one code path. Given the upload divergence this
  project already suffered — two implementations against one endpoint — a single
  path is worth preferring on principle.

### Option B — direct APNs transport server-side

Keep the native APNs token and add an `ApnsPushTransport` alongside
`FcmPushTransport`, signing JWTs with the `.p8` key.

- No Firebase iOS SDK, no plist.
- But: a second transport to maintain, a second set of failure modes, and the
  server would need to route by `DeviceToken.platform`.

**Recommendation: A.** The server was built for it.

## What is already in place

| | |
|---|---|
| `DeviceToken.platform` column | ✅ exists, populated at registration |
| Server `apns` block in FCM message | ✅ declared and forwarded |
| `aps-environment` entitlement | ✅ emitted by prebuild (`development`) |
| `app.json` → `ios.googleServicesFile` | ✅ wired to `./GoogleService-Info.plist` |
| `UIBackgroundModes: remote-notification` | ✅ declared |
| iOS gate in `push.ts` | being removed — was `Android only … iOS is a no-op` |
| Firebase iOS pods | ❌ absent (0 in Podfile.lock) |
| `GoogleService-Info.plist` | ❌ absent — owner action |

## Owner steps (Apple + Firebase)

1. **Apple Developer portal** — register App ID `com.openchat.mobile`, enable the
   **Push Notifications** capability.
2. **Generate an APNs Auth Key (`.p8`)**. Note the Key ID and your Team ID. The
   `.p8` downloads exactly once — keep it somewhere durable.
3. **Firebase console**, project `openchat-app-f9272` (the same project Android
   uses — it must be the same, tokens are project-scoped): add an **iOS app**
   with bundle id `com.openchat.mobile`.
4. **Upload the `.p8`** to that iOS app's Cloud Messaging settings, with Key ID
   and Team ID.
5. **Download `GoogleService-Info.plist`** to `apps/mobile/GoogleService-Info.plist`.

The plist is gitignored, like `google-services.json`. It is not secret — it ships
inside the app — but it identifies one specific Firebase project, and this repo
goes upstream. Each deployer supplies their own.

The `.p8` **is** secret. It belongs in the Firebase console and nowhere else —
not in the repo, not in a chat message.

## After that

`aps-environment` is currently `development`, which is correct for a debug build
installed directly from Xcode. A distribution-signed TestFlight or App Store
build needs `production`. Verify delivery on a physical device with the
development entitlement first, then change it and verify the exact archived
build before distributing it.

## What cannot be tested without hardware

Push cannot be verified on the iOS Simulator in the way that matters. The
simulator accepts `xcrun simctl push` with a payload file, which exercises the
app's *handling* of a notification but not APNs delivery, token acquisition, or
the server round trip. Treat simulator push as a UI check only, and require a
physical iPhone before claiming FR-NOTIF is satisfied on iOS.

That is the same standard applied to voice, and for the same reason: the
simulator cannot produce the evidence the requirement asks for.
