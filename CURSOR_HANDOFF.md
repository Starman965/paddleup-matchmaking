# PaddleUp Matchmaking - Developer Handoff

Last updated: May 31, 2026

## Executive Summary

PaddleUp Matchmaking is a mobile-first React/TypeScript/Firebase PWA for real-time pickleball matchmaking.

The MVP is launching around one active location:

- `blackhawk` - Blackhawk Country Club

Important architecture decision: do not hard-code Blackhawk into the domain model. Every user, availability record, game, and future matching decision should reference `locationId`. The app has one live location today, but the data model is intentionally location-first so it can later support public courts, resorts, vacation destinations, country clubs, nearby matching, and GPS-based discovery.

The product is not a scheduling app, event system, chat app, ladder app, or open-play manager. The product is an intent-driven matchmaking tool.

Core value proposition:

> Time from "I want to play" to "I have a game."

The Home experience should continue to revolve around one giant CTA:

> Find Me Playmates

That CTA is the product's "request ride" moment.

## Live Project

GitHub:

- `https://github.com/Starman965/paddleup-matchmaking`

Live Firebase Hosting:

- `https://paddleup-match-maker.web.app`
- `https://paddleup-match-maker.firebaseapp.com`

Firebase project:

- Project ID: `paddleup-match-maker`
- Authentication: Google Sign-In
- Firestore: active
- Cloud Functions: active
- Hosting: active
- Messaging/FCM: not wired into product behavior yet

Current branch:

- `main`

Latest known deployed state:

- Hosting is live.
- Functions are live.
- Latest backend-only deploy updated Cloud Functions after commit `56f1240`.
- Latest known commit: `56f1240 Preserve forming game windows`.

## Product Model

PaddleUp has one matchmaking concept:

- A player wants to play.

The timing can be:

- `Ready Now`
- `Later Today`
- `Tomorrow`

Do not split future requests into a separate user-facing concept like "future matches" versus "forming games." That confused QA because both were really partial matches. The current product language should be:

- `Matches Forming`
- `Getting Matched`
- `Confirmed`

Mental model:

- `Ready Now` means matchmaking starts immediately for an immediate play window.
- `Later Today` means matchmaking starts immediately for a later play window.
- `Tomorrow` means matchmaking starts immediately for tomorrow's requested play window.
- A match becomes `confirmed` only when capacity is reached.
- MVP default match type is doubles, requiring 4 players.

MVP priority:

- Doubles first. The first Blackhawk users are expected to want doubles and mixed doubles.

Not MVP:

- DUPR integration
- Skill filtering
- Public courts
- Resort mode
- Nearby players
- GPS matching
- Auto-generated locations
- Learning engine
- Preferred partners
- Court reservations
- Club integrations
- WhatsApp replacement
- Group play
- Open play
- Round robins
- Drills

## Stack

Frontend:

- React
- TypeScript
- Vite
- Lucide icons
- Custom mobile-first CSS
- PWA manifest and service worker

Backend:

- Firebase Authentication
- Firestore
- Firebase Cloud Functions v2
- Firebase Hosting

Future:

- Firebase Cloud Messaging for push notifications
- Native iOS wrapper or native app only if install/push friction becomes a real MVP blocker

## Local Development

Install:

```bash
npm install
```

Run web app:

```bash
npm run dev
```

Build web app:

```bash
npm run build
```

Build functions:

```bash
cd functions
npm install
npm run build
```

Deploy hosting:

```bash
FIREBASE_CLI_UPDATE_NOTIFIER=false firebase deploy --only hosting --project paddleup-match-maker
```

Deploy functions:

```bash
FIREBASE_CLI_UPDATE_NOTIFIER=false firebase deploy --only functions --project paddleup-match-maker
```

Deploy both:

```bash
FIREBASE_CLI_UPDATE_NOTIFIER=false firebase deploy --only functions,hosting --project paddleup-match-maker
```

Deploy rules:

