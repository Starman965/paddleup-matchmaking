import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { onAuthStateChanged, signInWithPopup, signOut, type User as FirebaseUser } from "firebase/auth";
import { QRCodeSVG } from "qrcode.react";
import {
  Calendar,
  ChevronRight,
  Home,
  MapPin,
  Plus,
  Search,
  Sparkles,
  Users,
  UserRound
} from "lucide-react";
import { currentUserId, games as seedGames, locations, playmates as seedPlaymates, users as seedUsers } from "./data";
import type { Availability, AvailabilityType, Game, Location, Playmate, TabKey, User, WebPushSubscription } from "./domain";
import { auth, googleProvider, initializeAnalytics, trackEvent } from "./firebase";
import {
  approveLocationSuggestion,
  assignGameCourt,
  getAdminDashboard,
  joinGame,
  listLocationSuggestions,
  leaveGame,
  markReadyNow,
  rejectLocationSuggestion,
  resetTestData,
  saveAvailabilityWindow,
  saveWebPushSubscription,
  setDefaultReadyNowDuration,
  setPlaymateEnabled,
  setUserHomeLocation,
  setUserHomeLocationPreference,
  setUserPresence,
  suggestLocation,
  subscribeLocationAvailability,
  subscribeLocationGames,
  subscribeLocationUsers,
  subscribeLocations,
  subscribeUser,
  subscribeUserGames,
  subscribeUserPlaymates,
  subscribeUserWebPushSubscriptions,
  updateGameStartTime,
  upsertLocation,
  uploadLocationPhoto,
  uploadProfilePhoto,
  upsertCurrentUser,
  type AdminDashboard,
  type AdminLocation,
  type AdminLocationSuggestion
} from "./firebaseDb";
import { getPwaInstallState, type PwaInstallState } from "./pwa";
import { hasPushVapidKey, requestWebPushSubscription } from "./pushNotifications";
import "./styles.css";

const locationById = new Map(locations.map((location) => [location.id, location]));
const appShareUrl = "https://paddleup-match-maker.web.app/";
const defaultCourtOptions = Array.from({ length: 10 }, (_, index) => `Court ${index + 1}`);
const matchLeadTimeMinutes = 30;
const gameCloseGraceMinutes = 15;
const startTimeEditGraceMinutes = 15;
const readyNowDurations = [30, 60, 90, 120];
const timeRoundingMinutes = 15;
const defaultBuildMetadata: BuildMetadata = {
  appVersion: "1.0",
  build: "1",
  version: "local",
  commit: "local"
};
const versionCheckIntervalMs = 10 * 60 * 1000;

type MatchFeedback = {
  type: Exclude<AvailabilityType, "weekend">;
  status: "idle" | "saving" | "waiting" | "forming" | "confirmed" | "alreadyActive" | "error";
  badge?: string;
  title: string;
  body: string;
  previousGameIds?: string[];
};

type PlayerTab = "looking" | "members" | "blocked";

type UserPresence = {
  label: string;
  detail: string;
  deadline?: string;
  tone: "offline" | "available" | "matching" | "matched";
};

type BuildMetadata = {
  appVersion: string;
  build: string;
  version: string;
  commit?: string;
};

type AppUpdateState = {
  appVersion: string;
  build: string;
  commit?: string;
  currentVersion?: string;
  latestVersion?: string;
  checkedAt?: number;
  status: "checking" | "current" | "available" | "updating" | "error";
  error?: string;
};

type AlertPermissionState = "unsupported" | "needsInstall" | "setupNeeded" | "off" | "allowedNoToken" | "on" | "blocked";

