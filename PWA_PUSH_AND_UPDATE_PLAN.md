# PaddleUp PWA Push Notifications and Update Strategy

Last updated: June 1, 2026

## Purpose

This document defines the next PWA infrastructure direction for PaddleUp Matchmaking.

The MVP is now live enough that the biggest PWA limitation is no longer the UI. The major limitation is attention:

- A player should not need to keep opening PaddleUp all day to discover that a match is forming.
- A player should be alerted when something needs action.
- A player should stay on the newest app build even when PaddleUp is installed to the iPhone Home Screen.

This document is written for Cursor/development agents taking over the next implementation pass.

## Product Goal

PaddleUp should feel closer to a lightweight iPhone app:

- Installable to the Home Screen.
- Able to send match alerts.
- Able to update itself when David ships rapid improvements.
- Able to recover gracefully if a user is stale, offline, or not installed.

The short-term target is not a native iOS app. The short-term target is a stronger PWA.

## Current Recommendation

Prioritize iPhone Safari PWA support first.

Why:

- The initial users are mostly iPhone users.
- iOS supports Web Push for Home Screen web apps on iOS/iPadOS 16.4+.
- Push notifications solve the biggest MVP problem: users should not need to check the app manually.
- This gives us a real test before deciding whether native iOS is worth the cost.

Still design the system so Android Chrome and desktop Chrome/Safari can be supported later without rewriting the model.

## Current Implementation Status

As of June 1, 2026:

- PaddleUp uses standard Web Push, not Firebase Cloud Messaging web push.
- The service worker handles raw `push` events and displays notifications from payload data.
- Cloud Functions use the `web-push` package and the `WEB_PUSH_VAPID_PRIVATE_KEY` secret.
- The frontend stores subscriptions in `pushSubscriptions`, scoped by `userId` and `locationId`.
- Users enable alerts explicitly from Profile. Passive actions must not request notification permission.
- Location switching refreshes push subscription metadata only when `Notification.permission === "granted"`.
- FCM web push was removed because iOS Safari/Home Screen behavior was not reliable for the MVP path.

## Platform Reality

### iPhone Safari

This is the primary MVP path.

For push notifications on iPhone:

1. User must open PaddleUp in Safari.
2. User must add PaddleUp to the Home Screen.
3. User must launch PaddleUp from the Home Screen icon.
4. App can request notification permission from that installed context.
5. If allowed, the app stores a push token/subscription for that user/device.
6. Cloud Functions can send push notifications for match events.

Important: the app cannot install itself on iPhone. Apple requires the user to manually use Share -> Add to Home Screen.

What the app can do:

- Detect that the user is on iPhone Safari and not installed.
- Explain why installation matters.
- Show step-by-step instructions.
- Delay notification permission requests until the installed PWA context.

What the app cannot do:

- Programmatically add itself to the Home Screen on iPhone.
- Force notification permissions.
- Reliably show a native install prompt on iPhone like Android Chrome can.

### iPhone Chrome

Treat iPhone Chrome as secondary for now.

Current product guidance:

- If user is on iPhone Chrome and wants match alerts, instruct them to open PaddleUp in Safari and add it to the Home Screen.
- Do not make Chrome on iPhone the primary tested path for push.
- Do not block normal app usage in Chrome, but be explicit that alerts require the Safari/Home Screen path for the MVP.

Suggested message:

```text
For match alerts on iPhone, open PaddleUp in Safari and add it to your Home Screen.
```

Reasoning:

- iOS browser behavior can vary.
- Safari/Home Screen is the most predictable path for iPhone PWA push.
- The MVP should minimize support complexity.

### Android Chrome

Support later, but design for it now.

Android Chrome generally has a smoother PWA install path:

- Browser can fire `beforeinstallprompt`.
- App can show an install button.
- User can accept a native install prompt.
- Push notification support is mature.