```bash
FIREBASE_CLI_UPDATE_NOTIFIER=false firebase deploy --only firestore:rules --project paddleup-match-maker
```

Live smoke check:

```bash
curl -I https://paddleup-match-maker.web.app
```

## Important Files

Frontend:

- `src/main.tsx` - main React app, state wiring, view composition
- `src/firebase.ts` - Firebase initialization
- `src/firebaseDb.ts` - Firestore subscriptions and callable wrappers
- `src/domain.ts` - shared TypeScript domain types
- `src/data.ts` - sample fallback data
- `src/styles.css` - mobile app shell and visual styling
- `public/manifest.webmanifest` - PWA manifest
- `public/sw.js` - service worker cache behavior

Backend:

- `functions/src/index.ts` - Cloud Functions and matchmaking logic
- `functions/package.json` - Functions dependencies/runtime

Firebase:

- `firebase.json` - Hosting config and cache headers
- `firestore.rules` - Firestore security rules
- `storage.rules` - Storage rules

## Current User Flows

### Sign In

- Google Sign-In only.
- On sign-in, the app upserts `users/{uid}`.
- The user profile includes `uid`, `firstName`, `lastName`, `email`, `photoUrl`, `locationId`, `presence`, and app preferences such as `defaultReadyNowDuration`.

### Home

Home currently prioritizes:

1. Player/location header
2. Active selected/own match status, if applicable
3. Primary CTA: `Find Me Playmates`
4. Secondary timing buttons: `Later Today`, `Tomorrow`
5. `Matches Forming`

Recent UX decisions:

- Removed the old pulse count cards (`Ready Now`, `Later Today`, `Tomorrow`, `Forming`) for MVP because they were not obvious enough to the user.
- Removed the confusing distinction between `Future Matches` and `Games Forming`.
- All open requests now appear as `Matches Forming`.
- Cards must show play-window context so the user knows whether they can join.

Ready Now card labeling:

- Show the expiration window, not only `Ready Now`.
- Examples:
  - `Ready Now - until 12:48 PM`
  - `Ready Now - 12 min left`
  - `Ready Now - closing now`

Future card labeling:

- Show day and range.
- Examples:
  - `Today - 1:00 PM-5:00 PM`
  - `Tomorrow - 11:00 AM-12:00 PM`

### Me

- User can set default Ready Now duration: `30`, `60`, `90`, or `120` minutes.
- This preference is stored on `users/{uid}.defaultReadyNowDuration`.
- Hydration must wait for the live Firestore user record before falling back to local defaults. A prior bug caused the UI to revert to `60` after sign-out/sign-in because local state won the race.

### My Games

- Shows selected/active game, forming games, and confirmed games.
- Selected game is derived only from the current user's live games.
- After dropping out, the selected game should disappear immediately without requiring pull-to-refresh.
- The row under player avatars should show participating player names, not redundant "Need X more" text.
- Use `First L.` format separated with dots, for example: `Ira R. - David L. - Beth M.`

### Direct Join

- Users can join an open forming match directly from the card.
- They should not be forced to publish new availability first.
- Direct join is valid because the user is explicitly accepting the displayed play window.
- Backend still validates:
  - signed-in user
  - forming game
  - capacity not full
  - no overlapping active game for that user
  - playmate exclusions

### Drop Out

- Dropping out removes the user from the game.
- The UI should update immediately by clearing the selected game and deriving visible games from live `myGames`.
- If the drop causes a confirmed game to fall below capacity, backend behavior should keep the game consistent and notify remaining players.

### Court Assignment

- Any player in a game should be able to assign a court.
- The assign-court affordance should be visible on game cards when a game needs a court, especially confirmed games.
- Earlier UI hard-coded `Court 4`; current/future UI should use a simple picker or prompt.
- Backend accepts a court string through the `assignCourt` callable.

Product nuance:

- It is acceptable to assign a court before the game is fully confirmed if a real-world court is known, but the most obvious MVP placement is on confirmed or selected game cards where it is actionable.

