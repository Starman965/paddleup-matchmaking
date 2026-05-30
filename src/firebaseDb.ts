import { doc, serverTimestamp, setDoc } from "firebase/firestore";
import type { User as FirebaseUser } from "firebase/auth";
import { db } from "./firebase";

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
