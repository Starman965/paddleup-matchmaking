import type { Availability, Game, Location, Playmate, User } from "./domain";

export const locations: Location[] = [
  {
    id: "blackhawk",
    name: "Blackhawk Country Club",
    type: "club"
  }
];

export const currentUserId = "david";

export const users: User[] = [
  {
    uid: "david",
    firstName: "David",
    lastName: "Lewis",
    email: "david@example.com",
    photoUrl: "DL",
    locationId: "blackhawk"
  },
  {
    uid: "mia",
    firstName: "Mia",
    lastName: "Chen",
    email: "mia@example.com",
    photoUrl: "MC",
    locationId: "blackhawk"
  },
  {
    uid: "susan",
    firstName: "Susan",
    lastName: "Jones",
    email: "susan@example.com",
    photoUrl: "SJ",
    locationId: "blackhawk"
  },
  {
    uid: "mike",
    firstName: "Mike",
    lastName: "Taylor",
    email: "mike@example.com",
    photoUrl: "MT",
    locationId: "blackhawk"
  },
  {
    uid: "alex",
    firstName: "Alex",
    lastName: "Johnson",
    email: "alex@example.com",
    photoUrl: "AJ",
    locationId: "blackhawk"
  },
  {
    uid: "ryan",
    firstName: "Ryan",
    lastName: "Carter",
    email: "ryan@example.com",
    photoUrl: "RC",
    locationId: "blackhawk"
  },
  {
    uid: "nina",
    firstName: "Nina",
    lastName: "Patel",
    email: "nina@example.com",
    photoUrl: "NP",
    locationId: "blackhawk"
  }
];

export const playmates: Playmate[] = users
  .filter((user) => user.uid !== currentUserId)
  .map((user) => ({
    userId: currentUserId,
    playmateId: user.uid,
    enabled: user.uid !== "ryan"
  }));

export const availabilities: Availability[] = [
  {
    id: "a1",
    userId: "mia",
    locationId: "blackhawk",
    type: "readyNow",
    startTime: "2026-05-29T09:15:00",
    endTime: "2026-05-29T10:15:00",
    expiresAt: "2026-05-29T10:15:00"
  },
  {
    id: "a2",
    userId: "susan",
    locationId: "blackhawk",
    type: "laterToday",
    startTime: "2026-05-29T13:00:00",
    endTime: "2026-05-29T17:00:00"
  },
  {
    id: "a3",
    userId: "mike",
    locationId: "blackhawk",
    type: "tomorrow",
    startTime: "2026-05-30T08:00:00",
    endTime: "2026-05-30T12:00:00"
  }
];

export const games: Game[] = [
  {
    id: "g1",
    locationId: "blackhawk",
    type: "doubles",
    status: "confirmed",
    requiredPlayers: 4,
    playerIds: ["david", "mia", "susan", "mike"],
    startsAt: "2026-05-29T09:30:00",
    court: "Court 4"
  },
  {
    id: "g2",
    locationId: "blackhawk",
    type: "doubles",
    status: "forming",
    requiredPlayers: 4,
    playerIds: ["alex", "nina", "mia"],
    startsAt: "2026-05-29T16:00:00"
  },
  {
    id: "g3",
    locationId: "blackhawk",
    type: "singles",
    status: "forming",
    requiredPlayers: 2,
    playerIds: ["susan"],
    startsAt: "2026-05-30T08:00:00"
  }
];
