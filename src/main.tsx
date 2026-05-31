import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { onAuthStateChanged, signInWithPopup, signOut, type User as FirebaseUser } from "firebase/auth";
import {
  Calendar,
  ChevronRight,
  Home,
  MapPin,
  Plus,
  Search,
  Sparkles,
  UserMinus,
  UserPlus,
  Users,
  UserRound
} from "lucide-react";
import { currentUserId, games as seedGames, locations, playmates as seedPlaymates, users as seedUsers } from "./data";
import type { Availability, AvailabilityType, Game, Playmate, TabKey, User } from "./domain";
import { auth, googleProvider, initializeAnalytics, trackEvent } from "./firebase";
import {
  assignGameCourt,
  leaveGame,
  markReadyNow,
  resetTestData,
  saveAvailabilityWindow,
  setDefaultReadyNowDuration,
  setPlaymateEnabled,
  setUserPresence,
  subscribeLocation,
  subscribeLocationAvailability,
  subscribeLocationGames,
  subscribeLocationUsers,
  subscribeUserPlaymates,
  updateGameStartTime,
  uploadProfilePhoto,
  upsertCurrentUser
} from "./firebaseDb";
import "./styles.css";

const locationById = new Map(locations.map((location) => [location.id, location]));
const defaultCourtOptions = Array.from({ length: 10 }, (_, index) => `Court ${index + 1}`);
const adminEmails = new Set(["demandgendave@gmail.com"]);
const matchLeadTimeMinutes = 30;

type MatchFeedback = {
  type: Exclude<AvailabilityType, "weekend">;
  status: "idle" | "saving" | "waiting" | "forming" | "confirmed" | "alreadyActive" | "error";
  title: string;
  body: string;
  previousGameIds?: string[];
};

type UserPresence = {
  label: string;
  detail: string;
  deadline?: string;
  tone: "offline" | "available" | "matching" | "matched";
};

