# PaddleUp QA Code Review - June 2, 2026

Reviewer: Codex acting as QA/code-review engineer

Scope:

- Review only.
- No application code changes made.
- Current worktree includes substantial uncommitted Cursor changes.
- Frontend build passes.
- Functions build passes.

## Context From Field QA

David observed this while onboarding a real user courtside:

- User scanned the PaddleUp QR code from the Profile/Me share area.
- User logged in with Google.
- After closing/reopening the browser, the browser showed a Firebase Auth handler URL:

```text
https://paddleup-match-maker.firebaseapp.com/__/auth/handler?state=...
```

The visible error was:

```text
Unable to process request due to missing initial state.
This may happen if browser sessionStorage is inaccessible or accidentally cleared...
```

This should be treated as a launch-critical auth/install issue because multiple users have reported login weirdness.

## Verification Performed

Commands run:

```bash
npm run build
npm --prefix functions run build
```

Results:

- Frontend build passed.
- Functions TypeScript build passed.
- Frontend still has a large bundle warning.
- Running the frontend build executes `scripts/generate-version.mjs`, which mutates build metadata files.

No browser/device QA was performed in this pass.

## Findings

### P0 - Firebase Auth handler can strand users on `/__/auth/handler`

Evidence:

- [src/firebase.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/firebase.ts:10) sets:

```ts
authDomain: "paddleup-match-maker.firebaseapp.com"
```

- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1944) uses `signInWithPopup`.
- The app share URL and QR code use:

```ts
https://paddleup-match-maker.web.app/
```

- The field screenshot shows the browser directly on the Firebase auth handler domain, not the app URL.

Why this matters:

- If a user/browser restores the auth helper tab instead of the app tab, the user sees a raw Firebase error page.
- If any future mobile auth flow switches to `signInWithRedirect`, this domain split becomes more dangerous because redirect auth depends on browser storage state.
- Firebase’s own redirect best-practices docs warn that third-party storage partitioning breaks redirect flows unless the auth helper is served from the app domain or proxied correctly.

Recommended Cursor fix:

1. Decide on one canonical public app origin. Current likely choice:

```text
https://paddleup-match-maker.web.app
```

2. Update Firebase web config `authDomain` to the app-serving domain if using Firebase Hosting:

```ts
authDomain: "paddleup-match-maker.web.app"
```

3. In Firebase/Auth and Google OAuth config, verify authorized domains/redirect URI include:

```text
paddleup-match-maker.web.app
https://paddleup-match-maker.web.app/__/auth/handler
```

4. QA both:

- `signInWithPopup` on desktop.
- iPhone Safari from QR scan.
- iPhone Safari after Add to Home Screen.

5. Consider using `signInWithRedirect` on mobile only after the authDomain is corrected and `getRedirectResult` handling is implemented and tested.

References:

- Firebase redirect best practices: https://firebase.google.com/docs/auth/web/redirect-best-practices
- Firebase Google sign-in docs: https://firebase.google.com/docs/auth/web/google-signin

### P0 - The app update detector likely cannot detect that the currently loaded JS is stale

Evidence:

- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1660) fetches `/version.json`.
- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1663) initializes `loadedVersionRef.current` to the freshly fetched remote version:

```ts
if (!loadedVersionRef.current) loadedVersionRef.current = metadata.version;
const currentVersion = loadedVersionRef.current;
const updateAvailable = metadata.version !== currentVersion;
```

Why this matters:

- If an old installed PWA loads stale JS and then fetches the newest `/version.json`, it will set its "loaded" version to the newest remote version.
- That makes `updateAvailable` false on first check, even though the running JS bundle may be old.
- The Profile page may say "up to date" while the app is actually stale.

Recommended Cursor fix:

- Embed the build metadata into the JS bundle at build time, not only into `/version.json`.
- Compare:

```text
loaded bundle version
vs
latest fetched /version.json
```

Implementation options:

- Generate `src/buildMetadata.ts` during build and import it in `main.tsx`.
- Or use Vite `define` values for `__APP_VERSION__`, `__BUILD_NUMBER__`, and `__COMMIT__`.
- Keep `/version.json` as the remote truth, but never use the first remote fetch to define the current loaded bundle version.

QA:

1. Deploy build A.
2. Install/open PWA.
3. Deploy build B.
4. Open stale PWA without clearing cache.
5. Confirm it reports update available and `Update Now` actually loads build B.

### P1 - `prebuild` mutates version/build files on every local build

Evidence:

- [package.json](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/package.json:8) has:

```json
"prebuild": "node scripts/generate-version.mjs"
```