## Firestore Collections

### `locations`

Current seeded doc:

```json
{
  "id": "blackhawk",
  "name": "Blackhawk Country Club",
  "type": "club"
}
```

### `users`

```json
{
  "uid": "",
  "firstName": "",
  "lastName": "",
  "email": "",
  "photoUrl": "",
  "locationId": "blackhawk",
  "presence": "visible",
  "defaultReadyNowDuration": 60,
  "updatedAt": "serverTimestamp"
}
```

### `availability`

Doc ID convention:

```text
{uid}_{type}
```

Examples:

- `{uid}_readyNow`
- `{uid}_laterToday`
- `{uid}_tomorrow`

Shape:

```json
{
  "id": "",
  "userId": "",
  "locationId": "blackhawk",
  "type": "readyNow",
  "startTime": "",
  "endTime": "",
  "expiresAt": "",
  "updatedAt": "serverTimestamp"
}
```

### `games`

Current backend supports doubles:

```json
{
  "id": "",
  "locationId": "blackhawk",
  "type": "doubles",
  "status": "forming",
  "requiredPlayers": 4,
  "playerIds": [],
  "formedFromAvailabilityIds": [],
  "availabilityType": "readyNow",
  "startsAt": "",
  "endsAt": "",
  "meetTime": "",
  "court": null,
  "createdAt": "serverTimestamp",
  "updatedAt": "serverTimestamp"
}
```

When 4 players are reached:

- `status` becomes `confirmed`
- `meetTime` defaults to now plus 30 minutes
- `court` stays `null` until assigned
- `gameConfirmed` notifications are created

Completed/expired behavior:

- A scheduled function runs every 5 minutes.
- Forming and confirmed games are closed after the game window ends plus a 15-minute grace period.
- The frontend also filters stale games locally after `endsAt + 15 minutes` so old games disappear before the scheduled cleanup necessarily runs.

### `notifications`

```json
{
  "id": "",
  "userId": "",
  "gameId": "",
  "type": "formingGame",
  "title": "",
  "body": "",
  "read": false,
  "createdAt": "serverTimestamp"
}
```

Current notification types:

- `formingGame`
- `gameConfirmed`
- `courtAssigned`
- `playerLeft`

Browser/mobile push notifications are not implemented yet. Current notifications are Firestore in-app notifications.

### `playmates`

Rules and backend logic expect playmate exclusions.

Desired shape:

```json
{
  "userId": "",
  "playmateId": "",
  "enabled": true
}
```

Desired behavior:

- Default: all players are playmates.
- If A removes B, A should not be matched with B.
- Exclusion should apply even if only one side removed the other.

## Cloud Functions

Source:

- `functions/src/index.ts`

### `matchReadyNowDoubles`

Name is now stale. It handles more than Ready Now, but the function name has not been renamed yet.

Trigger:

- Firestore v2 `onDocumentWritten("availability/{availabilityId}")`

Current behavior:

1. Ignore invalid or expired availability.
2. Ignore availability that does not leave enough useful play time.
3. Query active availability at the same `locationId`.
4. Find an existing compatible forming doubles game or create one.
5. Merge eligible players into the game.
6. Confirm the game when `playerIds.length >= 4`.
7. Create in-app notifications.

Important matching rule added May 31:

- The first forming game owns/preserves the proposed play window.
- Later players can join that game if their availability overlaps the game window by at least 30 minutes.
- Later players must not shrink or mutate the original `startsAt`/`endsAt`.

Example:

- Player A creates tomorrow `11:00 AM-12:00 PM`.
- Player B creates tomorrow `10:00 AM-11:30 AM`.
- They can match because overlap is 30 minutes.
- The game remains `11:00 AM-12:00 PM`.

Another example:

- Player A creates `12:00 PM-2:00 PM`.
- Player B creates `12:00 PM-12:49 PM`.
- They can match because overlap is at least 30 minutes.
- The game remains `12:00 PM-2:00 PM`.

