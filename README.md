# PaddleUp Matchmaking

Mobile-first React/TypeScript PWA prototype for availability-based pickleball matchmaking.

## Run

```bash
npm install
npm run dev -- --port 5173
```

Open `http://localhost:5173/`.

## Build

```bash
npm run build
```

The production app is emitted to `dist/`.

## Architecture Notes

- The MVP seeds only one active location: `blackhawk`.
- Users, availability records, and games all reference `locationId` from day one.
- Domain types live in `src/domain.ts`; seeded Firestore-shaped data lives in `src/data.ts`.
- The UI is intentionally centered on the Home CTA: `I Want to Play`.
- The PWA manifest and service worker live in `public/`.

Firebase Authentication, Firestore, Cloud Functions, and FCM can be wired behind the existing domain model without changing the screen structure.
