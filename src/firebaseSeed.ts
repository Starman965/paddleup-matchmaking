import { doc, serverTimestamp, setDoc, writeBatch } from "firebase/firestore";
import { currentUserId, locations, users } from "./data";
import { db } from "./firebase";

export async function seedBlackhawkMvp() {
  const batch = writeBatch(db);

  for (const location of locations) {
    batch.set(doc(db, "locations", location.id), {
      ...location,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  const user = users.find((candidate) => candidate.uid === currentUserId);
  if (user) {
    batch.set(doc(db, "users", user.uid), {
      ...user,
      seededMvpUser: true,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  await batch.commit();
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