type WindowRange = {
  start: Date;
  end: Date;
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatBuildStamp(value?: string, commit?: string) {
  if (!value || value === "local") return commit ? `Local build · ${commit}` : "Local build";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return commit ? `Build ${value} · ${commit}` : `Build ${value}`;
  const formatted = new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
  return commit ? `Updated ${formatted} · ${commit}` : `Updated ${formatted}`;
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

function timeValue(date: Date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function roundUpDate(date: Date, incrementMinutes: number) {
  const incrementMs = incrementMinutes * 60 * 1000;
  return new Date(Math.ceil(date.getTime() / incrementMs) * incrementMs);
}

function nextAvailableTime(date = new Date()) {
  const rounded = roundUpDate(date, timeRoundingMinutes);
  return rounded > date ? rounded : new Date(rounded.getTime() + timeRoundingMinutes * 60 * 1000);
}

function availabilityWindowValidation(type: "laterToday" | "tomorrow", startTime: string, endTime: string) {
  const start = new Date(isoForTime(type, startTime));
  const end = new Date(isoForTime(type, endTime));
  const now = new Date();
  const minimumEnd = new Date(now.getTime() + matchLeadTimeMinutes * 60 * 1000);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Choose a valid start and end time.";
  if (end <= start) return "Choose an end time after the start time.";
  if (type === "laterToday" && start <= now) return "Choose a start time later than now.";
  if (type === "laterToday" && end <= minimumEnd) return "Choose an end time at least 30 minutes from now.";
  return "";
}

function readyNowDeadline(start: Date, durationMinutes: number) {
  return roundUpDate(new Date(start.getTime() + durationMinutes * 60 * 1000), timeRoundingMinutes);
}

function readBuildMetadata(value: unknown): BuildMetadata {
  if (!value || typeof value !== "object") return defaultBuildMetadata;
  const data = value as Record<string, unknown>;
  return {
    appVersion: typeof data.appVersion === "string" ? data.appVersion : defaultBuildMetadata.appVersion,
    build: typeof data.build === "string" ? data.build : defaultBuildMetadata.build,
    version: typeof data.version === "string" ? data.version : defaultBuildMetadata.version,
    commit: typeof data.commit === "string" ? data.commit : undefined
  };
}

function availabilityStatus(availability: Availability) {
  if (availability.type === "readyNow") return "Ready Now";
  return `${availability.type === "tomorrow" ? "Tomorrow" : "Today"} ${formatTime(availability.startTime)}-${formatTime(availability.endTime)}`;
}

function availabilityBadgeLabel(availability: Availability) {
  if (availability.type === "readyNow") return "Now";
  return availability.type === "tomorrow" ? "Tmrw" : "Today";
}

function dateBadgeLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Today";
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === now.toDateString()) return "Today";
  if (date.toDateString() === tomorrow.toDateString()) return "Tmrw";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
}

function gameBadgeLabel(game: Game) {
  const phase = gamePhase(game);
  if (phase === "live") return "Now";
  if (phase === "wrapping") return "Done";
  if (game.availabilityType === "readyNow") return "Now";
  return dateBadgeLabel(game.startsAt);
}

function readyNowGameLabel(game: Game) {
  if (!game.endsAt) return "Ready Now";
  const endsAt = new Date(game.endsAt);
  if (Number.isNaN(endsAt.getTime())) return "Ready Now";

  const remainingMinutes = Math.ceil((endsAt.getTime() - Date.now()) / 60000);
  if (remainingMinutes <= 0) return "Ready Now · closing now";
  if (remainingMinutes <= 15) return `Ready Now · ${remainingMinutes} min left`;
  return `Ready Now · until ${formatTime(game.endsAt)}`;
}

function gameTimeLabel(game: Game) {
  const window = gameWindow(game);
  const phase = gamePhase(game);
  if (game.status === "confirmed" && window && phase === "live") {
    return `Now · ${formatTime(window.start.toISOString())}-${formatTime(window.end.toISOString())}`;
  }
  if (game.status === "confirmed" && window && phase === "wrapping") {
    return `Wrapping Up · ${formatTime(window.start.toISOString())}-${formatTime(window.end.toISOString())}`;
  }
  if (game.status === "forming" && game.availabilityType === "readyNow") return readyNowGameLabel(game);
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

function gameSortTime(game: Game) {
  const window = gameWindow(game);
  return window?.start.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function gameEndTime(game: Game) {
  const window = gameWindow(game);
  return window?.end.getTime() ?? Number.MAX_SAFE_INTEGER;
}

function gamePhase(game: Game, nowMs = Date.now()) {
  const window = gameWindow(game);
  if (!window) return "upcoming";
  if (nowMs >= window.start.getTime() && nowMs <= window.end.getTime()) return "live";
  if (nowMs > window.end.getTime() && nowMs < window.end.getTime() + gameCloseGraceMinutes * 60 * 1000) return "wrapping";
  return nowMs < window.start.getTime() ? "upcoming" : "ended";
}

function availabilityStartTime(availability: Availability) {
  const start = new Date(availability.startTime).getTime();
  return Number.isNaN(start) ? Number.MAX_SAFE_INTEGER : start;
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

function isPastGameCloseGrace(game: Game, nowMs: number) {
  if (game.status !== "forming" && game.status !== "confirmed") return false;
  const window = gameWindow(game);
  if (!window) return false;
  return window.end.getTime() + gameCloseGraceMinutes * 60 * 1000 <= nowMs;
}

function matchDeadline(availability: Availability) {
  const endValue = availability.endTime || availability.expiresAt;
  if (!endValue) return undefined;
  const deadline = new Date(new Date(endValue).getTime() - matchLeadTimeMinutes * 60 * 1000);
  return Number.isNaN(deadline.getTime()) ? undefined : deadline;
}

function formatCountdown(deadline: Date, nowMs: number) {
  const remainingMinutes = Math.ceil((deadline.getTime() - nowMs) / 60000);
  if (remainingMinutes <= 0) return "closing";
  if (remainingMinutes < 60) return `${remainingMinutes}m left`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return minutes === 0 ? `${hours}h left` : `${hours}h ${minutes}m left`;
}

function matchDeadlineLabel(availability: Availability | undefined, nowMs: number) {
  if (!availability) return undefined;
  const deadline = matchDeadline(availability);
  if (!deadline) return undefined;
  return `Time remaining: ${formatCountdown(deadline, nowMs)}. By ${formatTime(deadline.toISOString())}`;
}

function activeGameForStatus(games: Game[], selectedGameId: string | null) {
  const activeGames = games.filter((game) => game.status === "forming" || game.status === "confirmed");
  const confirmed = activeGames
    .filter((game) => game.status === "confirmed")
    .sort((gameA, gameB) => gameSortTime(gameA) - gameSortTime(gameB));
  if (confirmed[0]) return confirmed[0];

  const selectedGame = selectedGameId ? activeGames.find((game) => game.id === selectedGameId) : undefined;
  if (selectedGame) return selectedGame;

  return activeGames
    .filter((game) => game.status === "forming")
    .sort((gameA, gameB) => {
      const missingA = Math.max(0, gameA.requiredPlayers - gameA.playerIds.length);
      const missingB = Math.max(0, gameB.requiredPlayers - gameB.playerIds.length);
      return missingA - missingB || gameEndTime(gameA) - gameEndTime(gameB);
    })[0];
}

function initials(user: User) {
  const first = user.firstName?.[0] || "P";
  const last = user.lastName?.[0] || "";
  return `${first}${last}`;
}

function shortPlayerName(user: User) {
  const firstName = user.firstName || user.email.split("@")[0] || "Player";
  const lastInitial = user.lastName?.[0] ? ` ${user.lastName[0]}.` : "";
  return `${firstName}${lastInitial}`;
}

function formatMatchType(type: Game["type"]) {
  return type === "singles" ? "Singles" : "Doubles";
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
    homeLocationId: locationId,
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

const adminEmail = "demandgendave@gmail.com";

function blankAdminLocation(): AdminLocation {
  return {
    id: "",
    name: "",
    city: "",
    state: "",
    country: "USA",
    imageUrl: "",
    type: "club",
    courtCount: 0,
    courtLabels: [],
    active: true
  };
}

function locationFromSuggestion(suggestion: AdminLocationSuggestion): AdminLocation {
  const courtCount = suggestion.courtCount || 0;
  return {
    id: "",
    name: suggestion.name,
    city: suggestion.city,
    state: suggestion.state,
    country: suggestion.country || "USA",
    imageUrl: "",
    type: "club",
    courtCount,
    courtLabels: courtCount > 0 ? Array.from({ length: courtCount }, (_, index) => `Court ${index + 1}`) : [],
    active: true
  };
}

function AdminApp() {
  const [adminUser, setAdminUser] = useState<FirebaseUser | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [suggestions, setSuggestions] = useState<AdminLocationSuggestion[]>([]);
  const [adminStatus, setAdminStatus] = useState("Sign in to manage PaddleUp.");
  const [loading, setLoading] = useState(false);
  const [resetConfirmText, setResetConfirmText] = useState("");

  useEffect(() => {
    document.documentElement.classList.add("admin-page");
    return () => document.documentElement.classList.remove("admin-page");
  }, []);

  useEffect(() => onAuthStateChanged(auth, (user) => {
    setAdminUser(user);
    setAuthReady(true);
  }), []);

  const isAdmin = adminUser?.email === adminEmail;

  async function loadAdminData() {
    if (!isAdmin) return;
    setLoading(true);
    try {
      const [nextDashboard, nextSuggestions] = await Promise.all([getAdminDashboard(), listLocationSuggestions()]);
      setDashboard(nextDashboard);
      setSuggestions(nextSuggestions);
      setAdminStatus("Admin data loaded.");
    } catch (error) {
      setAdminStatus(error instanceof Error ? `Admin load failed: ${error.message}` : "Admin load failed.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isAdmin) void loadAdminData();
  }, [isAdmin]);

  function signInAdmin() {
    signInWithPopup(auth, googleProvider).catch((error: Error) => setAdminStatus(`Admin sign-in failed: ${error.message}`));
  }

  function signOutAdmin() {
    signOut(auth).catch((error: Error) => setAdminStatus(`Admin sign-out failed: ${error.message}`));
  }

  async function approveSuggestion(suggestionId: string, location: AdminLocation) {
    setLoading(true);
    try {
      await approveLocationSuggestion(suggestionId, location);
      setAdminStatus("Location approved and added.");
      await loadAdminData();
    } catch (error) {
      setAdminStatus(error instanceof Error ? `Approval failed: ${error.message}` : "Approval failed.");
    } finally {
      setLoading(false);
    }
  }

  async function rejectSuggestion(suggestionId: string) {
    setLoading(true);
    try {
      await rejectLocationSuggestion(suggestionId);
      setAdminStatus("Location suggestion rejected.");
      await loadAdminData();
    } catch (error) {
      setAdminStatus(error instanceof Error ? `Reject failed: ${error.message}` : "Reject failed.");
    } finally {
      setLoading(false);
    }
  }

  async function saveLocation(location: AdminLocation) {
    setLoading(true);
    try {
      await upsertLocation(location);
      setAdminStatus("Location saved.");
      await loadAdminData();
    } catch (error) {
      setAdminStatus(error instanceof Error ? `Location save failed: ${error.message}` : "Location save failed.");
    } finally {
      setLoading(false);
    }
  }

  async function resetBetaData() {
    if (resetConfirmText !== "RESET BETA DATA") {
      setAdminStatus("Type RESET BETA DATA before resetting beta activity.");
      return;
    }

    setLoading(true);
    try {
      const result = await resetTestData();
      setResetConfirmText("");
      await loadAdminData();
      setAdminStatus(
        `Deleted ${result.games} games, ${result.availability} availability records, and ${result.notifications} notification history records. User alert settings were preserved.`
      );
    } catch (error) {
      setAdminStatus(error instanceof Error ? `Beta reset failed: ${error.message}` : "Beta reset failed.");
    } finally {
      setLoading(false);
    }
  }

  if (!authReady) return <main className="admin-shell"><p>Loading admin...</p></main>;

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <div>
          <span>PaddleUp Admin</span>
          <h1>Admin Portal</h1>
          <p>{adminStatus}</p>
        </div>
        {adminUser ? (
          <button onClick={signOutAdmin}>Sign Out</button>
        ) : (
          <button onClick={signInAdmin}>Admin Sign in with Google</button>
        )}
      </header>

      {adminUser && !isAdmin && (
        <section className="admin-panel">
          <h2>Admin access required</h2>
          <p>Signed in as {adminUser.email}. Use {adminEmail}.</p>
        </section>
      )}

      {!adminUser && (
        <section className="admin-panel">
          <h2>Sign in required</h2>
          <p>Use your admin Google account to manage locations and view beta metrics.</p>
        </section>
      )}

      {isAdmin && (
        <>
          <section className="admin-grid">
            <AdminMetric label="Users" value={dashboard?.users ?? 0} />
            <AdminMetric label="Games" value={dashboard?.games ?? 0} />
            <AdminMetric label="Forming" value={dashboard?.formingGames ?? 0} />
            <AdminMetric label="Confirmed" value={dashboard?.confirmedGames ?? 0} />
            <AdminMetric label="Completed" value={dashboard?.completedGames ?? 0} />
            <AdminMetric label="Locations" value={dashboard?.locations ?? 0} />
            <AdminMetric label="Pending Suggestions" value={dashboard?.pendingLocationSuggestions ?? 0} />
          </section>

          <section className="admin-panel">
            <div className="admin-section-title">
              <h2>Location Suggestions</h2>
              <button disabled={loading} onClick={() => void loadAdminData()}>Refresh</button>
            </div>
            {suggestions.length === 0 && <p>No pending suggestions.</p>}
            <div className="admin-stack">
              {suggestions.map((suggestion) => (
                <AdminSuggestionCard
                  key={suggestion.id}
                  suggestion={suggestion}
                  disabled={loading}
                  onApprove={approveSuggestion}
                  onReject={rejectSuggestion}
                />
              ))}
            </div>
          </section>

          <section className="admin-panel admin-danger-panel">
            <h2>Beta Data Reset</h2>
            <p>
              Clears only beta activity: games, availability, and generated notification history. Users, locations, uploaded photos,
              location suggestions, and notification opt-in settings stay intact.
            </p>
            <label className="admin-confirm-field">
              <span>Type RESET BETA DATA to confirm</span>
              <input
                value={resetConfirmText}
                onChange={(event) => setResetConfirmText(event.target.value)}
                placeholder="RESET BETA DATA"
              />
            </label>
            <button
              className="admin-danger"
              disabled={loading || resetConfirmText !== "RESET BETA DATA"}
              onClick={() => void resetBetaData()}
            >
              Reset Beta Data
            </button>
          </section>

          <section className="admin-panel">
            <h2>Create Location</h2>
            <AdminLocationForm initialLocation={blankAdminLocation()} submitLabel="Create Location" disabled={loading} onSubmit={saveLocation} />
          </section>

          <section className="admin-panel">
            <h2>Manage Locations</h2>
            <div className="admin-stack">
              {(dashboard?.locationRows ?? []).map((location) => (
                <AdminLocationForm key={location.id} initialLocation={location} submitLabel="Save Location" disabled={loading} onSubmit={saveLocation} />
              ))}
            </div>
          </section>
        </>
      )}
    </main>
  );
}

function AdminMetric({ label, value }: { label: string; value: number }) {
  return (
    <article className="admin-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </article>
  );
}

function AdminSuggestionCard({
  suggestion,
  disabled,
  onApprove,
  onReject
}: {
  suggestion: AdminLocationSuggestion;
  disabled: boolean;
  onApprove: (suggestionId: string, location: AdminLocation) => Promise<void>;
  onReject: (suggestionId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AdminLocation>(() => locationFromSuggestion(suggestion));
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  async function uploadPhoto(file: File) {
    const fallbackId = draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const locationId = draft.id.trim() || fallbackId;
    if (!locationId) return;

    setUploadingPhoto(true);
    const objectUrl = URL.createObjectURL(file);
    try {
      const photo = await cropImageToWebp(objectUrl, 1);
      const imageUrl = await uploadLocationPhoto(locationId, photo);
      setDraft((current) => ({ ...current, id: current.id || locationId, imageUrl }));
    } finally {
      URL.revokeObjectURL(objectUrl);
      setUploadingPhoto(false);
    }
  }

  return (
    <article className="admin-card">
      <div className="admin-card-heading">
        <div>
          <strong>{suggestion.name}</strong>
          <span>{[suggestion.city, suggestion.state, suggestion.country].filter(Boolean).join(", ")}</span>
        </div>
        <small>{suggestion.createdAt ? new Date(suggestion.createdAt).toLocaleString() : "Pending"}</small>
      </div>
      <p className="admin-helper">Edit details below before approving. The approved values become the new location.</p>
      <AdminLocationPhotoField location={draft} uploading={uploadingPhoto} onUpload={(file) => void uploadPhoto(file)} />
      <AdminLocationFields location={draft} onChange={setDraft} />
      <div className="admin-actions">
        <button disabled={disabled} onClick={() => void onApprove(suggestion.id, draft)}>Approve</button>
        <button className="admin-danger" disabled={disabled} onClick={() => void onReject(suggestion.id)}>Reject</button>
      </div>
    </article>
  );
}

function AdminLocationForm({
  initialLocation,
  submitLabel,
  disabled,
  onSubmit
}: {
  initialLocation: AdminLocation;
  submitLabel: string;
  disabled: boolean;
  onSubmit: (location: AdminLocation) => Promise<void>;
}) {
  const [draft, setDraft] = useState<AdminLocation>(initialLocation);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  useEffect(() => setDraft(initialLocation), [initialLocation.id, initialLocation.name]);

  async function uploadPhoto(file: File) {
    const fallbackId = draft.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const locationId = draft.id.trim() || fallbackId;
    if (!locationId) return;

    setUploadingPhoto(true);
    const objectUrl = URL.createObjectURL(file);
    try {
      const photo = await cropImageToWebp(objectUrl, 1);
      const imageUrl = await uploadLocationPhoto(locationId, photo);
      setDraft((current) => ({ ...current, id: current.id || locationId, imageUrl }));
    } finally {
      URL.revokeObjectURL(objectUrl);
      setUploadingPhoto(false);
    }
  }

  return (
    <article className="admin-card">
      <AdminLocationPhotoField location={draft} uploading={uploadingPhoto} onUpload={(file) => void uploadPhoto(file)} />
      <AdminLocationFields location={draft} onChange={setDraft} />
      <button disabled={disabled} onClick={() => void onSubmit(draft)}>{submitLabel}</button>
    </article>
  );
}

function AdminLocationPhotoField({
  location,
  uploading,
  onUpload
}: {
  location: AdminLocation;
  uploading: boolean;
  onUpload: (file: File) => void;
}) {
  const inputId = `location-photo-${location.id || location.name || "new"}`.replace(/[^a-zA-Z0-9_-]/g, "-");

  return (
    <div className="admin-location-photo">
      <span className="admin-location-photo-preview">
        <LocationAvatar location={location} />
      </span>
      <div>
        <strong>Location Photo</strong>
        <p>Upload a photo for this location. It will appear on location cards.</p>
        <label htmlFor={inputId}>{uploading ? "Uploading..." : "Choose Photo"}</label>
        <input
          id={inputId}
          type="file"
          accept="image/*"
          disabled={uploading}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) onUpload(file);
            event.currentTarget.value = "";
          }}
        />
      </div>
    </div>
  );
}

function AdminLocationFields({ location, onChange }: { location: AdminLocation; onChange: (location: AdminLocation) => void }) {
  const courtLabelsText = (location.courtLabels ?? []).join("\n");
  const setField = (field: keyof AdminLocation, value: string | number | boolean | string[]) => onChange({ ...location, [field]: value });

  return (
    <div className="admin-form">
      <label>
        <span>Location ID</span>
        <input value={location.id} onChange={(event) => setField("id", event.target.value)} placeholder="Optional, auto-created if blank" />
      </label>
      <label>
        <span>Location Name</span>
        <input value={location.name} onChange={(event) => setField("name", event.target.value)} placeholder="PIKL Los Angeles" />
      </label>
      <label>
        <span>City</span>
        <input value={location.city || ""} onChange={(event) => setField("city", event.target.value)} placeholder="Los Angeles" />
      </label>
      <label>
        <span>State / Region</span>
        <input value={location.state || ""} onChange={(event) => setField("state", event.target.value)} placeholder="CA" />
      </label>
      <label>
        <span>Country</span>
        <input value={location.country || ""} onChange={(event) => setField("country", event.target.value)} placeholder="USA" />
      </label>
      <label>
        <span>Image URL</span>
        <input value={location.imageUrl || ""} onChange={(event) => setField("imageUrl", event.target.value)} placeholder="Uploaded photo URL" />
      </label>
      <label>
        <span>Type</span>
        <select value={location.type} onChange={(event) => setField("type", event.target.value)}>
          <option value="club">Club</option>
          <option value="publicCourt">Public Court</option>
          <option value="resort">Resort</option>
          <option value="destination">Destination</option>
        </select>
      </label>
      <label>
        <span>Court Count</span>
        <input
          value={location.courtCount || ""}
          onChange={(event) => setField("courtCount", Number(event.target.value))}
          inputMode="numeric"
          placeholder="12"
        />
      </label>
      <label className="admin-full-field">
        <span>Court Labels</span>
        <textarea
          value={courtLabelsText}
          onChange={(event) => setField("courtLabels", event.target.value.split(/\n|,/).map((value) => value.trim()).filter(Boolean))}
          placeholder="Court 1&#10;Court 2&#10;Court 3"
        />
      </label>
      <label className="admin-checkbox">
        <input checked={location.active !== false} onChange={(event) => setField("active", event.target.checked)} type="checkbox" />
        Active
      </label>
    </div>
  );
}

function App() {
  if (window.location.pathname === "/admin") return <AdminApp />;

  const [activeTab, setActiveTab] = useState<TabKey>("home");
  const [playerTab, setPlayerTab] = useState<PlayerTab>("looking");
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
  const [liveLocations, setLiveLocations] = useState<Location[]>(locations);
  const [currentUserProfile, setCurrentUserProfile] = useState<User | undefined>();
  const [liveUsers, setLiveUsers] = useState<User[]>([]);
  const [liveGames, setLiveGames] = useState<Game[]>([]);
  const [liveUserGames, setLiveUserGames] = useState<Game[]>([]);
  const [liveAvailability, setLiveAvailability] = useState<Availability[]>([]);
  const [liveWebPushSubscriptions, setLiveWebPushSubscriptions] = useState<WebPushSubscription[]>([]);
  const [courtPickerGame, setCourtPickerGame] = useState<Game | null>(null);
  const [courtChoice, setCourtChoice] = useState(defaultCourtOptions[0]);
  const [customCourt, setCustomCourt] = useState("");
  const [assigningCourt, setAssigningCourt] = useState(false);
  const [joiningGameId, setJoiningGameId] = useState<string | null>(null);
  const [leavingGameId, setLeavingGameId] = useState<string | null>(null);
  const [updatingStartTimeGameId, setUpdatingStartTimeGameId] = useState<string | null>(null);
  const [activeLocation, setActiveLocation] = useState(locations[0]);
  const [locationSearch, setLocationSearch] = useState("");
  const [matchFeedback, setMatchFeedback] = useState<MatchFeedback | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [photoEditorOpen, setPhotoEditorOpen] = useState(false);
  const [onlineSheetOpen, setOnlineSheetOpen] = useState(false);
  const [locationSuggestionOpen, setLocationSuggestionOpen] = useState(false);
  const [suggestLocationName, setSuggestLocationName] = useState("");
  const [suggestLocationCity, setSuggestLocationCity] = useState("");
  const [suggestLocationState, setSuggestLocationState] = useState("");
  const [suggestLocationCountry, setSuggestLocationCountry] = useState("");
  const [suggestLocationCourtCount, setSuggestLocationCourtCount] = useState("");
  const [suggestingLocation, setSuggestingLocation] = useState(false);
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);
  const [readyNowSheetOpen, setReadyNowSheetOpen] = useState(false);
  const [readyNowDraftDuration, setReadyNowDraftDuration] = useState(duration);
  const [windowSheetType, setWindowSheetType] = useState<"laterToday" | "tomorrow" | null>(null);
  const [windowDraftStart, setWindowDraftStart] = useState(laterTodayStart);
  const [windowDraftEnd, setWindowDraftEnd] = useState(laterTodayEnd);
  const [windowDraftError, setWindowDraftError] = useState("");
  const [durationHydratedForUser, setDurationHydratedForUser] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [pwaInstallState, setPwaInstallState] = useState<PwaInstallState>(() => getPwaInstallState());
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() => ("Notification" in window ? Notification.permission : "default"));
  const [pushBusy, setPushBusy] = useState(false);
  const [appUpdate, setAppUpdate] = useState<AppUpdateState>({
    appVersion: defaultBuildMetadata.appVersion,
    build: defaultBuildMetadata.build,
    commit: defaultBuildMetadata.commit,
    currentVersion: defaultBuildMetadata.version,
    status: "checking"
  });
  const loadedVersionRef = useRef<string | null>(null);
  const autoUpdateAttemptedRef = useRef(false);

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
    const refreshPwaState = () => setPwaInstallState(getPwaInstallState());
    const refreshPermission = () => {
      if ("Notification" in window) setNotificationPermission(Notification.permission);
    };
    refreshPwaState();
    refreshPermission();
    window.addEventListener("focus", refreshPwaState);
    window.addEventListener("focus", refreshPermission);
    document.addEventListener("visibilitychange", refreshPwaState);
    document.addEventListener("visibilitychange", refreshPermission);
    return () => {
      window.removeEventListener("focus", refreshPwaState);
      window.removeEventListener("focus", refreshPermission);
      document.removeEventListener("visibilitychange", refreshPwaState);
      document.removeEventListener("visibilitychange", refreshPermission);
    };
  }, []);

  useEffect(() => {
    const check = () => {
      if (document.visibilityState !== "hidden") void checkForAppUpdate();
    };

    check();
    const timer = window.setInterval(check, versionCheckIntervalMs);
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, [activeTab, readyNowSheetOpen, windowSheetType, courtPickerGame, photoEditorOpen, onlineSheetOpen, joiningGameId, leavingGameId, updatingStartTimeGameId]);

  useEffect(() => {
    if (!firebaseUser) {
      setCurrentUserProfile(undefined);
      return undefined;
    }

    return subscribeUser(
      firebaseUser.uid,
      setCurrentUserProfile,
      (error) => setFirebaseStatus(`Profile read failed: ${error.message}`)
    );
  }, [firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) {
      setLiveLocations(locations);
      setActiveLocation(locations[0]);
      return undefined;
    }

    return subscribeLocations(
      (nextLocations) => setLiveLocations(nextLocations.length ? nextLocations : locations),
      (error) => setFirebaseStatus(`Locations read failed: ${error.message}`)
    );
  }, [firebaseUser]);

  useEffect(() => {
    const preferredLocationId = currentUserProfile?.homeLocationId || currentUserProfile?.locationId || activeLocation.id;
    const nextLocation = liveLocations.find((location) => location.id === activeLocation.id) || liveLocations.find((location) => location.id === preferredLocationId) || locations[0];
    setActiveLocation(nextLocation);
  }, [activeLocation.id, currentUserProfile?.homeLocationId, currentUserProfile?.locationId, liveLocations]);

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
      setLiveUserGames([]);
      return undefined;
    }

    return subscribeUserGames(
      firebaseUser.uid,
      setLiveUserGames,
      (error) => setFirebaseStatus(`My Games read failed: ${error.message}`)
    );
  }, [firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) {
      setPlaymateState(seedPlaymates);
      return undefined;
    }

    return subscribeUserPlaymates(
      firebaseUser.uid,
      setPlaymateState,
      (error) => setFirebaseStatus(`Players read failed: ${error.message}`)
    );
  }, [firebaseUser]);

  useEffect(() => {
    if (!firebaseUser) {
      setLiveWebPushSubscriptions([]);
      return undefined;
    }

    return subscribeUserWebPushSubscriptions(
      firebaseUser.uid,
      setLiveWebPushSubscriptions,
      (error) => setFirebaseStatus(`Alert subscription read failed: ${error.message}`)
    );
  }, [firebaseUser]);

  const allUsers = useMemo(() => {
    const userMap = new Map<string, User>();
    if (!firebaseUser) {
      seedUsers.forEach((user) => userMap.set(user.uid, user));
    }
    liveUsers.forEach((user) => userMap.set(user.uid, user));
    if (currentUserProfile) userMap.set(currentUserProfile.uid, currentUserProfile);
    if (firebaseUser) userMap.set(firebaseUser.uid, userMap.get(firebaseUser.uid) || userFromFirebase(firebaseUser, activeLocation.id));
    return Array.from(userMap.values());
  }, [activeLocation.id, currentUserProfile, firebaseUser, liveUsers]);

  const userById = useMemo(() => new Map(allUsers.map((user) => [user.uid, user])), [allUsers]);
  const activeUserId = firebaseUser?.uid || currentUserId;
  const liveCurrentUser = firebaseUser ? currentUserProfile || liveUsers.find((user) => user.uid === firebaseUser.uid) : undefined;
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
  const activeAvailabilityByUserId = useMemo(() => {
    const now = Date.now();
    const earliestAvailabilityByUserId = new Map<string, Availability>();
    liveAvailability
      .filter((availability) => !availability.expiresAt || new Date(availability.expiresAt).getTime() > now)
      .forEach((availability) => {
        const existing = earliestAvailabilityByUserId.get(availability.userId);
        if (!existing || availabilityStartTime(availability) < availabilityStartTime(existing)) {
          earliestAvailabilityByUserId.set(availability.userId, availability);
        }
      });
    return earliestAvailabilityByUserId;
  }, [liveAvailability]);
  const playmateIds = useMemo(() => {
    if (!firebaseUser) return new Set(playmateState.filter((p) => p.enabled).map((p) => p.playmateId));
    const disabledPlaymateIds = new Set(playmateState.filter((p) => !p.enabled).map((p) => p.playmateId));
    return new Set(allUsers.filter((user) => user.uid !== activeUserId && !disabledPlaymateIds.has(user.uid)).map((user) => user.uid));
  }, [activeUserId, allUsers, firebaseUser, playmateState]);
  const blockedPlayerIds = useMemo(() => new Set(playmateState.filter((p) => !p.enabled).map((p) => p.playmateId)), [playmateState]);

  const displayGames = useMemo(
    () => {
      const sourceGames = firebaseUser ? liveGames : seedGames;
      return sourceGames.filter((game) => !isPastGameCloseGrace(game, nowMs));
    },
    [firebaseUser, liveGames, nowMs]
  );
  const myGames = useMemo(
    () => {
      const sourceGames = firebaseUser ? liveUserGames : displayGames.filter((game) => game.playerIds.includes(activeUserId));
      return sourceGames.filter((game) => !isPastGameCloseGrace(game, nowMs));
    },
    [activeUserId, displayGames, firebaseUser, liveUserGames, nowMs]
  );
  const activeGameByUserId = useMemo(() => {
    const activeGames = displayGames.filter((game) => game.status === "forming" || game.status === "confirmed").sort((gameA, gameB) => {
      if (gameA.status === "confirmed" && gameB.status !== "confirmed") return -1;
      if (gameB.status === "confirmed" && gameA.status !== "confirmed") return 1;
      return gameSortTime(gameA) - gameSortTime(gameB);
    });
    const gameByUserId = new Map<string, Game>();
    activeGames.forEach((game) => {
      game.playerIds.forEach((playerId) => {
        if (!gameByUserId.has(playerId)) gameByUserId.set(playerId, game);
      });
    });
    return gameByUserId;
  }, [displayGames]);
  const visiblePlayers = useMemo(() => {
    const search = playerSearch.trim().toLowerCase();
    return allUsers
      .filter((user) => {
        const isSelf = user.uid === activeUserId;
        const isBlocked = blockedPlayerIds.has(user.uid);
        const hasAvailability = activeAvailabilityByUserId.has(user.uid);
        const hasActiveGame = activeGameByUserId.has(user.uid);
        const isVisible = isSelf || user.presence !== "offline";
        const isAtLocation = user.locationId === activeLocation.id;
        const isLooking = hasAvailability || hasActiveGame;

        if (playerTab === "blocked") return !isSelf && isBlocked;
        if (!isVisible || !isAtLocation || isBlocked) return false;
        if (playerTab === "looking") return isLooking;
        return !isLooking;
      })
      .filter((user) => {
        if (!search) return true;
        return `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(search);
      })
      .sort((userA, userB) => {
        if (userA.uid === activeUserId) return -1;
        if (userB.uid === activeUserId) return 1;
        return `${userA.firstName} ${userA.lastName}`.localeCompare(`${userB.firstName} ${userB.lastName}`);
      });
  }, [activeLocation.id, activeUserId, activeGameByUserId, allUsers, activeAvailabilityByUserId, blockedPlayerIds, playerSearch, playerTab]);
  const activeMyGames = useMemo(
    () => myGames.filter((game) => game.status === "forming" || game.status === "confirmed"),
    [myGames]
  );
  const nextGame = displayGames.find((game) => game.status === "confirmed" && game.playerIds.includes(activeUserId));
  const selectedGame = selectedGameId ? myGames.find((game) => game.id === selectedGameId) : undefined;
  const statusGame = useMemo(() => activeGameForStatus(myGames, selectedGameId), [myGames, selectedGameId]);
  const courtOptions = activeLocation.courtLabels?.length ? activeLocation.courtLabels : defaultCourtOptions;
  const selectedCourt = courtChoice === "Other" ? customCourt.trim() : courtChoice;
  const alertPermissionState: AlertPermissionState = useMemo(() => {
    if (!("Notification" in window) || !("serviceWorker" in navigator) || !("PushManager" in window)) return "unsupported";
    if (!pwaInstallState.isStandalone) return "needsInstall";
    if (!hasPushVapidKey()) return "setupNeeded";
    if (notificationPermission === "denied") return "blocked";
    if (liveWebPushSubscriptions.some((subscription) => subscription.enabled)) return "on";
    if (notificationPermission === "granted") return "allowedNoToken";
    return "off";
  }, [liveWebPushSubscriptions, notificationPermission, pwaInstallState.isStandalone]);
  const currentUserAvailability = activeAvailabilityByUserId.get(activeUserId);
  const currentPresence: UserPresence = useMemo(() => {
    const activeGame = statusGame;
    const deadline = matchDeadlineLabel(currentUserAvailability, nowMs);
    if (activeGame?.status === "confirmed") {
      const phase = gamePhase(activeGame, nowMs);
      return { label: phase === "live" ? "Game On" : phase === "wrapping" ? "Wrapping Up" : "Game Confirmed", detail: gameTimeLabel(activeGame), tone: "matched" };
    }
    if (activeGame?.status === "forming") {
      const missing = Math.max(0, activeGame.requiredPlayers - activeGame.playerIds.length);
      const timeLeft = activeGame.endsAt ? formatCountdown(new Date(activeGame.endsAt), nowMs) : undefined;
      return {
        label: "Getting Matched",
        detail: `${activeGame.playerIds.length}/${activeGame.requiredPlayers} in${missing > 0 ? ` · ${missing} needed` : ""}`,
        deadline: timeLeft,
        tone: "matching"
      };
    }
    if (currentUserAvailability?.type === "readyNow") {
      return { label: "Looking For Players", detail: "Ready Now", deadline, tone: "available" };
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
    return { label: "Want a Match?", detail: "Click Find Me Players to play", tone: "offline" };
  }, [currentUser.presence, currentUserAvailability, nowMs, statusGame]);
  useEffect(() => {
    if (!firebaseUser) {
      setDurationHydratedForUser(null);
      return;
    }
    if (durationHydratedForUser === activeUserId) return;
    if (!liveCurrentUser) return;
    const savedDuration = liveCurrentUser.defaultReadyNowDuration;
    if ([30, 60, 90, 120].includes(savedDuration ?? 0)) {
      setDuration(savedDuration!);
    }
    setDurationHydratedForUser(activeUserId);
  }, [activeUserId, durationHydratedForUser, firebaseUser, liveCurrentUser]);

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
        if (selectedGameId === gameId) setSelectedGameId(null);
        setFirebaseStatus("You left the game. Other players have been notified.");
      })
      .catch((error: Error) => setFirebaseStatus(`Leaving game failed: ${error.message}`))
      .finally(() => setLeavingGameId(null));
  }

  function joinSelectedGame(game: Game) {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can join a match.");
      return;
    }

    const targetWindow = gameWindow(game);
    if (!targetWindow) {
      setFirebaseStatus("This match does not have a valid play window yet.");
      return;
    }

    const overlappingGame = activeGameOverlappingWindow(activeMyGames, targetWindow);
    if (overlappingGame) {
      setMatchFeedback({
        type: (overlappingGame.availabilityType ?? game.availabilityType ?? "readyNow") as Exclude<AvailabilityType, "weekend">,
        status: "alreadyActive",
        badge: "Conflict",
        title: "You're Already Booked",
        body: "You already have a match during that time."
      });
      setFirebaseStatus("You are already in a match during that time window.");
      return;
    }

    const matchType = (game.availabilityType ?? "readyNow") as Exclude<AvailabilityType, "weekend">;
    setJoiningGameId(game.id);
    setMatchFeedback({
      type: matchType,
      status: "saving",
      title: "Joining Match",
      body: `Trying to join the ${gameTimeLabel(game)} match.`,
      previousGameIds: displayGames.filter((displayGame) => displayGame.status === "forming" || displayGame.status === "confirmed").map((displayGame) => displayGame.id)
    });

    joinGame(game.id)
      .then(() => {
        trackEvent("game_joined", { gameId: game.id, availabilityType: game.availabilityType ?? "readyNow" });
        setSelectedGameId(game.id);
        setActiveTab("games");
        setFirebaseStatus("You joined the match.");
      })
      .catch((error: Error) => {
        setMatchFeedback({
          type: matchType,
          status: "error",
          title: "Join Failed",
          body: error.message
        });
        setFirebaseStatus(`Join failed: ${error.message}`);
      })
      .finally(() => setJoiningGameId(null));
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
        badge: "Conflict",
        title: "You're Already Booked",
        body: "You already have a match during that time."
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
    const validation = availabilityWindowValidation(type, startTime, endTime);
    if (validation) {
      setMatchFeedback({
        type,
        status: "error",
        title: "Choose A Future Time",
        body: validation
      });
      setFirebaseStatus(validation);
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
    const readyNowEnd = readyNowDeadline(readyNowStart, durationMinutes);
    if (!beginMatchingFeedback("readyNow", { start: readyNowStart, end: readyNowEnd })) return;

    if (currentUser.presence === "offline") {
      setUserPresence(firebaseUser.uid, "visible").catch((error: Error) => setFirebaseStatus(`Presence update failed: ${error.message}`));
    }

    trackEvent("ready_now_clicked", { durationMinutes, locationId: activeLocation.id });
    markReadyNow(firebaseUser.uid, activeLocation.id, durationMinutes, readyNowEnd.toISOString())
      .then(() => {
        trackEvent("availability_created", { type: "readyNow", durationMinutes, locationId: activeLocation.id });
        setFirebaseStatus(`Ready Now saved. PaddleUp will look for a match that starts by ${formatTime(readyNowEnd.toISOString())}.`);
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

    if (type === "laterToday") {
      const nextStart = nextAvailableTime();
      const savedStart = new Date(isoForTime("laterToday", laterTodayStart));
      const start = savedStart > nextStart ? savedStart : nextStart;
      const savedEnd = new Date(isoForTime("laterToday", laterTodayEnd));
      const end = savedEnd > new Date(start.getTime() + matchLeadTimeMinutes * 60 * 1000)
        ? savedEnd
        : new Date(start.getTime() + 60 * 60 * 1000);

      setWindowDraftStart(timeValue(start));
      setWindowDraftEnd(timeValue(end));
    } else {
      setWindowDraftStart(tomorrowStart);
      setWindowDraftEnd(tomorrowEnd);
    }
    setWindowDraftError("");
    setWindowSheetType(type);
  }

  function confirmReadyNowDuration() {
    setDuration(readyNowDraftDuration);
    setReadyNowSheetOpen(false);
    startReadyNowMatching(readyNowDraftDuration);
  }

  function confirmWindowAvailability() {
    if (!windowSheetType) return;
    const validation = availabilityWindowValidation(windowSheetType, windowDraftStart, windowDraftEnd);
    if (validation) {
      setWindowDraftError(validation);
      setFirebaseStatus(validation);
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
      .then(() => setFirebaseStatus(enabled ? "Player unblocked." : "Player blocked."))
      .catch((error: Error) => setFirebaseStatus(`Player update failed: ${error.message}`));
  }

  function canAutoApplyUpdate() {
    const passiveTab = activeTab === "home" || activeTab === "me";
    const noOpenSheet = !readyNowSheetOpen && !windowSheetType && !courtPickerGame && !photoEditorOpen && !onlineSheetOpen;
    const noPendingAction = !joiningGameId && !leavingGameId && !updatingStartTimeGameId && !assigningCourt;
    return passiveTab && noOpenSheet && noPendingAction;
  }

  async function checkForAppUpdate(manual = false) {
    if (manual) {
      setAppUpdate((current) => ({ ...current, status: "checking", error: undefined }));
    }

    try {
      const response = await fetch(`/version.json?ts=${Date.now()}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Version check failed.");
      const metadata = readBuildMetadata(await response.json());
      if (!loadedVersionRef.current) loadedVersionRef.current = metadata.version;
      const currentVersion = loadedVersionRef.current;
      const updateAvailable = metadata.version !== currentVersion;
      setAppUpdate({
        appVersion: metadata.appVersion,
        build: metadata.build,
        commit: metadata.commit,
        currentVersion,
        latestVersion: metadata.version,
        checkedAt: Date.now(),
        status: updateAvailable ? "available" : "current"
      });

      if (updateAvailable && canAutoApplyUpdate() && !autoUpdateAttemptedRef.current) {
        autoUpdateAttemptedRef.current = true;
        window.setTimeout(() => void updateAppNow(), 600);
      }
    } catch (error) {
      setAppUpdate((current) => ({
        ...current,
        checkedAt: Date.now(),
        status: "error",
        error: error instanceof Error ? error.message : "Version check failed."
      }));
    }
  }

  async function updateAppNow() {
    setAppUpdate((current) => ({ ...current, status: "updating", error: undefined }));
    try {
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration?.update();
        if (registration?.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, 1500);
            navigator.serviceWorker.addEventListener(
              "controllerchange",
              () => {
                window.clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
        }
      }
    } finally {
      window.location.reload();
    }
  }

  async function enableMatchAlerts() {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can turn on match alerts.");
      return;
    }
    if (!pwaInstallState.isStandalone) {
      setFirebaseStatus("Add PaddleUp to your Home Screen first, then open it from the icon.");
      return;
    }

    setPushBusy(true);
    try {
      const subscription = await requestWebPushSubscription();
      await saveWebPushSubscription({
        userId: firebaseUser.uid,
        locationId: activeLocation.id,
        subscription,
        platform: pwaInstallState.platform,
        browser: pwaInstallState.browser,
        standalone: pwaInstallState.isStandalone
      });

      if ("Notification" in window) setNotificationPermission(Notification.permission);
      trackEvent("match_alerts_enabled", { locationId: activeLocation.id, platform: pwaInstallState.platform });
      setFirebaseStatus("Match alerts are on for this device.");
    } catch (error) {
      if ("Notification" in window) setNotificationPermission(Notification.permission);
      setFirebaseStatus(error instanceof Error ? error.message : "Could not turn on match alerts.");
    } finally {
      setPushBusy(false);
    }
  }

  async function shareSelectedGame(game: Game) {
    const inviteUrl = "https://paddleup-match-maker.web.app/";
    const text = `I am looking for a doubles pickleball game on PaddleUp at ${activeLocation.name}. Join here:`;
    const safariHint = "On iPhone, open the link in Safari.";
    const fallbackText = `${text} ${inviteUrl}`;

    try {
      if (navigator.share) {
        await navigator.share({
          title: "Join me on PaddleUp",
          text: `${text}\n${safariHint}`,
          url: inviteUrl
        });
        trackEvent("match_invite_shared", { gameId: game.id, locationId: game.locationId, method: "native" });
        setFirebaseStatus("Invite shared.");
        return;
      }

      if (navigator.clipboard) {
        await navigator.clipboard.writeText(`${fallbackText}\n${safariHint}`);
        trackEvent("match_invite_shared", { gameId: game.id, locationId: game.locationId, method: "clipboard" });
        setFirebaseStatus("Invite copied. Paste it into WhatsApp or a text.");
        return;
      }

      setFirebaseStatus(fallbackText);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setFirebaseStatus(error instanceof Error ? `Invite share failed: ${error.message}` : "Invite share failed.");
    }
  }

  function switchActiveLocation(location: Location) {
    setActiveLocation(location);
    setSelectedGameId(null);
    setMatchFeedback(null);
    setFirebaseStatus(`Now viewing ${location.name}.`);
    trackEvent("location_switched", { locationId: location.id });
    const canRefreshPushSilently =
      firebaseUser &&
      "Notification" in window &&
      Notification.permission === "granted" &&
      liveWebPushSubscriptions.some((subscription) => subscription.enabled);

    if (canRefreshPushSilently) {
      requestWebPushSubscription()
        .then((subscription) =>
          saveWebPushSubscription({
            userId: firebaseUser.uid,
            locationId: location.id,
            subscription,
            platform: pwaInstallState.platform,
            browser: pwaInstallState.browser,
            standalone: pwaInstallState.isStandalone
          })
        )
        .catch(() => undefined);
    }
  }

  function chooseHomeLocation(location: Location) {
    if (!firebaseUser) return;
    setUserHomeLocation(firebaseUser.uid, location.id)
      .then(() => {
        switchActiveLocation(location);
        setFirebaseStatus(`${location.name} set as your home location.`);
      })
      .catch((error: Error) => setFirebaseStatus(`Home location save failed: ${error.message}`));
  }

  function chooseOtherHomeLocation() {
    if (!firebaseUser) return;
    setUserHomeLocationPreference(firebaseUser.uid, "other")
      .then(() => {
        setFirebaseStatus("Other set as your main play location.");
      })
      .catch((error: Error) => setFirebaseStatus(`Main play location save failed: ${error.message}`));
  }

  function resetLocationSuggestionForm() {
    setSuggestLocationName("");
    setSuggestLocationCity("");
    setSuggestLocationState("");
    setSuggestLocationCountry("");
    setSuggestLocationCourtCount("");
  }

  function closeLocationSuggestion() {
    if (suggestingLocation) return;
    setLocationSuggestionOpen(false);
  }

  async function submitLocationSuggestion() {
    if (!firebaseUser) {
      setFirebaseStatus("Sign in first, then you can suggest a location.");
      return;
    }

    const name = suggestLocationName.trim();
    const city = suggestLocationCity.trim();
    const state = suggestLocationState.trim();
    const country = suggestLocationCountry.trim();
    const courtCount = Number(suggestLocationCourtCount);

    if (!name || !city) {
      setFirebaseStatus("Add at least the location name and city.");
      return;
    }

    setSuggestingLocation(true);
    try {
      await suggestLocation({
        userId: firebaseUser.uid,
        name,
        city,
        state,
        country,
        courtCount: Number.isFinite(courtCount) && courtCount > 0 ? courtCount : undefined
      });
      trackEvent("location_suggested", { locationId: activeLocation.id });
      setFirebaseStatus("Thanks. New locations are reviewed and added in less than 24 hours.");
      resetLocationSuggestionForm();
      setLocationSuggestionOpen(false);
    } catch (error) {
      setFirebaseStatus(error instanceof Error ? `Location suggestion failed: ${error.message}` : "Location suggestion failed.");
    } finally {
      setSuggestingLocation(false);
    }
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
    { key: "locations" as const, label: "Locations", icon: MapPin },
    { key: "me" as const, label: "Profile", icon: UserRound }
  ];

  if (!firebaseUser) {
    return (
      <main className="app-shell">
        <div className="phone-frame signed-out-frame">
          <SignedOutScreen onSignIn={signIn} status={firebaseStatus} pwaInstallState={pwaInstallState} />
        </div>
      </main>
    );
  }

  if (currentUserProfile && !currentUserProfile.homeLocationId) {
    return (
      <main className="app-shell">
        <div className="phone-frame">
          <section className="screen first-run-screen">
            <LocationHomePicker locations={liveLocations} onChoose={chooseHomeLocation} onChooseOther={chooseOtherHomeLocation} />
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="app-shell">
      <div className="phone-frame">
        <header className="top-bar">
          <button className={`identity-button ${firebaseUser ? "" : "signed-out"}`} onClick={firebaseUser ? () => setPhotoEditorOpen(true) : signIn}>
            {firebaseUser ? <Avatar user={currentUser} /> : "Sign in with Google"}
          </button>
          <div>
            <h1>{activeTab === "home" ? "PaddleUp" : nav.find((item) => item.key === activeTab)?.label}</h1>
            <p className="location-kicker"><MapPin size={13} /> {activeLocation.name}</p>
          </div>
          <OnlinePill count={onlinePlayerCount} onClick={() => setOnlineSheetOpen(true)} />
        </header>

        <section className="screen">
          {activeTab === "home" && (
            <HomeScreen
              nextGame={nextGame}
              activeGame={statusGame}
              games={displayGames}
              userById={userById}
              activeUserId={activeUserId}
              presence={currentPresence}
              matchFeedback={matchFeedback}
              nowMs={nowMs}
              joiningGameId={joiningGameId}
              onSetTab={setActiveTab}
              onChooseAvailability={chooseHomeAvailability}
              onViewGame={viewSelectedGame}
              onAssignCourt={openCourtPicker}
              onJoinGame={joinSelectedGame}
              onDismissFeedback={() => setMatchFeedback(null)}
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
              blockedPlayerIds={blockedPlayerIds}
              availabilityByUserId={activeAvailabilityByUserId}
              activeGameByUserId={activeGameByUserId}
              onToggle={togglePlaymate}
            />
          )}
          {activeTab === "locations" && (
            <LocationsScreen
              locations={liveLocations}
              activeLocation={activeLocation}
              homeLocationId={currentUser.homeLocationId || currentUser.locationId}
              search={locationSearch}
              onSearch={setLocationSearch}
              onSelect={switchActiveLocation}
              onSuggestLocation={() => setLocationSuggestionOpen(true)}
            />
          )}
          {activeTab === "games" && (
            <GamesScreen
              games={myGames}
              selectedGame={selectedGame}
              userById={userById}
              locations={liveLocations}
              activeUserId={activeUserId}
              nowMs={nowMs}
              leavingGameId={leavingGameId}
              updatingStartTimeGameId={updatingStartTimeGameId}
              onAssignCourt={openCourtPicker}
              onLeaveGame={leaveSelectedGame}
              onShareGame={shareSelectedGame}
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
              pwaInstallState={pwaInstallState}
              appUpdate={appUpdate}
              alertPermissionState={alertPermissionState}
              pushBusy={pushBusy}
              locations={liveLocations}
              onCheckForUpdate={() => void checkForAppUpdate(true)}
              onUpdateApp={() => void updateAppNow()}
              onEnableAlerts={() => void enableMatchAlerts()}
              isOffline={currentUser.presence === "offline"}
              onTogglePresence={togglePresence}
              onSetHomeLocation={chooseHomeLocation}
              onSetOtherHomeLocation={chooseOtherHomeLocation}
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
            activeGameByUserId={activeGameByUserId}
            onClose={() => setOnlineSheetOpen(false)}
          />
        )}
        {readyNowSheetOpen && (
          <ReadyNowSheet
            duration={readyNowDraftDuration}
            nowMs={nowMs}
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
            error={windowDraftError}
            onStartTimeChange={(time) => {
              setWindowDraftError("");
              setWindowDraftStart(time);
            }}
            onEndTimeChange={(time) => {
              setWindowDraftError("");
              setWindowDraftEnd(time);
            }}
            onClose={() => setWindowSheetType(null)}
            onConfirm={confirmWindowAvailability}
          />
        )}
        {locationSuggestionOpen && (
          <LocationSuggestionSheet
            name={suggestLocationName}
            city={suggestLocationCity}
            state={suggestLocationState}
            country={suggestLocationCountry}
            courtCount={suggestLocationCourtCount}
            submitting={suggestingLocation}
            onName={setSuggestLocationName}
            onCity={setSuggestLocationCity}
            onState={setSuggestLocationState}
            onCountry={setSuggestLocationCountry}
            onCourtCount={setSuggestLocationCourtCount}
            onClose={closeLocationSuggestion}
            onSubmit={() => void submitLocationSuggestion()}
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

function SignedOutScreen({ onSignIn, status, pwaInstallState }: { onSignIn: () => void; status: string; pwaInstallState: PwaInstallState }) {
  const showStatus = status.startsWith("Sign-in failed") || status.includes("unauthorized-domain");
  const shouldRecommendSafari = pwaInstallState.shouldSuggestOpenInSafari;
  const appUrl = "https://paddleup-match-maker.web.app/";
  const copySafariLink = () => {
    if (!navigator.clipboard) return;
    void navigator.clipboard.writeText(appUrl);
  };
  return (
    <section className="signed-out-screen">
      <div className="signed-out-brand">
        <img className="signin-logo" src="/paddleup-logo.png" alt="" />
        <h1>PaddleUp</h1>
        <p>Find pickleball players when you are ready to play.</p>
      </div>
      {shouldRecommendSafari && (
        <div className="safari-guidance">
          <strong>iPhone tip: use Safari.</strong>
          <p>Google sign-in works here, but Home Screen install and match alerts need Safari.</p>
          <span>Copy this link, open Safari, and paste it there. You can still sign in here if you only want to try PaddleUp.</span>
          <button type="button" onClick={copySafariLink}>Copy Link</button>
        </div>
      )}
      <button className="signed-out-button" onClick={onSignIn}>
        Sign in with Google
      </button>
      <p className="signed-out-note">Sign in first. Match alerts are set up later after you add PaddleUp to your Home Screen.</p>
      {showStatus && <p className="signed-out-status">{status}</p>}
    </section>
  );
}

function locationSubtitle(location: Location) {
  const place = [location.city, location.state, location.country].filter(Boolean).join(", ");
  return place || location.subtitle || "PaddleUp location";
}

function locationCourtLabel(location: Location) {
  const count = location.courtLabels?.length || location.courtCount || 0;
  if (!count) return "Courts TBD";
  return `${count} ${count === 1 ? "court" : "courts"}`;
}

function locationTypeLabel(type: Location["type"]) {
  if (type === "publicCourt") return "Public";
  if (type === "resort") return "Resort";
  if (type === "destination") return "Destination";
  return "Club";
}

function LocationAvatar({ location }: { location: Location }) {
  if (location.imageUrl) {
    return <img src={location.imageUrl} alt="" />;
  }
  return <MapPin size={24} />;
}

function LocationListItem({
  location,
  isActive,
  isHome,
  actionLabel,
  onSelect
}: {
  location: Location;
  isActive?: boolean;
  isHome?: boolean;
  actionLabel: string;
  onSelect: () => void;
}) {
  return (
    <button className={`location-row ${isActive ? "active" : ""} ${isHome ? "home" : ""}`} onClick={onSelect}>
      <span className="location-row-select">
        <span className="location-thumb">
          <LocationAvatar location={location} />
        </span>
        <span className="location-row-main">
          <strong>{location.name}</strong>
          <span>{locationSubtitle(location)}</span>
          <small>{locationCourtLabel(location)} · {locationTypeLabel(location.type)}</small>
        </span>
      </span>
      <span className="location-row-action">
        <strong>{isActive ? "Current" : actionLabel}</strong>
      </span>
    </button>
  );
}

function LocationHomePicker({
  locations,
  onChoose,
  onChooseOther
}: {
  locations: Location[];
  onChoose: (location: Location) => void;
  onChooseOther: () => void;
}) {
  return (
    <div className="stack home-location-picker">
      <section className="location-intro">
        <span><MapPin size={20} /></span>
        <h2>Main Play Location</h2>
        <p>Pick your home court location.</p>
      </section>
      <div className="location-list">
        {locations.map((location) => (
          <LocationListItem
            key={location.id}
            location={location}
            actionLabel="Choose"
            onSelect={() => onChoose(location)}
          />
        ))}
        <button className="location-row other-location-row" onClick={onChooseOther}>
          <span className="location-row-select">
            <span className="location-thumb">
              <Plus size={23} />
            </span>
            <span className="location-row-main">
              <strong>Other</strong>
              <span>My location is not listed yet</span>
              <small>You can switch locations later</small>
            </span>
          </span>
          <span className="location-row-action">
            <strong>Choose</strong>
          </span>
        </button>
      </div>
    </div>
  );
}

function LocationsScreen({
  locations,
  activeLocation,
  homeLocationId,
  search,
  onSearch,
  onSelect,
  onSuggestLocation
}: {
  locations: Location[];
  activeLocation: Location;
  homeLocationId?: string;
  search: string;
  onSearch: (value: string) => void;
  onSelect: (location: Location) => void;
  onSuggestLocation: () => void;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const filteredLocations = locations.filter((location) =>
    `${location.name} ${location.city || ""} ${location.state || ""} ${location.country || ""}`.toLowerCase().includes(normalizedSearch)
  );

  return (
    <div className="stack">
      <section className="glass-panel current-location-card">
        <span className="location-thumb large">
          <LocationAvatar location={activeLocation} />
        </span>
        <div>
          <span>Current Location</span>
          <strong>{activeLocation.name}</strong>
          <p>{locationSubtitle(activeLocation)} · {locationCourtLabel(activeLocation)}</p>
        </div>
      </section>
      <div className="location-search-row">
        <label className="search-wrap">
          <Search size={17} />
          <input value={search} onChange={(event) => onSearch(event.target.value)} placeholder="Search locations" />
        </label>
        <button className="location-add-button" onClick={onSuggestLocation} aria-label="Suggest location">
          <Plus size={19} />
        </button>
      </div>
      <div className="location-list">
        {filteredLocations.map((location) => (
          <LocationListItem
            key={location.id}
            location={location}
            isActive={location.id === activeLocation.id}
            isHome={location.id === homeLocationId}
            actionLabel="Switch"
            onSelect={() => onSelect(location)}
          />
        ))}
      </div>
      {filteredLocations.length === 0 && <p className="empty-copy">No locations found.</p>}
    </div>
  );
}

function LocationSuggestionSheet({
  name,
  city,
  state,
  country,
  courtCount,
  submitting,
  onName,
  onCity,
  onState,
  onCountry,
  onCourtCount,
  onClose,
  onSubmit
}: {
  name: string;
  city: string;
  state: string;
  country: string;
  courtCount: string;
  submitting: boolean;
  onName: (value: string) => void;
  onCity: (value: string) => void;
  onState: (value: string) => void;
  onCountry: (value: string) => void;
  onCourtCount: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet location-suggestion-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Suggest a location" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="Suggest a Location" action="Close" onClick={onClose} />
        <p>New locations are reviewed and added in less than 24 hours.</p>
        <div className="suggestion-form">
          <input value={name} onChange={(event) => onName(event.target.value)} placeholder="Location name" />
          <input value={city} onChange={(event) => onCity(event.target.value)} placeholder="City" />
          <input value={state} onChange={(event) => onState(event.target.value)} placeholder="State / region" />
          <input value={country} onChange={(event) => onCountry(event.target.value)} placeholder="Country" />
          <input value={courtCount} onChange={(event) => onCourtCount(event.target.value)} inputMode="numeric" placeholder="Number of courts (optional)" />
        </div>
        <button className="primary-sheet-action" disabled={submitting || !name.trim() || !city.trim()} onClick={onSubmit}>
          {submitting ? "Submitting..." : "Submit Location"}
        </button>
      </section>
    </div>
  );
}

function HomeScreen({
  nextGame,
  activeGame,
  games,
  userById,
  activeUserId,
  presence,
  matchFeedback,
  nowMs,
  joiningGameId,
  onSetTab,
  onChooseAvailability,
  onViewGame,
  onAssignCourt,
  onJoinGame,
  onDismissFeedback
}: {
  nextGame?: Game;
  activeGame?: Game;
  games: Game[];
  userById: Map<string, User>;
  activeUserId: string;
  presence: UserPresence;
  matchFeedback: MatchFeedback | null;
  nowMs: number;
  joiningGameId: string | null;
  onSetTab: (tab: TabKey) => void;
  onChooseAvailability: (mode: Exclude<AvailabilityType, "weekend">) => void;
  onViewGame: (game: Game) => void;
  onAssignCourt: (game: Game) => void;
  onJoinGame: (game: Game) => void;
  onDismissFeedback: () => void;
}) {
  const forming = games.filter((game) => game.status === "forming");
  const visibleMatchFeedback =
    matchFeedback && matchFeedback.status !== "forming" && matchFeedback.status !== "confirmed" ? matchFeedback : null;

  return (
    <div className="stack">
      <StatusCard presence={presence} game={activeGame} userById={userById} />
      <section className="hero-cta glass-panel">
        <div className="hero-title">
          <Sparkles className="spark" size={24} />
          <p>Want to play now or soon?</p>
        </div>
        <button className="hero-primary" onClick={() => onChooseAvailability("readyNow")}>
          <strong>Find Me Players</strong>
          <span>Start playing soon. PaddleUp will match you with available players.</span>
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

      {visibleMatchFeedback && <MatchFeedbackCard feedback={visibleMatchFeedback} onDismiss={onDismissFeedback} />}

      {nextGame && (
        <button className="next-game-card" onClick={() => onViewGame(nextGame)}>
          <span>Next Game</span>
          <GameCard
            game={nextGame}
            userById={userById}
            activeUserId={activeUserId}
            nowMs={nowMs}
            compact
            onAssignCourt={(event) => {
              event.stopPropagation();
              onAssignCourt(nextGame);
            }}
          />
        </button>
      )}

      <section className="stack">
        <SectionTitle title="Matches Forming" />
        {forming.length === 0 && <p className="empty-copy">No matches forming right now. Tap Find Me Players when you want to play.</p>}
        {forming.map((game) => (
          <FormingGame
            key={game.id}
            game={game}
            userById={userById}
            activeUserId={activeUserId}
            isJoining={joiningGameId === game.id}
            onView={() => onViewGame(game)}
            onJoin={() => onJoinGame(game)}
          />
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
  blockedPlayerIds,
  availabilityByUserId,
  activeGameByUserId,
  onToggle
}: {
  playerTab: PlayerTab;
  setPlayerTab: (tab: PlayerTab) => void;
  search: string;
  setSearch: (search: string) => void;
  visiblePlayers: User[];
  activeUserId: string;
  blockedPlayerIds: Set<string>;
  availabilityByUserId: Map<string, Availability>;
  activeGameByUserId: Map<string, Game>;
  onToggle: (uid: string) => void;
}) {
  const emptyCopy =
    playerTab === "looking"
      ? "No one is looking right now."
      : playerTab === "blocked"
        ? "No blocked players."
        : "No members found.";
  return (
    <div className="stack">
      <Segmented
        value={playerTab}
        options={[
          ["looking", "Looking"],
          ["members", "Members"],
          ["blocked", "Blocked"]
        ]}
        onChange={(value) => setPlayerTab(value as PlayerTab)}
      />
      <label className="search glass-panel">
        <Search size={17} />
        <input value={search} placeholder={`Search ${playerTab}`} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="list glass-panel">
        {visiblePlayers.length === 0 && <p className="empty-copy">{emptyCopy}</p>}
        {visiblePlayers.map((user) => {
          const isSelf = user.uid === activeUserId;
          const isBlocked = blockedPlayerIds.has(user.uid);
          const activeGame = activeGameByUserId.get(user.uid);
          const availability = availabilityByUserId.get(user.uid);
          const statusCopy = user.presence === "offline" ? "Offline" : activeGame ? gameTimeLabel(activeGame) : availability ? availabilityStatus(availability) : locationById.get(user.locationId)?.name;
          return (
            <article className={`player-row ${isSelf ? "self" : ""}`} key={user.uid}>
              <Avatar user={user} />
              <div>
                <strong>{user.firstName} {user.lastName}{isSelf ? " · You" : ""}</strong>
                <span>{statusCopy}</span>
              </div>
              {user.presence === "offline" ? (
                <span className="availability-badge muted">Off</span>
              ) : activeGame ? (
                <span className="availability-badge">{gameBadgeLabel(activeGame)}</span>
              ) : availability && (
                <span className="availability-badge">{availabilityBadgeLabel(availability)}</span>
              )}
              {!isSelf && (
                <button className={`player-action ${isBlocked ? "blocked" : ""}`} onClick={() => onToggle(user.uid)} aria-label={isBlocked ? "Unblock player" : "Block player"}>
                  {isBlocked ? "Unblock" : "Block"}
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
  locations,
  activeUserId,
  nowMs,
  leavingGameId,
  updatingStartTimeGameId,
  onAssignCourt,
  onLeaveGame,
  onShareGame,
  onUpdateStartTime
}: {
  games: Game[];
  selectedGame?: Game;
  userById: Map<string, User>;
  locations: Location[];
  activeUserId: string;
  nowMs: number;
  leavingGameId: string | null;
  updatingStartTimeGameId: string | null;
  onAssignCourt: (game: Game) => void;
  onLeaveGame: (gameId: string) => void;
  onShareGame: (game: Game) => void;
  onUpdateStartTime: (game: Game, time: string) => void;
}) {
  const selectedGameCard = selectedGame && (selectedGame.status === "forming" || selectedGame.status === "confirmed") ? selectedGame : undefined;
  const selectedGameId = selectedGameCard?.id;
  const selectedFirst = (gameA: Game, gameB: Game) => {
    if (gameA.id === selectedGameId) return -1;
    if (gameB.id === selectedGameId) return 1;
    return gameSortTime(gameA) - gameSortTime(gameB);
  };
  const forming = games.filter((game) => game.status === "forming").sort(selectedFirst);
  const confirmed = games.filter((game) => game.status === "confirmed").sort(selectedFirst);
  const hasGames = forming.length > 0 || confirmed.length > 0;

  return (
    <div className="stack">
      {!hasGames && <p className="empty-copy">No games yet.</p>}
      {forming.length > 0 && <SectionTitle title="Forming" />}
      {forming.map((game) => (
        <GameCard
          key={game.id}
          game={game}
          userById={userById}
          locations={locations}
          showLocation
          activeUserId={activeUserId}
          nowMs={nowMs}
          isSelected={game.id === selectedGameId}
          isLeaving={leavingGameId === game.id}
          isUpdatingStartTime={updatingStartTimeGameId === game.id}
          onAssignCourt={() => onAssignCourt(game)}
          onLeaveGame={() => onLeaveGame(game.id)}
          onShareGame={() => onShareGame(game)}
          onUpdateStartTime={(time) => onUpdateStartTime(game, time)}
        />
      ))}
      {confirmed.length > 0 && <SectionTitle title="Confirmed" />}
      {confirmed.map((game) => (
        <GameCard
          key={game.id}
          game={game}
          userById={userById}
          locations={locations}
          showLocation
          activeUserId={activeUserId}
          nowMs={nowMs}
          isSelected={game.id === selectedGameId}
          isLeaving={leavingGameId === game.id}
          isUpdatingStartTime={updatingStartTimeGameId === game.id}
          onAssignCourt={() => onAssignCourt(game)}
          onLeaveGame={() => onLeaveGame(game.id)}
          onShareGame={() => onShareGame(game)}
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
  activeGameByUserId,
  onClose
}: {
  players: User[];
  activeUserId: string;
  availabilityByUserId: Map<string, Availability>;
  activeGameByUserId: Map<string, Game>;
  onClose: () => void;
}) {
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet online-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Online players" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="Online Now" action="Close" onClick={onClose} />
        <div className="online-list">
          {players.length === 0 && <p className="empty-copy">No players are online right now.</p>}
          {players.map((user) => {
            const activeGame = activeGameByUserId.get(user.uid);
            const availability = availabilityByUserId.get(user.uid);
            const statusCopy = activeGame ? gameTimeLabel(activeGame) : availability ? availabilityStatus(availability) : locationById.get(user.locationId)?.name;
            return (
              <article className="online-player-row" key={user.uid}>
                <Avatar user={user} />
                <div>
                  <strong>{user.firstName} {user.lastName}{user.uid === activeUserId ? " · You" : ""}</strong>
                  <span>{statusCopy}</span>
                </div>
                {activeGame ? (
                  <span className="availability-badge">{gameBadgeLabel(activeGame)}</span>
                ) : availability && (
                  <span className="availability-badge">{availabilityBadgeLabel(availability)}</span>
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
  nowMs,
  onDurationChange,
  onClose,
  onConfirm
}: {
  duration: number;
  nowMs: number;
  onDurationChange: (duration: number) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const selectedDeadline = readyNowDeadline(new Date(nowMs), duration);
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Ready Now window" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="When Can You Start?" action="Close" onClick={onClose} />
        <p>Include time to get to the court.</p>
        <div className="duration-grid">
          {readyNowDurations.map((minutes) => (
            <button key={minutes} className={duration === minutes ? "selected" : ""} onClick={() => onDurationChange(minutes)}>
              {minutes}<span>min</span>
            </button>
          ))}
        </div>
        <p className="ready-now-summary">Start by: <strong>{formatTime(selectedDeadline.toISOString())}</strong></p>
        <button className="primary-action" onClick={onConfirm}>
          Find Me Players
        </button>
      </section>
    </div>
  );
}

function AvailabilityWindowSheet({
  type,
  startTime,
  endTime,
  error,
  onStartTimeChange,
  onEndTimeChange,
  onClose,
  onConfirm
}: {
  type: "laterToday" | "tomorrow";
  startTime: string;
  endTime: string;
  error?: string;
  onStartTimeChange: (time: string) => void;
  onEndTimeChange: (time: string) => void;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const title = type === "tomorrow" ? "Play Tomorrow" : "Play Later Today";
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet glass-panel" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
        <SectionTitle title={title} action="Close" onClick={onClose} />
        <p>When can you start?</p>
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
        {error && <p className="sheet-error">{error}</p>}
        <button className="primary-action" onClick={onConfirm}>
          Find Me Players
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
  pwaInstallState,
  appUpdate,
  alertPermissionState,
  pushBusy,
  locations,
  onCheckForUpdate,
  onUpdateApp,
  onEnableAlerts,
  isOffline,
  onTogglePresence,
  onSetHomeLocation,
  onSetOtherHomeLocation,
  onEditPhoto
}: {
  currentUser: User;
  firebaseUser: FirebaseUser | null;
  onSignIn: () => void;
  onSignOut: () => void;
  duration: number;
  setDuration: (duration: number) => void;
  pwaInstallState: PwaInstallState;
  appUpdate: AppUpdateState;
  alertPermissionState: AlertPermissionState;
  pushBusy: boolean;
  locations: Location[];
  onCheckForUpdate: () => void;
  onUpdateApp: () => void;
  onEnableAlerts: () => void;
  isOffline: boolean;
  onTogglePresence: () => void;
  onSetHomeLocation: (location: Location) => void;
  onSetOtherHomeLocation: () => void;
  onEditPhoto: () => void;
}) {
  const [installGuideOpen, setInstallGuideOpen] = useState(false);
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  const [shareStatus, setShareStatus] = useState("");
  const installTitle = pwaInstallState.isStandalone
    ? "PaddleUp is Installed"
    : pwaInstallState.shouldSuggestOpenInSafari
      ? "Open in Safari for alerts"
      : "How to Get Match Alerts";
  const installBody = pwaInstallState.isStandalone
    ? "You now have the app as a Home Screen app."
    : pwaInstallState.shouldSuggestOpenInSafari
      ? "On iPhone, open PaddleUp in Safari and add it to your Home Screen."
      : pwaInstallState.platform === "ios"
        ? "Add PaddleUp as a Home Screen Icon so you get Notifications."
        : pwaInstallState.platform === "android"
          ? "Install PaddleUp so match alerts are easier to find when they launch."
          : "Install PaddleUp from your browser menu for quick access.";
  const updateTitle = appUpdate.status === "available" ? "App update available" : appUpdate.status === "updating" ? "Updating PaddleUp" : "PaddleUp is up to date";
  const updateBody =
    appUpdate.status === "available"
      ? "Tap to refresh PaddleUp."
      : appUpdate.status === "error"
        ? "Could not check for updates."
        : appUpdate.checkedAt
          ? `Last checked ${formatTime(new Date(appUpdate.checkedAt).toISOString())}.`
          : "Checking for the latest build.";
  const alertTitle =
    alertPermissionState === "on"
      ? "Match Alerts are On"
      : alertPermissionState === "blocked"
        ? "Notifications are blocked"
        : alertPermissionState === "allowedNoToken"
          ? "Finish Match Alerts"
          : "Match Alerts";
  const alertBody =
    alertPermissionState === "on"
      ? "You will get notified when matches need you."
      : alertPermissionState === "needsInstall"
        ? "Add PaddleUp to your Home Screen first."
        : alertPermissionState === "setupNeeded"
          ? "Push setup needs a Firebase Web Push key."
          : alertPermissionState === "allowedNoToken"
            ? "Notifications are allowed. Tap again to finish setup."
            : alertPermissionState === "blocked"
              ? "Turn notifications back on in Safari settings."
              : alertPermissionState === "unsupported"
                ? "This browser does not support match alerts."
                : "Get notified when matches need your attention.";
  const canEnableAlerts = alertPermissionState === "off" || alertPermissionState === "allowedNoToken";
  const homeLocationId = currentUser.homeLocationId || currentUser.locationId;
  async function sharePaddleUpLink() {
    const text = "Join me on PaddleUp. On iPhone, open in Safari for the best app experience.";
    try {
      if (navigator.share) {
        await navigator.share({ title: "Join PaddleUp", text, url: appShareUrl });
        setShareStatus("Shared.");
        return;
      }
      await copyPaddleUpLink();
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setShareStatus(error instanceof Error ? `Share failed: ${error.message}` : "Share failed.");
    }
  }

  async function copyPaddleUpLink() {
    if (!navigator.clipboard) {
      setShareStatus(appShareUrl);
      return;
    }
    await navigator.clipboard.writeText(appShareUrl);
    setShareStatus("Link copied.");
  }

  return (
    <>
    <div className="stack">
      <section className="account-panel glass-panel">
        <button className="avatar-edit-button" onClick={firebaseUser ? onEditPhoto : onSignIn} aria-label="Edit profile photo">
          <Avatar user={currentUser} />
        </button>
        <div>
          <strong>{firebaseUser ? `${currentUser.firstName} ${currentUser.lastName}` : "PaddleUp Matchmaking"}</strong>
          <span>{firebaseUser ? "Tap photo to change." : "Sign in to save availability and matches."}</span>
        </div>
        <div className="account-actions">
          <button onClick={firebaseUser ? onSignOut : onSignIn}>{firebaseUser ? "Sign Out" : "Sign in with Google"}</button>
          {firebaseUser && (
            <button className="visibility-toggle" onClick={onTogglePresence}>
              {isOffline ? "Go Visible" : "Go Offline"}
            </button>
          )}
        </div>
      </section>
      <section className="glass-panel update-panel share-app-panel">
        <div>
          <strong>Share PaddleUp with Friends</strong>
          <p>Click Share for a QR code to show them.</p>
        </div>
        <button onClick={() => setShareSheetOpen(true)}>Share</button>
      </section>
      <section className="glass-panel preference-panel">
        <SectionTitle title="Default Location" />
        <p>Pick your home court location</p>
        <select
          className="profile-location-select"
          value={homeLocationId}
          disabled={!firebaseUser}
          onChange={(event) => {
            if (event.target.value === "other") {
              onSetOtherHomeLocation();
              return;
            }
            const nextLocation = locations.find((location) => location.id === event.target.value);
            if (nextLocation) onSetHomeLocation(nextLocation);
          }}
        >
          {locations.map((location) => (
            <option key={location.id} value={location.id}>{location.name}</option>
          ))}
          <option value="other">Other</option>
        </select>
      </section>
      <section className="glass-panel preference-panel">
        <SectionTitle title="Default Ready Now Setting" />
        <p>Your default start-by window, including time to get to the court.</p>
        <div className="duration-grid compact">
          {readyNowDurations.map((minutes) => (
            <button key={minutes} className={duration === minutes ? "selected" : ""} onClick={() => setDuration(minutes)}>
              {minutes}<span>min</span>
            </button>
          ))}
        </div>
      </section>
      <section className="glass-panel install-tip">
        <img src="/paddleup-logo.png" alt="" />
        <div>
          <strong>{installTitle}</strong>
          <p>{installBody}</p>
          {!pwaInstallState.isStandalone && (
            <div className="install-actions">
              <button onClick={() => setInstallGuideOpen(true)}>Show Me How</button>
            </div>
          )}
        </div>
      </section>
      <section className={`glass-panel update-panel alert-panel ${alertPermissionState === "on" ? "enabled" : ""}`}>
        <div>
          <strong>{alertTitle}</strong>
          <p>{alertBody}</p>
        </div>
        <button disabled={!canEnableAlerts || pushBusy} onClick={onEnableAlerts}>
          {pushBusy ? "Turning On" : alertPermissionState === "on" ? "On" : alertPermissionState === "allowedNoToken" ? "Finish" : "Allow Alerts"}
        </button>
      </section>
      <section className={`glass-panel update-panel ${appUpdate.status === "available" ? "available" : ""}`}>
        <div>
          <strong>{updateTitle}</strong>
          <p>{updateBody}</p>
        </div>
        {appUpdate.status === "available" ? (
          <button onClick={onUpdateApp}>Update Now</button>
        ) : (
          <button disabled={appUpdate.status === "checking" || appUpdate.status === "updating"} onClick={onCheckForUpdate}>
            {appUpdate.status === "checking" ? "Checking" : appUpdate.status === "updating" ? "Updating" : "Check"}
          </button>
        )}
      </section>
      <section className="app-info">
        <p>V {appUpdate.appVersion}, Build {appUpdate.build}</p>
        <p>{formatBuildStamp(appUpdate.currentVersion, appUpdate.commit)}</p>
        <p>Created by David Lewis</p>
        <p>Copyright 2026. All rights reserved.</p>
      </section>
    </div>
    {installGuideOpen && <InstallGuideSheet pwaInstallState={pwaInstallState} onClose={() => setInstallGuideOpen(false)} />}
    {shareSheetOpen && (
      <SharePaddleUpSheet
        status={shareStatus}
        onClose={() => setShareSheetOpen(false)}
        onShare={() => void sharePaddleUpLink()}
        onCopy={() => void copyPaddleUpLink()}
      />
    )}
    </>
  );
}

function SharePaddleUpSheet({
  status,
  onClose,
  onShare,
  onCopy
}: {
  status: string;
  onClose: () => void;
  onShare: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet share-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Share PaddleUp" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="Share PaddleUp" action="Close" onClick={onClose} />
        <div className="qr-card">
          <QRCodeSVG value={appShareUrl} size={190} marginSize={2} />
        </div>
        <strong>Scan to join PaddleUp</strong>
        <p>On iPhone, open in Safari. Sign in first, then add PaddleUp to the Home Screen for match alerts.</p>
        <div className="share-sheet-actions">
          <button className="primary-action" onClick={onShare}>Share Link</button>
          <button className="ghost-action" onClick={onCopy}>Copy Link</button>
        </div>
        {status && <p className="share-status">{status}</p>}
      </section>
    </div>
  );
}

function InstallGuideSheet({ pwaInstallState, onClose }: { pwaInstallState: PwaInstallState; onClose: () => void }) {
  const isAndroid = pwaInstallState.platform === "android";
  const steps = isAndroid
    ? ["Tap the browser menu", "Tap Add to Home screen", "Open PaddleUp from the new icon"]
    : ["Tap the Share button", "Scroll if needed", "Tap Add to Home Screen", "Tap Add", "Open PaddleUp from the new icon"];

  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet install-guide glass-panel" role="dialog" aria-modal="true" aria-label="How to get match alerts" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="How to Get Match Alerts" action="Close" onClick={onClose} />
        <p>Add PaddleUp as a Home Screen app first. Then open it from the icon to turn on match alerts.</p>
        <div className="install-guide-steps">
          {steps.map((step, index) => (
            <article key={step}>
              <span>{index + 1}</span>
              <strong>{step}</strong>
            </article>
          ))}
        </div>
      </section>
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

function StatusCard({ presence, game }: { presence: UserPresence; game?: Game; userById?: Map<string, User> }) {
  return (
    <section className={`status-card glass-panel ${presence.tone} ${game ? "with-game" : ""}`}>
      <div className="status-copy">
        <span className="status-pill">{presence.label}</span>
        {presence.detail && <strong>{presence.detail}</strong>}
        {presence.deadline && <p>{presence.deadline}</p>}
        {game?.court && <p className="status-court">{game.court}</p>}
      </div>
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

function MatchFeedbackCard({ feedback, onDismiss }: { feedback: MatchFeedback; onDismiss?: () => void }) {
  const badge = feedback.badge ?? (feedback.type === "readyNow" ? "Ready Now" : feedback.type === "tomorrow" ? "Tomorrow" : "Later Today");
  return (
    <section className={`match-feedback glass-panel ${feedback.status}`}>
      <span>{badge}</span>
      <strong>{feedback.title}</strong>
      <p>{feedback.body}</p>
      {feedback.status === "alreadyActive" && onDismiss && (
        <button className="feedback-action" onClick={onDismiss}>
          OK
        </button>
      )}
    </section>
  );
}

function GameCard({
  game,
  userById,
  locations: gameLocations,
  showLocation,
  compact,
  activeUserId,
  nowMs,
  isSelected,
  isLeaving,
  isUpdatingStartTime,
  onAssignCourt,
  onLeaveGame,
  onShareGame,
  onUpdateStartTime
}: {
  game: Game;
  userById: Map<string, User>;
  locations?: Location[];
  showLocation?: boolean;
  compact?: boolean;
  activeUserId?: string;
  nowMs?: number;
  isSelected?: boolean;
  isLeaving?: boolean;
  isUpdatingStartTime?: boolean;
  onAssignCourt?: (event: React.MouseEvent<HTMLButtonElement>) => void;
  onLeaveGame?: () => void;
  onShareGame?: () => void;
  onUpdateStartTime?: (time: string) => void;
}) {
  const location = gameLocations?.find((candidate) => candidate.id === game.locationId) || locationById.get(game.locationId);
  const players = game.playerIds.map((id) => userById.get(id)!).filter(Boolean);
  const missing = game.requiredPlayers - game.playerIds.length;
  const isForming = game.status === "forming";
  const canLeave = Boolean(activeUserId && game.playerIds.includes(activeUserId) && onLeaveGame);
  const isSoloFormingMatch = game.status === "forming" && game.playerIds.length === 1;
  const canShare = Boolean(!compact && game.status === "forming" && activeUserId && game.playerIds.includes(activeUserId) && onShareGame);
  const canAssignCourt = Boolean(onAssignCourt && (!isForming || (activeUserId && game.playerIds.includes(activeUserId))));
  const startEditDeadline = new Date(new Date(game.startsAt).getTime() + startTimeEditGraceMinutes * 60 * 1000);
  const canUpdateStartTime = Boolean(
    !compact &&
    activeUserId &&
    game.status === "confirmed" &&
    game.playerIds.includes(activeUserId) &&
    onUpdateStartTime &&
    (!nowMs || nowMs <= startEditDeadline.getTime())
  );
  const timing = gameTimeLabel(game);
  const activeUntil = isForming && game.endsAt ? new Date(game.endsAt) : undefined;
  const timeLeft =
    activeUntil && !Number.isNaN(activeUntil.getTime()) && nowMs
      ? formatCountdown(activeUntil, nowMs)
      : undefined;
  const courtLabel = game.court || "Assign Court";
  const playerSummary = players.length > 0 ? players.map(shortPlayerName).join(" · ") : "No players yet";

  return (
    <article className={`game-card glass-panel ${game.status} ${isSelected ? "selected" : ""}`}>
      <div className="game-meta">
        <div>
          <strong>{isForming ? "Getting Matched" : timing}</strong>
          {isForming ? (
            <>
              <span className="game-window-line">{timing}</span>
              <span className="match-type-line"><CourtIcon /> {formatMatchType(game.type)} · {game.playerIds.length}/{game.requiredPlayers} joined · {missing > 0 ? `${missing} needed` : "Players set"}</span>
            </>
          ) : (
            <span className="match-type-line"><CourtIcon /> {formatMatchType(game.type)} · {location?.name || "PaddleUp Location"}</span>
          )}
        </div>
      </div>
      {(timeLeft || canAssignCourt || !isForming || game.court) && (
        <div className="game-action-row">
          {isForming && timeLeft && <span className={`time-left-pill ${timeLeft === "closing" ? "urgent" : ""}`}>{timeLeft === "closing" ? "Closing" : timeLeft}</span>}
          {(canAssignCourt || !isForming || game.court) && (
            canAssignCourt ? (
              <button className="court-pill" onClick={onAssignCourt}>{courtLabel}</button>
            ) : (
              <span className={`court-pill ${game.court ? "" : "muted"}`}>{game.court || "Court TBD"}</span>
            )
          )}
        </div>
      )}
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
      {!compact && <p className="player-summary">{playerSummary}</p>}
      {!compact && showLocation && (
        <p className="game-location-line">
          <MapPin size={13} /> {location?.name || "PaddleUp Location"}
        </p>
      )}
      {canShare && (
        <button className="invite-action" onClick={onShareGame}>
          Invite Players
        </button>
      )}
      {!compact && canLeave && (
        <button className="danger-action" disabled={isLeaving} onClick={onLeaveGame}>
          {isLeaving ? (isSoloFormingMatch ? "Canceling..." : "Dropping Out...") : isSoloFormingMatch ? "Cancel Match" : "Drop Out"}
        </button>
      )}
    </article>
  );
}

function FormingGame({
  game,
  userById,
  activeUserId,
  isJoining,
  onView,
  onJoin
}: {
  game: Game;
  userById: Map<string, User>;
  activeUserId: string;
  isJoining: boolean;
  onView: () => void;
  onJoin: () => void;
}) {
  const missing = game.requiredPlayers - game.playerIds.length;
  const timing = gameTimeLabel(game);
  const isInGame = game.playerIds.includes(activeUserId);
  return (
    <article className="forming-row glass-panel">
      <div>
        <strong className="match-type-heading"><CourtIcon /> {formatMatchType(game.type)}</strong>
        <span className="forming-window">{timing}</span>
        <span>{game.playerIds.length}/{game.requiredPlayers} joined · {missing > 0 ? `${missing} needed` : "Players set"}</span>
        {game.court && <em>{game.court}</em>}
      </div>
      <div className="forming-side">
        <AvatarStack users={game.playerIds.map((id) => userById.get(id)!).filter(Boolean)} missing={missing} />
        {isInGame ? (
          <button className="forming-action secondary" onClick={onView}>View Match</button>
        ) : (
          <button className="forming-action" disabled={isJoining || missing <= 0} onClick={onJoin}>
            {isJoining ? "Joining..." : "Join Match"}
          </button>
        )}
      </div>
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

function CourtIcon() {
  return (
    <svg className="court-icon" viewBox="0 0 64 42" aria-hidden="true" focusable="false">
      <rect x="3" y="5" width="58" height="32" rx="8" />
      <path d="M32 5v32M10 21h44M16 5v32M48 5v32" />
    </svg>
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
