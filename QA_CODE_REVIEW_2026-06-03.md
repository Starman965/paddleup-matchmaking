# PaddleUp QA Code Review - June 3, 2026

Reviewer: Codex acting as QA/code-review engineer

Scope:

- Review only.
- No application code changes were made during this pass.
- This document summarizes the latest QA findings for Cursor to verify and address.
- Primary focus: PWA reliability, Google auth persistence/redirect behavior, push notification readiness, stale-build handling, and matchmaking product risks.

## Current Product Context

PaddleUp is a mobile-first React/TypeScript/Firebase PWA for real-time pickleball matchmaking.

The MVP goal is simple:

> Reduce the time from "I want to play" to "I have a game."

The product should continue to treat all match requests as one core concept:

- `Ready Now`
- `Later Today`
- `Tomorrow`

All of these are actively matchmaking once submitted. The difference is the intended play window, not whether matchmaking is happening.

Current architecture principles:

- Keep `locationId` central to users, games, availability, subscriptions, and backend logic.
- MVP is doubles-first.
- Do not hard-code Blackhawk into product logic.
- PWA is the current delivery path, with future iOS/native app optional if install or notification friction becomes too high.

## Verification Performed

Commands run:

```bash
npx tsc --noEmit
npm --prefix functions run build
```

Results:

- Frontend TypeScript check passed.
- Functions TypeScript build passed.
- No source files were changed.
- `npm run build` was intentionally not run because the current `prebuild` script mutates tracked version/build metadata.

## Key Positive Updates Observed

### Firebase auth domain appears corrected

Evidence:

- [src/firebase.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/firebase.ts:10) now uses:

```ts
authDomain: "paddleup-match-maker.web.app"
```

Why this matters:

- This is the correct direction for avoiding Firebase Auth redirect/session-storage issues caused by splitting the app URL and auth helper URL across `web.app` and `firebaseapp.com`.
- It directly addresses the field QA issue where users could get stranded on `/__/auth/handler` with a missing initial state error.

Cursor should still verify:

- Firebase Auth authorized domains include `paddleup-match-maker.web.app`.
- Google OAuth authorized redirect URI includes:

```text
https://paddleup-match-maker.web.app/__/auth/handler
```

- iPhone Safari QR flow works from a clean browser state.
- iPhone Home Screen PWA login works after install.
- Reopening the PWA does not strand the user on the auth handler URL.

### iOS redirect sign-in appears implemented

Evidence:

- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1975) uses redirect sign-in for iOS.
- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:981) handles `getRedirectResult(auth)`.

Why this matters:

- Redirect sign-in is usually more reliable than popup sign-in on iPhone Safari and installed PWAs.

Remaining QA:

- Confirm iPad detection does not incorrectly fall back to popup.
- Confirm Chrome on iOS behaves acceptably, remembering that Chrome on iOS still uses WebKit under the hood.

## Findings

### P1 - Update checking can still falsely report that stale app code is current

Evidence:

- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1684) fetches `/version.json`.
- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1689) initializes the loaded version from the freshly fetched remote metadata:

```ts
if (!loadedVersionRef.current) loadedVersionRef.current = metadata.version;
```

Why this matters:

- A stale installed PWA can load old JavaScript but fetch the newest `/version.json`.
- The stale app then labels the latest remote version as its own currently loaded version.
- Result: the Profile page can say the user is up to date when the running JavaScript bundle is actually old.

Recommended Cursor fix:

- Embed build metadata into the JavaScript bundle at build time.
- Compare:

```text
loaded bundle version
vs
latest fetched /version.json
```

Possible implementation:

- Generate `src/buildMetadata.ts` during release build and import it.
- Or use Vite `define` values such as `__APP_VERSION__`, `__BUILD_NUMBER__`, and `__COMMIT__`.
- Continue using `/version.json` only as the remote latest-version signal.

QA plan:

1. Deploy build A.
2. Install/open PWA.
3. Deploy build B.
4. Reopen stale PWA without clearing Safari data.
5. Confirm app detects update.
6. Tap `Update Now`.
7. Confirm build B is actually running.

### P1 - Local builds mutate tracked release metadata

Evidence:

- [package.json](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/package.json:8) runs:

```json
"prebuild": "node scripts/generate-version.mjs"
```

- [scripts/generate-version.mjs](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/scripts/generate-version.mjs:12) increments/writes build metadata.

Why this matters:

- Running a normal build for QA can dirty the repo.
- Build numbers may increase without an actual deploy.
- This weakens the app-update system because build numbers no longer strictly mean real releases.

Recommended Cursor fix:

- Separate local build from release build.

Example:

```json
"build": "tsc && vite build",
"build:release": "node scripts/generate-version.mjs && tsc && vite build"
```