Implementation details:

- `MINIMUM_MATCH_OVERLAP_MINUTES = 30`.
- Existing forming games are matched with `hasMinimumOverlap(...)`.
- `selectAvailabilityGroup(...)` checks each candidate against the preserved game window.
- Existing direct-joined players are kept anchored to the existing game window so recalculation does not drop them.

Current caveat:

- The rule is individual overlap with the base game window, not strict common overlap among every player. For a long original window, one player could overlap the early part and another the late part. This matches the current MVP decision but may need refinement if real users find it confusing.

### `joinGame`

Callable HTTPS function.

Behavior:

1. Requires signed-in Firebase user.
2. Requires `gameId`.
3. Loads the game.
4. Verifies game is `forming` and not full.
5. Verifies caller is not already in an overlapping active game.
6. Verifies playmate exclusions.
7. Adds caller to `playerIds`.
8. If game reaches capacity, marks it `confirmed` and creates notifications.

### `leaveGame`

Callable HTTPS function.

Behavior:

- Removes caller from the game.
- Keeps game state consistent.
- Creates relevant notifications.

Known caveat:

- Review whether it deletes all availability docs for the leaving user. That may conflict with future multi-window behavior where a player leaves one future match but still wants another separate time window active.

### `assignCourt`

Callable HTTPS function.

Behavior:

1. Requires signed-in Firebase user.
2. Requires `gameId` and `court`.
3. Loads the game.
4. Verifies caller is in `playerIds`.
5. Updates `games/{gameId}.court`.
6. Creates `courtAssigned` notifications for every player in the game.

### `closeExpiredGames`

Scheduled function.

Behavior:

- Runs every 5 minutes.
- Closes stale forming/confirmed games after `endsAt + 15 minutes`.
- This prevents old open matches from staying visible forever.

## Security Rules

Rules file:

- `firestore.rules`

Current posture:

- Signed-in users can read:
  - `locations`
  - `users`
  - `playmates`
  - `availability`
  - `games`
  - their own `notifications`
- Users can create/update only their own `users/{uid}` doc.
- Users can create/update/delete only their own availability.
- Client cannot write games.
- Client cannot create notifications.
- Users can only update `read` on their own notifications.
- Cloud Functions use Admin SDK for game and notification writes.

This is the intended architecture: clients express intent, backend owns matchmaking and game mutations.

## PWA and Mobile Notes

This is currently a PWA, not a native iPhone app.

Install on iPhone:

1. Open `https://paddleup-match-maker.web.app` in Safari.
2. Tap Share.
3. Tap `Add to Home Screen`.
4. Launch from the Home Screen icon.

Important iOS note:

- PWA push notifications on iPhone require the user to install the PWA to Home Screen.
- FCM/push is not implemented yet, so current alerts are in-app only.

Mobile app shell fixes already made:

- The document body is locked to reduce Safari scroll bounce issues.
- Each screen uses internal scrolling.
- Bottom navigation is intended to stay consistent page-to-page.
- Safe-area padding is handled in CSS.

Continue testing on real iPhone Safari/PWA because desktop browser emulation misses Safari address-bar and bottom-bar behavior.

## Current Verified State

As of May 31, 2026:

- Firebase Hosting is live.
- Google sign-in works.
- User profile doc is written on sign-in.
- Ready Now, Later Today, and Tomorrow requests write availability.
- Cloud Function creates/updates doubles forming games.
- Direct join works.
- Drop out updates the UI immediately.
- Ready Now default duration persists across sign-out/sign-in.
- Forming cards show timing context.
- Ready Now cards show remaining/expiration context.
- Old expired games disappear after the grace period.
- Confirmed games can have courts assigned.
- Home reads live Firestore games after sign-in.
- My Games reads live Firestore games after sign-in.
- Notifications are read live from Firestore and shown in-app.
- Web production build passes.
- Functions production build passes.
- Code is pushed to GitHub.
- Latest Cloud Functions deploy succeeded.

