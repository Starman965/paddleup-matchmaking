export type LocationType = "club" | "publicCourt" | "resort" | "destination";

export type Location = {
  id: string;
  name: string;
  type: LocationType;
};

export type User = {
  uid: string;
  firstName: string;
  lastName: string;
  email: string;
  photoUrl: string;
  locationId: string;
};

export type Playmate = {
  userId: string;
  playmateId: string;
  enabled: boolean;
};

export type AvailabilityType = "readyNow" | "laterToday" | "tomorrow" | "weekend";

export type Availability = {
  id: string;
  userId: string;
  locationId: string;
  type: AvailabilityType;
  startTime: string;
  endTime: string;
  expiresAt?: string;
};

export type MatchType = "singles" | "doubles";
export type GameStatus = "forming" | "confirmed" | "completed";

export type Game = {
  id: string;
  locationId: string;
  type: MatchType;
  status: GameStatus;
  requiredPlayers: 2 | 4;
  playerIds: string[];
  startsAt: string;
  court?: string;
};

export type TabKey = "home" | "players" | "games" | "me";
