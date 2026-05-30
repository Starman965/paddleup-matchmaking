import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { onAuthStateChanged, signInWithPopup, signOut, type User as FirebaseUser } from "firebase/auth";
import {
  Bell,
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
import type { Availability, AvailabilityType, Game, Notification, Playmate, TabKey, User } from "./domain";
import { auth, googleProvider, initializeAnalytics, trackEvent } from "./firebase";
import {
  assignGameCourt,
  leaveGame,
  markReadyNow,
  markNotificationRead,
  markNotificationsRead,
  resetTestData,
  saveAvailabilityWindow,
  setPlaymateEnabled,
  subscribeLocation,
  subscribeLocationAvailability,
  subscribeLocationGames,
  subscribeLocationUsers,
  subscribeUserNotifications,
  subscribeUserPlaymates,
  updateLocationCourts,
  upsertCurrentUser
} from "./firebaseDb";
import "./styles.css";

const locationById = new Map(locations.map((location) => [location.id, location]));
const defaultCourtOptions = Array.from({ length: 10 }, (_, index) => `Court ${index + 1}`);
const adminEmails = new Set(["demandgendave@gmail.com"]);

type MatchFeedback = {
  type: Exclude<AvailabilityType, "weekend">;
  status: "idle" | "saving" | "waiting" | "forming" | "confirmed" | "alreadyActive" | "error";
  title: string;
  body: string;
  previousGameIds?: string[];
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
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [courtPickerGame, setCourtPickerGame] = useState<Game | null>(null);
  const [courtChoice, setCourtChoice] = useState(defaultCourtOptions[0]);
  const [customCourt, setCustomCourt] = useState("");
  const [assigningCourt, setAssigningCourt] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [leavingGameId, setLeavingGameId] = useState<string | null>(null);
  const [activeLocation, setActiveLocation] = useState(locations[0]);
  const [adminBusy, setAdminBusy] = useState(false);
  const [matchFeedback, setMatchFeedback] = useState<MatchFeedback | null>(null);

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
      setNotifications([]);
      return undefined;
    }

    return subscribeUserNotifications(
      firebaseUser.uid,
      setNotifications,
      (error) => setFirebaseStatus(`Notifications read failed: ${error.message}`)
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
      .filter((user) => user.uid !== activeUserId)
      .filter((user) => playerTab === "community" || playmateIds.has(user.uid))
      .filter((user) => {
        if (!search) return true;
        return `${user.firstName} ${user.lastName} ${user.email}`.toLowerCase().includes(search);
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
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length;
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

  function markOneNotificationRead(notificationId: string) {
    markNotificationRead(notificationId).catch((error: Error) => setFirebaseStatus(`Notification update failed: ${error.message}`));
  }

  function markAllNotificationsRead() {
    const unreadIds = notifications.filter((notification) => !notification.read).map((notification) => notification.id);
    if (unreadIds.length === 0) return;
    markNotificationsRead(unreadIds)
      .then(() => setFirebaseStatus("Notifications marked read."))
      .catch((error: Error) => setFirebaseStatus(`Notification update failed: ${error.message}`));
  }

  function runAdminResetTestData() {
    setAdminBusy(true);
    resetTestData()
      .then(({ deletedCount }) => setFirebaseStatus(`Admin reset complete. Deleted ${deletedCount} test records.`))
      .catch((error: Error) => setFirebaseStatus(`Admin reset failed: ${error.message}`))
      .finally(() => setAdminBusy(false));
  }

  function saveAdminCourtDefaults() {
    setAdminBusy(true);
    updateLocationCourts(activeLocation.id, defaultCourtOptions)
      .then(({ courtLabels }) => {
        setActiveLocation((location) => ({ ...location, courtLabels }));
        setFirebaseStatus(`Admin saved ${courtLabels.length} court labels.`);
      })
      .catch((error: Error) => setFirebaseStatus(`Court config failed: ${error.message}`))
      .finally(() => setAdminBusy(false));
  }

  function signIn() {
    signInWithPopup(auth, googleProvider).catch((error: Error) => {
      setFirebaseStatus(`Sign-in failed: ${error.message}`);
    });
  }

  const nav = [
    { key: "home" as const, label: "Home", icon: Home },
    { key: "players" as const, label: "Players", icon: Users },
    { key: "games" as const, label: "My Games", icon: Calendar },
    { key: "me" as const, label: "Me", icon: UserRound }
  ];

  return (
    <main className="app-shell">
      <div className="phone-frame">
        <header className="top-bar">
          <button className={`identity-button ${firebaseUser ? "" : "signed-out"}`} onClick={firebaseUser ? () => setActiveTab("me") : signIn}>
            {firebaseUser ? <Avatar user={currentUser} /> : "Sign In"}
          </button>
          <div>
            <p className="location-kicker"><MapPin size={13} /> {activeLocation.name}</p>
            <h1>{activeTab === "home" ? "PaddleUp" : nav.find((item) => item.key === activeTab)?.label}</h1>
          </div>
          <button className="icon-button notification-button" aria-label="Notifications" onClick={() => setNotificationsOpen(true)}>
            <Bell size={20} />
            {unreadNotificationCount > 0 && <span>{unreadNotificationCount}</span>}
          </button>
        </header>

        <section className="screen">
          {activeTab === "home" && (
            <HomeScreen
              nextGame={nextGame}
              games={displayGames}
              userById={userById}
              notifications={notifications}
              onSetTab={setActiveTab}
              onMode={setAvailabilityMode}
              onReadNotification={markOneNotificationRead}
            />
          )}
          {activeTab === "players" && (
            <PlayersScreen
              playerTab={playerTab}
              setPlayerTab={setPlayerTab}
              search={playerSearch}
              setSearch={setPlayerSearch}
              visiblePlayers={visiblePlayers}
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
              onAssignCourt={openCourtPicker}
              onLeaveGame={leaveSelectedGame}
            />
          )}
          {activeTab === "me" && (
            <MeScreen
              currentUser={currentUser}
              firebaseUser={firebaseUser}
              status={firebaseStatus}
              onSignIn={signIn}
              onSignOut={() => signOut(auth)}
              mode={availabilityMode}
              setMode={setAvailabilityMode}
              duration={duration}
              setDuration={setDuration}
              laterTodayStart={laterTodayStart}
              setLaterTodayStart={setLaterTodayStart}
              laterTodayEnd={laterTodayEnd}
              setLaterTodayEnd={setLaterTodayEnd}
              tomorrowStart={tomorrowStart}
              setTomorrowStart={setTomorrowStart}
              tomorrowEnd={tomorrowEnd}
              setTomorrowEnd={setTomorrowEnd}
              onStartMatching={() => {
                if (!firebaseUser) {
                  setFirebaseStatus("Sign in first, then Ready Now can write to Firestore.");
                  return;
                }

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
              }}
              matchFeedback={matchFeedback}
              isAdmin={isAdmin}
              adminBusy={adminBusy}
              courtCount={courtOptions.length}
              onResetTestData={runAdminResetTestData}
              onSaveCourtDefaults={saveAdminCourtDefaults}
              onSaveWindow={saveWindowAvailability}
            />
          )}
        </section>
        {notificationsOpen && (
          <NotificationSheet
            notifications={notifications}
            onClose={() => setNotificationsOpen(false)}
            onRead={markOneNotificationRead}
            onReadAll={markAllNotificationsRead}
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
  notifications,
  onSetTab,
  onMode,
  onReadNotification
}: {
  nextGame?: Game;
  games: Game[];
  userById: Map<string, User>;
  notifications: Notification[];
  onSetTab: (tab: TabKey) => void;
  onMode: (mode: AvailabilityType) => void;
  onReadNotification: (notificationId: string) => void;
}) {
  const forming = games.filter((game) => game.status === "forming");

  return (
    <div className="stack">
      <section className="hero-cta glass-panel">
        <Sparkles className="spark" size={24} />
        <p>Fastest path to a court</p>
        <button onClick={() => onSetTab("me")}>I Want to Play</button>
        <div className="mode-row">
          {[
            ["readyNow", "Ready Now"],
            ["laterToday", "Later Today"],
            ["tomorrow", "Tomorrow"]
          ].map(([mode, label]) => (
            <button key={mode} onClick={() => { onMode(mode as AvailabilityType); onSetTab("me"); }}>
              {label}
            </button>
          ))}
        </div>
      </section>

      {nextGame && (
        <section className="glass-panel">
          <SectionTitle title="Next Game" action="View Game" onClick={() => onSetTab("games")} />
          <GameCard game={nextGame} userById={userById} compact />
        </section>
      )}

      {notifications.length > 0 && (
        <section className="stack">
          <SectionTitle title="Latest Updates" />
          {notifications.slice(0, 2).map((notification) => (
            <article
              className={`notification-card glass-panel ${notification.read ? "" : "unread"}`}
              key={notification.id}
              onClick={() => onReadNotification(notification.id)}
            >
              <strong>{notification.title}</strong>
              <span>{notification.body}</span>
            </article>
          ))}
        </section>
      )}

      <section className="stack">
        <SectionTitle title="Forming Games" />
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
  playmateIds,
  availabilityByUserId,
  onToggle
}: {
  playerTab: "playmates" | "community";
  setPlayerTab: (tab: "playmates" | "community") => void;
  search: string;
  setSearch: (search: string) => void;
  visiblePlayers: User[];
  playmateIds: Set<string>;
  availabilityByUserId: Map<string, Availability>;
  onToggle: (uid: string) => void;
}) {
  return (
    <div className="stack">
      <Segmented
        value={playerTab}
        options={[
          ["playmates", "Playmates"],
          ["community", "Community"]
        ]}
        onChange={(value) => setPlayerTab(value as "playmates" | "community")}
      />
      <label className="search glass-panel">
        <Search size={17} />
        <input value={search} placeholder={`Search ${playerTab}`} onChange={(event) => setSearch(event.target.value)} />
      </label>
      <div className="list glass-panel">
        {visiblePlayers.length === 0 && <p className="empty-copy">No players found.</p>}
        {visiblePlayers.map((user) => {
          const isPlaymate = playmateIds.has(user.uid);
          const availability = availabilityByUserId.get(user.uid);
          return (
            <article className="player-row" key={user.uid}>
              <Avatar user={user} />
              <div>
                <strong>{user.firstName} {user.lastName}</strong>
                <span>{availability ? availabilityStatus(availability) : locationById.get(user.locationId)?.name}</span>
              </div>
              {availability && <span className="availability-badge">{availability.type === "readyNow" ? "Now" : availability.type === "tomorrow" ? "Tmrw" : "Today"}</span>}
              <button className="small-icon" onClick={() => onToggle(user.uid)} aria-label={isPlaymate ? "Remove playmate" : "Add playmate"}>
                {isPlaymate ? <UserMinus size={18} /> : <UserPlus size={18} />}
              </button>
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
  onAssignCourt,
  onLeaveGame
}: {
  games: Game[];
  userById: Map<string, User>;
  activeUserId: string;
  leavingGameId: string | null;
  onAssignCourt: (game: Game) => void;
  onLeaveGame: (gameId: string) => void;
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
          onAssignCourt={() => onAssignCourt(game)}
          onLeaveGame={() => onLeaveGame(game.id)}
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
          onAssignCourt={() => onAssignCourt(game)}
          onLeaveGame={() => onLeaveGame(game.id)}
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

function NotificationSheet({
  notifications,
  onClose,
  onRead,
  onReadAll
}: {
  notifications: Notification[];
  onClose: () => void;
  onRead: (notificationId: string) => void;
  onReadAll: () => void;
}) {
  return (
    <div className="court-sheet-backdrop" role="presentation" onClick={onClose}>
      <section className="court-sheet glass-panel" role="dialog" aria-modal="true" aria-label="Notifications" onClick={(event) => event.stopPropagation()}>
        <SectionTitle title="Notifications" action="Close" onClick={onClose} />
        {notifications.length === 0 && <p className="empty-copy">No notifications yet.</p>}
        {notifications.length > 0 && (
          <button className="ghost-action" onClick={onReadAll}>
            Mark All Read
          </button>
        )}
        <div className="notification-list">
          {notifications.map((notification) => (
            <article
              className={`notification-card glass-panel ${notification.read ? "" : "unread"}`}
              key={notification.id}
              onClick={() => onRead(notification.id)}
            >
              <strong>{notification.title}</strong>
              <span>{notification.body}</span>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}

function MeScreen({
  currentUser,
  firebaseUser,
  status,
  onSignIn,
  onSignOut,
  mode,
  setMode,
  duration,
  setDuration,
  laterTodayStart,
  setLaterTodayStart,
  laterTodayEnd,
  setLaterTodayEnd,
  tomorrowStart,
  setTomorrowStart,
  tomorrowEnd,
  setTomorrowEnd,
  onStartMatching,
  matchFeedback,
  isAdmin,
  adminBusy,
  courtCount,
  onResetTestData,
  onSaveCourtDefaults,
  onSaveWindow
}: {
  currentUser: User;
  firebaseUser: FirebaseUser | null;
  status: string;
  onSignIn: () => void;
  onSignOut: () => void;
  mode: AvailabilityType;
  setMode: (mode: AvailabilityType) => void;
  duration: number;
  setDuration: (duration: number) => void;
  laterTodayStart: string;
  setLaterTodayStart: (time: string) => void;
  laterTodayEnd: string;
  setLaterTodayEnd: (time: string) => void;
  tomorrowStart: string;
  setTomorrowStart: (time: string) => void;
  tomorrowEnd: string;
  setTomorrowEnd: (time: string) => void;
  onStartMatching: () => void;
  matchFeedback: MatchFeedback | null;
  isAdmin: boolean;
  adminBusy: boolean;
  courtCount: number;
  onResetTestData: () => void;
  onSaveCourtDefaults: () => void;
  onSaveWindow: (type: "laterToday" | "tomorrow", startTime: string, endTime: string) => void;
}) {
  const scheduledType = mode === "tomorrow" ? "tomorrow" : "laterToday";
  const scheduledStart = scheduledType === "tomorrow" ? tomorrowStart : laterTodayStart;
  const scheduledEnd = scheduledType === "tomorrow" ? tomorrowEnd : laterTodayEnd;
  const setScheduledStart = scheduledType === "tomorrow" ? setTomorrowStart : setLaterTodayStart;
  const setScheduledEnd = scheduledType === "tomorrow" ? setTomorrowEnd : setLaterTodayEnd;

  return (
    <div className="stack">
      <section className="account-panel glass-panel">
        <Avatar user={currentUser} />
        <div>
          <strong>{firebaseUser ? `${currentUser.firstName} ${currentUser.lastName}` : "PaddleUp Matchmaking"}</strong>
          <span>{status}</span>
        </div>
        <button onClick={firebaseUser ? onSignOut : onSignIn}>{firebaseUser ? "Sign Out" : "Sign In"}</button>
      </section>
      <Segmented
        value={mode}
        options={[
          ["readyNow", "Ready Now"],
          ["laterToday", "Today"],
          ["tomorrow", "Tomorrow"]
        ]}
        onChange={(value) => setMode(value as AvailabilityType)}
      />
      {mode === "readyNow" ? (
        <section className="glass-panel">
          <SectionTitle title="Availability Expires" />
          <div className="duration-grid">
            {[30, 60, 90, 120].map((minutes) => (
              <button key={minutes} className={duration === minutes ? "selected" : ""} onClick={() => setDuration(minutes)}>
                {minutes}<span>min</span>
              </button>
            ))}
          </div>
          <button className="primary-action" onClick={onStartMatching}>
            {firebaseUser ? "Start Matching" : "Sign In To Match"}
          </button>
        </section>
      ) : (
        <section className="glass-panel time-window">
          <SectionTitle title={mode === "laterToday" ? "Later Today" : "Tomorrow"} />
          <TimeInput label="Start" value={scheduledStart} onChange={setScheduledStart} />
          <TimeInput label="End" value={scheduledEnd} onChange={setScheduledEnd} />
          <button className="primary-action" onClick={() => onSaveWindow(scheduledType, scheduledStart, scheduledEnd)}>
            {firebaseUser ? "Save Availability" : "Sign In To Save"}
          </button>
        </section>
      )}
      {matchFeedback && <MatchFeedbackCard feedback={matchFeedback} />}
      {isAdmin && (
        <section className="glass-panel admin-panel">
          <SectionTitle title="Admin" />
          <p>Blackhawk courts configured: {courtCount}</p>
          <button className="ghost-action" disabled={adminBusy} onClick={onSaveCourtDefaults}>
            Save Blackhawk Court 1-10 Defaults
          </button>
          <button className="danger-action" disabled={adminBusy} onClick={onResetTestData}>
            Reset Test Data
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
  onAssignCourt,
  onLeaveGame
}: {
  game: Game;
  userById: Map<string, User>;
  compact?: boolean;
  activeUserId?: string;
  isLeaving?: boolean;
  onAssignCourt?: () => void;
  onLeaveGame?: () => void;
}) {
  const location = locationById.get(game.locationId)!;
  const players = game.playerIds.map((id) => userById.get(id)!).filter(Boolean);
  const missing = game.requiredPlayers - game.playerIds.length;
  const canLeave = Boolean(activeUserId && game.playerIds.includes(activeUserId) && onLeaveGame);

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
      {!compact && <p className="need-copy">{missing > 0 ? `Need ${missing} more` : "Players confirmed"}</p>}
      {!compact && canLeave && (
        <button className="danger-action" disabled={isLeaving} onClick={onLeaveGame}>
          {isLeaving ? "Leaving..." : "I Can't Make It"}
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
    <div className="avatar" aria-label={`${user.firstName} ${user.lastName}`}>
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

function TimeInput({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="time-field">
      <span>{label}</span>
      <input type="time" value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
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