Alternative:

- Only generate version metadata in CI/deploy.
- Require an explicit env flag, such as `RELEASE_BUILD=true`.

### P1 - Push alert status can be wrong on a second device or browser

Evidence:

- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1253) appears to mark alerts as enabled if the signed-in user has any enabled push subscription.
- [src/firebaseDb.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/firebaseDb.ts:420) subscribes to push subscriptions for the user.
- [src/firebaseDb.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/firebaseDb.ts:430) saves the current browser push subscription.

Why this matters:

- A user could enable alerts on desktop.
- Later, the same user opens the app on iPhone.
- The iPhone may show alerts as enabled because another device has a subscription.
- The user will reasonably believe this iPhone can receive notifications, even if it cannot.

Recommended Cursor fix:

- At runtime, call `serviceWorkerRegistration.pushManager.getSubscription()`.
- Compare that current browser subscription endpoint to the stored `pushSubscriptions`.
- Display notification status for the current device/browser, not merely the current user.

Suggested UX:

- `Alerts on this device`
- `Alerts enabled on another device`
- `Enable alerts`
- `Unsupported in this browser`

QA plan:

1. Sign in on desktop and enable alerts.
2. Sign in as same user on iPhone Safari without enabling alerts.
3. Confirm iPhone does not show alerts as enabled.
4. Enable alerts on iPhone.
5. Confirm iPhone now shows alerts enabled for this device.

### P1 - New-match in-app notifications are coupled to push subscription opt-in

Evidence:

- [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:348) builds the `matchPosted` fanout from `pushSubscriptions`.
- [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:356) creates beta `matchPosted` notifications for those opted-in user IDs.

Why this matters:

- In-app notifications and push notifications are different channels.
- A user who has not enabled push may still need to see new-match notices inside the app.
- Current logic risks making in-app visibility depend on push setup.

Recommended Cursor fix:

- Build notification audience from eligible users/playmates/location membership.
- Then send push only to users in that audience who also have enabled push subscriptions.

The backend model should be:

```text
eligible audience
-> create in-app notification
-> if push subscription exists, also send push
```

Not:

```text
push subscribers
-> create in-app notification
```

### P1 - New-match fanout may ignore removed playmates

Evidence:

- Disabled playmate filtering exists in the matchmaking path.
- The `matchPosted` fanout path in [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:356) does not appear to apply that same disabled-pair check.

Why this matters:

- If Player A removes Player B as a playmate, matchmaking should exclude them.
- New-match notifications should follow the same exclusion rule.
- Otherwise, a removed playmate can still receive a prompt about the other user's match.

Recommended Cursor fix:

- Reuse the disabled-pair logic before creating `matchPosted` notifications.
- Add a backend unit/integration test for:

```text
A removes B
A creates match
B does not receive matchPosted notification
B is not matched into A's game
```

### P1 - VAPID web-push key mismatch risk remains

Evidence:

- Client uses `VITE_FIREBASE_VAPID_KEY` in [src/pushNotifications.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/pushNotifications.ts:1).
- Backend hard-codes `WEB_PUSH_VAPID_PUBLIC_KEY` in [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:19).
- Backend private key comes from `WEB_PUSH_VAPID_PRIVATE_KEY` in [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:21).

Why this matters:

- Browser subscriptions are bound to the public VAPID key used during subscription.
- Backend sends must use the matching private key.
- If these values drift, the user may look subscribed but never receive alerts.

Recommended Cursor fix:

- Document the VAPID keypair source.
- Add an admin-only "Send test push to me" tool.
- Consider serving the public VAPID key from backend config so the client and backend cannot drift.

QA plan:

1. Install PWA on iPhone Home Screen.
2. Enable alerts.
3. Confirm `pushSubscriptions` document exists.
4. Trigger test push.
5. Confirm receipt on lock screen/Notification Center.

### P2 - Frontend notification type model does not match backend

Evidence:

- [src/domain.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/domain.ts:80) defines frontend notification types.
- [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:94) includes backend types such as `matchPosted` and `playerJoined`.

Why this matters:

- The UI may currently work by rendering `title` and `body`, but TypeScript is not representing the real backend data.
- Future logic based on `notification.type` can silently miss valid backend events.

Recommended Cursor fix:

- Update frontend union types to match backend notification types.
- Ideally centralize the notification type contract.

### P2 - Service worker update activation is not robust enough

Evidence:

- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1720) only sends `SKIP_WAITING` if `registration.waiting` exists.
- [public/sw.js](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/public/sw.js:30) does not call `self.skipWaiting()` during install.
- [public/sw.js](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/public/sw.js:43) only skips waiting when messaged.

Why this matters:

- If the new service worker is still installing, the user may hit `Update Now` and reload before the new worker controls the page.
- Installed PWAs are especially sensitive to this because users expect app-like updates.

Recommended Cursor fix:

- Track `registration.installing` state changes.
- Use `controllerchange` before reloading.
- Ensure `Update Now` waits until the new service worker is controlling the page.

### P2 - Push notification click behavior should route intentionally

Evidence:

- [public/sw.js](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/public/sw.js:18) focuses the first available app client.

Why this matters:

- A notification for a confirmed game, court assignment, or player joined event should open the relevant place in the app.
- Current behavior may focus an arbitrary existing tab/state.

Recommended Cursor fix:

- Include route/deep-link metadata in notification payloads.
- On notification click:
  - Focus an existing app client if present.
  - Navigate that client to the intended route if needed.
  - Otherwise open a new client at that route.

### P2 - Dropping from a game still appears to delete availability

Evidence:

- [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:701) deletes availability records associated with the leaving player.

Why this matters:

- Product rule discussed previously: users should only be blocked from overlapping matches.
- If someone drops from one match, they may still want to remain available for that same window or another non-overlapping window.
- Deleting availability can surprise the user and reduce matching opportunities.

Recommended Cursor fix:

- Revisit product behavior:
  - If user drops from a specific game, should their original availability remain active?
  - If they intentionally cancel availability, that should be separate from dropping from a game.
- Consider decoupling:

```text
drop from game
cancel availability
```

### P3 - `pushSubscriptions.createdAt` can be overwritten on resave

Evidence:

- [src/firebaseDb.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/firebaseDb.ts:456) writes `createdAt` during a merge save.

Why this matters:

- Re-enabling or refreshing a subscription may overwrite the original creation time.
- This is not user-facing, but it weakens debugging/auditing.

Recommended Cursor fix:

- Only set `createdAt` on create.
- Set `updatedAt` on every save.

### P3 - Disabled playmate lookups may not scale

Evidence:

- Backend disabled-playmate lookups appear to scan disabled playmate records broadly.

Why this matters:

- Fine for 20-30 users.
- Not fine if the app grows to public courts/resorts and hundreds or thousands of users.

Recommended Cursor fix:

- Scope queries by user/location where possible.
- Add indexes that support the actual matchmaking queries.
- Keep this as a V1/V1.1 scalability task, not necessarily an MVP blocker.

### P3 - Firestore rules include a legacy `pushTokens` collection

Evidence:

- [firestore.rules](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/firestore.rules:45) includes rules for `pushTokens`.
- Current code appears to use `pushSubscriptions`.

Why this matters:

- Not immediately harmful.
- It creates confusion about the canonical push storage model.

Recommended Cursor fix:

- Confirm whether `pushTokens` is obsolete.
- Remove or comment with migration rationale.

## Auth Persistence Notes For Product/QA

Users should not normally need to log in every time they open the app.

Expected behavior:

- Firebase Auth persists sign-in state in browser storage.
- Safari, Chrome, and installed PWA contexts each have their own storage behavior.
- If storage remains intact, the user should reopen PaddleUp and still be signed in.
- Google may occasionally require reauthentication for security/account reasons, but that should not be every launch.

Cases that can break persistence:

- User clears Safari/Chrome website data.
- User uses private browsing.
- iOS removes site data under storage pressure.
- User signs out.
- App opens on a different browser than the one used for login.
- Auth redirect flow is interrupted and restored directly to `/__/auth/handler`.

QA recommendation:

- Test install/login persistence separately for:
  - iPhone Safari browser tab
  - iPhone Home Screen PWA
  - Chrome on iOS
  - Desktop Chrome

## Recommended Cursor Priority Order

1. Fix app-update/version detection so stale PWAs can reliably detect new builds.
2. Separate local build from release build metadata generation.
3. Fix current-device push alert state.
4. Decouple in-app notification audience from push subscribers.
5. Apply removed-playmate filtering to new-match notification fanout.
6. Add test-push/admin verification path for VAPID.
7. Align frontend/backend notification types.
8. Harden service worker activation/update flow.
9. Improve notification click routing.
10. Revisit drop-game versus cancel-availability behavior.

## Launch Risk Summary

Highest current risk:

- Users running stale code without knowing it.
- Users believing alerts are enabled on a device when they are only enabled elsewhere.
- Users without push enabled missing in-app new-match notifications if audience selection is push-gated.

Strongest current improvement:

- Auth domain and iOS redirect flow appear to be moving in the correct direction.

Cursor should treat this as a follow-up QA handoff, not as proof that every issue exists in production. Each finding should be verified against the latest code and then fixed or explicitly dismissed with rationale.
