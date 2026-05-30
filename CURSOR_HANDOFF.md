# PaddleUp Matchmaking - Developer Handoff

Last updated: May 30, 2026

## Executive Summary

PaddleUp Matchmaking is a mobile-first React/TypeScript PWA for real-time pickleball availability and matchmaking.

The MVP is launching around one active location:

- `blackhawk` - Blackhawk Country Club

Important architecture decision: do not hard-code Blackhawk into the data model. Every user, availability record, game, and future matching decision should reference `locationId`. The app currently has one location, but the data model is intentionally location-first so it can later support public courts, resorts, vacation destinations, country clubs, nearby matching, and GPS-based discovery.

The product is not intended to be a scheduling app, event system, chat app, ladder app, or open-play manager. The core value proposition is:

> Time from "I want to play" to "I have a game."

The app should continue to revolve around the giant Home CTA:

> I Want to Play

That button is the product's "request ride" moment.

## Live Project

GitHub:

- `https://github.com/Starman965/paddleup-matchmaking`

Live Firebase Hosting:

- `https://paddleup-match-maker.web.app`
- Firebase also serves the same app at `https://paddleup-match-maker.firebaseapp.com`

Firebase project:

- Project ID: `paddleup-match-maker`
- Authentication: Google Sign-In
- Firestore: active
- Cloud Functions: active
- Hosting: active
- Messaging/FCM: not yet wired into product behavior

Current branch:

- `main`

Recent commits:

- `7598361 Add court assignment function`
- `0a7d038 Read live Firestore games in UI`
- `866a72a Add ready now doubles matchmaking`
- `0964899 Refresh PWA cache behavior`
- `34354bf Add Firestore availability rules`
- `c843a2a Wire Firebase hosting and auth`

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
firebase deploy --only hosting --project paddleup-match-maker
```

Deploy functions:

```bash
firebase deploy --only functions --project paddleup-match-maker
```

Deploy rules:

```bash
firebase deploy --only firestore:rules --project paddleup-match-maker
```

## Stack

Frontend:

- React
- TypeScript
- Vite
- CSS with Tailwind import, mostly custom CSS
- Lucide icons
- Mobile-first PWA

Backend:

- Firebase Authentication
- Firestore
- Firebase Cloud Functions v2
- Firebase Hosting

Future:

- Firebase Cloud Messaging for push notifications
- Possibly iOS wrapper/native app later, but PWA is currently the fastest path for MVP testing

## Product Requirements Snapshot

MVP goal:

- Launch to 20-30 Blackhawk players
- Determine whether availability-based matching beats WhatsApp coordination

Success metrics:

- At least 10 active weekly users
- At least 20 games formed through the app
- Average Ready Now formation time under 30 minutes

Core navigation:

- Home
- Players
- My Games
- Me

MVP match types:

- Doubles, 4 players
- Singles, 2 players, but this is not yet implemented in the backend

Current practical priority:

- Doubles first. The initial users are expected to want doubles and mixed doubles.

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

## Current App Behavior

Authentication:

- Google Sign-In only
- On sign-in, app upserts `users/{uid}`
- Captures:
  - `uid`
  - `firstName`
  - `lastName`
  - `email`
  - `photoUrl`
  - `locationId`

Home:

- Shows a large `I Want to Play` CTA
- Shows user's next confirmed game if signed in and a live game exists
- Shows latest notification cards for the signed-in user
- Shows forming games
- Signed-out state uses sample data so the app still looks presentable

Me:

- User can mark `Ready Now`
- Default durations:
  - 30 minutes
  - 60 minutes
  - 90 minutes
  - 120 minutes
- `Start Matching` writes `availability/{uid}_readyNow`
- Backend Cloud Function reacts and creates/updates a forming doubles game

My Games:

- Reads real Firestore `games` after sign-in
- Shows forming and confirmed games
- Confirmed game `Court TBD` pill now calls the backend `assignCourt` function
- Current UI assigns `Court 4` as a simple MVP action

Players:

- Still mostly sample/playmate UI
- Live users are merged into the app's known user map after sign-in
- Playmate add/remove is local UI state only right now; Firestore rules are ready for `playmates`, but the UI is not fully wired to persist it

Notifications:

- App reads real Firestore `notifications` for the signed-in user
- Bell count shows unread notifications
- Latest updates display on Home
- Mark-as-read UI is not implemented yet
- Browser/mobile push notifications are not implemented yet

## Firestore Collections

### `locations`

Current doc:

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
  "updatedAt": "serverTimestamp"
}
```

### `availability`

Ready Now doc ID convention:

```text
{uid}_readyNow
```

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
  "meetTime": "",
  "court": null,
  "createdAt": "serverTimestamp",
  "updatedAt": "serverTimestamp"
}
```

When 4 players are reached:

- `status` becomes `confirmed`
- `meetTime` is set to now plus 30 minutes
- `court` stays `null` until assigned
- `gameConfirmed` notifications are created

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
- `playerLeft` type exists in TypeScript but is not implemented yet

### `playmates`

Rules exist, but app persistence is not fully wired yet.

```json
{
  "userId": "",
  "playmateId": "",
  "enabled": true
}
```

Desired behavior:

- Default: all players are playmates
- User can remove a playmate
- Matchmaking excludes removed playmates

This exclusion is not yet implemented in the backend.

## Cloud Functions

Source:

- `functions/src/index.ts`

### `matchReadyNowDoubles`

Trigger:

- Firestore v2 `onDocumentWritten("availability/{availabilityId}")`

Behavior:

1. Ignore non-Ready Now availability.
2. Ignore expired availability.
3. Query all active Ready Now records at the same `locationId`.
4. Find existing forming doubles game at that location, or create one.
5. Merge active players into the game.
6. If player count reaches 4:
   - set `status: "confirmed"`
   - set `meetTime` to now plus 30 minutes
   - keep `court: null`
   - create `gameConfirmed` notifications
7. If fewer than 4:
   - keep `status: "forming"`
   - create `formingGame` notifications

Important limitation:

- It does not yet prevent a user who already has a confirmed game from starting another Ready Now game.
- It does not yet respect playmate exclusions.
- It does not yet distinguish mixed doubles.
- It does not yet support singles.

### `assignCourt`

Callable HTTPS function.

Behavior:

1. Requires signed-in Firebase user.
2. Requires `gameId` and `court`.
3. Loads the game.
4. Verifies caller is in `playerIds`.
5. Updates `games/{gameId}.court`.
6. Creates `courtAssigned` notifications for every player in the game.

Current UI calls this with:

```text
Court 4
```

Next UI improvement should let the user choose/type the court rather than hard-coding Court 4.

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

This is the intended shape: clients express availability, backend owns matchmaking.

## Important Files

Frontend:

- `src/main.tsx` - main app UI and state wiring
- `src/firebase.ts` - Firebase app/auth/firestore/functions initialization
- `src/firebaseDb.ts` - Firestore subscriptions and write helpers
- `src/domain.ts` - shared TypeScript domain types
- `src/data.ts` - sample fallback data
- `src/styles.css` - mobile Liquid Glass-ish UI styling
- `public/manifest.webmanifest` - PWA manifest
- `public/sw.js` - service worker cache behavior

Backend:

- `functions/src/index.ts` - Cloud Functions
- `functions/package.json` - Functions dependencies/runtime

Firebase:

- `firebase.json` - Hosting config and no-cache headers for `index.html` and `sw.js`
- `firestore.rules` - Firestore rules

## Current Verified State

As of May 30, 2026:

- Firebase Hosting is live.
- Google sign-in works.
- User profile doc is written on sign-in.
- Ready Now availability writes to Firestore.
- Cloud Function creates/updates doubles game.
- With four Ready Now players, game confirms.
- Confirmed game appears in Home and My Games after sign-in.
- Notifications appear in Home and bell count.
- Assign Court backend function is deployed.
- Code is pushed to GitHub.
- `npm run build` passes for web.
- `npm run build` passes for functions.

Known test data:

- Two real signed-in users were used.
- Two temporary test players were manually seeded:
  - `test-player-3`
  - `test-player-4`
- Existing confirmed game may include those test users. Do not treat current Firestore data as clean production data.

Before inviting real users, create a small admin cleanup script or manually reset test data.

## Known Issues / Rough Edges

1. Auth popup/tab can remain open on Firebase auth handler.
   - This is mostly a browser/popup cleanup issue.
   - The user can close the blank auth handler tab safely.

2. App has sample fallback data.
   - Good for signed-out demo.
   - Can confuse QA if signed-in reads fail because sample data still appears.
   - Keep the status strip visible during POC.

3. Court assignment is hard-coded to `Court 4`.
   - Backend accepts any valid court string.
   - UI should provide a simple picker/input.

4. Ready Now can create duplicate active games for the same user.
   - Backend should check whether the user is already in a forming/confirmed game before creating/updating another one.

5. Playmate removal is not enforced by matchmaking.
   - Need backend query/logic to respect disabled playmates.

6. Later Today, Tomorrow, and Weekend Availability are UI-only placeholders.
   - They do not write real Firestore availability yet.

7. FCM/push notification is not implemented.
   - Current notifications are Firestore in-app notifications only.

8. No native iOS app yet.
   - Current product is a PWA.
   - For MVP testing, PWA is likely enough.
   - Native iOS can come later if push/install friction becomes the bottleneck.

9. No admin tools.
   - Need ability to clean test data, view games, maybe seed users, and inspect matching state.
   - Admin should eventually configure location settings, including court labels/counts. Blackhawk currently has 10 courts.

10. No analytics events beyond Firebase Analytics initialization.
   - Need product metrics around Ready Now, time to game formation, confirmed games, court assignment, and weekly active users.

## Recommended Next Steps

### 1. Add a small Reset/Test Admin path

For POC speed, create either:

- local script using Firebase Admin SDK, or
- callable admin-only function, or
- temporary CLI snippets

Needed actions:

- Delete test players
- Delete test availability
- Delete test games
- Delete test notifications
- Seed 2-4 fake users and Ready Now records when needed

Do not expose this to normal users.

### 2. Prevent duplicate active games

In `matchReadyNowDoubles`, before adding a player:

- query active games where `playerIds` contains user and `status` is `forming` or `confirmed`
- if already active, either:
  - ignore new availability, or
  - update their existing availability only

Firestore supports `array-contains`, but watch index requirements.

### 3. Real Court Assignment UI

Replace hard-coded Court 4 with:

- simple bottom sheet/modal
- choices like Court 1-10 plus "Other" for Blackhawk
- call `assignGameCourt(gameId, selectedCourt)`

Keep game writes backend-owned.
Later admin should make court options configurable per `locationId` rather than baking court counts into the client.

### 4. Mark Notifications Read

Implement:

- tap bell opens notification list
- tap notification or "mark all read" updates `notifications/{id}.read`

Rules already allow users to update only `read` on their own notifications.

### 5. Wire Later Today and Tomorrow

Implement Firestore writes for:

- `type: "laterToday"`
- `type: "tomorrow"`
- user-selected `startTime`
- user-selected `endTime`

Then expand Cloud Function matching logic to match overlapping windows.

Keep MVP simple:

- if enough overlapping players exist, create game
- no optimization
- no countdowns

### 6. Playmate Persistence and Exclusion

Wire `playmates` collection in UI:

- default all users as eligible
- store disabled records only if simpler
- backend should exclude removed playmates during matching

Be careful with mutual exclusion:

- If A removes B, A should not be matched with B.
- If B has not removed A, still exclude the pair.

### 7. Firebase Messaging / Push Notifications

Only do this after in-app notification flow is stable.

Implementation direction:

- Enable Firebase Cloud Messaging in Firebase console if not already done.
- Add web push certificate / VAPID key.
- Add browser permission prompt at a meaningful moment, not on first load.
- Store FCM token under user doc or `userPushTokens`.
- Cloud Functions send FCM when:
  - game confirmed
  - court assigned
  - player left
  - replacement needed

For iPhone:

- PWA push notifications require the app to be added to Home Screen on modern iOS.
- If App Store native iOS is chosen later, push flow changes to APNs/FCM native.

### 8. Product Metrics

Track:

- Ready Now clicks
- Availability created
- Game forming created
- Game confirmed
- Formation time
- Court assigned
- Weekly active users

Use these to answer the actual MVP question:

> Is this better than WhatsApp coordination?

## Design Direction

The current UI is intentionally iPhone-shaped and inspired by Apple Liquid Glass, but it is still a web/PWA implementation.

Keep:

- mobile-first
- big Home CTA
- calm, polished, Apple-ish surface
- Bottom nav
- Location visible
- Status strip during POC

Avoid:

- making it a marketing landing page
- cluttering Home with too much information
- chat features
- event-management complexity
- ladders/round robins/open play until MVP proves demand

## Development Philosophy

The backend should own decisions. Client should express intent:

- "I am available"
- "Assign this court"
- "I am leaving"

Cloud Functions should handle:

- matching
- locking games
- notification creation
- validation of game changes

This avoids fragile client-side matchmaking and keeps GitHub Pages/Firebase Hosting viable because the "server" is Firebase Functions, not a custom Node server.

## Quick Mental Model

User day-in-the-life:

1. At 8:00 AM, user opens PaddleUp.
2. Taps `I Want to Play`.
3. Chooses `Ready Now` for 60 minutes.
4. App writes availability to Firestore.
5. Cloud Function checks other active Ready Now players at Blackhawk.
6. If fewer than 4 players, a forming doubles game exists and players see "Need X more."
7. When 4 players are available, function confirms the game.
8. Players see in-app notification and eventually push notification.
9. Meet time defaults to 30 minutes after formation.
10. Any player assigns a court.
11. Everyone gets court notification.

## Cursor Starting Prompt

Suggested prompt to give Cursor:

```text
You are taking over a React/TypeScript/Firebase PWA called PaddleUp Matchmaking. Read CURSOR_HANDOFF.md, README.md, src/domain.ts, src/firebaseDb.ts, src/main.tsx, firestore.rules, and functions/src/index.ts first. Preserve the architecture: clients write availability, Cloud Functions own game matching and game mutations, and every record must keep locationId. Do not hard-code Blackhawk outside the single seeded location. Start by implementing the next recommended task from the handoff, preferably duplicate-active-game prevention or a real court assignment picker.
```