Known test data:

- Several real and temporary test users/games may exist in Firestore.
- Do not treat current Firestore data as clean production data.
- Before inviting real users, add an admin cleanup path or manually reset test data.

## Recent Enhancements and Fixes

### Match model simplification

- Removed separate `Future Matches` vs `Games Forming` mental model.
- Unified open requests under `Matches Forming`.
- Added explicit play-window labels on match cards.

### Home pulse cards removed

- Removed MVP count cards because users could not easily infer what action to take from them.
- The primary CTA and open matches now carry the UX.

### Direct join restored

- Users can now join displayed forming games directly.
- This supports the practical use case: "I see an open match at a time I can play; let me join it."

### Overlap rules relaxed correctly

- Users are blocked only from joining or creating overlapping active games.
- A user can be in a tomorrow game and still create/join a Ready Now or Later Today game if times do not overlap.

### Forming game windows preserved

- Later players no longer shrink the original forming game's time window.
- Match requires at least 30 minutes of overlap with the preserved game window.

### Expiration cleanup

- Backend scheduled cleanup closes stale forming/confirmed games.
- Frontend hides stale games after the 15-minute grace period.

### Ready Now default persistence fixed

- The UI now waits for the live user preference before selecting the default duration.
- This fixed the bug where 120 minutes reverted to 60 after sign-out/sign-in.

### Mobile scrolling pass

- Reduced inconsistent Safari scroll behavior.
- Kept bottom navigation more stable across pages.

### My Games selected game refresh fixed

- Dropping out clears selected game immediately.
- The selected card is derived from the current user's live games.

### Player names on game cards

- Replaced redundant "Need X more" line under avatars with first-name/last-initial player summaries.

### CTA compacted

- Sparkle icon and "Want to play now or soon?" were moved onto one row to save vertical space.

### Ready Now expiration shown

- Ready Now cards now show the user's active play window ending time or minutes remaining.

## Known Issues / Rough Edges

1. Function naming is stale.
   - `matchReadyNowDoubles` handles more than Ready Now.
   - Rename carefully later if desired.

2. Singles are not implemented in backend.
   - MVP is doubles-first.

3. Push notifications are not implemented.
   - Current notification system is Firestore/in-app only.

4. Admin tooling is minimal.
   - Admin controls are intended for David only.
   - Need safer cleanup/reset tools before broader testing.

5. Test data may pollute QA.
   - Add a cleanup script or admin-only reset function before inviting real players.

6. Playmate UX/persistence should be checked end-to-end.
   - Backend has playmate exclusion logic, but UI and data setup should be audited before relying on it.

7. Direct join does not create availability.
   - This is intentional for now because direct join means accepting the visible game window.
   - Be mindful when building analytics around "availability created" versus "game joined."

8. Individual overlap may not equal common overlap.
   - Current rule is at least 30 minutes overlap between each player and the base game window.
   - If real users expect all players to share the exact same 30-minute segment, backend logic must become stricter.

9. Bundle size warning exists.
   - Production build passes, but Vite warns about a bundle over 500KB.
   - Not MVP-blocking.

10. No full analytics funnel yet.
   - Firebase Analytics is initialized, but product events need to be defined and tracked.

## Recommended Next Steps

### 1. QA the latest deployed backend behavior

Test:

- A creates tomorrow `11:00 AM-12:00 PM`.
- B creates tomorrow `10:00 AM-11:30 AM`.
- Confirm B joins A's match.
- Confirm the game still displays `11:00 AM-12:00 PM`.

Also test:

- A has tomorrow match.
- A can still create Ready Now today.
- A cannot create/join another game that overlaps the same time window.

### 2. Add cleanup/admin tools

Create a safe admin-only way to:

- Delete test availability
- Delete test notifications
- Delete test games
- Optionally delete seeded fake users
- Reset one location to a clean QA state

