import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";

initializeApp();

const db = getFirestore();
const REQUIRED_DOUBLES_PLAYERS = 4;
const DEFAULT_MEET_DELAY_MINUTES = 30;
const MATCH_LEAD_TIME_MINUTES = 30;
const ADMIN_EMAILS = new Set(["demandgendave@gmail.com"]);

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
  formedFromAvailabilityIds: string[];
  createdAt?: FirebaseFirestore.FieldValue;
  updatedAt?: FirebaseFirestore.FieldValue;
  meetTime?: string;
  startsAt?: string;
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

  const now = new Date();
  const latestMatchDeadline = new Date(now.getTime() + MATCH_LEAD_TIME_MINUTES * 60 * 1000);
  const triggerWindow = availabilityWindow(availability);
  if (!triggerWindow || triggerWindow.end <= latestMatchDeadline) {
    logger.info("Ignoring expired, invalid, or too-tight availability", {
      availabilityId,
      availabilityType,
      matchLeadTimeMinutes: MATCH_LEAD_TIME_MINUTES
    });
    return;
  }

  const activeAvailabilitySnapshot = await db
    .collection("availability")
    .where("locationId", "==", availability.locationId)
    .where("type", "==", availabilityType)
    .get();

  const candidates: AvailabilityCandidate[] = [];

  for (const doc of activeAvailabilitySnapshot.docs) {
    const data = doc.data() as Availability;
    const window = availabilityWindow(data);
    if (!data.userId || !window || window.end <= latestMatchDeadline) continue;
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
      .where("locationId", "==", availability.locationId)
      .where("type", "==", "doubles")
      .where("status", "==", "forming");
    const confirmedQuery = db
      .collection("games")
      .where("locationId", "==", availability.locationId)
      .where("type", "==", "doubles")
      .where("status", "==", "confirmed");

    const formingSnapshot = await transaction.get(formingQuery);
    const confirmedSnapshot = await transaction.get(confirmedQuery);
    const formingDoc = formingSnapshot.docs.find((doc) => {
      const game = doc.data() as Partial<Game>;
      return game.availabilityType === availabilityType || (!game.availabilityType && availabilityType === "readyNow");
    });
    const gameRef = formingDoc ? formingDoc.ref : db.collection("games").doc();
    const existing = formingDoc ? (formingDoc.data() as Game) : undefined;
    const existingPlayers = existing?.playerIds ?? [];
    const activeGamePlayerIds = new Set<string>();

    for (const gameDoc of [...formingSnapshot.docs, ...confirmedSnapshot.docs]) {
      if (gameDoc.id === gameRef.id) continue;
      const game = gameDoc.data() as Partial<Game>;
      for (const playerId of game.playerIds ?? []) {
        activeGamePlayerIds.add(playerId);
      }
    }

    const selection = selectAvailabilityGroup(candidates, existingPlayers, activeGamePlayerIds, disabledPairs);
    const candidatePlayerIds = unique([...existingPlayers, ...candidates.map((candidate) => candidate.userId)]);
    const skippedPlayerIds = candidatePlayerIds.filter((playerId) => activeGamePlayerIds.has(playerId));

    if (!selection || selection.playerIds.length === 0) {
      logger.info("No eligible players for doubles match update", {
        availabilityId,
        availabilityType,
        skippedPlayerIds,
        locationId: availability.locationId
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
          ? new Date(Date.now() + DEFAULT_MEET_DELAY_MINUTES * 60 * 1000).toISOString()
          : selection.overlapStart.toISOString()
        : undefined;

    const game: Game = {
      id: gameRef.id,
      locationId: availability.locationId!,
      type: "doubles",
      availabilityType,
      status,
      requiredPlayers: REQUIRED_DOUBLES_PLAYERS,
      playerIds: selection.playerIds,
      formedFromAvailabilityIds: unique([...(existing?.formedFromAvailabilityIds ?? []), ...selection.availabilityIds]),
      court: existing?.court ?? null,
      createdAt: existing?.createdAt ?? FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      ...(meetTime ? { meetTime, startsAt: meetTime } : {})
    };

    transaction.set(gameRef, game, { merge: true });

    const notificationType = status === "confirmed" ? "gameConfirmed" : "formingGame";
    const notificationTitle = status === "confirmed" ? "Doubles confirmed" : `Doubles forming: ${selection.playerIds.length}/4`;
    const notificationBody =
      status === "confirmed"
        ? `${availabilityLabel(availabilityType)} match confirmed. Court TBD.`
        : `Need ${REQUIRED_DOUBLES_PLAYERS - selection.playerIds.length} more at Blackhawk.`;

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

    logger.info("Doubles match updated", {
      gameId: gameRef.id,
      availabilityType,
      status,
      playerCount: selection.playerIds.length,
      skippedPlayerIds,
      incompatiblePlayerIds,
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
  const availabilityRefs = ["readyNow", "laterToday", "tomorrow"].map((type) => db.collection("availability").doc(`${uid}_${type}`));
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

  const testUserIds = new Set(["test-player-3", "test-player-4"]);
  const testUsersSnapshot = await db.collection("users").where("isTestUser", "==", true).get();
  testUsersSnapshot.docs.forEach((doc) => testUserIds.add(doc.id));

  const deleteRefs = new Map<string, FirebaseFirestore.DocumentReference>();
  const addDelete = (ref: FirebaseFirestore.DocumentReference) => deleteRefs.set(ref.path, ref);
  testUsersSnapshot.docs.forEach((doc) => addDelete(doc.ref));

  const availabilitySnapshot = await db.collection("availability").get();
  availabilitySnapshot.docs.forEach((doc) => {
    addDelete(doc.ref);
  });

  const gamesSnapshot = await db.collection("games").get();
  gamesSnapshot.docs.forEach((doc) => {
    addDelete(doc.ref);
  });

  const notificationsSnapshot = await db.collection("notifications").get();
  notificationsSnapshot.docs.forEach((doc) => {
    addDelete(doc.ref);
  });

  const deletes = [...deleteRefs.values()];
  await deleteInBatches(deletes);
  logger.info("Admin cleared test activity", { count: deletes.length, admin: request.auth?.token.email });
  return { deletedCount: deletes.length };
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

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
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

function pairKey(userA: string, userB: string) {
  return [userA, userB].sort().join("__");
}

function selectAvailabilityGroup(
  candidates: AvailabilityCandidate[],
  existingPlayerIds: string[],
  activeGamePlayerIds: Set<string>,
  disabledPairs: string[]
): MatchSelection | undefined {
  const candidateByUserId = new Map(candidates.map((candidate) => [candidate.userId, candidate]));
  const orderedPlayerIds = unique([...existingPlayerIds, ...candidates.map((candidate) => candidate.userId)]).filter(
    (playerId) => candidateByUserId.has(playerId) && !activeGamePlayerIds.has(playerId)
  );
  const selectedCandidates: AvailabilityCandidate[] = [];
  let overlapStart: Date | undefined;
  let overlapEnd: Date | undefined;

  for (const playerId of orderedPlayerIds) {
    const candidate = candidateByUserId.get(playerId);
    if (!candidate) continue;

    const compatible = selectedCandidates.every((selected) => !disabledPairs.includes(pairKey(candidate.userId, selected.userId)));
    if (!compatible) continue;

    const nextOverlapStart = new Date(Math.max(overlapStart?.getTime() ?? candidate.start.getTime(), candidate.start.getTime()));
    const nextOverlapEnd = new Date(Math.min(overlapEnd?.getTime() ?? candidate.end.getTime(), candidate.end.getTime()));
    if (nextOverlapEnd <= nextOverlapStart) continue;

    selectedCandidates.push(candidate);
    overlapStart = nextOverlapStart;
    overlapEnd = nextOverlapEnd;

    if (selectedCandidates.length >= REQUIRED_DOUBLES_PLAYERS) break;
  }

  if (!overlapStart || !overlapEnd) return undefined;

  return {
    playerIds: selectedCandidates.map((candidate) => candidate.userId),
    availabilityIds: selectedCandidates.map((candidate) => candidate.availabilityId),
    overlapStart,
    overlapEnd
  };
}

function assertAdmin(email: unknown) {
  if (typeof email !== "string" || !ADMIN_EMAILS.has(email)) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
}

async function deleteInBatches(refs: FirebaseFirestore.DocumentReference[]) {
  for (let index = 0; index < refs.length; index += 450) {
    const batch = db.batch();
    refs.slice(index, index + 450).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}