The implementation should keep platform detection abstract enough that Android support can be added by reusing the same install/push state model.

### Desktop

Desktop browser push is not the MVP priority.

Desktop can still be useful for:

- David/admin testing.
- Development QA.
- Debugging service worker state.

Do not optimize the product UX around desktop notifications yet.

## Desired User Experience

### First Signed-In Session

After sign-in, if the user is on iPhone Safari and not installed:

Show a calm onboarding card or modal:

```text
Get match alerts

Add PaddleUp to your iPhone Home Screen so we can notify you when a match is forming or confirmed.

1. Tap Share
2. Tap Add to Home Screen
3. Open PaddleUp from the new icon
```

Actions:

- `Show Me How`
- `Not Now`

Do not request notification permission yet if the app is not installed.

### Installed Home Screen Session

When the app detects it is running standalone:

Show a notification permission prompt at a meaningful moment.

Good timing:

- After the user creates availability.
- After the user joins a match.
- From a profile/settings row labeled `Match Alerts`.

Avoid:

- Asking immediately on first app load.
- Asking before the user understands why notifications matter.

Suggested copy:

```text
Turn on match alerts?

PaddleUp can notify you when a match is forming, confirmed, or a court is assigned.
```

Actions:

- `Allow Alerts`
- `Not Now`

### Profile / Me Page

Add a persistent status area later:

- Install status:
  - `Installed`
  - `Open in Safari to install`
  - `Add to Home Screen for alerts`
- Notification status:
  - `Alerts on`
  - `Alerts off`
  - `Permission blocked`
- App version:
  - `Up to date`
  - `Update available`

This gives users and David a visible place to debug issues during MVP.

## Notification Events

Start with high-value events only.

### Send Push

Send push for:

- Match confirmed.
- Need 1 more for a match the user is relevant to.
- Court assigned.
- Player left a confirmed match.
- Replacement needed.

### Be Careful With Push

Do not spam users for every backend recalculation.

Avoid push for:

- Every forming-game write.
- Every availability write.
- Every user presence update.
- Every match card reorder.

### Suggested Notification Copy

Match forming:

```text
Doubles needs 1 more
Tomorrow 11:00 AM-12:00 PM at Blackhawk.
```

Match confirmed:

```text
Your doubles match is confirmed
Meet at 11:30 AM. Court TBD.
```

Court assigned:

```text
Court assigned
Your match is on Court 4.
```

Player left:

```text
Player left your match
PaddleUp is looking for a replacement.
```

## Push Data Model

Add a dedicated collection rather than overloading `users/{uid}`.

Recommended collection:

```text
pushSubscriptions/{subscriptionId}
```

Suggested shape:

```json
{
  "id": "",
  "userId": "",
  "locationId": "blackhawk",
  "endpoint": "",
  "keys": {
    "p256dh": "",
    "auth": ""
  },
  "platform": "ios",
  "browser": "safari",
  "standalone": true,
  "enabled": true,
  "lastSeenAt": "serverTimestamp",
  "createdAt": "serverTimestamp",
  "updatedAt": "serverTimestamp"
}
```

Why separate collection:

- One user can have multiple devices.
- Subscriptions expire, are revoked, or become invalid.
- Easier to disable/delete one broken subscription without changing the user's profile.
- Easier for Cloud Functions to query all subscriptions for a player.

Security:

- Users can create/update/delete only their own subscription docs.
- Clients should not be able to write arbitrary users' subscriptions.
- Cloud Functions use Admin SDK for sending.

## Backend Push Flow

Cloud Functions should send push after the same events that create Firestore notifications.

Current app already has in-app notifications. Push should be layered on top:

1. Backend creates `notifications/{id}`.
2. Backend loads enabled Web Push subscriptions for `userId`.
3. Backend sends Web Push to each subscription.
4. If Web Push reports an expired/invalid subscription, backend deletes it.

Do not make push the source of truth. Firestore notifications remain the durable in-app record.

