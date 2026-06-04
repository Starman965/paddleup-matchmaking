import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { defineSecret } from "firebase-functions/params";
import { onDocumentCreated, onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import webpush from "web-push";

initializeApp();

const db = getFirestore();
const REQUIRED_DOUBLES_PLAYERS = 4;
const DEFAULT_MEET_DELAY_MINUTES = 30;
const MATCH_LEAD_TIME_MINUTES = 30;
const MINIMUM_MATCH_OVERLAP_MINUTES = 30;
const GAME_CLOSE_GRACE_MINUTES = 15;
const ADMIN_EMAILS = new Set(["demandgendave@gmail.com"]);
const WEB_PUSH_VAPID_PUBLIC_KEY = "BHvIGy1DWxNdPSQ7UST5NUvjRgfEjdO93lyUkqtED9h8QxKXopr_5zwchGFg2FdSTjypgSUXuYDFt13c4sew6JQ";
const WEB_PUSH_CONTACT = "mailto:demandgendave@gmail.com";
const webPushVapidPrivateKey = defineSecret("WEB_PUSH_VAPID_PRIVATE_KEY");

type Availability = {
  id?: string;
  userId?: string;
  locationId?: string;
  type?: string;
  startTime?: string;
  endTime?: string;
  expiresAt?: string;
};

type Playmate = {
  userId?: string;
  playmateId?: string;
  enabled?: boolean;
};

type Game = {
  id?: string;
  locationId: string;
  type: "doubles";
  availabilityType?: "readyNow" | "laterToday" | "tomorrow";
  status: "forming" | "confirmed" | "completed";
  requiredPlayers: 4;
  playerIds: string[];
  createdBy?: string;
  formedFromAvailabilityIds: string[];
  createdAt?: FirebaseFirestore.FieldValue;
  updatedAt?: FirebaseFirestore.FieldValue;
  meetTime?: string;
  startsAt?: string;
  endsAt?: string;
  court?: string | null;
};

type AvailabilityCandidate = {
  userId: string;
  availabilityId: string;
  start: Date;
  end: Date;
};

type MatchSelection = {
  playerIds: string[];
  availabilityIds: string[];
  overlapStart: Date;
  overlapEnd: Date;
};

type WindowRange = {
  start: Date;
  end: Date;
};

type WebPushSubscription = {
  id?: string;
  userId?: string;
  locationId?: string;
  endpoint?: string;
  keys?: {
    p256dh?: string;
    auth?: string;
  };
  enabled?: boolean;
};

type UserProfile = {
  uid?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  locationId?: string;
  homeLocationId?: string;
  presence?: "visible" | "offline";
  lastSeenBuild?: string;
  lastSeenVersion?: string;
  lastSeenCommit?: string;
  lastSeenAt?: unknown;
  lastSeenPlatform?: string;
  lastSeenBrowser?: string;
  lastSeenStandalone?: boolean;
  lastSeenNotificationPermission?: string;
};

type AppNotification = {
  id?: string;
  userId?: string;
  gameId?: string;
  type?: "matchPosted" | "playerJoined" | "formingGame" | "gameConfirmed" | "courtAssigned" | "playerLeft" | "testPush";
  title?: string;
  body?: string;
};

type AdminLocationInput = {
  id?: unknown;
  name?: unknown;
  city?: unknown;
  state?: unknown;
  country?: unknown;
  type?: unknown;
  imageUrl?: unknown;
  courtCount?: unknown;
  courtLabels?: unknown;
  active?: unknown;
};

export const sendPushForNotification = onDocumentCreated(
  { document: "notifications/{notificationId}", secrets: [webPushVapidPrivateKey] },
  async (event) => {
  const notification = event.data?.data() as AppNotification | undefined;
  if (!notification?.userId || !notification.title || !notification.body || !shouldSendPush(notification)) return;

  await sendPushToUser(notification.userId, {
    title: notification.title,
    body: notification.body,
    gameId: notification.gameId,
    notificationId: event.params.notificationId,
    type: notification.type
  });
  }
);

export const matchReadyNowDoubles = onDocumentWritten("availability/{availabilityId}", async (event) => {
  const availabilityId = event.params.availabilityId;
  const after = event.data?.after;

  if (!after?.exists) return;

  const availability = after.data() as Availability;
  if (!isMatchableAvailabilityType(availability.type)) return;
  const availabilityType = availability.type;
  if (!availability.userId || !availability.locationId) {
    logger.warn("Availability missing userId or locationId", { availabilityId, availability });
    return;
  }
  const locationId = availability.locationId;

  const now = new Date();
  const latestMatchDeadline = new Date(now.getTime() + MATCH_LEAD_TIME_MINUTES * 60 * 1000);
  const minimumWindowEnd = availabilityType === "readyNow" ? now : latestMatchDeadline;
  const triggerWindow = availabilityWindow(availability);
  if (!triggerWindow || triggerWindow.end <= minimumWindowEnd) {
    logger.info("Ignoring expired, invalid, or too-tight availability", {
      availabilityId,
      availabilityType,
      matchLeadTimeMinutes: MATCH_LEAD_TIME_MINUTES
    });
    return;
  }

  const activeAvailabilitySnapshot = await db
    .collection("availability")
    .where("locationId", "==", locationId)
    .where("type", "==", availabilityType)
    .get();

  const candidates: AvailabilityCandidate[] = [];

  for (const doc of activeAvailabilitySnapshot.docs) {
    const data = doc.data() as Availability;
    const window = availabilityWindow(data);
    if (!data.userId || !window || window.end <= minimumWindowEnd) continue;
    if (!candidates.some((candidate) => candidate.userId === data.userId)) {
      candidates.push({ userId: data.userId, availabilityId: doc.id, ...window });
    }
  }

  const disabledPlaymateSnapshot = await db.collection("playmates").where("enabled", "==", false).get();
  const disabledPairs = disabledPlaymateSnapshot.docs
    .map((doc) => doc.data() as Playmate)
    .filter((playmate) => playmate.userId && playmate.playmateId)
    .map((playmate) => pairKey(playmate.userId!, playmate.playmateId!));

  await db.runTransaction(async (transaction) => {
    const formingQuery = db
      .collection("games")
      .where("locationId", "==", locationId)
      .where("type", "==", "doubles")
      .where("status", "==", "forming");
    const confirmedQuery = db
      .collection("games")
      .where("locationId", "==", locationId)
      .where("type", "==", "doubles")
      .where("status", "==", "confirmed");
    const locationRef = db.collection("locations").doc(locationId);

    const formingSnapshot = await transaction.get(formingQuery);
    const confirmedSnapshot = await transaction.get(confirmedQuery);
    const usersSnapshot = await transaction.get(db.collection("users").where("locationId", "==", locationId));
    const locationSnapshot = await transaction.get(locationRef);
    const locationName = readAdminString(locationSnapshot.data()?.name, "your location");
    const formingDoc = formingSnapshot.docs.find((doc) => {
      const game = doc.data() as Partial<Game>;
      const gameRange = gameWindow(game);
      return (
        (game.availabilityType === availabilityType || (!game.availabilityType && availabilityType === "readyNow")) &&
        Boolean(gameRange && hasMinimumOverlap(triggerWindow, gameRange, MINIMUM_MATCH_OVERLAP_MINUTES))
      );
    });
    const gameRef = formingDoc ? formingDoc.ref : db.collection("games").doc();
    const existing = formingDoc ? (formingDoc.data() as Game) : undefined;
    const existingPlayers = existing?.playerIds ?? [];
    const isNewGame = !formingDoc;
    const existingWindow = existing ? gameWindow(existing) : undefined;
    const activeGameConflicts = new Map<string, WindowRange[]>();

    for (const gameDoc of [...formingSnapshot.docs, ...confirmedSnapshot.docs]) {
      if (gameDoc.id === gameRef.id) continue;
      const game = gameDoc.data() as Partial<Game>;
      const gameRange = gameWindow(game);
      if (!gameRange) continue;
      for (const playerId of game.playerIds ?? []) {
        const conflicts = activeGameConflicts.get(playerId) ?? [];
        conflicts.push(gameRange);
        activeGameConflicts.set(playerId, conflicts);
      }
    }

    const selectionCandidates = [...candidates];
    if (existingWindow) {
      for (const playerId of existingPlayers) {
        selectionCandidates.push({
          userId: playerId,
          availabilityId: `${gameRef.id}_${playerId}_directJoin`,
          ...existingWindow
        });
      }
    }

    const matchWindow = existingWindow ?? triggerWindow;
    const selection = selectAvailabilityGroup(selectionCandidates, existingPlayers, activeGameConflicts, disabledPairs, matchWindow);
    const candidatePlayerIds = unique([...existingPlayers, ...candidates.map((candidate) => candidate.userId)]);
    const skippedPlayerIds = candidates
      .filter((candidate) => hasOverlappingGame(candidate, activeGameConflicts))
      .map((candidate) => candidate.userId);

    if (!selection || selection.playerIds.length === 0) {
      logger.info("No eligible players for doubles match update", {
        availabilityId,
        availabilityType,
        skippedPlayerIds,
        locationId
      });
      return;
    }

    const incompatiblePlayerIds = candidatePlayerIds.filter(
      (playerId) =>
        !selection.playerIds.includes(playerId) &&
        selection.playerIds.some((selectedPlayerId) => disabledPairs.includes(pairKey(playerId, selectedPlayerId)))
    );

    const status = selection.playerIds.length >= REQUIRED_DOUBLES_PLAYERS ? "confirmed" : "forming";
    const meetTime =
      status === "confirmed"
        ? availabilityType === "readyNow"
          ? readyNowMeetTime(matchWindow.end)
          : matchWindow.start.toISOString()
        : undefined;
    const startsAt = meetTime ?? matchWindow.start.toISOString();
    const endsAt = matchWindow.end.toISOString();

    const game: Game = {
      id: gameRef.id,
      locationId,
      type: "doubles",
      availabilityType,
      status,
      requiredPlayers: REQUIRED_DOUBLES_PLAYERS,
      playerIds: selection.playerIds,
      createdBy: existing?.createdBy ?? selection.playerIds[0],
      formedFromAvailabilityIds: unique([...(existing?.formedFromAvailabilityIds ?? []), ...selection.availabilityIds]),
      court: existing?.court ?? null,
      createdAt: existing?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      startsAt,
      endsAt,
      ...(meetTime ? { meetTime } : {})
    };

    transaction.set(gameRef, game, { merge: true });

    const notificationType = status === "confirmed" ? "gameConfirmed" : "formingGame";
    const notificationTitle = status === "confirmed" ? "Doubles confirmed" : `Doubles forming: ${selection.playerIds.length}/4`;
    const notificationBody =
      status === "confirmed"
        ? `${availabilityLabel(availabilityType)} match confirmed. Court TBD.`
        : `Need ${REQUIRED_DOUBLES_PLAYERS - selection.playerIds.length} more at ${locationName}.`;

    for (const playerId of selection.playerIds) {
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

    if (isNewGame && status === "forming" && selection.playerIds.length === 1) {
      const creatorId = selection.playerIds[0];
      const matchPostedRef = db.collection("notifications").doc(`${gameRef.id}_matchPosted_${creatorId}`);
      transaction.set(
        matchPostedRef,
        {
          id: matchPostedRef.id,
          userId: creatorId,
          gameId: gameRef.id,
          type: "matchPosted",
          title: "Your match is posted",
          body: "We will alert you when players join.",
          read: false,
          createdAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );

      const usersById = new Map(
        usersSnapshot.docs.map((doc) => {
          const user = doc.data() as UserProfile;
          return [user.uid ?? doc.id, user];
        })
      );
      const activePlayerIds = new Set(
        [...formingSnapshot.docs, ...confirmedSnapshot.docs].flatMap((doc) => {
          if (doc.id === gameRef.id) return [];
          return ((doc.data() as Partial<Game>).playerIds ?? []);
        })
      );
      for (const [userId, user] of usersById) {
        const removedPlaymate = disabledPairs.includes(pairKey(userId, creatorId));
        if (!user || user.presence === "offline" || userId === creatorId || activePlayerIds.has(userId) || removedPlaymate) continue;
        const notificationRef = db.collection("notifications").doc(`${gameRef.id}_matchPosted_beta_${userId}`);
        transaction.set(
          notificationRef,
          {
            id: notificationRef.id,
            userId,
            gameId: gameRef.id,
            type: "matchPosted",
            title: "New doubles game posted",
            body: `A player is looking for a doubles game at ${locationName}.`,
            read: false,
            createdAt: FieldValue.serverTimestamp()
          },
          { merge: true }
        );
      }
    }

    logger.info("Doubles match updated", {
      gameId: gameRef.id,
      availabilityType,
      status,
      playerCount: selection.playerIds.length,
      skippedPlayerIds,
      incompatiblePlayerIds,
      locationId
    });
  });
});

export const closeExpiredGames = onSchedule("every 5 minutes", async () => {
  const closeBefore = new Date(Date.now() - GAME_CLOSE_GRACE_MINUTES * 60 * 1000);
  const snapshots = await Promise.all([
    db.collection("games").where("status", "==", "forming").get(),
    db.collection("games").where("status", "==", "confirmed").get()
  ]);
  const expiredDocs = snapshots
    .flatMap((snapshot) => snapshot.docs)
    .filter((doc) => {
      const window = gameWindow(doc.data() as Partial<Game>);
      return Boolean(window && window.end <= closeBefore);
    });

  for (let index = 0; index < expiredDocs.length; index += 450) {
    const batch = db.batch();
    expiredDocs.slice(index, index + 450).forEach((doc) => {
      batch.update(doc.ref, {
        status: "completed",
        completedAt: FieldValue.serverTimestamp(),
        closedReason: "expired",
        updatedAt: FieldValue.serverTimestamp()
      });
    });
    await batch.commit();
  }

  if (expiredDocs.length > 0) {
    logger.info("Closed expired games", {
      count: expiredDocs.length,
      closeBefore: closeBefore.toISOString()
    });
  }
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

export const joinGame = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before joining a match.");
  }

  const gameId = typeof request.data?.gameId === "string" ? request.data.gameId : "";
  if (!gameId) {
    throw new HttpsError("invalid-argument", "Missing game ID.");
  }

  const gameRef = db.collection("games").doc(gameId);
  const disabledPlaymateSnapshot = await db.collection("playmates").where("enabled", "==", false).get();
  const disabledPairs = disabledPlaymateSnapshot.docs
    .map((doc) => doc.data() as Playmate)
    .filter((playmate) => playmate.userId && playmate.playmateId)
    .map((playmate) => pairKey(playmate.userId!, playmate.playmateId!));

  await db.runTransaction(async (transaction) => {
    const gameSnapshot = await transaction.get(gameRef);
    if (!gameSnapshot.exists) {
      throw new HttpsError("not-found", "Match not found.");
    }

    const game = gameSnapshot.data() as Game;
    if (game.status !== "forming") {
      throw new HttpsError("failed-precondition", "Only forming matches can be joined.");
    }

    if (game.playerIds.includes(uid)) {
      return;
    }

    if (game.playerIds.length >= game.requiredPlayers) {
      throw new HttpsError("failed-precondition", "This match is already full.");
    }

    const targetWindow = gameWindow(game);
    if (!targetWindow) {
      throw new HttpsError("failed-precondition", "This match does not have a valid play window.");
    }

    const incompatiblePlayerId = game.playerIds.find((playerId) => disabledPairs.includes(pairKey(uid, playerId)));
    if (incompatiblePlayerId) {
      throw new HttpsError("failed-precondition", "This match includes a removed playmate.");
    }

    const formingQuery = db
      .collection("games")
      .where("locationId", "==", game.locationId)
      .where("status", "==", "forming");
    const confirmedQuery = db
      .collection("games")
      .where("locationId", "==", game.locationId)
      .where("status", "==", "confirmed");
    const locationRef = db.collection("locations").doc(game.locationId);
    const [formingSnapshot, confirmedSnapshot, locationSnapshot] = await Promise.all([
      transaction.get(formingQuery),
      transaction.get(confirmedQuery),
      transaction.get(locationRef)
    ]);
    const locationName = readAdminString(locationSnapshot.data()?.name, "your location");

    const overlappingGame = [...formingSnapshot.docs, ...confirmedSnapshot.docs].find((doc) => {
      if (doc.id === gameRef.id) return false;
      const activeGame = doc.data() as Partial<Game>;
      if (!(activeGame.playerIds ?? []).includes(uid)) return false;
      const activeWindow = gameWindow(activeGame);
      return Boolean(activeWindow && windowsOverlap(targetWindow, activeWindow));
    });

    if (overlappingGame) {
      throw new HttpsError("failed-precondition", "You are already in a match during this time window.");
    }

    const playerIds = unique([...game.playerIds, uid]);
    const status = playerIds.length >= game.requiredPlayers ? "confirmed" : "forming";
    const meetTime =
      status === "confirmed"
        ? game.availabilityType === "readyNow"
          ? readyNowMeetTime(targetWindow.end)
          : game.startsAt
        : game.meetTime;
    const startsAt = status === "confirmed" && meetTime ? meetTime : game.startsAt;

    transaction.update(gameRef, {
      playerIds,
      status,
      startsAt,
      ...(meetTime ? { meetTime } : {}),
      updatedAt: FieldValue.serverTimestamp()
    });

    const notificationType = status === "confirmed" ? "gameConfirmed" : "formingGame";
    const notificationTitle = status === "confirmed" ? "Doubles confirmed" : `Doubles forming: ${playerIds.length}/4`;
    const notificationBody =
      status === "confirmed"
        ? `${availabilityLabel(game.availabilityType ?? "readyNow")} match confirmed. Court TBD.`
        : `Need ${game.requiredPlayers - playerIds.length} more at ${locationName}.`;

    for (const playerId of playerIds) {
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

    const creatorId = game.createdBy ?? game.playerIds[0];
    if (status === "forming" && creatorId && creatorId !== uid && game.playerIds.includes(creatorId)) {
      const notificationRef = db.collection("notifications").doc(`${gameRef.id}_playerJoined_${creatorId}_${uid}`);
      transaction.set(
        notificationRef,
        {
          id: notificationRef.id,
          userId: creatorId,
          gameId: gameRef.id,
          type: "playerJoined",
          title: "Player joined your match",
          body: `You now have ${playerIds.length}/${game.requiredPlayers} players.`,
          read: false,
          createdAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  logger.info("Player joined game", { gameId, userId: uid });
  return { gameId };
});

export const updateGameStartTime = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before updating the start time.");
  }

  const gameId = typeof request.data?.gameId === "string" ? request.data.gameId : "";
  const startsAt = typeof request.data?.startsAt === "string" ? request.data.startsAt : "";
  const startsAtDate = new Date(startsAt);

  if (!gameId) {
    throw new HttpsError("invalid-argument", "Missing game ID.");
  }

  if (!startsAt || Number.isNaN(startsAtDate.getTime())) {
    throw new HttpsError("invalid-argument", "Start time must be a valid date.");
  }

  if (startsAtDate <= new Date()) {
    throw new HttpsError("invalid-argument", "Start time must be in the future.");
  }

  if (startsAtDate.getMinutes() % 15 !== 0 || startsAtDate.getSeconds() !== 0 || startsAtDate.getMilliseconds() !== 0) {
    throw new HttpsError("invalid-argument", "Start time must be in 15 minute increments.");
  }

  const gameRef = db.collection("games").doc(gameId);

  await db.runTransaction(async (transaction) => {
    const gameSnapshot = await transaction.get(gameRef);
    if (!gameSnapshot.exists) {
      throw new HttpsError("not-found", "Game not found.");
    }

    const game = gameSnapshot.data() as Game;
    if (!game.playerIds.includes(uid)) {
      throw new HttpsError("permission-denied", "Only players in this game can update the start time.");
    }

    if (game.status !== "confirmed") {
      throw new HttpsError("failed-precondition", "Only confirmed games can have a start time override.");
    }

    transaction.update(gameRef, {
      startsAt: startsAtDate.toISOString(),
      meetTime: startsAtDate.toISOString(),
      updatedAt: FieldValue.serverTimestamp()
    });
  });

  logger.info("Game start time updated", { gameId, startsAt: startsAtDate.toISOString(), updatedBy: uid });
  return { gameId, startsAt: startsAtDate.toISOString() };
});

export const leaveGame = onCall(async (request) => {
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before leaving a game.");
  }

  const gameId = typeof request.data?.gameId === "string" ? request.data.gameId : "";
  if (!gameId) {
    throw new HttpsError("invalid-argument", "Missing game ID.");
  }

  const gameRef = db.collection("games").doc(gameId);
  await db.runTransaction(async (transaction) => {
    const gameSnapshot = await transaction.get(gameRef);
    if (!gameSnapshot.exists) {
      throw new HttpsError("not-found", "Game not found.");
    }

    const game = gameSnapshot.data() as Game;
    if (!game.playerIds.includes(uid)) {
      throw new HttpsError("permission-denied", "Only players in this game can leave it.");
    }

    if (game.status === "completed") {
      throw new HttpsError("failed-precondition", "Completed games cannot be changed.");
    }

    const remainingPlayerIds = game.playerIds.filter((playerId) => playerId !== uid);
    const status = remainingPlayerIds.length >= REQUIRED_DOUBLES_PLAYERS ? "confirmed" : "forming";
    const availabilityRefs = availabilityRefsForLeavingPlayer(game, uid);

    availabilityRefs.forEach((availabilityRef) => transaction.delete(availabilityRef));

    if (remainingPlayerIds.length === 0) {
      transaction.delete(gameRef);
      return;
    }

    transaction.update(gameRef, {
      playerIds: remainingPlayerIds,
      status,
      court: status === "confirmed" ? game.court ?? null : null,
      updatedAt: FieldValue.serverTimestamp()
    });

    for (const playerId of remainingPlayerIds) {
      const notificationRef = db.collection("notifications").doc(`${gameRef.id}_playerLeft_${playerId}_${uid}`);
      transaction.set(
        notificationRef,
        {
          id: notificationRef.id,
          userId: playerId,
          gameId: gameRef.id,
          type: "playerLeft",
          title: "Player left the game",
          body: "A player can no longer make it. PaddleUp is looking for a replacement.",
          read: false,
          createdAt: FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    }
  });

  logger.info("Player left game", { gameId, userId: uid });
  return { gameId };
});

export const resetTestData = onCall(async (request) => {
  assertAdmin(request.auth?.token.email);

  const deleteRefs = new Map<string, FirebaseFirestore.DocumentReference>();
  const addDelete = (ref: FirebaseFirestore.DocumentReference) => deleteRefs.set(ref.path, ref);
  const [gamesSnapshot, availabilitySnapshot, notificationsSnapshot] = await Promise.all([
    db.collection("games").get(),
    db.collection("availability").get(),
    db.collection("notifications").get()
  ]);

  gamesSnapshot.docs.forEach((doc) => addDelete(doc.ref));
  availabilitySnapshot.docs.forEach((doc) => addDelete(doc.ref));
  notificationsSnapshot.docs.forEach((doc) => addDelete(doc.ref));

  const deletes = [...deleteRefs.values()];
  await deleteInBatches(deletes);
  logger.info("Admin reset beta activity", {
    count: deletes.length,
    games: gamesSnapshot.size,
    availability: availabilitySnapshot.size,
    notifications: notificationsSnapshot.size,
    preserved: ["users", "locations", "locationSuggestions", "pushSubscriptions", "storage"],
    admin: request.auth?.token.email
  });
  return {
    deletedCount: deletes.length,
    games: gamesSnapshot.size,
    availability: availabilitySnapshot.size,
    notifications: notificationsSnapshot.size
  };
});

export const sendTestPushToMe = onCall({ secrets: [webPushVapidPrivateKey] }, async (request) => {
  assertAdmin(request.auth?.token.email);
  const uid = request.auth?.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before sending a test push.");
  }

  const notificationId = `testPush_${uid}_${Date.now()}`;
  const result = await sendPushToUser(uid, {
    title: "PaddleUp test alert",
    body: "Your PaddleUp match alerts are working.",
    notificationId,
    type: "testPush"
  });

  logger.info("Admin sent test push", {
    admin: request.auth?.token.email,
    uid,
    notificationId,
    ...result
  });
  return result;
});

export const updateLocationCourts = onCall(async (request) => {
  assertAdmin(request.auth?.token.email);

  const locationId = typeof request.data?.locationId === "string" ? request.data.locationId.trim() : "";
  const rawCourtLabels: unknown[] = Array.isArray(request.data?.courtLabels) ? request.data.courtLabels : [];
  const courtLabels = rawCourtLabels
        .filter((court): court is string => typeof court === "string")
        .map((court) => court.trim())
        .filter(Boolean);

  if (!locationId) {
    throw new HttpsError("invalid-argument", "Missing location ID.");
  }

  if (courtLabels.length === 0 || courtLabels.length > 40) {
    throw new HttpsError("invalid-argument", "Provide 1 to 40 court labels.");
  }

  await db.collection("locations").doc(locationId).set(
    {
      courtLabels,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  logger.info("Admin updated location courts", { locationId, courtCount: courtLabels.length, admin: request.auth?.token.email });
  return { locationId, courtLabels };
});

export const getAdminDashboard = onCall(async (request) => {
  assertAdmin(request.auth?.token.email);

  const [usersSnapshot, gamesSnapshot, locationsSnapshot, suggestionsSnapshot, pushSubscriptionsSnapshot] = await Promise.all([
    db.collection("users").get(),
    db.collection("games").get(),
    db.collection("locations").get(),
    db.collection("locationSuggestions").where("status", "==", "pending").get(),
    db.collection("pushSubscriptions").where("enabled", "==", true).get()
  ]);

  const games = gamesSnapshot.docs.map((doc) => doc.data() as Partial<Game>);
  const enabledPushByUser = new Map<string, { total: number; standalone: number }>();
  pushSubscriptionsSnapshot.docs.forEach((doc) => {
    const subscription = doc.data() as WebPushSubscription & { standalone?: boolean };
    if (!subscription.userId) return;
    const current = enabledPushByUser.get(subscription.userId) ?? { total: 0, standalone: 0 };
    current.total += 1;
    if (subscription.standalone === true) current.standalone += 1;
    enabledPushByUser.set(subscription.userId, current);
  });

  return {
    users: usersSnapshot.size,
    games: gamesSnapshot.size,
    formingGames: games.filter((game) => game.status === "forming").length,
    confirmedGames: games.filter((game) => game.status === "confirmed").length,
    completedGames: games.filter((game) => game.status === "completed").length,
    locations: locationsSnapshot.size,
    pendingLocationSuggestions: suggestionsSnapshot.size,
    locationRows: locationsSnapshot.docs.map((doc) => serializeLocation(doc.id, doc.data())),
    userRows: usersSnapshot.docs
      .map((doc) => {
        const user = doc.data() as UserProfile;
        const uid = user.uid ?? doc.id;
        const push = enabledPushByUser.get(uid) ?? { total: 0, standalone: 0 };
        const name = [readAdminString(user.firstName), readAdminString(user.lastName)].filter(Boolean).join(" ") || "Player";
        return {
          uid,
          name,
          email: readAdminString(user.email),
          locationId: readAdminString(user.locationId),
          homeLocationId: readAdminString(user.homeLocationId),
          presence: user.presence === "offline" ? "offline" : "visible",
          lastSeenBuild: readAdminString(user.lastSeenBuild),
          lastSeenVersion: readAdminString(user.lastSeenVersion),
          lastSeenCommit: readAdminString(user.lastSeenCommit),
          lastSeenAt: serializeTimestamp(user.lastSeenAt),
          lastSeenPlatform: readAdminString(user.lastSeenPlatform),
          lastSeenBrowser: readAdminString(user.lastSeenBrowser),
          lastSeenStandalone: user.lastSeenStandalone === true,
          lastSeenNotificationPermission: readAdminString(user.lastSeenNotificationPermission),
          enabledPushSubscriptions: push.total,
          hasEnabledPush: push.total > 0,
          hasStandalonePush: push.standalone > 0
        };
      })
      .sort((userA, userB) => (userB.lastSeenAt || "").localeCompare(userA.lastSeenAt || ""))
  };
});

export const listLocationSuggestions = onCall(async (request) => {
  assertAdmin(request.auth?.token.email);

  const snapshot = await db.collection("locationSuggestions").where("status", "==", "pending").get();
  return {
    suggestions: snapshot.docs.map((doc) => serializeSuggestion(doc.id, doc.data()))
  };
});

export const approveLocationSuggestion = onCall(async (request) => {
  const adminEmail = request.auth?.token.email;
  assertAdmin(adminEmail);

  const suggestionId = typeof request.data?.suggestionId === "string" ? request.data.suggestionId.trim() : "";
  if (!suggestionId) throw new HttpsError("invalid-argument", "Missing suggestion ID.");

  const input = normalizeLocationInput(request.data?.location ?? {});
  const locationId = input.id || slugifyLocationId(input.name, input.city);
  const suggestionRef = db.collection("locationSuggestions").doc(suggestionId);
  const locationRef = db.collection("locations").doc(locationId);

  await db.runTransaction(async (transaction) => {
    const suggestionSnapshot = await transaction.get(suggestionRef);
    if (!suggestionSnapshot.exists) throw new HttpsError("not-found", "Suggestion not found.");

    transaction.set(locationRef, { ...input, id: locationId, active: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    transaction.set(
      suggestionRef,
      {
        status: "approved",
        locationId,
        approvedAt: FieldValue.serverTimestamp(),
        approvedBy: adminEmail,
        updatedAt: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  logger.info("Admin approved location suggestion", { suggestionId, locationId, admin: adminEmail });
  return { suggestionId, locationId };
});

export const rejectLocationSuggestion = onCall(async (request) => {
  const adminEmail = request.auth?.token.email;
  assertAdmin(adminEmail);

  const suggestionId = typeof request.data?.suggestionId === "string" ? request.data.suggestionId.trim() : "";
  if (!suggestionId) throw new HttpsError("invalid-argument", "Missing suggestion ID.");

  await db.collection("locationSuggestions").doc(suggestionId).set(
    {
      status: "rejected",
      rejectedAt: FieldValue.serverTimestamp(),
      rejectedBy: adminEmail,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  logger.info("Admin rejected location suggestion", { suggestionId, admin: adminEmail });
  return { suggestionId };
});

export const upsertLocation = onCall(async (request) => {
  const adminEmail = request.auth?.token.email;
  assertAdmin(adminEmail);

  const input = normalizeLocationInput(request.data?.location ?? {});
  const locationId = input.id || slugifyLocationId(input.name, input.city);

  await db.collection("locations").doc(locationId).set(
    {
      ...input,
      id: locationId,
      active: input.active !== false,
      updatedAt: FieldValue.serverTimestamp()
    },
    { merge: true }
  );

  logger.info("Admin upserted location", { locationId, admin: adminEmail });
  return { locationId };
});

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function readAdminString(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function readAdminStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function readAdminNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function slugifyLocationId(name: string, city: string) {
  const slug = `${name}-${city}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  if (!slug) throw new HttpsError("invalid-argument", "Location needs a valid name.");
  return slug;
}

function normalizeLocationInput(raw: AdminLocationInput) {
  const name = readAdminString(raw.name);
  const city = readAdminString(raw.city);
  const state = readAdminString(raw.state);
  const country = readAdminString(raw.country, "USA");
  const type = readAdminString(raw.type, "club");
  const imageUrl = readAdminString(raw.imageUrl);
  const courtLabels = readAdminStringArray(raw.courtLabels);
  const courtCount = readAdminNumber(raw.courtCount, courtLabels.length);

  if (!name || !city) throw new HttpsError("invalid-argument", "Location name and city are required.");
  if (!["club", "publicCourt", "resort", "destination"].includes(type)) {
    throw new HttpsError("invalid-argument", "Invalid location type.");
  }

  return {
    id: readAdminString(raw.id),
    name,
    city,
    state,
    country,
    type,
    imageUrl,
    courtCount,
    courtLabels: courtLabels.length ? courtLabels : Array.from({ length: Math.max(0, Math.min(courtCount, 40)) }, (_, index) => `Court ${index + 1}`),
    active: raw.active !== false
  };
}

function serializeTimestamp(value: unknown) {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return typeof value === "string" ? value : "";
}

function serializeLocation(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    id: readAdminString(data.id, id),
    name: readAdminString(data.name),
    city: readAdminString(data.city),
    state: readAdminString(data.state),
    country: readAdminString(data.country),
    type: readAdminString(data.type, "club"),
    imageUrl: readAdminString(data.imageUrl),
    courtCount: readAdminNumber(data.courtCount, readAdminStringArray(data.courtLabels).length),
    courtLabels: readAdminStringArray(data.courtLabels),
    active: data.active !== false
  };
}

function serializeSuggestion(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    id: readAdminString(data.id, id),
    userId: readAdminString(data.userId),
    name: readAdminString(data.name),
    city: readAdminString(data.city),
    state: readAdminString(data.state),
    country: readAdminString(data.country),
    courtCount: readAdminNumber(data.courtCount, 0),
    status: readAdminString(data.status, "pending"),
    createdAt: serializeTimestamp(data.createdAt)
  };
}

function isMatchableAvailabilityType(value: unknown): value is "readyNow" | "laterToday" | "tomorrow" {
  return value === "readyNow" || value === "laterToday" || value === "tomorrow";
}

function availabilityWindow(availability: Availability) {
  const start = availability.startTime ? new Date(availability.startTime) : undefined;
  const endValue = availability.endTime || availability.expiresAt;
  const end = endValue ? new Date(endValue) : undefined;

  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
    return undefined;
  }

  return { start, end };
}

function availabilityLabel(type: string) {
  if (type === "laterToday") return "Later Today";
  if (type === "tomorrow") return "Tomorrow";
  return "Ready Now";
}

function readyNowMeetTime(latestStart: Date) {
  const defaultMeetTime = new Date(Date.now() + DEFAULT_MEET_DELAY_MINUTES * 60 * 1000);
  return (defaultMeetTime < latestStart ? defaultMeetTime : latestStart).toISOString();
}

function availabilityRefsForLeavingPlayer(game: Game, userId: string) {
  const userAvailabilityIds = new Set(["readyNow", "laterToday", "tomorrow"].map((type) => `${userId}_${type}`));
  return unique(game.formedFromAvailabilityIds ?? [])
    .filter((availabilityId) => userAvailabilityIds.has(availabilityId))
    .map((availabilityId) => db.collection("availability").doc(availabilityId));
}

function pairKey(userA: string, userB: string) {
  return [userA, userB].sort().join("__");
}

function selectAvailabilityGroup(
  candidates: AvailabilityCandidate[],
  existingPlayerIds: string[],
  activeGameConflicts: Map<string, WindowRange[]>,
  disabledPairs: string[],
  matchWindow: WindowRange
): MatchSelection | undefined {
  const candidateByUserId = new Map(candidates.map((candidate) => [candidate.userId, candidate]));
  const orderedPlayerIds = unique([...existingPlayerIds, ...candidates.map((candidate) => candidate.userId)]).filter(
    (playerId) => {
      const candidate = candidateByUserId.get(playerId);
      return Boolean(
        candidate &&
        !hasOverlappingGame(candidate, activeGameConflicts) &&
        hasMinimumOverlap(candidate, matchWindow, MINIMUM_MATCH_OVERLAP_MINUTES)
      );
    }
  );
  const selectedCandidates: AvailabilityCandidate[] = [];

  for (const playerId of orderedPlayerIds) {
    const candidate = candidateByUserId.get(playerId);
    if (!candidate) continue;

    const compatible = selectedCandidates.every((selected) => !disabledPairs.includes(pairKey(candidate.userId, selected.userId)));
    if (!compatible) continue;

    selectedCandidates.push(candidate);

    if (selectedCandidates.length >= REQUIRED_DOUBLES_PLAYERS) break;
  }

  if (selectedCandidates.length === 0) return undefined;

  return {
    playerIds: selectedCandidates.map((candidate) => candidate.userId),
    availabilityIds: selectedCandidates.map((candidate) => candidate.availabilityId),
    overlapStart: matchWindow.start,
    overlapEnd: matchWindow.end
  };
}

function gameWindow(game: Partial<Game>): WindowRange | undefined {
  const startValue = game.startsAt ?? game.meetTime;
  if (!startValue) return undefined;
  const start = new Date(startValue);
  if (Number.isNaN(start.getTime())) return undefined;

  const parsedEnd = game.endsAt ? new Date(game.endsAt) : undefined;
  const end =
    parsedEnd && !Number.isNaN(parsedEnd.getTime()) && parsedEnd > start
      ? parsedEnd
      : new Date(start.getTime() + 2 * 60 * 60 * 1000);

  return { start, end };
}

function hasOverlappingGame(candidate: AvailabilityCandidate, activeGameConflicts: Map<string, WindowRange[]>) {
  const conflicts = activeGameConflicts.get(candidate.userId) ?? [];
  return conflicts.some((conflict) => windowsOverlap(candidate, conflict));
}

function windowsOverlap(windowA: WindowRange, windowB: WindowRange) {
  return windowA.start < windowB.end && windowB.start < windowA.end;
}

function overlapMinutes(windowA: WindowRange, windowB: WindowRange) {
  const overlapStart = Math.max(windowA.start.getTime(), windowB.start.getTime());
  const overlapEnd = Math.min(windowA.end.getTime(), windowB.end.getTime());
  return Math.max(0, Math.floor((overlapEnd - overlapStart) / 60000));
}

function hasMinimumOverlap(windowA: WindowRange, windowB: WindowRange, minimumMinutes: number) {
  return overlapMinutes(windowA, windowB) >= minimumMinutes;
}

function assertAdmin(email: unknown) {
  if (typeof email !== "string" || !ADMIN_EMAILS.has(email)) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

function shouldSendPush(notification: AppNotification) {
  if (notification.type === "matchPosted" || notification.type === "playerJoined" || notification.type === "testPush") return true;
  if (notification.type === "gameConfirmed" || notification.type === "courtAssigned" || notification.type === "playerLeft") return true;
  if (notification.type === "formingGame") return notification.body?.toLowerCase().includes("need 1 more") === true;
  return false;
}

async function sendPushToUser(
  userId: string,
  payload: {
    title: string;
    body: string;
    gameId?: string;
    notificationId: string;
    type?: string;
  }
) {
  const subscriptionSnapshot = await db
    .collection("pushSubscriptions")
    .where("userId", "==", userId)
    .where("enabled", "==", true)
    .get();
  const subscriptionDocs = subscriptionSnapshot.docs
    .map((doc) => ({ ref: doc.ref, data: doc.data() as WebPushSubscription }))
    .filter((record) => Boolean(record.data.endpoint && record.data.keys?.p256dh && record.data.keys?.auth));

  const webPushPayload = JSON.stringify({
    title: payload.title,
    body: payload.body,
    notificationId: payload.notificationId,
    gameId: payload.gameId ?? "",
    type: payload.type ?? "",
    url: "https://paddleup-match-maker.web.app/"
  });

  let webPushSuccessCount = 0;
  let webPushFailureCount = 0;
  const disabledSubscriptions: Promise<FirebaseFirestore.WriteResult>[] = [];

  if (subscriptionDocs.length > 0) {
    webpush.setVapidDetails(WEB_PUSH_CONTACT, WEB_PUSH_VAPID_PUBLIC_KEY, webPushVapidPrivateKey.value());

    const webPushResponses = await Promise.allSettled(
      subscriptionDocs.map((record) =>
        webpush.sendNotification(
          {
            endpoint: record.data.endpoint!,
            keys: {
              p256dh: record.data.keys!.p256dh!,
              auth: record.data.keys!.auth!
            }
          },
          webPushPayload,
          { TTL: 60 * 60, urgency: "high" }
        )
      )
    );

    webPushResponses.forEach((response, index) => {
      if (response.status === "fulfilled") {
        webPushSuccessCount += 1;
        return;
      }

      webPushFailureCount += 1;
      const statusCode = response.reason?.statusCode;
      if (statusCode === 404 || statusCode === 410) {
        disabledSubscriptions.push(
          subscriptionDocs[index].ref.set(
            {
              enabled: false,
              disabledAt: FieldValue.serverTimestamp(),
              updatedAt: FieldValue.serverTimestamp()
            },
            { merge: true }
          )
        );
      } else {
        logger.warn("Web Push send failed", {
          userId,
          notificationId: payload.notificationId,
          statusCode,
          body: response.reason?.body
        });
      }
    });
  }

  await Promise.all(disabledSubscriptions);

  logger.info("Push send complete", {
    userId,
    notificationId: payload.notificationId,
    webPushSuccessCount,
    webPushFailureCount,
    disabledSubscriptions: disabledSubscriptions.length,
    successCount: webPushSuccessCount,
    failureCount: webPushFailureCount
  });
  return {
    webPushSuccessCount,
    webPushFailureCount,
    disabledSubscriptions: disabledSubscriptions.length
  };
}

async function deleteInBatches(refs: FirebaseFirestore.DocumentReference[]) {
  for (let index = 0; index < refs.length; index += 450) {
    const batch = db.batch();
    refs.slice(index, index + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}