type WindowRange = {
  start: Date;
  end: Date;
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDay(value: string) {
  const date = new Date(value);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return "Today";
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function timeInputValue(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function isoOnSameDay(value: string, time: string) {
  const [hours = "0", minutes = "0"] = time.split(":");
  const date = new Date(value);
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return date.toISOString();
}

function dateForAvailability(type: "laterToday" | "tomorrow") {
  const date = new Date();
  if (type === "tomorrow") date.setDate(date.getDate() + 1);
  return date;
}

function isoForTime(type: "laterToday" | "tomorrow", time: string) {
  const [hours = "0", minutes = "0"] = time.split(":");
  const date = dateForAvailability(type);
  date.setHours(Number(hours), Number(minutes), 0, 0);
  return date.toISOString();
}

function availabilityStatus(availability: Availability) {
  if (availability.type === "readyNow") return "Ready Now";
  return `${availability.type === "tomorrow" ? "Tomorrow" : "Today"} ${formatTime(availability.startTime)}-${formatTime(availability.endTime)}`;
}

function gameTimeLabel(game: Game) {
  if (game.status === "forming" && game.availabilityType === "readyNow") return "Ready Now";
  if (game.startsAt && game.endsAt && (game.availabilityType === "laterToday" || game.availabilityType === "tomorrow")) {
    return `${formatDay(game.startsAt)} · ${formatTime(game.startsAt)}-${formatTime(game.endsAt)}`;
  }
  if (game.startsAt) return `${formatDay(game.startsAt)} · ${formatTime(game.startsAt)}`;
  if (game.availabilityType === "laterToday") return "Later Today";
  if (game.availabilityType === "tomorrow") return "Tomorrow";
  return "Ready Now";
}

function gameWindow(game: Game): WindowRange | undefined {
  const start = new Date(game.startsAt || game.meetTime || "");
  if (Number.isNaN(start.getTime())) return undefined;

  const parsedEnd = game.endsAt ? new Date(game.endsAt) : undefined;
  const end =
    parsedEnd && !Number.isNaN(parsedEnd.getTime()) && parsedEnd > start
      ? parsedEnd
      : new Date(start.getTime() + 2 * 60 * 60 * 1000);

  return { start, end };
}

function windowsOverlap(windowA: WindowRange, windowB: WindowRange) {
  return windowA.start < windowB.end && windowB.start < windowA.end;
}

function activeGameOverlappingWindow(games: Game[], window: WindowRange) {
  return games.find((game) => {
    const activeWindow = gameWindow(game);
    return Boolean(activeWindow && windowsOverlap(window, activeWindow));
  });
}

function matchDeadline(availability: Availability) {
  const endValue = availability.endTime || availability.expiresAt;
  if (!endValue) return undefined;
  const deadline = new Date(new Date(endValue).getTime() - matchLeadTimeMinutes * 60 * 1000);
  return Number.isNaN(deadline.getTime()) ? undefined : deadline;
}

function formatCountdown(deadline: Date, nowMs: number) {
  const remainingMinutes = Math.ceil((deadline.getTime() - nowMs) / 60000);
  if (remainingMinutes <= 0) return "closing now";
  if (remainingMinutes < 60) return `${remainingMinutes} min left`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return minutes === 0 ? `${hours} hr left` : `${hours} hr ${minutes} min left`;
}

function matchDeadlineLabel(availability: Availability | undefined, nowMs: number) {
  if (!availability) return undefined;
  const deadline = matchDeadline(availability);
  if (!deadline) return undefined;
  return `Time remaining: ${formatCountdown(deadline, nowMs)}. By ${formatTime(deadline.toISOString())}`;
}

function initials(user: User) {
  const first = user.firstName?.[0] || "P";
  const last = user.lastName?.[0] || "";
  return `${first}${last}`;
}

function userFromFirebase(firebaseUser: FirebaseUser, locationId: string): User {
  const [firstName = "", ...lastNameParts] = (firebaseUser.displayName || "").trim().split(/\s+/);
  return {
    uid: firebaseUser.uid,
    firstName: firstName || firebaseUser.email?.split("@")[0] || "Player",
    lastName: lastNameParts.join(" "),
    email: firebaseUser.email || "",
    photoUrl: firebaseUser.photoURL || "",
    locationId,
    defaultReadyNowDuration: 60,
    presence: "visible"
  };
}

function loadImage(src: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not load that image."));
    image.src = src;
  });
}

async function cropImageToWebp(src: string, zoom: number) {
  const image = await loadImage(src);
  const canvas = document.createElement("canvas");
  const size = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not prepare image crop.");

  canvas.width = size;
  canvas.height = size;

  const clampedZoom = Math.min(Math.max(zoom, 1), 3);
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight) / clampedZoom;
  const sourceX = (image.naturalWidth - sourceSize) / 2;
  const sourceY = (image.naturalHeight - sourceSize) / 2;

  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, 0, 0, size, size);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Could not export profile photo."));
      },
      "image/webp",
      0.86
    );
  });
}

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("home");
  const [playerTab, setPlayerTab] = useState<"playmates" | "community">("playmates");
  const [playerSearch, setPlayerSearch] = useState("");
  const [availabilityMode, setAvailabilityMode] = useState<AvailabilityType>("readyNow");
  const [duration, setDuration] = useState(60);
  const [laterTodayStart, setLaterTodayStart] = useState("13:00");
  const [laterTodayEnd, setLaterTodayEnd] = useState("17:00");
  const [tomorrowStart, setTomorrowStart] = useState("08:00");
  const [tomorrowEnd, setTomorrowEnd] = useState("12:00");
  const [playmateState, setPlaymateState] = useState<Playmate[]>(seedPlaymates);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [firebaseStatus, setFirebaseStatus] = useState("Sign in to save availability and see live games.");
  const [liveUsers, setLiveUsers] = useState<User[]>([]);
  const [liveGames, setLiveGames] = useState<Game[]>([]);
  const [liveAvailability, setLiveAvailability] = useState<Availability[]>([]);
  const [courtPickerGame, setCourtPickerGame] = useState<Game | null>(null);
  const [courtChoice, setCourtChoice] = useState(defaultCourtOptions[0]);
  const [customCourt, setCustomCourt] = useState("");
  const [assigningCourt, setAssigningCourt] = useState(false);
  const [leavingGameId, setLeavingGameId] = useState<string | null>(null);
  const [updatingStartTimeGameId, setUpdatingStartTimeGameId] = useState<string | null>(null);
  const [activeLocation, setActiveLocation] = useState(locations[0]);
  const [adminBusy, setAdminBusy] = useState(false);
  const [matchFeedback, setMatchFeedback] = useState<MatchFeedback | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoEditorOpen, setPhotoEditorOpen] = useState(false);
  const [onlineSheetOpen, setOnlineSheetOpen] = useState(false);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [readyNowSheetOpen, setReadyNowSheetOpen] = useState(false);
  const [readyNowDraftDuration, setReadyNowDraftDuration] = useState(duration);
  const [windowSheetType, setWindowSheetType] = useState<"laterToday" | "tomorrow" | null>(null);
  const [windowDraftStart, setWindowDraftStart] = useState(laterTodayStart);
  const [windowDraftEnd, setWindowDraftEnd] = useState(laterTodayEnd);
  const [durationHydratedForUser, setDurationHydratedForUser] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    initializeAnalytics();
    return onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      if (user) {
        setActiveTab("home");
        upsertCurrentUser(user, locations[0].id)
          .then(() => setFirebaseStatus(`Signed in. Ready to match at ${locations[0].name}.`))
          .catch((error: Error) => setFirebaseStatus(`Signed in, but profile save failed: ${error.message}`));
      } else {
        setFirebaseStatus("Sign in to save availability and see live games.");
      }
    });
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!firebaseUser) {
      setActiveLocation(locations[0]);
      return undefined;
    }

    return subscribeLocation(
      locations[0].id,
      (location) => setActiveLocation({ ...locations[0], ...location }),
      (error) => setFirebaseStatus(`Location read failed: ${error.message}`)
    );
  }, [firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) {
      setLiveUsers([]);
      return undefined;
    }

    return subscribeLocationUsers(
      activeLocation.id,
      setLiveUsers,
      (error) => setFirebaseStatus(`Players read failed: ${error.message}`)
    );
  }, [activeLocation.id, firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) {
      setLiveAvailability([]);
      return undefined;
    }

    return subscribeLocationAvailability(
      activeLocation.id,
      setLiveAvailability,
      (error) => setFirebaseStatus(`Availability read failed: ${error.message}`)
    );
  }, [activeLocation.id, firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) {
      setLiveGames([]);
      return undefined;
    }

    return subscribeLocationGames(
      activeLocation.id,
      setLiveGames,
      (error) => setFirebaseStatus(`Games read failed: ${error.message}`)
    );
  }, [activeLocation.id, firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) {
      setPlaymateState(seedPlaymates);
      return undefined;
    }

    return subscribeUserPlaymates(
      firebaseUser.uid,
      setPlaymateState,
      (error) => setFirebaseStatus(`Playmates read failed: ${error.message}`)
    );
  }, [firebaseUser]);

  const allUsers = useMemo(() => {
    const userMap = new Map<string, User>();
    if (!firebaseUser) {
      seedUsers.forEach((user) => userMap.set(user.uid, user));
    }
    liveUsers.forEach((user) => userMap.set(user.uid, user));
    if (firebaseUser) userMap.set(firebaseUser.uid, userMap.get(firebaseUser.uid) || userFromFirebase(firebaseUser, activeLocation.id));
    return Array.from(userMap.values());
  }, [activeLocation.id, firebaseUser, liveUsers]);

  const userById = useMemo(() => new Map(allUsers.map((user) => [user.uid, user])), [allUsers]);
  const activeUserId = firebaseUser?.uid || currentUserId;
  const currentUser = userById.get(activeUserId) || (firebaseUser ? userFromFirebase(firebaseUser, activeLocation.id) : seedUsers[0]);
  const onlinePlayerCount = allUsers.filter((user) => user.presence !== "offline").length;
  const onlinePlayers = useMemo(
    () =>
      allUsers
        .filter((user) => user.presence !== "offline")
        .sort((userA, userB) => {
          if (userA.uid === activeUserId) return -1;
          if (userB.uid === activeUserId) return 1;
          return `${userA.firstName} ${userA.lastName}`.localeCompare(`${userB.firstName} ${userB.lastName}`);
        }),
    [activeUserId, allUsers]
  );
  const playmateIds = useMemo(() => {
    if (!firebaseUser) return new Set(playmateState.filter((p) => p.enabled).map((p) => p.playmateId));
    const disabledPlaymateIds = new Set(playmateState.filter((p) => !p.enabled).map((p) => p.playmateId));
    return new Set(allUsers.filter((user) => user.uid !== activeUserId && !disabledPlaymateIds.has(user.uid)).map((user) => user.uid));
  }, [activeUserId, allUsers, firebaseUser, playmateState]);
  const visiblePlayers = useMemo(() => {
    const search = playerSearch.trim().toLowerCase();
    return allUsers
      .filter((user) => user.uid === activeUserId || user.presence !== "offline")
      .filter((user) => user.uid === activeUserId || playerTab === "community" || playmateIds.has(user.uid))
      .filter((user) => {
        if (!search) return true;
        return `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(search);
      })
      .sort((userA, userB) => {
        if (userA.uid === activeUserId) return -1;
        if (userB.uid === activeUserId) return 1;
        return `${userA.firstName} ${userA.lastName}`.localeCompare(`${userB.firstName} ${userB.lastName}`);
      });
  }, [activeUserId, allUsers, playmateIds, playerSearch, playerTab]);

  const displayGames = useMemo(
    () => {
      return firebaseUser ? liveGames : seedGames;
    },
    [firebaseUser, liveGames]
  );
  const myGames = useMemo(
    () => displayGames.filter((game) => game.playerIds.includes(activeUserId)),
    [activeUserId, displayGames]
  );
  const activeMyGames = useMemo(
    () => myGames.filter((game) => game.status === "forming" || game.status === "confirmed"),
    [myGames]
  );
  const nextGame = displayGames.find((game) => game.status === "confirmed" && game.playerIds.includes(activeUserId));
  const selectedGame = selectedGameId ? displayGames.find((game) => game.id === selectedGameId) : undefined;
  const courtOptions = activeLocation.courtLabels?.length ? activeLocation.courtLabels : defaultCourtOptions;
  const selectedCourt = courtChoice === "Other" ? customCourt.trim() : courtChoice;
  const isAdmin = Boolean(firebaseUser?.email && adminEmails.has(firebaseUser.email));
  const activeAvailabilityByUserId = useMemo(() => {
    const now = Date.now();
    return new Map(
      liveAvailability
        .filter((availability) => !availability.expiresAt || new Date(availability.expiresAt).getTime() > now)
        .map((availability) => [availability.userId, availability])
    );
  }, [liveAvailability]);
  const currentUserAvailability = activeAvailabilityByUserId.get(activeUserId);
  const currentPresence: UserPresence = useMemo(() => {
    const activeGame = activeMyGames[0];
    const deadline = matchDeadlineLabel(currentUserAvailability, nowMs);
    if (activeGame?.status === "confirmed") {
      return { label: "Matched", detail: "Your game is confirmed.", tone: "matched" };
    }
    if (activeGame?.status === "forming") {
      return {
        label: "Getting Matched",
        detail: "",
        deadline,
        tone: "matching"
      };
    }
    if (currentUserAvailability?.type === "readyNow") {
      return { label: "Ready Now", detail: "You are available to start within your Ready Now window.", deadline, tone: "available" };
    }
    if (currentUserAvailability?.type === "laterToday") {
      return { label: "Available Today", detail: availabilityStatus(currentUserAvailability), deadline, tone: "available" };
    }
    if (currentUserAvailability?.type === "tomorrow") {
      return { label: "Available Tomorrow", detail: availabilityStatus(currentUserAvailability), deadline, tone: "available" };
    }
    if (currentUser.presence === "offline") {
      return { label: "Offline", detail: "You are hidden from Players. Your matches stay active.", tone: "offline" };
    }
    return { label: "Want a Match?", detail: "Click Find Me Playmates to play ASAP, or choose a later time.", tone: "offline" };
  }, [activeMyGames, currentUser.presence, currentUserAvailability, nowMs]);
  useEffect(() => {
    if (!firebaseUser) {
      setDurationHydratedForUser(null);
      return;
    }
    if (durationHydratedForUser === activeUserId) return;
    const savedDuration = currentUser.defaultReadyNowDuration;
    if ([30, 60, 90, 120].includes(savedDuration ?? 0)) {
      setDuration(savedDuration!);
    }
    setDurationHydratedForUser(activeUserId);
  }, [activeUserId, currentUser.defaultReadyNowDuration, durationHydratedForUser, firebaseUser]);

  useEffect(() => {
    if (!matchFeedback) return;

    const relevantActiveGame = activeMyGames.find(
      (game) => (game.availabilityType ?? "readyNow") === matchFeedback.type
    );
    const hasRelevantAvailability = currentUserAvailability?.type === matchFeedback.type;

    if (matchFeedback.status === "alreadyActive" && !relevantActiveGame) {
      if (hasRelevantAvailability) {
        setMatchFeedback({
          ...matchFeedback,
          status: "waiting",
          title: "Availability Saved",
          body: "Looking for compatible players. You will see a forming game here as soon as PaddleUp finds one."
        });
        return;
      }
      setMatchFeedback(null);
      return;
    }

    if ((matchFeedback.status === "forming" || matchFeedback.status === "confirmed") && !relevantActiveGame) {
      setMatchFeedback(hasRelevantAvailability ? {
        ...matchFeedback,
        status: "waiting",
        title: "Availability Saved",
        body: "Looking for compatible players. You will see a forming game here as soon as PaddleUp finds one."
      } : null);
      return;
    }

    if (matchFeedback.status === "waiting" && !hasRelevantAvailability && !relevantActiveGame) {
      setMatchFeedback(null);
    }
  }, [activeMyGames, activeUserId, currentUserAvailability, matchFeedback]);

  useEffect(() => {
    if (!matchFeedback || matchFeedback.status === "confirmed" || matchFeedback.status === "alreadyActive" || matchFeedback.status === "error") return;

    const matchingGame = activeMyGames.find(
      (game) => (game.availabilityType ?? "readyNow") === matchFeedback.type
    );
    if (matchingGame) {
      const matchingStatus = matchingGame.status === "confirmed" ? "confirmed" : "forming";
      const previousGameIds = new Set(matchFeedback.previousGameIds ?? []);
      const joinedExisting = previousGameIds.has(matchingGame.id);
      const nextTitle = matchingStatus === "confirmed" ? "Game Confirmed" : joinedExisting ? "Added To A Forming Game" : "New Game Forming";
      const nextBody =
        matchingStatus === "confirmed"
          ? `${matchingGame.playerIds.length}/${matchingGame.requiredPlayers} players are in. Check My Games for meet time and court.`
          : `${matchingGame.playerIds.length}/${matchingGame.requiredPlayers} players are in. Need ${Math.max(0, matchingGame.requiredPlayers - matchingGame.playerIds.length)} more.`;
      if (matchFeedback.status === matchingStatus && matchFeedback.title === nextTitle && matchFeedback.body === nextBody) return;
      setMatchFeedback({
        ...matchFeedback,
        status: matchingStatus,
        title: nextTitle,
        body: nextBody
      });
      return;
    }

    if (currentUserAvailability?.type === matchFeedback.type && matchFeedback.status !== "waiting") {
      setMatchFeedback({
        ...matchFeedback,
        status: "waiting",
        title: "Availability Saved",
        body: "Looking for compatible players. You will see a forming game here as soon as PaddleUp finds one."
      });
    }
  }, [activeMyGames, activeUserId, currentUserAvailability, matchFeedback]);

  function openCourtPicker(game: Game) {
    setCourtPickerGame(game);
    if (game.court && courtOptions.includes(game.court)) {
      setCourtChoice(game.court);
      setCustomCourt("");
      return;
    }

    setCourtChoice(game.court ? "Other" : courtOptions[0]);
    setCustomCourt(game.court || "");
  }

  function viewSelectedGame(game: Game) {
    setSelectedGameId(game.id);
    setActiveTab("games");
  }

  function closeCourtPicker() {
    if (!assigningCourt) setCourtPickerGame(null);
  }

  function assignSelectedCourt() {
    if (!courtPickerGame) return;
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can assign a court.");
      return;
    }
    if (!selectedCourt) {
      setFirebaseStatus("Choose a court before assigning it.");
      return;
    }

    setAssigningCourt(true);
    assignGameCourt(courtPickerGame.id, selectedCourt)
      .then(() => {
        setFirebaseStatus(`${selectedCourt} assigned. Players have been notified.`);
        setCourtPickerGame(null);
      })
      .catch((error: Error) => setFirebaseStatus(`Court assignment failed: ${error.message}`))
      .finally(() => setAssigningCourt(false));
  }

  function leaveSelectedGame(gameId: string) {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can leave a game.");
      return;
    }

    setLeavingGameId(gameId);
    leaveGame(gameId)
      .then(() => {
        trackEvent("game_left", { gameId });
        setFirebaseStatus("You left the game. Other players have been notified.");
      })
      .catch((error: Error) => setFirebaseStatus(`Leaving game failed: ${error.message}`))
      .finally(() => setLeavingGameId(null));
  }

  function updateSelectedGameStartTime(game: Game, time: string) {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can update the start time.");
      return;
    }

    const startsAt = isoOnSameDay(game.startsAt, time);
    setUpdatingStartTimeGameId(game.id);
    updateGameStartTime(game.id, startsAt)
      .then(() => {
        trackEvent("game_start_time_updated", { gameId: game.id });
        setFirebaseStatus(`Start time updated to ${formatTime(startsAt)}.`);
      })
      .catch((error: Error) => setFirebaseStatus(`Start time update failed: ${error.message}`))
      .finally(() => setUpdatingStartTimeGameId(null));
  }

  function beginMatchingFeedback(type: Exclude<AvailabilityType, "weekend">, requestedWindow: WindowRange) {
    const overlappingGame = activeGameOverlappingWindow(activeMyGames, requestedWindow);
    if (overlappingGame) {
      setMatchFeedback({
        type: (overlappingGame.availabilityType ?? type) as Exclude<AvailabilityType, "weekend">,
        status: "alreadyActive",
        title: "Time Window Already Booked",
        body:
          overlappingGame.status === "confirmed"
            ? `You already have a confirmed game during ${gameTimeLabel(overlappingGame)}. Drop out first if you need to change that time.`
            : `${overlappingGame.playerIds.length}/${overlappingGame.requiredPlayers} players are already in your forming game for ${gameTimeLabel(overlappingGame)}.`
      });
      return false;
    }

    setMatchFeedback({
      type,
      status: "saving",
      title: "Saving Availability",
      body: "PaddleUp is checking for compatible players now.",
      previousGameIds: displayGames.filter((game) => game.status === "forming" || game.status === "confirmed").map((game) => game.id)
    });
    return true;
  }

  function saveWindowAvailability(type: "laterToday" | "tomorrow", startTime: string, endTime: string) {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then availability can write to Firestore.");
      return;
    }

    if (currentUser.presence === "offline") {
      setUserPresence(firebaseUser.uid, "visible").catch((error: Error) => setFirebaseStatus(`Presence update failed: ${error.message}`));
    }

    const startIso = isoForTime(type, startTime);
    const endIso = isoForTime(type, endTime);
    if (new Date(endIso) <= new Date(startIso)) {
      setFirebaseStatus("Choose an end time after the start time.");
      return;
    }

    if (!beginMatchingFeedback(type, { start: new Date(startIso), end: new Date(endIso) })) return;

    trackEvent("availability_window_saved", { type, locationId: activeLocation.id });
    saveAvailabilityWindow(firebaseUser.uid, activeLocation.id, type, startIso, endIso)
      .then(() => {
        trackEvent("availability_created", { type, locationId: activeLocation.id });
        setFirebaseStatus(`${type === "tomorrow" ? "Tomorrow" : "Later Today"} availability saved.`);
      })
      .catch((error: Error) => {
        setMatchFeedback({
          type,
          status: "error",
          title: "Availability Save Failed",
          body: error.message
        });
        setFirebaseStatus(`Availability save failed: ${error.message}`);
      });
  }

  function startReadyNowMatching(durationMinutes = duration) {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then Ready Now can write to Firestore.");
      return;
    }

    setAvailabilityMode("readyNow");
    const readyNowStart = new Date();
    const readyNowEnd = new Date(readyNowStart.getTime() + durationMinutes * 60 * 1000);
    if (!beginMatchingFeedback("readyNow", { start: readyNowStart, end: readyNowEnd })) return;

    if (currentUser.presence === "offline") {
      setUserPresence(firebaseUser.uid, "visible").catch((error: Error) => setFirebaseStatus(`Presence update failed: ${error.message}`));
    }

    trackEvent("ready_now_clicked", { durationMinutes, locationId: activeLocation.id });
    markReadyNow(firebaseUser.uid, activeLocation.id, durationMinutes)
      .then(() => {
        trackEvent("availability_created", { type: "readyNow", durationMinutes, locationId: activeLocation.id });
        setFirebaseStatus(`Ready Now saved. You are available to start within ${durationMinutes} minutes at ${activeLocation.name}.`);
      })
      .catch((error: Error) => {
        setMatchFeedback({
          type: "readyNow",
          status: "error",
          title: "Ready Now Failed",
          body: error.message
        });
        setFirebaseStatus(`Ready Now failed: ${error.message}`);
      });
  }

  function chooseHomeAvailability(type: Exclude<AvailabilityType, "weekend">) {
    setAvailabilityMode(type);
    if (type === "readyNow") {
      setReadyNowDraftDuration(duration);
      setReadyNowSheetOpen(true);
      return;
    }

    setWindowDraftStart(type === "tomorrow" ? tomorrowStart : laterTodayStart);
    setWindowDraftEnd(type === "tomorrow" ? tomorrowEnd : laterTodayEnd);
    setWindowSheetType(type);
  }

  function confirmReadyNowDuration() {
    setDuration(readyNowDraftDuration);
    setReadyNowSheetOpen(false);
    startReadyNowMatching(readyNowDraftDuration);
  }

  function confirmWindowAvailability() {
    if (!windowSheetType) return;
    const startIso = isoForTime(windowSheetType, windowDraftStart);
    const endIso = isoForTime(windowSheetType, windowDraftEnd);
    if (new Date(endIso) <= new Date(startIso)) {
      setFirebaseStatus("Choose an end time after the start time.");
      return;
    }
    if (windowSheetType === "tomorrow") {
      setTomorrowStart(windowDraftStart);
      setTomorrowEnd(windowDraftEnd);
    } else {
      setLaterTodayStart(windowDraftStart);
      setLaterTodayEnd(windowDraftEnd);
    }
    setWindowSheetType(null);
    saveWindowAvailability(windowSheetType, windowDraftStart, windowDraftEnd);
  }

  function togglePlaymate(uid: string) {
    const enabled = !playmateIds.has(uid);
    setPlaymateState((records) => {
      const existing = records.find((record) => record.playmateId === uid);
      if (existing) {
        return records.map((record) => (record.playmateId === uid ? { ...record, enabled } : record));
      }
      return [...records, { userId: activeUserId, playmateId: uid, enabled }];
    });

    if (!firebaseUser) return;

    setPlaymateEnabled(firebaseUser.uid, uid, enabled)
      .then(() => setFirebaseStatus(enabled ? "Player added back to your playmates." : "Player removed from your playmates."))
      .catch((error: Error) => setFirebaseStatus(`Playmate update failed: ${error.message}`));
  }

  function runAdminResetTestData() {
    setAdminBusy(true);
    resetTestData()
      .then(({ deletedCount }) => setFirebaseStatus(`Admin cleanup complete. Deleted ${deletedCount} activity records.`))
      .catch((error: Error) => setFirebaseStatus(`Admin cleanup failed: ${error.message}`))
      .finally(() => setAdminBusy(false));
  }

  function setVisiblePresence() {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can control your availability.");
      return;
    }

    setUserPresence(firebaseUser.uid, "visible")
      .then(() => {
        trackEvent("presence_updated", { presence: "visible", locationId: activeLocation.id });
        setFirebaseStatus("You are visible in Players.");
      })
      .catch((error: Error) => setFirebaseStatus(`Presence update failed: ${error.message}`));
  }

  function setOfflinePresence() {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can control your availability.");
      return;
    }

    setUserPresence(firebaseUser.uid, "offline")
      .then(() => {
        trackEvent("presence_updated", { presence: "offline", locationId: activeLocation.id });
        setFirebaseStatus("You are hidden from Players. Existing matches stay active.");
      })
      .catch((error: Error) => setFirebaseStatus(`Presence update failed: ${error.message}`));
  }

  function togglePresence() {
    if (currentUser.presence === "offline") {
      setVisiblePresence();
      return;
    }
    setOfflinePresence();
  }

  function updateDefaultReadyNowDuration(durationMinutes: number) {
    setDuration(durationMinutes);
    if (!firebaseUser) return;

    setDefaultReadyNowDuration(firebaseUser.uid, durationMinutes)
      .then(() => setFirebaseStatus(`Default Ready Now setting saved: ${durationMinutes} minutes.`))
      .catch((error: Error) => setFirebaseStatus(`Default setting save failed: ${error.message}`));
  }

  function saveProfilePhoto(photo: Blob) {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can update your profile photo.");
      return Promise.reject(new Error("Sign in first."));
    }

    setPhotoUploading(true);
    return uploadProfilePhoto(firebaseUser.uid, photo)
      .then(() => {
        trackEvent("profile_photo_uploaded", { locationId: activeLocation.id });
        setFirebaseStatus("Profile photo updated.");
        setPhotoEditorOpen(false);
      })
      .catch((error: Error) => {
        setFirebaseStatus(`Profile photo upload failed: ${error.message}`);
        throw error;
      })
      .finally(() => setPhotoUploading(false));
  }

  function signIn() {
    signInWithPopup(auth, googleProvider)
      .then(({ user }) => {
        setActiveTab("home");
        return upsertCurrentUser(user, activeLocation.id)
          .then(() => setUserPresence(user.uid, "visible"))
          .then(() => {
            trackEvent("presence_updated", { presence: "visible", locationId: activeLocation.id, source: "sign_in" });
            setFirebaseStatus(`Signed in. You are visible in Players.`);
          })
          .catch((error: Error) => setFirebaseStatus(`Signed in, but presence update failed: ${error.message}`));
      })
      .catch((error: Error) => {
        setFirebaseStatus(`Sign-in failed: ${error.message}`);
      });
  }

  function signOutUser() {
    if (!firebaseUser) {
      signOut(auth).catch((error: Error) => setFirebaseStatus(`Sign-out failed: ${error.message}`));
      return;
    }

    setUserPresence(firebaseUser.uid, "offline")
      .then(() => {
        trackEvent("presence_updated", { presence: "offline", locationId: activeLocation.id, source: "sign_out" });
      })
      .catch((error: Error) => setFirebaseStatus(`Presence update before sign-out failed: ${error.message}`))
      .finally(() => {
        signOut(auth).catch((error: Error) => setFirebaseStatus(`Sign-out failed: ${error.message}`));
      });
  }

  const nav = [
    { key: "home" as const, label: "Home", icon: Home },
    { key: "games" as const, label: "My Games", icon: Calendar },
    { key: "players" as const, label: "Players", icon: Users },
    { key: "me" as const, label: "Me", icon: UserRound }
  ];

  if (!firebaseUser) {
    return (
      <main className="app-shell">
        <div className="phone-frame signed-out-frame">
          <SignedOutScreen onSignIn={signIn} status={firebaseStatus} />
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="phone-frame">
        <header className="top-bar">
          <button className={`identity-button ${firebaseUser ? "" : "signed-out"}`} onClick={firebaseUser ? () => setPhotoEditorOpen(true) : signIn}>
            {firebaseUser ? <Avatar user={currentUser} /> : "Sign In"}
          </button>
          <div>
            <p className="location-kicker"><MapPin size={13} /> {activeLocation.name}</p>
            <h1>{activeTab === "home" ? "PaddleUp" : nav.find((item) => item.key === activeTab)?.label}</h1>
          </div>
          <OnlinePill count={onlinePlayerCount} onClick={() => setOnlineSheetOpen(true)} />
        </header>

        <section className="screen">
          {activeTab === "home" && (
            <HomeScreen
              nextGame={nextGame}
              activeGame={activeMyGames[0]}
              games={displayGames}
              userById={userById}
              presence={currentPresence}
              matchFeedback={matchFeedback}
              onSetTab={setActiveTab}
              onChooseAvailability={chooseHomeAvailability}
              onViewGame={viewSelectedGame}
            />
          )}
          {activeTab === "players" && (
            <PlayersScreen
              playerTab={playerTab}
              setPlayerTab={setPlayerTab}
              search={playerSearch}
              setSearch={setPlayerSearch}
              visiblePlayers={visiblePlayers}
              activeUserId={activeUserId}
              playmateIds={playmateIds}
              availabilityByUserId={activeAvailabilityByUserId}
              onToggle={togglePlaymate}
            />
          )}
          {activeTab === "games" && (
            <GamesScreen
              games={myGames}
              selectedGame={selectedGame}
              userById={userById}
              activeUserId={activeUserId}
              leavingGameId={leavingGameId}
              updatingStartTimeGameId={updatingStartTimeGameId}
              onAssignCourt={openCourtPicker}
              onLeaveGame={leaveSelectedGame}
              onUpdateStartTime={updateSelectedGameStartTime}
            />
          )}
          {activeTab === "me" && (
            <MeScreen
              currentUser={currentUser}
              firebaseUser={firebaseUser}
              onSignIn={signIn}
              onSignOut={signOutUser}
              duration={duration}
              setDuration={updateDefaultReadyNowDuration}
              isAdmin={isAdmin}
              adminBusy={adminBusy}
              onResetTestData={runAdminResetTestData}
              isOffline={currentUser.presence === "offline"}
              onTogglePresence={togglePresence}
              onEditPhoto={() => setPhotoEditorOpen(true)}
            />
          )}
        </section>
        {photoEditorOpen && firebaseUser && (
          <PhotoEditorSheet
            user={currentUser}
            uploading={photoUploading}
            onSave={saveProfilePhoto}
            onClose={() => setPhotoEditorOpen(false)}
          />
        )}
        {onlineSheetOpen && (
          <OnlinePlayersSheet
            players={onlinePlayers}
            activeUserId={activeUserId}
            availabilityByUserId={activeAvailabilityByUserId}
            onClose={() => setOnlineSheetOpen(false)}
          />
        )}
        {readyNowSheetOpen && (
          <ReadyNowSheet
            duration={readyNowDraftDuration}
            onDurationChange={setReadyNowDraftDuration}
            onClose={() => setReadyNowSheetOpen(false)}
            onConfirm={confirmReadyNowDuration}
          />
        )}
        {windowSheetType && (
          <AvailabilityWindowSheet
            type={windowSheetType}
            startTime={windowDraftStart}
            endTime={windowDraftEnd}
            onStartTimeChange={setWindowDraftStart}
            onEndTimeChange={setWindowDraftEnd}
            onClose={() => setWindowSheetType(null)}
            onConfirm={confirmWindowAvailability}
          />
        )}
        {courtPickerGame && (
          <CourtPicker
            game={courtPickerGame}
            courtOptions={courtOptions}
            courtChoice={courtChoice}
            customCourt={customCourt}
            selectedCourt={selectedCourt}
            assigning={assigningCourt}
            onChoice={setCourtChoice}
            onCustomCourt={setCustomCourt}
            onClose={closeCourtPicker}
            onAssign={assignSelectedCourt}
          />
        )}

        <nav className="bottom-nav">
          {nav.map((item) => {
            const Icon = item.icon;
            return (
              <button key={item.key} className={activeTab === item.key ? "active" : ""} onClick={() => setActiveTab(item.key)}>
                <Icon size={21} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </div>
    </main>
  );
}

function SignedOutScreen({ onSignIn, status }: { onSignIn: () => void; status: string }) {
  const showStatus = status.startsWith("Sign-in failed") || status.includes("unauthorized-domain");
  return (
    <section className="signed-out-screen">
      <div className="signed-out-brand">
        <Sparkles size={28} />
        <h1>PaddleUp</h1>
        <p>Find pickleball playmates when you are ready to play.</p>
      </div>
      <button className="signed-out-button" onClick={onSignIn}>
        Sign In
      </button>
      {showStatus && <p className="signed-out-status">{status}</p>}
    </section>
  );
}

function HomeScreen({
  nextGame,
  activeGame,
  games,
  userById,
  presence,
  matchFeedback,
  onSetTab,
  onChooseAvailability,
  onViewGame
}: {
  nextGame?: Game;
  activeGame?: Game;
  games: Game[];
  userById: Map<string, User>;
  presence: UserPresence;
  matchFeedback: MatchFeedback | null;
  onSetTab: (tab: TabKey) => void;
  onChooseAvailability: (mode: Exclude<AvailabilityType, "weekend">) => void;
  onViewGame: (game: Game) => void;
}) {
  const forming = games.filter((game) => game.status === "forming");

  return (
    <div className="stack">
      <StatusCard presence={presence} game={activeGame} userById={userById} />
      <section className="hero-cta glass-panel">
        <Sparkles className="spark" size={24} />
        <p>Want to play now or soon?</p>
        <button className="hero-primary" onClick={() => onChooseAvailability("readyNow")}>
          <strong>Find Me Playmates</strong>
          <span>Click to get a match ASAP. Or below for later/tomorrow.</span>
        </button>
        <div className="mode-row">
          {[
            ["laterToday", "Later Today"],
            ["tomorrow", "Tomorrow"]
          ].map(([mode, label]) => (
            <button key={mode} onClick={() => onChooseAvailability(mode as Exclude<AvailabilityType, "weekend">)}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {matchFeedback && <MatchFeedbackCard feedback={matchFeedback} />}

      {nextGame && (
        <section className="glass-panel">
          <SectionTitle title="Next Game" action="View Game" onClick={() => onSetTab("games")} />
          <GameCard game={nextGame} userById={userById} compact />
        </section>
      )}

      <section className="stack">
        <SectionTitle title="Matches Forming" />
        {forming.length === 0 && <p className="empty-copy">No matches forming right now. Tap Find Me Playmates when you want to play.</p>}
        {forming.map((game) => (
          <FormingGame key={game.id} game={game} userById={userById} onClick={() => onViewGame(game)} />
        ))}
      </section>

    </div>
  );
}

function PlayersScreen({
  playerTab,
  setPlayerTab,
  search,
  setSearch,
  visiblePlayers,
  activeUserId,
  playmateIds,
  availabilityByUserId,
  onToggle
}: {
  playerTab: "playmates" | "community";
  setPlayerTab: (tab: "playmates" | "community") => void;
  search: string;
  setSearch: (search: string) => void;
  visiblePlayers: User[];
  activeUserId: string;
  playmateIds: Set<string>;
  availabilityByUserId: Map<string, Availability>;
  onToggle: (uid: string) => void;
}) {
  return (
    <div className="stack">
      <Segmented
        value={playerTab}
        options={[
          ["playmates", "My Playmates"],
          ["community", "All Players"]
        ]}
        onChange={(value) => setPlayerTab(value as "playmates" | "community")}
      />
      <label className="search glass-panel">
        <Search size={17} />
        <input value={search} placeholder={playerTab === "playmates" ? "Search my playmates" : "Search all players"} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="list glass-panel">
        {visiblePlayers.length === 0 && <p className="empty-copy">No players found.</p>}
        {visiblePlayers.map((user) => {
          const isSelf = user.uid === activeUserId;
          const isPlaymate = playmateIds.has(user.uid);
          const availability = availabilityByUserId.get(user.uid);
          const statusCopy = user.presence === "offline" ? "Offline" : availability ? availabilityStatus(availability) : locationById.get(user.locationId)?.name;
          return (
            <article className={`player-row ${isSelf ? "self" : ""}`} key={user.uid}>
              <Avatar user={user} />
              <div>
                <strong>{user.firstName} {user.lastName}{isSelf ? " · You" : ""}</strong>
                <span>{statusCopy}</span>
              </div>
              {user.presence === "offline" ? (
                <span className="availability-badge muted">Off</span>
              ) : availability && (
                <span className="availability-badge">{availability.type === "readyNow" ? "Now" : availability.type === "tomorrow" ? "Tmrw" : "Today"}</span>
              )}
              {isSelf ? (
                <span className="self-badge">You</span>
              ) : (
                <button className="small-icon" onClick={() => onToggle(user.uid)} aria-label={isPlaymate ? "Remove playmate" : "Add playmate"}>
                  {isPlaymate ? <UserMinus size={18} /> : <UserPlus size={18} />}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function GamesScreen({
  games,
  selectedGame,
  userById,
  activeUserId,
  leavingGameId,
  updatingStartTimeGameId,
  onAssignCourt,
  onLeaveGame,
  onUpdateStartTime
}: {
  games: Game[];
  selectedGame?: Game;
  userById: Map<string, User>;
  activeUserId: string;
  leavingGameId: string | null;
  updatingStartTimeGameId: string | null;
  onAssignCourt: (game: Game) => void;
  onLeaveGame: (gameId: string) => void;
  onUpdateStartTime: (game: Game, time: string) => void;
}) {
  const selectedGameCard = selectedGame && (selectedGame.status === "forming" || selectedGame.status === "confirmed") ? selectedGame : undefined;
  const selectedGameIds = new Set(selectedGameCard ? [selectedGameCard.id] : []);
  const forming = games.filter((game) => game.status === "forming" && !selectedGameIds.has(game.id));
  const confirmed = games.filter((game) => game.status === "confirmed" && !selectedGameIds.has(game.id));

  return (
    <div className="stack">
      {selectedGameCard && (
        <>
          <SectionTitle title="Selected Game" />
          <GameCard
            game={selectedGameCard}
            userById={userById}
            activeUserId={activeUserId}
            isLeaving={leavingGameId === selectedGameCard.id}
            isUpdatingStartTime={updatingStartTimeGameId === selectedGameCard.id}
            onAssignCourt={() => onAssignCourt(selectedGameCard)}
            onLeaveGame={() => onLeaveGame(selectedGameCard.id)}
            onUpdateStartTime={(time) => onUpdateStartTime(selectedGameCard, time)}
          />
        </>
      )}
      <SectionTitle title="Forming" />
      {forming.length === 0 && <p className="empty-copy">No forming games right now.</p>}
      {forming.map((game) => (
        <GameCard
          key={game.id}
          game={game}
          userById={userById}
          activeUserId={activeUserId}
          isLeaving={leavingGameId === game.id}
          isUpdatingStartTime={updatingStartTimeGameId === game.id}
          onAssignCourt={() => onAssignCourt(game)}
          onLeaveGame={() => onLeaveGame(game.id)}
          onUpdateStartTime={(time) => onUpdateStartTime(game, time)}
        />
      ))}
      <SectionTitle title="Confirmed" />
      {confirmed.length === 0 && <p className="empty-copy">No confirmed games yet.</p>}
      {confirmed.map((game) => (
        <GameCard
          key={game.id}
          game={game}
          userById={userById}
          activeUserId={activeUserId}
          isLeaving={leavingGameId === game.id}
          isUpdatingStartTime={updatingStartTimeGameId === game.id}
          onAssignCourt={() => onAssignCourt(game)}
          onLeaveGame={() => onLeaveGame(game.id)}
          onUpdateStartTime={(time) => onUpdateStartTime(game, time)}
        />
      ))}
    </div>
  );
}

function CourtPicker({
  game,
  courtOptions,
  courtChoice,
  customCourt,
  selectedCourt,
  assigning,
  onChoice,
  onCustomCourt,
  onClose,
  onAssign
}: {
  game: Game;
  courtOptions: string[];
  courtChoice: string;
  customCourt: string;
  selectedCourt: string;
  assigning: boolean;
  onChoice: (court: string) => void;
  onCustomCourt: (court: string) => void;
  onClose: () => void;
  onAssign: () => void;
}) {
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Assign court" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="Assign Court" action="Close" onClick={onClose} />
        <p>{game.court ? `Current court: ${game.court}` : "Choose where everyone should meet."}</p>
        <div className="court-grid">
          {[...courtOptions, "Other"].map((court) => (
            <button key={court} className={courtChoice === court ? "selected" : ""} onClick={() => onChoice(court)}>
              {court}
            </button>
          ))}
        </div>
        {courtChoice === "Other" && (
          <input
            className="court-input"
            value={customCourt}
            maxLength={40}
            placeholder="Type court or location"
            onChange={(event) => onCustomCourt(event.target.value)}
          />
        )}
        <button className="primary-action" disabled={assigning || !selectedCourt} onClick={onAssign}>
          {assigning ? "Assigning..." : `Assign ${selectedCourt || "Court"}`}
        </button>
      </section>
    </div>
  );
}

function PhotoEditorSheet({
  user,
  uploading,
  onSave,
  onClose
}: {
  user: User;
  uploading: boolean;
  onSave: (photo: Blob) => Promise<void>;
  onClose: () => void;
}) {
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Profile photo" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="Profile Photo" action="Close" onClick={onClose} />
        <ProfilePhotoEditor user={user} uploading={uploading} onSave={onSave} />
      </section>
    </div>
  );
}

function OnlinePlayersSheet({
  players,
  activeUserId,
  availabilityByUserId,
  onClose
}: {
  players: User[];
  activeUserId: string;
  availabilityByUserId: Map<string, Availability>;
  onClose: () => void;
}) {
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet online-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Online players" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="Online Now" action="Close" onClick={onClose} />
        <div className="online-list">
          {players.length === 0 && <p className="empty-copy">No players are online right now.</p>}
          {players.map((user) => {
            const availability = availabilityByUserId.get(user.uid);
            return (
              <article className="online-player-row" key={user.uid}>
                <Avatar user={user} />
                <div>
                  <strong>{user.firstName} {user.lastName}{user.uid === activeUserId ? " · You" : ""}</strong>
                  <span>{availability ? availabilityStatus(availability) : locationById.get(user.locationId)?.name}</span>
                </div>
                {availability && (
                  <span className="availability-badge">{availability.type === "readyNow" ? "Now" : availability.type === "tomorrow" ? "Tmrw" : "Today"}</span>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}

function ReadyNowSheet({
  duration,
  onDurationChange,
  onClose,
  onConfirm
}: {
  duration: number;
  onDurationChange: (duration: number) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Ready Now window" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="Ready Now Window" action="Close" onClick={onClose} />
        <p>Choose how long you are available to start a game. Your default from Me is already selected.</p>
        <div className="duration-grid">
          {[30, 60, 90, 120].map((minutes) => (
            <button key={minutes} className={duration === minutes ? "selected" : ""} onClick={() => onDurationChange(minutes)}>
              {minutes}<span>min</span>
            </button>
          ))}
        </div>
        <button className="primary-action" onClick={onConfirm}>
          Find Me Playmates
        </button>
      </section>
    </div>
  );
}

function AvailabilityWindowSheet({
  type,
  startTime,
  endTime,
  onStartTimeChange,
  onEndTimeChange,
  onClose,
  onConfirm
}: {
  type: "laterToday" | "tomorrow";
  startTime: string;
  endTime: string;
  onStartTimeChange: (time: string) => void;
  onEndTimeChange: (time: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const title = type === "tomorrow" ? "Tomorrow Window" : "Later Today Window";
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet glass-panel" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <SectionTitle title={title} action="Close" onClick={onClose} />
        <p>Choose the window when you can start a game.</p>
        <div className="window-time-grid">
          <label className="window-time-field">
            <span>Start</span>
            <input type="time" step={900} value={startTime} onChange={(event) => onStartTimeChange(event.target.value)} />
          </label>
          <label className="window-time-field">
            <span>End</span>
            <input type="time" step={900} value={endTime} onChange={(event) => onEndTimeChange(event.target.value)} />
          </label>
        </div>
        <button className="primary-action" onClick={onConfirm}>
          Find Me Playmates
        </button>
      </section>
    </div>
  );
}

function MeScreen({
  currentUser,
  firebaseUser,
  onSignIn,
  onSignOut,
  duration,
  setDuration,
  isAdmin,
  adminBusy,
  onResetTestData,
  isOffline,
  onTogglePresence,
  onEditPhoto
}: {
  currentUser: User;
  firebaseUser: FirebaseUser | null;
  onSignIn: () => void;
  onSignOut: () => void;
  duration: number;
  setDuration: (duration: number) => void;
  isAdmin: boolean;
  adminBusy: boolean;
  onResetTestData: () => void;
  isOffline: boolean;
  onTogglePresence: () => void;
  onEditPhoto: () => void;
}) {
  return (
    <div className="stack">
      <section className="account-panel glass-panel">
        <button className="avatar-edit-button" onClick={firebaseUser ? onEditPhoto : onSignIn} aria-label="Edit profile photo">
          <Avatar user={currentUser} />
        </button>
        <div>
          <strong>{firebaseUser ? `${currentUser.firstName} ${currentUser.lastName}` : "PaddleUp Matchmaking"}</strong>
          <span>{firebaseUser ? "Tap your photo to update it." : "Sign in to save availability and matches."}</span>
        </div>
        <div className="account-actions">
          <button onClick={firebaseUser ? onSignOut : onSignIn}>{firebaseUser ? "Sign Out" : "Sign In"}</button>
          {firebaseUser && (
            <button className="visibility-toggle" onClick={onTogglePresence}>
              {isOffline ? "Go Visible" : "Go Offline"}
            </button>
          )}
        </div>
      </section>
      <section className="glass-panel preference-panel">
        <SectionTitle title="Default Ready Now Setting" />
        <p>Used when you click Ready Now. This means you are available to start within this many minutes.</p>
        <div className="duration-grid compact">
          {[30, 60, 90, 120].map((minutes) => (
            <button key={minutes} className={duration === minutes ? "selected" : ""} onClick={() => setDuration(minutes)}>
              {minutes}<span>min</span>
            </button>
          ))}
        </div>
      </section>
      {isAdmin && (
        <section className="glass-panel admin-panel">
          <SectionTitle title="Admin" />
          <p>Clear testing activity while keeping real user profiles.</p>
          <button className="danger-action" disabled={adminBusy} onClick={onResetTestData}>
            Clear Test Activity
          </button>
        </section>
      )}
    </div>
  );
}

function SectionTitle({ title, action, onClick }: { title: string; action?: string; onClick?: () => void }) {
  return (
    <div className="section-title">
      <h2>{title}</h2>
      {action && <button onClick={onClick}>{action}<ChevronRight size={16} /></button>}
    </div>
  );
}

function OnlinePill({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button className="online-pill" aria-label={`${count} online players. Show online players.`} onClick={onClick}>
      <span />
      <strong>{count}</strong>
      <em>online</em>
    </button>
  );
}

function StatusCard({ presence, game, userById }: { presence: UserPresence; game?: Game; userById?: Map<string, User> }) {
  const players = game && userById ? game.playerIds.map((id) => userById.get(id)!).filter(Boolean) : [];
  const missing = game ? Math.max(0, game.requiredPlayers - game.playerIds.length) : 0;

  return (
    <section className={`status-card glass-panel ${presence.tone} ${game ? "with-game" : ""}`}>
      <div className="status-copy">
        <span className="status-pill">{presence.label}</span>
        {presence.detail && <strong>{presence.detail}</strong>}
        {presence.deadline && <p>{presence.deadline}</p>}
        {game?.court && <p className="status-court">{game.court}</p>}
      </div>
      {game && (
        <div className="status-game">
          <AvatarStack users={players} missing={missing} />
          <span>{missing > 0 ? `${missing} needed` : "Players set"}</span>
        </div>
      )}
    </section>
  );
}

function ProfilePhotoEditor({
  user,
  uploading,
  onSave
}: {
  user: User;
  uploading: boolean;
  onSave: (photo: Blob) => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [zoom, setZoom] = useState(1.15);
  const [error, setError] = useState("");

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function chooseFile(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("Choose an image file.");
      return;
    }

    setError("");
    setZoom(1.15);
    const nextUrl = URL.createObjectURL(file);
    setPreviewUrl((currentUrl) => {
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      return nextUrl;
    });
  }

  async function savePhoto() {
    if (!previewUrl) {
      inputRef.current?.click();
      return;
    }

    setError("");
    try {
      const croppedPhoto = await cropImageToWebp(previewUrl, zoom);
      await onSave(croppedPhoto);
      setPreviewUrl((currentUrl) => {
        if (currentUrl) URL.revokeObjectURL(currentUrl);
        return "";
      });
      if (inputRef.current) inputRef.current.value = "";
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Could not save profile photo.");
    }
  }

  return (
    <section className="photo-editor glass-panel">
      <div className="photo-editor-header">
        <div className="photo-preview">
          {previewUrl ? (
            <img src={previewUrl} alt="Profile crop preview" style={{ transform: `scale(${zoom})` }} />
          ) : (
            <Avatar user={user} />
          )}
        </div>
        <div>
          <strong>Profile Photo</strong>
          <span>Upload, crop, and save as WebP.</span>
        </div>
      </div>
      <input ref={inputRef} type="file" accept="image/*" onChange={chooseFile} hidden />
      {previewUrl && (
        <label className="zoom-control">
          <span>Zoom</span>
          <input type="range" min="1" max="3" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} />
        </label>
      )}
      {error && <p className="photo-error">{error}</p>}
      <div className="photo-actions">
        <button className="ghost-action" onClick={() => inputRef.current?.click()}>
          {previewUrl ? "Choose Different Photo" : "Upload Photo"}
        </button>
        {previewUrl && (
          <button className="primary-action" disabled={uploading} onClick={savePhoto}>
            {uploading ? "Saving..." : "Save Photo"}
          </button>
        )}
      </div>
    </section>
  );
}

function MatchFeedbackCard({ feedback }: { feedback: MatchFeedback }) {
  return (
    <section className={`match-feedback glass-panel ${feedback.status}`}>
      <span>{feedback.type === "readyNow" ? "Ready Now" : feedback.type === "tomorrow" ? "Tomorrow" : "Later Today"}</span>
      <strong>{feedback.title}</strong>
      <p>{feedback.body}</p>
    </section>
  );
}

function GameCard({
  game,
  userById,
  compact,
  activeUserId,
  isLeaving,
  isUpdatingStartTime,
  onAssignCourt,
  onLeaveGame,
  onUpdateStartTime
}: {
  game: Game;
  userById: Map<string, User>;
  compact?: boolean;
  activeUserId?: string;
  isLeaving?: boolean;
  isUpdatingStartTime?: boolean;
  onAssignCourt?: () => void;
  onLeaveGame?: () => void;
  onUpdateStartTime?: (time: string) => void;
}) {
  const location = locationById.get(game.locationId)!;
  const players = game.playerIds.map((id) => userById.get(id)!).filter(Boolean);
  const missing = game.requiredPlayers - game.playerIds.length;
  const canLeave = Boolean(activeUserId && game.playerIds.includes(activeUserId) && onLeaveGame);
  const canUpdateStartTime = Boolean(!compact && activeUserId && game.status === "confirmed" && game.playerIds.includes(activeUserId) && onUpdateStartTime);
  const isForming = game.status === "forming";
  const timing = gameTimeLabel(game);
  const courtLabel = game.court || "Assign Court";

  return (
    <article className={`game-card glass-panel ${game.status}`}>
      <div className="game-meta">
        <div>
          <strong>{isForming ? "Getting Matched" : timing}</strong>
          {isForming ? (
            <>
              <span className="game-window-line">Play window: {timing}</span>
              <span>{game.type} · {game.playerIds.length}/{game.requiredPlayers} joined · {missing > 0 ? `${missing} needed` : "Players set"}</span>
            </>
          ) : (
            <span>{game.type} · {location.name}</span>
          )}
        </div>
        {!isForming && (
          onAssignCourt ? (
            <button className="court-pill" onClick={onAssignCourt}>{courtLabel}</button>
          ) : (
            <span className={`court-pill ${game.court ? "" : "muted"}`}>{game.court || "Court TBD"}</span>
          )
        )}
      </div>
      <AvatarStack users={players} missing={missing} />
      {canUpdateStartTime && (
        <label className="start-time-control">
          <span>{isUpdatingStartTime ? "Updating start time..." : "Start time"}</span>
          <input
            type="time"
            step={900}
            value={timeInputValue(game.startsAt)}
            disabled={isUpdatingStartTime}
            onChange={(event) => onUpdateStartTime?.(event.target.value)}
          />
        </label>
      )}
      {!compact && <p className="need-copy">{missing > 0 ? `Need ${missing} more` : "Players confirmed"}</p>}
      {!compact && canLeave && (
        <button className="danger-action" disabled={isLeaving} onClick={onLeaveGame}>
          {isLeaving ? "Dropping Out..." : "Drop Out"}
        </button>
      )}
    </article>
  );
}

function FormingGame({ game, userById, onClick }: { game: Game; userById: Map<string, User>; onClick: () => void }) {
  const missing = game.requiredPlayers - game.playerIds.length;
  const timing = gameTimeLabel(game);
  return (
    <button className="forming-row glass-panel" onClick={onClick} aria-label={`View forming ${game.type} game`}>
      <div>
        <strong>{game.type}</strong>
        <span className="forming-window">Play window: {timing}</span>
        <span>{game.playerIds.length}/{game.requiredPlayers} joined · {missing > 0 ? `${missing} needed` : "Players set"}</span>
        {game.court && <em>{game.court}</em>}
      </div>
      <div className="forming-side">
        <AvatarStack users={game.playerIds.map((id) => userById.get(id)!).filter(Boolean)} missing={missing} />
        <span>View Match</span>
      </div>
    </button>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: string[][]; onChange: (value: string) => void }) {
  return (
    <div className="segmented">
      {options.map(([key, label]) => <button key={key} className={value === key ? "selected" : ""} onClick={() => onChange(key)}>{label}</button>)}
    </div>
  );
}

function Avatar({ user }: { user: User }) {
  return (
    <div className={`avatar ${user.photoUrl ? "has-photo" : ""}`} aria-label={`${user.firstName} ${user.lastName}`}>
      {user.photoUrl ? <img src={user.photoUrl} alt="" /> : initials(user)}
    </div>
  );
}

function AvatarStack({ users, missing }: { users: User[]; missing: number }) {
  return (
    <div className="avatar-stack">
      {users.map((user) => <Avatar key={user.uid} user={user} />)}
      {Array.from({ length: Math.max(0, missing) }).map((_, index) => <div className="avatar empty" key={index}><Plus size={14} /></div>)}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

if (import.meta.env.DEV && "serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    registrations.forEach((registration) => registration.unregister());
  });
}

if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}
