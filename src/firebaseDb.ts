import {
  collection,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe
} from "firebase/firestore";
import type { User as FirebaseUser } from "firebase/auth";
import { db } from "./firebase";
import type { Game, Notification, User } from "./domain";

function timestampToIso(value: unknown) {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return new Date().toISOString();
}

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function userFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): User {
  const data = snapshot.data();
  return {
    uid: readString(data.uid, snapshot.id),
    firstName: readString(data.firstName, "Player"),
    lastName: readString(data.lastName),
    email: readString(data.email),
    photoUrl: readString(data.photoUrl),
    locationId: readString(data.locationId, "blackhawk"),
    isTestUser: data.isTestUser === true
  };
}

function gameFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): Game {
  const data = snapshot.data();
  const meetTime = timestampToIso(data.meetTime);
  return {
    id: readString(data.id, snapshot.id),
    locationId: readString(data.locationId, "blackhawk"),
    type: data.type === "singles" ? "singles" : "doubles",
    status: data.status === "confirmed" || data.status === "completed" ? data.status : "forming",
    requiredPlayers: data.requiredPlayers === 2 ? 2 : 4,
    playerIds: readStringArray(data.playerIds),
    startsAt: readString(data.startsAt, meetTime),
    meetTime,
    court: typeof data.court === "string" ? data.court : null,
    formedFromAvailabilityIds: readStringArray(data.formedFromAvailabilityIds)
  };
}

function notificationFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): Notification {
  const data = snapshot.data();
  return {
    id: readString(data.id, snapshot.id),
    userId: readString(data.userId),
    gameId: readString(data.gameId),
    type: data.type === "gameConfirmed" || data.type === "courtAssigned" || data.type === "playerLeft" ? data.type : "formingGame",
    title: readString(data.title, "PaddleUp"),
    body: readString(data.body),
    read: data.read === true,
    createdAt: timestampToIso(data.createdAt)
  };
}

export async function upsertCurrentUser(firebaseUser: FirebaseUser, locationId: string) {
  const [firstName = "", ...lastNameParts] = (firebaseUser.displayName || "").trim().split(/\s+/);
  const lastName = lastNameParts.join(" ");

  await setDoc(
    doc(db, "users", firebaseUser.uid),
    {
      uid: firebaseUser.uid,
      firstName: firstName || firebaseUser.email?.split("@")[0] || "Player",
      lastName,
      email: firebaseUser.email || "",
      photoUrl: firebaseUser.photoURL || "",
      locationId,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function markReadyNow(userId: string, locationId: string, durationMinutes: number) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMinutes * 60 * 1000);
  const availabilityId = `${userId}_readyNow`;

  await setDoc(doc(db, "availability", availabilityId), {
    id: availabilityId,
    userId,
    locationId,
    type: "readyNow",
    startTime: now.toISOString(),
    endTime: expiresAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    updatedAt: serverTimestamp()
  });
}

export function subscribeLocationUsers(locationId: string, onUsers: (users: User[]) => void, onError: (error: Error) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, "users"), where("locationId", "==", locationId)),
    (snapshot) => onUsers(snapshot.docs.map(userFromSnapshot)),
    onError
  );
}

export function subscribeLocationGames(locationId: string, onGames: (games: Game[]) => void, onError: (error: Error) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, "games"), where("locationId", "==", locationId)),
    (snapshot) => onGames(snapshot.docs.map(gameFromSnapshot)),
    onError
  );
}

export function subscribeUserNotifications(
  userId: string,
  onNotifications: (notifications: Notification[]) => void,
  onError: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, "notifications"), where("userId", "==", userId)),
    (snapshot) =>
      onNotifications(
        snapshot.docs
          .map(notificationFromSnapshot)
          .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      ),
    onError
  );
}