## PWA Install Detection

Build a small utility module rather than scattering user-agent checks through React components.

Suggested file:

```text
src/pwa.ts
```

Suggested API:

```ts
type PwaPlatform = "ios" | "android" | "desktop" | "unknown";
type PwaBrowser = "safari" | "chrome" | "firefox" | "edge" | "unknown";

type PwaInstallState = {
  platform: PwaPlatform;
  browser: PwaBrowser;
  isStandalone: boolean;
  canUseBeforeInstallPrompt: boolean;
  canRequestNotifications: boolean;
  shouldShowIosSafariInstallGuide: boolean;
  shouldSuggestOpenInSafari: boolean;
};
```

Detection hints:

- `window.matchMedia("(display-mode: standalone)").matches`
- `navigator.standalone` for older iOS Safari behavior
- `Notification` API availability
- service worker support
- PushManager support
- user agent only where necessary

Keep this isolated so platform quirks do not leak through the app.

## App Update Problem

Because David is iterating quickly, stale installed PWAs are a real MVP risk.

The app needs an intentional update strategy:

- Detect when a new build is available.
- Prefer a smooth automatic update when safe.
- Show a visible `Update available` fallback if automatic refresh is not possible.
- Provide a manual update action on the Me/Profile page.

Important service worker reality:

- A service worker update is detected when the service worker file changes.
- A new worker may install but wait until the old worker no longer controls open clients.
- A refresh does not always mean the latest worker controls the page immediately.
- `skipWaiting()` and `clients.claim()` can make updates more immediate, but should be used deliberately.

## Recommended Update Architecture

### 1. Generate a Build Version

Add a small generated build metadata file at build time.

Suggested public file:

```text
public/version.json
```

Example:

```json
{
  "version": "2026-06-01T21:35:00Z",
  "commit": "abc1234"
}
```

This can be generated before build using a script.

The app should display the current version somewhere small on the Me/Admin page during MVP.

### 2. Poll for New Version

Frontend should periodically fetch:

```text
/version.json?ts={Date.now()}
```

Use `cache: "no-store"`.

Suggested timing:

- On app start.
- When app returns to foreground.
- Every 5-10 minutes while active.
- After a user manually pulls to refresh or taps an update button.

If remote version differs from loaded version:

- Set `updateAvailable = true`.
- Trigger service worker update.
- If safe, reload after the new worker activates.
- If not safe, show an update pill/button.

### 3. Service Worker Update Messages

Enhance `public/sw.js` to support messages:

- `SKIP_WAITING`
- `GET_VERSION`
- possibly `CLEAR_RUNTIME_CACHE`

The app can call:

```ts
registration.update()
```

Then if a waiting worker exists:

```ts
registration.waiting.postMessage({ type: "SKIP_WAITING" });
```

The service worker should call:

```js
self.skipWaiting();
self.clients.claim();
```

Use care: if the app is mid-critical action, show `Update available` instead of reloading immediately.

### 4. UI Update Fallback

Add a visible fallback on Me/Profile:

```text
App update available
Tap to refresh PaddleUp.
```

Button:

```text
Update Now
```

Behavior:

1. Call `registration.update()`.
2. Tell waiting worker to skip waiting if present.
3. Clear old app caches if needed.
4. Reload the page.

### 5. Passive Auto Update

For this MVP, a reasonable policy:

- If the app is on Home or Me and no modal/form is open, auto-refresh after new worker activates.
- If user is in the middle of creating availability, joining, assigning court, or editing a game, show an update banner instead.

Banner copy:

```text
New PaddleUp version available
Update now
```

### 6. Cache Policy

Current Firebase config already sets no-cache headers for:

- `/index.html`
- `/sw.js`

Keep that.

Also consider no-cache for:

- `/manifest.webmanifest`
- `/version.json`

Hashed Vite assets can remain long-cacheable because their filenames change when content changes.