- [scripts/generate-version.mjs](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/scripts/generate-version.mjs:14) increments `public/build-number.txt` every time `npm run build` is run.

Why this matters:

- QA/build checks dirty the worktree.
- A developer can create a new build number without changing product code.
- "Build 51" may mean "someone ran build locally," not "a real deploy happened."
- This can confuse the PWA update system and Cursor/GitHub diffs.

Recommended Cursor fix:

- Separate local build from release build.
- Example:

```json
"build": "tsc && vite build",
"build:release": "node scripts/generate-version.mjs && tsc && vite build"
```

- Or generate build metadata only in CI/deploy.
- If keeping local generation, make the script idempotent unless a `RELEASE_BUILD=true` env var is set.

### P1 - Web Push public/private VAPID configuration can silently mismatch

Evidence:

- Client uses `VITE_FIREBASE_VAPID_KEY` in [src/pushNotifications.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/pushNotifications.ts:1).
- Backend hard-codes a public key in [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:19).
- Backend private key comes from Firebase secret `WEB_PUSH_VAPID_PRIVATE_KEY` in [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:21).

Why this matters:

- Browser subscriptions are tied to the public VAPID key used at subscription time.
- Backend sends must use the matching private key.
- If `VITE_FIREBASE_VAPID_KEY`, `WEB_PUSH_VAPID_PUBLIC_KEY`, and `WEB_PUSH_VAPID_PRIVATE_KEY` are not a pair, users may appear subscribed but never receive notifications.

Recommended Cursor fix:

- Make VAPID key source explicit and documented.
- Prefer a single public-key constant generated from the same keypair, or expose a callable/config endpoint returning the public key that matches the deployed function secret.
- Add an admin/test function or admin UI action: "Send test push to me."

QA:

1. Install PWA on iPhone Home Screen.
2. Enable alerts.
3. Confirm `pushSubscriptions/{id}` exists.
4. Trigger a one-off test push from backend.
5. Confirm receipt on iPhone lock screen/Notification Center.

### P1 - Service worker update flow may not activate new workers promptly

Evidence:

- [public/sw.js](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/public/sw.js:30) install handler does not call `self.skipWaiting()`.
- [public/sw.js](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/public/sw.js:43) only calls `skipWaiting()` when it receives `SKIP_WAITING`.
- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1694) calls `registration.update()` and only messages `registration.waiting`.

Why this matters:

- If a new service worker is still installing, not yet in `waiting`, `Update Now` may reload before the new worker controls the page.
- The user may tap Update Now and remain on the stale build.

Recommended Cursor fix:

- Implement a robust service-worker lifecycle helper:
  - listen for `registration.installing.statechange`
  - message `SKIP_WAITING` when the new worker reaches `installed`
  - wait for `controllerchange`
  - then reload
- Add QA logging/status to the Me page during MVP.

### P1 - Install instructions are wrong for iPhone Safari

Evidence:

- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:3161) uses iOS steps:

```ts
["Tap ... in the lower right", "Tap Share", "Tap Add to Home Screen", "Open PaddleUp from the new icon"]
```

Why this matters:

- On Safari iPhone, the primary step is the Share button, not usually "..." first.
- Users will be courtside, distracted, and not technical. The instructions need to match exactly.

Recommended Cursor fix:

- For iPhone Safari:

```text
1. Tap the Share button
2. Scroll if needed
3. Tap Add to Home Screen
4. Tap Add
5. Open PaddleUp from the new icon
```

- For iPhone Chrome:

```text
Open this link in Safari to install and receive match alerts.
```

### P1 - New-match push notifications are sent only to users with existing push subscriptions

Evidence:

- In matchmaking, beta `matchPosted` notifications are created only for `optedInUserIds` derived from `pushSubscriptions` in [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:348).

Why this matters:

- Users without push subscriptions will not even get in-app `matchPosted_beta` notifications for new posted matches.
- That makes "Latest Updates" incomplete and ties durable in-app notification behavior to push opt-in status.

Recommended Cursor fix:

- Separate durable in-app notification targeting from push delivery.
- First decide which users should get an in-app notification.
- Create Firestore notifications for those users.
- Let `sendPushForNotification` decide whether push can be delivered based on subscriptions.

### P1 - New-match notification audience does not appear to respect playmate exclusions

Evidence:

- The beta notification fanout in [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:336) filters presence/offline/current active games, but does not check `disabledPairs`.

Why this matters:

- A user who removed another player could still be alerted that the removed player's match is available.
- That violates the product rule that matchmaking excludes removed playmates and can create awkward social behavior.

Recommended Cursor fix:

- Apply the same pair exclusion check to new-match notification fanout.
- If A removed B, do not notify A about B's match.
- If B removed A, do not notify A about B's match either.

### P1 - `leaveGame` still deletes availability records tied to that game

Evidence:

- [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:703) computes availability refs for the leaving player.
- [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:705) deletes those availability docs.

Why this matters:

- The app now supports multiple non-overlapping intentions.
- Leaving one future game should not necessarily cancel all of that user's ability/willingness to play in that time category.
- This was already a known caveat and should be retested after direct join/future-match changes.

Recommended Cursor fix:

- Revisit the product rule:
  - If a user leaves a specific match, should their availability remain active to look for a different compatible match?
  - For direct-join users, there may be no availability doc to delete.
- Consider marking a game-specific join record instead of deleting broad availability.

### P2 - Notification type model is out of sync between frontend and backend

Evidence:

- Backend uses `matchPosted` and `playerJoined` in [functions/src/index.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/functions/src/index.ts:98).
- Frontend `Notification` type in [src/domain.ts](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/domain.ts:72) only includes:

```ts
"formingGame" | "gameConfirmed" | "courtAssigned" | "playerLeft"
```

Why this matters:

- Type safety is lying.
- UI that branches on notification type may miss new events.
- Future Cursor changes can accidentally assume `matchPosted` never exists.

Recommended Cursor fix:

- Add all backend notification types to the shared frontend domain type.
- Prefer a shared constant/type model if practical.

### P2 - QR share copy is good, but it should explicitly say not to bookmark/share auth handler tabs

Evidence:

- QR value is correct: [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:3143) uses `appShareUrl`.
- Field issue shows users/browsers can end up looking at the auth handler tab.

Recommended Cursor fix:

- After login, if practical, surface a short install/share note:

```text
If you see a Firebase auth page, close that tab and open PaddleUp from the original link.
```

- Longer-term, the authDomain fix should prevent most of this.

### P2 - `notificationclick` focuses any existing client, not the most relevant one

Evidence:

- [public/sw.js](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/public/sw.js:22) finds the first focusable client.

Why this matters:

- If multiple PaddleUp tabs/windows exist, tapping a notification may focus an unrelated stale tab.
- It does not navigate the existing tab to the notification target URL.

Recommended Cursor fix:

- Prefer a client whose URL is the app origin.
- If found, `focus()` and `navigate(targetUrl)` when supported.
- Otherwise open a new window.

### P2 - Profile default duration saves immediately but has no busy/failed UI state

Evidence:

- [src/main.tsx](/Users/davidlewis/Documents/Codex/2026-05-29/i-want-you-to-code-this/src/main.tsx:1915) optimistically sets duration and writes to Firestore.
- The Profile buttons are always active.

Why this matters:

- Rapid taps can race writes.
- If the write fails, the UI keeps the optimistic value while status text reports failure.

Recommended Cursor fix:

- Add saving state for default duration.
- Disable buttons while saving or reconcile local state on failure.

## Specific Auth Repro Plan

Use this before inviting more testers:

1. On iPhone Safari, scan the QR code from Profile.
2. Confirm URL starts on:

```text
https://paddleup-match-maker.web.app/
```

3. Tap Google sign-in.
4. Complete sign-in.
5. Confirm user lands back in PaddleUp, not on `/__/auth/handler`.
6. Close Safari fully.
7. Reopen Safari.
8. Confirm the restored tab is PaddleUp, not the Firebase handler.
9. Add PaddleUp to Home Screen.
10. Launch from Home Screen.
11. Confirm auth persists or sign-in flow completes cleanly.
12. Repeat on iPhone Chrome and verify copy tells user to use Safari for alerts.

## Recommended Priority Order For Cursor

1. Fix authDomain/canonical auth handler issue.
2. Fix update-version comparison so stale installed PWAs can actually detect new builds.
3. Separate local builds from release build metadata generation.
4. Add robust service-worker update lifecycle handling.
5. Verify VAPID env/secret pairing and add a test-push tool.
6. Correct iPhone Safari install instructions.
7. Separate in-app notification targeting from push-subscription targeting.
8. Audit leave-game availability deletion.
9. Sync notification types.

## Notes For David

The screenshot is not user error. It is a real class of web-auth failure/rough edge. The QR code appears to be correct, but the auth helper tab can survive or be restored, and the app currently uses a different auth helper domain than the QR/app domain.

The practical MVP fix is to make PaddleUp's public app URL and Firebase Auth helper URL align, then retest Google sign-in on real iPhones before pushing harder on Home Screen install and push notifications.