Do not expose this to normal users.

### 3. Improve court assignment UI

Add:

- bottom sheet or modal
- Blackhawk options like `Court 1` through `Court 10`
- `Other` text entry

Keep the write through `assignCourt`; do not let the client write `games` directly.

### 4. Mark notifications read

Implement:

- notification list or simple latest-updates interaction
- `mark all read`
- per-notification read update

Rules already allow users to update only `read` on their own notifications.

### 5. Audit leave-game availability cleanup

If a user can have multiple non-overlapping intentions, leaving one game should not necessarily delete all availability docs. Audit `leaveGame` against these use cases:

- User leaves tomorrow match but still wants Ready Now today.
- User leaves Ready Now but still wants a tomorrow match.
- User leaves one future game and should remain eligible for a different non-overlapping window.

### 6. Add product analytics

Track:

- CTA tap
- Ready Now request
- Later Today request
- Tomorrow request
- Direct join
- Drop out
- Game confirmed
- Time from request to confirmation
- Court assigned
- Weekly active users

These should answer the MVP question:

> Is this better than WhatsApp coordination?

### 7. Add FCM only after in-app flow is solid

Implementation direction:

- Enable Firebase Cloud Messaging.
- Add VAPID key.
- Ask permission at a meaningful moment, not first page load.
- Store push tokens per user/device.
- Send push for:
  - game confirmed
  - court assigned
  - player left
  - need replacement

For iPhone PWA, push requires Home Screen installation.

## Design Direction

The current UI is intentionally iPhone-shaped and inspired by Apple/Liquid Glass-style surfaces, but it is still a web/PWA implementation.

Keep:

- mobile-first interaction
- big Home CTA
- polished dark sports-club feel
- bottom nav
- location visible
- clear timing labels
- direct actions on cards

Avoid:

- landing-page design
- too many dashboard counts
- chat features
- event-management complexity
- ladders/round robins/open play until MVP proves demand
- hiding critical time-window details behind drill-in screens

## Development Philosophy

Clients should express intent:

- "I want to play now."
- "I want to play later today."
- "I want to play tomorrow."
- "I want to join this displayed match."
- "I am leaving this match."
- "Assign this court."

Cloud Functions should own:

- matching
- locking/confirming games
- validating game changes
- notifications
- expiration cleanup

This keeps Firebase Hosting viable. The "server" is Firebase Functions, not a custom Node app.

## Quick User Day-in-the-Life

1. At 8:00 AM, user opens PaddleUp from Safari or the installed Home Screen PWA.
2. User taps `Find Me Playmates`.
3. User chooses Ready Now for 60 minutes, or chooses a later/tomorrow play window.
4. App writes availability to Firestore.
5. Cloud Function checks compatible players at Blackhawk.
6. If fewer than 4 players, a forming doubles match appears with the requested play window and needed count.
7. Another user can either publish matching availability or directly join the displayed match.
8. When 4 players are in, the backend confirms the game.
9. Players see in-app notification, and later will receive push notification once FCM is implemented.
10. Any player assigns a court.
11. The game closes automatically after the play window plus grace period.

## Suggested Cursor Starting Prompt

```text
You are taking over PaddleUp Matchmaking, a React/TypeScript/Firebase PWA for pickleball matchmaking. Read CURSOR_HANDOFF.md, README.md, src/domain.ts, src/firebaseDb.ts, src/main.tsx, src/styles.css, firestore.rules, and functions/src/index.ts first. Preserve the architecture: clients express intent, Cloud Functions own game matching/mutations, and all data remains location-first through locationId. The latest product decision is that all Ready Now/Later Today/Tomorrow requests are "Matches Forming"; direct join is allowed; games close after the window plus 15 minutes; and forming game windows must be preserved while later players can join with at least 30 minutes of overlap. Start by QAing the latest deployed behavior, then choose from admin cleanup, court assignment UI, notification read states, or leave-game availability cleanup.
```
