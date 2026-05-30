import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore, Timestamp } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

initializeApp();

const db = getFirestore();
const REQUIRED_DOUBLES_PLAYERS = 4;
const DEFAULT_MEET_DELAY_MINUTES = 30;

type Availability = {
  id?: string;
  userId?: string;
  locationId?: string;
  type?: string;
  expiresAt?: string;
};

type Game = {
  id?: string;
  locationId: string;
  type: "doubles";
  status: "forming" | "confirmed";
  requiredPlayers: 4;
  playerIds: string[];
  formedFromAvailabilityIds: string[];
  createdAt?: FirebaseFirestore.FieldValue;
  updatedAt?: FirebaseFirestore.FieldValue;
  meetTime?: string;
  court?: string | null;
};

export const matchReadyNowDoubles = onDocumentWritten("availability/{availabilityId}", async (event) => {
  const availabilityId = event.params.availabilityId;
  const after = event.data?.after;

  if (!after?.exists) return;

  const availability = after.data() as Availability;
  if (availability.type !== "readyNow") return;
  if (!availability.userId || !availability.locationId) {
    logger.warn("Ready Now availability missing userId or locationId", { availabilityId, availability });
    return;
  }

  const now = new Date();
  if (availability.expiresAt && new Date(availability.expiresAt) <= now) {
    logger.info("Ignoring expired Ready Now availability", { availabilityId });
    return;
  }

  const activeReadyNow = await db
    .collection("availability")
    .where("locationId", "==", availability.locationId)
    .where("type", "==", "readyNow")
    .get();

  const activePlayerIds: string[] = [];
  const activeAvailabilityIds: string[] = [];

  for (const doc of activeReadyNow.docs) {
    const data = doc.data() as Availability;
    if (!data.userId || !data.expiresAt) continue;
    if (new Date(data.expiresAt) <= now) continue;
    if (!activePlayerIds.includes(data.userId)) {
      activePlayerIds.push(data.userId);
      activeAvailabilityIds.push(doc.id);
    }
  }

  if (!activePlayerIds.includes(availability.userId)) {
    activePlayerIds.push(availability.userId);
    activeAvailabilityIds.push(availabilityId);
  }

  await db.runTransaction(async (transaction) => {
    const formingQuery = db
      .collection("games")
      .where("locationId", "==", availability.locationId)
      .where("type", "==", "doubles")
      .where("status", "==", "forming")
      .limit(1);

    const formingSnapshot = await transaction.get(formingQuery);
    const gameRef = formingSnapshot.empty ? db.collection("games").doc() : formingSnapshot.docs[0].ref;
    const existing = formingSnapshot.empty ? undefined : (formingSnapshot.docs[0].data() as Game);
    const existingPlayers = existing?.playerIds ?? [];
    const mergedPlayers = unique([...existingPlayers, ...activePlayerIds]).slice(0, REQUIRED_DOUBLES_PLAYERS);
    const status = mergedPlayers.length >= REQUIRED_DOUBLES_PLAYERS ? "confirmed" : "forming";
    const meetTime = status === "confirmed" ? new Date(Date.now() + DEFAULT_MEET_DELAY_MINUTES * 60 * 1000).toISOString() : undefined;

    const game: Game = {
      id: gameRef.id,
      locationId: availability.locationId!,
      type: "doubles",
      status,
      requiredPlayers: REQUIRED_DOUBLES_PLAYERS,
      playerIds: mergedPlayers,
      formedFromAvailabilityIds: unique([...(existing?.formedFromAvailabilityIds ?? []), ...activeAvailabilityIds]),
      court: existing?.court ?? null,
      createdAt: existing?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(meetTime ? { meetTime } : {})
    };

    transaction.set(gameRef, game, { merge: true });

    const notificationType = status === "confirmed" ? "gameConfirmed" : "formingGame";
    const notificationTitle = status === "confirmed" ? "Doubles confirmed" : `Doubles forming: ${mergedPlayers.length}/4`;
    const notificationBody =
      status === "confirmed"
        ? `Meet in ${DEFAULT_MEET_DELAY_MINUTES} minutes. Court TBD.`
        : `Need ${REQUIRED_DOUBLES_PLAYERS - mergedPlayers.length} more at Blackhawk.`;

    for (const playerId of mergedPlayers) {
      const notificationRef = db.collection("notifications").doc(`${gameRef.id}_${notificationType}_${playerId}`);
      transaction.set(
        notificationRef,
        {
          id: notificationRef.id,
          userId: playerId,
          gameId: gameRef.id,
          type: notificationType,
          title: notificationTitle,
          body: notificationBody,
          read: false,
          createdAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }

    logger.info("Ready Now doubles match updated", {
      gameId: gameRef.id,
      status,
      playerCount: mergedPlayers.length,
      locationId: availability.locationId
    });
  });
});

export const assignCourt = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before assigning a court.");
  }

  const gameId = typeof request.data?.gameId === "string" ? request.data.gameId : "";
  const court = typeof request.data?.court === "string" ? request.data.court.trim() : "";

  if (!gameId) {
    throw new HttpsError("invalid-argument", "Missing game ID.");
  }

  if (!court || court.length > 40) {
    throw new HttpsError("invalid-argument", "Court must be 1 to 40 characters.");
  }

  const gameRef = db.collection("games").doc(gameId);

  await db.runTransaction(async (transaction) => {
    const gameSnapshot = await transaction.get(gameRef);
    if (!gameSnapshot.exists) {
      throw new HttpsError("not-found", "Game not found.");
    }

    const game = gameSnapshot.data() as Game;
    if (!game.playerIds.includes(uid)) {
      throw new HttpsError("permission-denied", "Only players in this game can assign a court.");
    }

    transaction.update(gameRef, {
      court,
      updatedAt: FieldValue.serverTimestamp()
    });

    for (const playerId of game.playerIds) {
      const notificationRef = db.collection("notifications").doc(`${gameRef.id}_courtAssigned_${playerId}`);
      transaction.set(
        notificationRef,
        {
          id: notificationRef.id,
          userId: playerId,
          gameId: gameRef.id,
          type: "courtAssigned",
          title: "Court assigned",
          body: court,
          read: false,
          createdAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  logger.info("Court assigned", { gameId, court, assignedBy: uid });
  return { gameId, court };
});

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
