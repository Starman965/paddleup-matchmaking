# PaddleUp Matchmaking

Mobile-first React/TypeScript PWA prototype for availability-based pickleball matchmaking.

## Run

```bash
npm install
npm run dev -- --port 5173
```

Open `http://localhost:5173/`.

## Live URLs

- Firebase Hosting: https://paddleup-match-maker.web.app
- Admin portal: https://paddleup-match-maker.web.app/admin
- GitHub Pages prototype: https://starman965.github.io/paddleup-matchmaking/

## Build

```bash
npm run build
```

The production app is emitted to `dist/`. Local builds do not bump release metadata.

To prepare a deployable release build with updated `public/version.json` and bundled build metadata:

```bash
npm run build:release
```

## Deploy to Firebase Hosting

```bash
npm run build:release
firebase deploy --only hosting --project paddleup-match-maker
```

## Architecture Notes

- The MVP now supports multiple active locations. Current beta locations include Blackhawk Country Club, Esperanza Resort, and admin-approved user suggestions.
- Users, availability records, games, push subscriptions, and location-scoped views all reference `locationId`.
- New users choose a `homeLocationId` / main play location on first sign-in. They can also choose `Other`; the Profile tab lets them update this later.
- Locations can include court metadata (`courtCount`, `courtLabels`) and an uploaded `imageUrl`.
- The admin portal is guarded by Cloud Functions checks for `demandgendave@gmail.com`. It manages location suggestions, location create/update, location photos, active/inactive state, and basic app metrics.
- Domain types live in `src/domain.ts`; seeded Firestore-shaped data lives in `src/data.ts`.
- The UI is intentionally centered on the Home CTA: `I Want to Play`.
- The PWA manifest and service worker live in `public/`.

Firebase Authentication, Firestore, Cloud Functions, Firebase Hosting, Firebase Storage, and standard Web Push are wired behind the existing domain model.
