import {
  collection,
  doc,
  getDoc,
  onSnapshot,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type DocumentData,
  type QueryDocumentSnapshot,
  type Unsubscribe
} from "firebase/firestore";
import type { User as FirebaseUser } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { getDownloadURL, ref, uploadBytes } from "firebase/storage";
import { db, functions, storage } from "./firebase";
import type { Availability, Game, Location, Playmate, User, WebPushSubscription } from "./domain";

export type AdminLocation = Location & {
  active?: boolean;
};

export type AdminLocationSuggestion = {
  id: string;
  userId: string;
  name: string;
  city: string;
  state: string;
  country: string;
  courtCount: number;
  status: string;
  createdAt?: string;
};

export type AdminDashboard = {
  users: number;
  games: number;
  formingGames: number;
  confirmedGames: number;
  completedGames: number;
  locations: number;
  pendingLocationSuggestions: number;
  locationRows: AdminLocation[];
};

export type AdminResetResult = {
  deletedCount: number;
  games: number;
  availability: number;
  notifications: number;
};

function timestampToIso(value: unknown) {
  if (!value) return new Date().toISOString();
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return new Date().toISOString();
}

function optionalTimestampToIso(value: unknown) {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && "toDate" in value && typeof value.toDate === "function") {
    return value.toDate().toISOString();
  }
  return undefined;
}

function readString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function readStringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
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
    homeLocationId: readString(data.homeLocationId),
    presence: data.presence === "offline" ? "offline" : "visible",
    defaultReadyNowDuration: readNumber(data.defaultReadyNowDuration, 60),
    isTestUser: data.isTestUser === true
  };
}

function locationFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): Location {
  const data = snapshot.data();
  return {
    id: readString(data.id, snapshot.id),
    name: readString(data.name, "PaddleUp Location"),
    type: data.type === "publicCourt" || data.type === "resort" || data.type === "destination" ? data.type : "club",
    city: readString(data.city),
    state: readString(data.state),
    country: readString(data.country),
    imageUrl: readString(data.imageUrl),
    subtitle: readString(data.subtitle),
    courtCount: readNumber(data.courtCount, readStringArray(data.courtLabels).length),
    courtLabels: readStringArray(data.courtLabels)
  };
}

function availabilityFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): Availability {
  const data = snapshot.data();
  return {
    id: readString(data.id, snapshot.id),
    userId: readString(data.userId),
    locationId: readString(data.locationId, "blackhawk"),
    type:
      data.type === "laterToday" || data.type === "tomorrow" || data.type === "weekend"
        ? data.type
        : "readyNow",
    startTime: readString(data.startTime, timestampToIso(data.updatedAt)),
    endTime: readString(data.endTime, timestampToIso(data.expiresAt)),
    expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : undefined
  };
}

function gameFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): Game {
  const data = snapshot.data();
  const meetTime = optionalTimestampToIso(data.meetTime);
  return {
    id: readString(data.id, snapshot.id),
    locationId: readString(data.locationId, "blackhawk"),
    type: data.type === "singles" ? "singles" : "doubles",
    availabilityType:
      data.availabilityType === "laterToday" || data.availabilityType === "tomorrow" || data.availabilityType === "readyNow"
        ? data.availabilityType
        : undefined,
    status: data.status === "confirmed" || data.status === "completed" ? data.status : "forming",
    requiredPlayers: data.requiredPlayers === 2 ? 2 : 4,
    playerIds: readStringArray(data.playerIds),
    startsAt: readString(data.startsAt, meetTime || ""),
    endsAt: typeof data.endsAt === "string" ? data.endsAt : undefined,
    meetTime,
    court: typeof data.court === "string" ? data.court : null,
    formedFromAvailabilityIds: readStringArray(data.formedFromAvailabilityIds)
  };
}

function playmateFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): Playmate {
  const data = snapshot.data();
  return {
    userId: readString(data.userId),
    playmateId: readString(data.playmateId),
    enabled: data.enabled !== false
  };
}

function webPushSubscriptionFromSnapshot(snapshot: QueryDocumentSnapshot<DocumentData>): WebPushSubscription {
  const data = snapshot.data();
  const keys = typeof data.keys === "object" && data.keys ? data.keys as Record<string, unknown> : {};
  return {
    id: readString(data.id, snapshot.id),
    userId: readString(data.userId),
    locationId: readString(data.locationId, "blackhawk"),
    endpoint: readString(data.endpoint),
    keys: {
      p256dh: readString(keys.p256dh),
      auth: readString(keys.auth)
    },
    platform: readString(data.platform, "unknown"),
    browser: readString(data.browser, "unknown"),
    standalone: data.standalone === true,
    enabled: data.enabled !== false
  };
}