### 7. Existing Service Worker Caution

Current `public/sw.js` precaches a small asset list and runtime-caches GET responses.

Before adding push/update logic, audit this carefully:

- Do not cache Firestore/Auth API responses accidentally.
- Do not serve stale `index.html`.
- Do not let stale runtime cache override newly deployed app shells.

Recommended direction:

- Keep `index.html`, `sw.js`, `manifest.webmanifest`, and `version.json` network-first/no-store.
- Let Vite hashed JS/CSS be cached normally.
- Consider removing broad runtime cache for all GET requests unless there is a specific offline goal.

PaddleUp is currently a real-time matchmaking app, so stale data is more dangerous than lack of offline support.

## Implementation Phases

### Phase 1: Install and Update UX

Build this before push.

Deliverables:

- PWA platform detection utility.
- iPhone Safari install guide.
- iPhone Chrome "open in Safari" guidance.
- Me/Profile app status area.
- Build version generation.
- Version polling.
- Update available banner/button.
- Service worker update flow.

Success criteria:

- Installed iPhone PWA can detect an available update.
- User can tap `Update Now` and get the latest build.
- App can auto-refresh when safe.
- Me/Profile shows enough state for David to debug.

### Phase 2: Notification Permission and Token Storage

Deliverables:

- Notification permission UI only after install/standalone.
- Standard Web Push setup.
- Push subscription registration.
- `pushSubscriptions` collection and rules.
- Subscription refresh/update handling.
- Me/Profile alert status.

Success criteria:

- Installed iPhone PWA can request notification permission.
- Token is written to Firestore.
- Token can be disabled/replaced.

### Phase 3: Backend Push

Deliverables:

- Functions send push after durable Firestore notifications.
- Invalid token cleanup.
- Push copy for match confirmed, need 1 more, court assigned, player left.

Success criteria:

- David can trigger a match event and receive an iPhone notification from the installed PWA.
- If push fails, in-app notification still exists.

### Phase 4: Android Chrome

Deliverables:

- `beforeinstallprompt` support.
- Android install button.
- Android push-token QA.
- Platform-specific copy.

Success criteria:

- Android Chrome user can install through native prompt.
- Android push works through the same token/backend path.

## QA Matrix

Minimum devices/contexts:

- iPhone Safari, not installed.
- iPhone Home Screen PWA, installed.
- iPhone Chrome, normal browser tab.
- Android Chrome, normal browser tab.
- Android installed PWA.
- Desktop Chrome.
- Desktop Safari if convenient.

For each:

- App loads.
- App detects install/standalone state correctly.
- App gives correct install guidance.
- App does not request notification permission too early.
- App detects version updates.
- App can refresh to latest build.

## Suggested Cursor Starting Prompt

```text
Read PWA_PUSH_AND_UPDATE_PLAN.md, CURSOR_HANDOFF.md, public/sw.js, firebase.json, src/main.tsx, src/pwa.ts, src/pushNotifications.ts, src/firebase.ts, src/firebaseDb.ts, and functions/src/index.ts. The app already has PWA install guidance, update detection, standard Web Push, and backend push sends. Do not reintroduce Firebase Messaging web push without retesting iOS Safari/Home Screen behavior. Continue QA on real iPhone Safari/Home Screen installs, keep notification permission explicit from Profile, and ensure passive actions such as sign-in, first-run location selection, and location switching never trigger the browser permission prompt.
```

## Reference Links

- Apple web push notifications for web apps and browsers: https://developer.apple.com/documentation/UserNotifications/sending-web-push-notifications-in-web-apps-and-browsers
- MDN install prompt guidance: https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Trigger_install_prompt
- web.dev service worker lifecycle: https://web.dev/articles/service-worker-lifecycle
- MDN `skipWaiting()`: https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerGlobalScope/skipWaiting
- web.dev PWA update guidance: https://web.dev/learn/pwa/update
