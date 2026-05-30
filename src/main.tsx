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
  goOffline,
  leaveGame,
  markReadyNow,
  resetTestData,
  saveAvailabilityWindow,
  setPlaymateEnabled,
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
  return `Match by ${formatTime(deadline.toISOString())} · ${formatCountdown(deadline, nowMs)}`;
}

function pulseCounts(availability: Availability[], games: Game[]) {
  const now = Date.now();
  const active = availability.filter((item) => !item.expiresAt || new Date(item.expiresAt).getTime() > now);
  return {
    readyNow: active.filter((item) => item.type === "readyNow").length,
    laterToday: active.filter((item) => item.type === "laterToday").length,
    tomorrow: active.filter((item) => item.type === "tomorrow").length,
    formingGames: games.filter((game) => game.status === "forming").length
  };
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
    locationId
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
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    initializeAnalytics();
    return onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      if (user) {
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
  const playmateIds = useMemo(() => {
    if (!firebaseUser) return new Set(playmateState.filter((p) => p.enabled).map((p) => p.playmateId));
    const disabledPlaymateIds = new Set(playmateState.filter((p) => !p.enabled).map((p) => p.playmateId));
    return new Set(allUsers.filter((user) => user.uid !== activeUserId && !disabledPlaymateIds.has(user.uid)).map((user) => user.uid));
  }, [activeUserId, allUsers, firebaseUser, playmateState]);
  const visiblePlayers = useMemo(() => {
    const search = playerSearch.trim().toLowerCase();
    return allUsers
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
        detail: `${activeGame.playerIds.length}/${activeGame.requiredPlayers} players in your forming game.`,
        deadline,
        tone: "matching"
      };
    }
    if (currentUserAvailability?.type === "readyNow") {
      return { label: "Ready Now", detail: "You are actively available right now.", deadline, tone: "available" };
    }
    if (currentUserAvailability?.type === "laterToday") {
      return { label: "Available Today", detail: availabilityStatus(currentUserAvailability), deadline, tone: "available" };
    }
    if (currentUserAvailability?.type === "tomorrow") {
      return { label: "Available Tomorrow", detail: availabilityStatus(currentUserAvailability), deadline, tone: "available" };
    }
    return { label: "Offline", detail: "You will not be matched until you set availability.", tone: "offline" };
  }, [activeMyGames, currentUserAvailability, nowMs]);
  const livePulseCounts = useMemo(() => pulseCounts(liveAvailability, displayGames), [displayGames, liveAvailability]);

  useEffect(() => {
    if (!matchFeedback || matchFeedback.status === "confirmed" || matchFeedback.status === "alreadyActive" || matchFeedback.status === "error") return;

    const matchingGame = activeMyGames.find(
      (game) => (game.availabilityType ?? "readyNow") === matchFeedback.type || game.playerIds.includes(activeUserId)
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

  function beginMatchingFeedback(type: Exclude<AvailabilityType, "weekend">) {
    const existingActiveGame = activeMyGames[0];
    if (existingActiveGame) {
      setMatchFeedback({
        type: (existingActiveGame.availabilityType ?? type) as Exclude<AvailabilityType, "weekend">,
        status: "alreadyActive",
        title: "Already In A Game",
        body:
          existingActiveGame.status === "confirmed"
            ? "You already have a confirmed game. Check My Games for details."
            : `${existingActiveGame.playerIds.length}/${existingActiveGame.requiredPlayers} players are already in your forming game.`
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

    const startIso = isoForTime(type, startTime);
    const endIso = isoForTime(type, endTime);
    if (new Date(endIso) <= new Date(startIso)) {
      setFirebaseStatus("Choose an end time after the start time.");
      return;
    }

    if (!beginMatchingFeedback(type)) return;

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

  function startReadyNowMatching() {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then Ready Now can write to Firestore.");
      return;
    }

    setAvailabilityMode("readyNow");
    if (!beginMatchingFeedback("readyNow")) return;

    trackEvent("ready_now_clicked", { durationMinutes: duration, locationId: activeLocation.id });
    markReadyNow(firebaseUser.uid, activeLocation.id, duration)
      .then(() => {
        trackEvent("availability_created", { type: "readyNow", durationMinutes: duration, locationId: activeLocation.id });
        setFirebaseStatus(`Ready Now saved for ${duration} minutes at ${activeLocation.name}.`);
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
      startReadyNowMatching();
      return;
    }

    const startTime = type === "tomorrow" ? tomorrowStart : laterTodayStart;
    const endTime = type === "tomorrow" ? tomorrowEnd : laterTodayEnd;
    saveWindowAvailability(type, startTime, endTime);
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

  function goOnline() {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can control your availability.");
      return;
    }

    setAvailabilityMode("readyNow");
    if (!beginMatchingFeedback("readyNow")) return;

    trackEvent("availability_toggled_online", { durationMinutes: duration, locationId: activeLocation.id });
    markReadyNow(firebaseUser.uid, activeLocation.id, duration)
      .then(() => {
        trackEvent("availability_created", { type: "readyNow", durationMinutes: duration, locationId: activeLocation.id });
        setFirebaseStatus(`You are back online for ${duration} minutes.`);
      })
      .catch((error: Error) => {
        setMatchFeedback({
          type: "readyNow",
          status: "error",
          title: "Going Online Failed",
          body: error.message
        });
        setFirebaseStatus(`Going online failed: ${error.message}`);
      });
  }

  function goOfflineNow() {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can control your availability.");
      return;
    }

    const formingGame = activeMyGames.find((game) => game.status === "forming");
    const offlineAction = formingGame ? leaveGame(formingGame.id) : goOffline(firebaseUser.uid);
    if (formingGame) setLeavingGameId(formingGame.id);

    offlineAction
      .then(() => {
        if (formingGame) trackEvent("game_left", { gameId: formingGame.id });
        trackEvent("availability_toggled_offline", { locationId: activeLocation.id });
        setMatchFeedback(null);
        setFirebaseStatus(
          formingGame
            ? "You are offline and were removed from the forming game."
            : "You are offline. PaddleUp will not match you until you go back online."
        );
      })
      .catch((error: Error) => setFirebaseStatus(`Going offline failed: ${error.message}`))
      .finally(() => {
        if (formingGame) setLeavingGameId(null);
      });
  }

  function togglePresence() {
    if (currentPresence.tone === "offline") {
      goOnline();
      return;
    }
    goOfflineNow();
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
    signInWithPopup(auth, googleProvider).catch((error: Error) => {
      setFirebaseStatus(`Sign-in failed: ${error.message}`);
    });
  }

  const nav = [
    { key: "home" as const, label: "Home", icon: Home },
    { key: "games" as const, label: "My Games", icon: Calendar },
    { key: "players" as const, label: "Players", icon: Users },
    { key: "me" as const, label: "Me", icon: UserRound }
  ];

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
        </header>

        <section className="screen">
          {activeTab === "home" && (
            <HomeScreen
              nextGame={nextGame}
              games={displayGames}
              userById={userById}
              presence={currentPresence}
              counts={livePulseCounts}
              matchFeedback={matchFeedback}
              onSetTab={setActiveTab}
              onChooseAvailability={chooseHomeAvailability}
              onTogglePresence={togglePresence}
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
              onSignOut={() => signOut(auth)}
              duration={duration}
              setDuration={setDuration}
              isAdmin={isAdmin}
              adminBusy={adminBusy}
              onResetTestData={runAdminResetTestData}
              presence={currentPresence}
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

function HomeScreen({
  nextGame,
  games,
  userById,
  presence,
  counts,
  matchFeedback,
  onSetTab,
  onChooseAvailability,
  onTogglePresence,
}: {
  nextGame?: Game;
  games: Game[];
  userById: Map<string, User>;
  presence: UserPresence;
  counts: ReturnType<typeof pulseCounts>;
  matchFeedback: MatchFeedback | null;
  onSetTab: (tab: TabKey) => void;
  onChooseAvailability: (mode: Exclude<AvailabilityType, "weekend">) => void;
  onTogglePresence: () => void;
}) {
  const forming = games.filter((game) => game.status === "forming");
  const primaryCta =
    presence.tone === "matched" || presence.tone === "matching"
      ? "View My Game"
      : presence.tone === "available"
        ? "Update Availability"
        : "I Want to Play";
  const onPrimaryCta = () => {
    if (presence.tone === "matched" || presence.tone === "matching") {
      onSetTab("games");
      return;
    }
    onChooseAvailability("readyNow");
  };

  return (
    <div className="stack">
      <StatusCard presence={presence} onTogglePresence={onTogglePresence} />
      <section className="hero-cta glass-panel">
        <Sparkles className="spark" size={24} />
        <p>Fastest path to a court</p>
        <button onClick={onPrimaryCta}>{primaryCta}</button>
        <div className="mode-row">
          {[
            ["readyNow", "Ready Now"],
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

      <section className="pulse-grid">
        <PulseCard label="Ready Now" value={counts.readyNow} onClick={() => onChooseAvailability("readyNow")} />
        <PulseCard label="Later Today" value={counts.laterToday} onClick={() => onChooseAvailability("laterToday")} />
        <PulseCard label="Tomorrow" value={counts.tomorrow} onClick={() => onChooseAvailability("tomorrow")} />
        <PulseCard label="Forming" value={counts.formingGames} onClick={() => onSetTab("games")} />
      </section>

      {nextGame && (
        <section className="glass-panel">
          <SectionTitle title="Next Game" action="View Game" onClick={() => onSetTab("games")} />
          <GameCard game={nextGame} userById={userById} compact />
        </section>
      )}

      <section className="stack">
        <SectionTitle title="Games Forming" />
        {forming.length === 0 && <p className="empty-copy">No games forming right now. Start with Ready Now when you want to play.</p>}
        {forming.map((game) => (
          <FormingGame key={game.id} game={game} userById={userById} />
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
          return (
            <article className={`player-row ${isSelf ? "self" : ""}`} key={user.uid}>
              <Avatar user={user} />
              <div>
                <strong>{user.firstName} {user.lastName}{isSelf ? " · You" : ""}</strong>
                <span>{availability ? availabilityStatus(availability) : locationById.get(user.locationId)?.name}</span>
              </div>
              {availability && <span className="availability-badge">{availability.type === "readyNow" ? "Now" : availability.type === "tomorrow" ? "Tmrw" : "Today"}</span>}
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
  userById,
  activeUserId,
  leavingGameId,
  updatingStartTimeGameId,
  onAssignCourt,
  onLeaveGame,
  onUpdateStartTime
}: {
  games: Game[];
  userById: Map<string, User>;
  activeUserId: string;
  leavingGameId: string | null;
  updatingStartTimeGameId: string | null;
  onAssignCourt: (game: Game) => void;
  onLeaveGame: (gameId: string) => void;
  onUpdateStartTime: (game: Game, time: string) => void;
}) {
  const forming = games.filter((game) => game.status === "forming");
  const confirmed = games.filter((game) => game.status === "confirmed");

  return (
    <div className="stack">
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
  presence,
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
  presence: UserPresence;
  onTogglePresence: () => void;
  onEditPhoto: () => void;
}) {
  return (
    <div className="stack">
      <StatusCard presence={presence} onTogglePresence={onTogglePresence} />
      <section className="account-panel glass-panel">
        <button className="avatar-edit-button" onClick={firebaseUser ? onEditPhoto : onSignIn} aria-label="Edit profile photo">
          <Avatar user={currentUser} />
        </button>
        <div>
          <strong>{firebaseUser ? `${currentUser.firstName} ${currentUser.lastName}` : "PaddleUp Matchmaking"}</strong>
          <span>{firebaseUser ? "Tap your photo to update it." : "Sign in to save availability and matches."}</span>
        </div>
        <button onClick={firebaseUser ? onSignOut : onSignIn}>{firebaseUser ? "Sign Out" : "Sign In"}</button>
      </section>
      <section className="glass-panel preference-panel">
        <SectionTitle title="Default Ready Now Setting" />
        <p>Used when you click Ready Now.</p>
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

function StatusCard({ presence, onTogglePresence }: { presence: UserPresence; onTogglePresence: () => void }) {
  return (
    <section className={`status-card glass-panel ${presence.tone}`}>
      <div>
        <span>{presence.label}</span>
        <strong>{presence.detail}</strong>
        {presence.deadline && <p>{presence.deadline}</p>}
      </div>
      {presence.tone !== "matched" && (
        <button onClick={onTogglePresence}>{presence.tone === "offline" ? "Go Online" : "Go Offline"}</button>
      )}
    </section>
  );
}

function PulseCard({ label, value, onClick }: { label: string; value: number; onClick: () => void }) {
  return (
    <button className="pulse-card" onClick={onClick}>
      <strong>{value}</strong>
      <span>{label}</span>
    </button>
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

  return (
    <article className={`game-card glass-panel ${game.status}`}>
      <div className="game-meta">
        <div>
          <strong>{formatDay(game.startsAt)} · {formatTime(game.startsAt)}</strong>
          <span>{game.type} · {location.name}</span>
        </div>
        <button className="court-pill" onClick={onAssignCourt}>{game.court || "Court TBD"}</button>
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

function FormingGame({ game, userById }: { game: Game; userById: Map<string, User> }) {
  const missing = game.requiredPlayers - game.playerIds.length;
  return (
    <article className="forming-row glass-panel">
      <div>
        <strong>{game.type}</strong>
        <span>{game.playerIds.length}/{game.requiredPlayers} players · Need {missing}</span>
      </div>
      <AvatarStack users={game.playerIds.map((id) => userById.get(id)!).filter(Boolean)} missing={missing} />
    </article>
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