export async function upsertCurrentUser(firebaseUser: FirebaseUser, locationId: string) {
  const [firstName = "", ...lastNameParts] = (firebaseUser.displayName || "").trim().split(/\s+/);
  const lastName = lastNameParts.join(" ");
  const userRef = doc(db, "users", firebaseUser.uid);
  const existingUser = await getDoc(userRef);
  const existingPhotoUrl = existingUser.exists() ? readString(existingUser.data().photoUrl) : "";
  const existingPresence = existingUser.exists() && existingUser.data().presence === "offline" ? "offline" : "visible";
  const existingLocationId = existingUser.exists() ? readString(existingUser.data().locationId, locationId) : locationId;
  const existingHomeLocationId = existingUser.exists() ? readString(existingUser.data().homeLocationId) : "";

  await setDoc(
    userRef,
    {
      uid: firebaseUser.uid,
      firstName: firstName || firebaseUser.email?.split("@")[0] || "Player",
      lastName,
      email: firebaseUser.email || "",
      photoUrl: existingPhotoUrl || firebaseUser.photoURL || "",
      locationId: existingLocationId,
      homeLocationId: existingHomeLocationId,
      presence: existingPresence,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function setUserHomeLocation(userId: string, locationId: string) {
  await updateDoc(doc(db, "users", userId), {
    homeLocationId: locationId,
    locationId,
    updatedAt: serverTimestamp()
  });
}

export async function setUserHomeLocationPreference(userId: string, locationId: string) {
  await updateDoc(doc(db, "users", userId), {
    homeLocationId: locationId,
    updatedAt: serverTimestamp()
  });
}

export async function suggestLocation({
  userId,
  name,
  city,
  state,
  country,
  courtCount
}: {
  userId: string;
  name: string;
  city: string;
  state: string;
  country: string;
  courtCount?: number;
}) {
  const suggestionRef = doc(collection(db, "locationSuggestions"));
  await setDoc(suggestionRef, {
    id: suggestionRef.id,
    userId,
    name,
    city,
    state,
    country,
    courtCount: courtCount && Number.isFinite(courtCount) ? courtCount : null,
    status: "pending",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  });
}

export async function uploadProfilePhoto(userId: string, photo: Blob) {
  const photoRef = ref(storage, `profilePhotos/${userId}/profile.webp`);
  await uploadBytes(photoRef, photo, {
    contentType: "image/webp",
    cacheControl: "public,max-age=3600"
  });
  const photoUrl = await getDownloadURL(photoRef);
  await updateDoc(doc(db, "users", userId), {
    photoUrl,
    updatedAt: serverTimestamp()
  });
  return photoUrl;
}

export async function uploadLocationPhoto(locationId: string, photo: Blob) {
  const photoRef = ref(storage, `locationPhotos/${locationId}/cover.webp`);
  await uploadBytes(photoRef, photo, {
    contentType: "image/webp",
    cacheControl: "public,max-age=3600"
  });
  return getDownloadURL(photoRef);
}

export async function markReadyNow(userId: string, locationId: string, durationMinutes: number, deadlineIso?: string) {
  const now = new Date();
  const requestedDeadline = deadlineIso ? new Date(deadlineIso) : undefined;
  const expiresAt =
    requestedDeadline && !Number.isNaN(requestedDeadline.getTime()) && requestedDeadline > now
      ? requestedDeadline
      : new Date(now.getTime() + durationMinutes * 60 * 1000);
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

export async function saveAvailabilityWindow(
  userId: string,
  locationId: string,
  type: "laterToday" | "tomorrow",
  startTime: string,
  endTime: string
) {
  const availabilityId = `${userId}_${type}`;

  await setDoc(doc(db, "availability", availabilityId), {
    id: availabilityId,
    userId,
    locationId,
    type,
    startTime,
    endTime,
    expiresAt: endTime,
    updatedAt: serverTimestamp()
  });
}

export async function setUserPresence(userId: string, presence: "visible" | "offline") {
  await updateDoc(doc(db, "users", userId), {
    presence,
    updatedAt: serverTimestamp()
  });
}

export async function setDefaultReadyNowDuration(userId: string, durationMinutes: number) {
  await updateDoc(doc(db, "users", userId), {
    defaultReadyNowDuration: durationMinutes,
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

export function subscribeUser(userId: string, onUser: (user: User | undefined) => void, onError: (error: Error) => void): Unsubscribe {
  return onSnapshot(doc(db, "users", userId), (snapshot) => {
    onUser(snapshot.exists() ? userFromSnapshot(snapshot as QueryDocumentSnapshot<DocumentData>) : undefined);
  }, onError);
}

export function subscribeLocations(onLocations: (locations: Location[]) => void, onError: (error: Error) => void): Unsubscribe {
  return onSnapshot(
    collection(db, "locations"),
    (snapshot) => onLocations(snapshot.docs.filter((doc) => doc.data().active !== false).map(locationFromSnapshot).sort((a, b) => a.name.localeCompare(b.name))),
    onError
  );
}

export function subscribeLocation(locationId: string, onLocation: (location: Location) => void, onError: (error: Error) => void): Unsubscribe {
  return onSnapshot(doc(db, "locations", locationId), (snapshot) => {
    if (snapshot.exists()) onLocation(locationFromSnapshot(snapshot as QueryDocumentSnapshot<DocumentData>));
  }, onError);
}

export function subscribeLocationAvailability(
  locationId: string,
  onAvailability: (availability: Availability[]) => void,
  onError: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, "availability"), where("locationId", "==", locationId)),
    (snapshot) => onAvailability(snapshot.docs.map(availabilityFromSnapshot)),
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

export function subscribeUserGames(userId: string, onGames: (games: Game[]) => void, onError: (error: Error) => void): Unsubscribe {
  return onSnapshot(
    query(collection(db, "games"), where("playerIds", "array-contains", userId)),
    (snapshot) => onGames(snapshot.docs.map(gameFromSnapshot)),
    onError
  );
}

export function subscribeUserPlaymates(
  userId: string,
  onPlaymates: (playmates: Playmate[]) => void,
  onError: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, "playmates"), where("userId", "==", userId)),
    (snapshot) => onPlaymates(snapshot.docs.map(playmateFromSnapshot)),
    onError
  );
}

export async function setPlaymateEnabled(userId: string, playmateId: string, enabled: boolean) {
  const playmateDocId = `${userId}_${playmateId}`;
  await setDoc(
    doc(db, "playmates", playmateDocId),
    {
      userId,
      playmateId,
      enabled,
      updatedAt: serverTimestamp()
    },
    { merge: true }
  );
}

export function subscribeUserWebPushSubscriptions(
  userId: string,
  onSubscriptions: (subscriptions: WebPushSubscription[]) => void,
  onError: (error: Error) => void
): Unsubscribe {
  return onSnapshot(
    query(collection(db, "pushSubscriptions"), where("userId", "==", userId)),
    (snapshot) => onSubscriptions(snapshot.docs.map(webPushSubscriptionFromSnapshot)),
    onError
  );
}

export async function saveWebPushSubscription({
  userId,
  locationId,
  subscription,
  platform,
  browser,
  standalone
}: {
  userId: string;
  locationId: string;
  subscription: PushSubscription;
  platform: string;
  browser: string;
  standalone: boolean;
}) {
  const serialized = subscription.toJSON();
  const endpoint = serialized.endpoint;
  const p256dh = serialized.keys?.p256dh;
  const auth = serialized.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    throw new Error("Push subscription is missing required keys.");
  }

  const endpointHash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
  const subscriptionId = Array.from(new Uint8Array(endpointHash)).map((byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32);
  await setDoc(
    doc(db, "pushSubscriptions", subscriptionId),
    {
      id: subscriptionId,
      userId,
      locationId,
      endpoint,
      keys: { p256dh, auth },
      platform,
      browser,
      standalone,
      enabled: true,
      lastSeenAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      createdAt: serverTimestamp()
    },
    { merge: true }
  );
}

export async function assignGameCourt(gameId: string, court: string) {
  const assignCourt = httpsCallable<{ gameId: string; court: string }, { gameId: string; court: string }>(functions, "assignCourt");
  await assignCourt({ gameId, court });
}

export async function joinGame(gameId: string) {
  const callable = httpsCallable<{ gameId: string }, { gameId: string }>(functions, "joinGame");
  await callable({ gameId });
}

export async function updateGameStartTime(gameId: string, startsAt: string) {
  const callable = httpsCallable<{ gameId: string; startsAt: string }, { gameId: string; startsAt: string }>(
    functions,
    "updateGameStartTime"
  );
  const result = await callable({ gameId, startsAt });
  return result.data;
}

export async function leaveGame(gameId: string) {
  const callable = httpsCallable<{ gameId: string }, { gameId: string }>(functions, "leaveGame");
  await callable({ gameId });
}

export async function resetTestData() {
  const callable = httpsCallable<Record<string, never>, AdminResetResult>(functions, "resetTestData");
  const result = await callable({});
  return result.data;
}

export async function updateLocationCourts(locationId: string, courtLabels: string[]) {
  const callable = httpsCallable<{ locationId: string; courtLabels: string[] }, { locationId: string; courtLabels: string[] }>(
    functions,
    "updateLocationCourts"
  );
  const result = await callable({ locationId, courtLabels });
  return result.data;
}

export async function getAdminDashboard() {
  const callable = httpsCallable<Record<string, never>, AdminDashboard>(functions, "getAdminDashboard");
  const result = await callable({});
  return result.data;
}

export async function listLocationSuggestions() {
  const callable = httpsCallable<Record<string, never>, { suggestions: AdminLocationSuggestion[] }>(functions, "listLocationSuggestions");
  const result = await callable({});
  return result.data.suggestions;
}

export async function approveLocationSuggestion(suggestionId: string, location: AdminLocation) {
  const callable = httpsCallable<{ suggestionId: string; location: AdminLocation }, { suggestionId: string; locationId: string }>(
    functions,
    "approveLocationSuggestion"
  );
  const result = await callable({ suggestionId, location });
  return result.data;
}

export async function rejectLocationSuggestion(suggestionId: string) {
  const callable = httpsCallable<{ suggestionId: string }, { suggestionId: string }>(functions, "rejectLocationSuggestion");
  const result = await callable({ suggestionId });
  return result.data;
}

export async function upsertLocation(location: AdminLocation) {
  const callable = httpsCallable<{ location: AdminLocation }, { locationId: string }>(functions, "upsertLocation");
  const result = await callable({ location });
  return result.data;
}
