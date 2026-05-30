import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { onAuthStateChanged, signInWithPopup, signOut, type User as FirebaseUser } from "firebase/auth";
import {
  Bell,
  Calendar,
  Check,
  ChevronRight,
  Clock3,
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
import type { AvailabilityType, Game, Notification, TabKey, User } from "./domain";
import { auth, googleProvider, initializeAnalytics } from "./firebase";
import {
  assignGameCourt,
  markReadyNow,
  subscribeLocationGames,
  subscribeLocationUsers,
  subscribeUserNotifications,
  upsertCurrentUser
} from "./firebaseDb";
import "./styles.css";

const locationById = new Map(locations.map((location) => [location.id, location]));

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
  const [availabilityMode, setAvailabilityMode] = useState<AvailabilityType>("readyNow");
  const [duration, setDuration] = useState(60);
  const [playmateState, setPlaymateState] = useState(seedPlaymates);
  const [joinedGameIds, setJoinedGameIds] = useState<string[]>([]);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(null);
  const [firebaseStatus, setFirebaseStatus] = useState("Firebase connected. Sign in to write live availability.");
  const [liveUsers, setLiveUsers] = useState<User[]>([]);
  const [liveGames, setLiveGames] = useState<Game[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    initializeAnalytics();
    return onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      if (user) {
        upsertCurrentUser(user, locations[0].id)
          .then(() => setFirebaseStatus("Signed in. Your PaddleUp profile is live."))
          .catch((error: Error) => setFirebaseStatus(`Signed in, but profile save failed: ${error.message}`));
      } else {
        setFirebaseStatus("Firebase connected. Sign in to write live availability.");
      }
    });
  }, []);

  const activeLocation = locations[0];
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

  const allUsers = useMemo(() => {
    const userMap = new Map(seedUsers.map((user) => [user.uid, user]));
    liveUsers.forEach((user) => userMap.set(user.uid, user));
    if (firebaseUser) userMap.set(firebaseUser.uid, userMap.get(firebaseUser.uid) || userFromFirebase(firebaseUser, activeLocation.id));
    return Array.from(userMap.values());
  }, [activeLocation.id, firebaseUser, liveUsers]);

  const userById = useMemo(() => new Map(allUsers.map((user) => [user.uid, user])), [allUsers]);
  const activeUserId = firebaseUser?.uid || currentUserId;
  const currentUser = userById.get(activeUserId) || seedUsers[0];
  const playmateIds = new Set(playmateState.filter((p) => p.enabled).map((p) => p.playmateId));
  const visiblePlayers =
    playerTab === "playmates"
      ? allUsers.filter((user) => playmateIds.has(user.uid) && user.uid !== activeUserId)
      : allUsers.filter((user) => user.uid !== activeUserId);

  const displayGames = useMemo(
    () => {
      const sourceGames = liveGames.length > 0 ? liveGames : seedGames;
      return sourceGames.map((game) => ({
        ...game,
        playerIds: joinedGameIds.includes(game.id) && !game.playerIds.includes(activeUserId) ? [...game.playerIds, activeUserId] : game.playerIds
      }));
    },
    [activeUserId, joinedGameIds, liveGames]
  );
  const nextGame = displayGames.find((game) => game.status === "confirmed" && game.playerIds.includes(activeUserId));
  const unreadNotificationCount = notifications.filter((notification) => !notification.read).length;

  const nav = [
    { key: "home" as const, label: "Home", icon: Home },
    { key: "players" as const, label: "Players", icon: Users },
    { key: "games" as const, label: "My Games", icon: Calendar },
    { key: "me" as const, label: "Me", icon: UserRound }
  ];

  return (
    <main className="app-shell">
      <div className="phone-frame">
        <div className="status-bar">
          <span>9:41</span>
          <span className="system-icons">5G  84%</span>
        </div>

        <header className="top-bar">
          <div>
            <p className="location-kicker"><MapPin size={13} /> {activeLocation.name}</p>
            <h1>{activeTab === "home" ? "PaddleUp" : nav.find((item) => item.key === activeTab)?.label}</h1>
          </div>
          <button className="icon-button notification-button" aria-label="Notifications">
            <Bell size={20} />
            {unreadNotificationCount > 0 && <span>{unreadNotificationCount}</span>}
          </button>
        </header>

        <section className="screen">
          <AuthStrip
            firebaseUser={firebaseUser}
            status={firebaseStatus}
            onSignIn={() =>
              signInWithPopup(auth, googleProvider).catch((error: Error) => {
                setFirebaseStatus(`Sign-in failed: ${error.message}`);
              })
            }
            onSignOut={() => signOut(auth)}
          />
          {activeTab === "home" && (
            <HomeScreen
              nextGame={nextGame}
              games={displayGames}
              userById={userById}
              notifications={notifications}
              onJoin={(gameId) => setJoinedGameIds((ids) => (ids.includes(gameId) ? ids : [...ids, gameId]))}
              onSetTab={setActiveTab}
              onMode={setAvailabilityMode}
            />
          )}
          {activeTab === "players" && (
            <PlayersScreen
              playerTab={playerTab}
              setPlayerTab={setPlayerTab}
              visiblePlayers={visiblePlayers}
              playmateIds={playmateIds}
              onToggle={(uid) =>
                setPlaymateState((records) =>
                  records.map((record) => (record.playmateId === uid ? { ...record, enabled: !record.enabled } : record))
                )
              }
            />
          )}
          {activeTab === "games" && (
            <GamesScreen
              games={displayGames}
              userById={userById}
              onAssignCourt={(gameId) => {
                if (!firebaseUser) {
                  setFirebaseStatus("Sign in first, then you can assign a court.");
                  return;
                }

                assignGameCourt(gameId, "Court 4")
                  .then(() => setFirebaseStatus("Court 4 assigned. Players have been notified."))
                  .catch((error: Error) => setFirebaseStatus(`Court assignment failed: ${error.message}`));
              }}
            />
          )}
          {activeTab === "me" && (
            <MeScreen
              currentUser={currentUser}
              firebaseUser={firebaseUser}
              mode={availabilityMode}
              setMode={setAvailabilityMode}
              duration={duration}
              setDuration={setDuration}
              onStartMatching={() => {
                if (!firebaseUser) {
                  setFirebaseStatus("Sign in first, then Ready Now can write to Firestore.");
                  return;
                }

                markReadyNow(firebaseUser.uid, activeLocation.id, duration)
                  .then(() => setFirebaseStatus(`Ready Now saved for ${duration} minutes at ${activeLocation.name}.`))
                  .catch((error: Error) => setFirebaseStatus(`Ready Now failed: ${error.message}`));
              }}
            />
          )}
        </section>

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

function AuthStrip({
  firebaseUser,
  status,
  onSignIn,
  onSignOut
}: {
  firebaseUser: FirebaseUser | null;
  status: string;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  return (
    <section className="auth-strip glass-panel">
      <div>
        <strong>{firebaseUser ? firebaseUser.displayName || firebaseUser.email : "Firebase MVP"}</strong>
        <span>{status}</span>
      </div>
      <button onClick={firebaseUser ? onSignOut : onSignIn}>{firebaseUser ? "Sign Out" : "Sign In"}</button>
    </section>
  );
}

function HomeScreen({
  nextGame,
  games,
  userById,
  notifications,
  onJoin,
  onSetTab,
  onMode
}: {
  nextGame?: Game;
  games: Game[];
  userById: Map<string, User>;
  notifications: Notification[];
  onJoin: (gameId: string) => void;
  onSetTab: (tab: TabKey) => void;
  onMode: (mode: AvailabilityType) => void;
}) {
  const counts = { readyNow: 5, laterToday: 12, tomorrow: 18 };
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
            <article className={`notification-card glass-panel ${notification.read ? "" : "unread"}`} key={notification.id}>
              <strong>{notification.title}</strong>
              <span>{notification.body}</span>
            </article>
          ))}
        </section>
      )}

      <section className="pulse-grid">
        <PulseCard label="Ready Now" value={counts.readyNow} tone="green" onClick={() => onSetTab("players")} />
        <PulseCard label="Later Today" value={counts.laterToday} tone="orange" onClick={() => onSetTab("players")} />
        <PulseCard label="Tomorrow" value={counts.tomorrow} tone="blue" onClick={() => onSetTab("players")} />
      </section>

      <section className="stack">
        <SectionTitle title="Forming Games" />
        {forming.map((game) => (
          <FormingGame key={game.id} game={game} userById={userById} onJoin={() => onJoin(game.id)} />
        ))}
      </section>
    </div>
  );
}

function PlayersScreen({
  playerTab,
  setPlayerTab,
  visiblePlayers,
  playmateIds,
  onToggle
}: {
  playerTab: "playmates" | "community";
  setPlayerTab: (tab: "playmates" | "community") => void;
  visiblePlayers: User[];
  playmateIds: Set<string>;
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
        <input placeholder={`Search ${playerTab}`} />
      </label>
      <div className="list glass-panel">
        {visiblePlayers.map((user) => {
          const isPlaymate = playmateIds.has(user.uid);
          return (
            <article className="player-row" key={user.uid}>
              <Avatar user={user} />
              <div>
                <strong>{user.firstName} {user.lastName}</strong>
                <span>{locationById.get(user.locationId)?.name}</span>
              </div>
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

function GamesScreen({ games, userById, onAssignCourt }: { games: Game[]; userById: Map<string, User>; onAssignCourt: (gameId: string) => void }) {
  const forming = games.filter((game) => game.status === "forming");
  const confirmed = games.filter((game) => game.status === "confirmed");

  return (
    <div className="stack">
      <SectionTitle title="Forming" />
      {forming.length === 0 && <p className="empty-copy">No forming games right now.</p>}
      {forming.map((game) => <GameCard key={game.id} game={game} userById={userById} onAssignCourt={() => onAssignCourt(game.id)} />)}
      <SectionTitle title="Confirmed" />
      {confirmed.length === 0 && <p className="empty-copy">No confirmed games yet.</p>}
      {confirmed.map((game) => <GameCard key={game.id} game={game} userById={userById} onAssignCourt={() => onAssignCourt(game.id)} />)}
    </div>
  );
}

function MeScreen({
  currentUser,
  firebaseUser,
  mode,
  setMode,
  duration,
  setDuration,
  onStartMatching
}: {
  currentUser: User;
  firebaseUser: FirebaseUser | null;
  mode: AvailabilityType;
  setMode: (mode: AvailabilityType) => void;
  duration: number;
  setDuration: (duration: number) => void;
  onStartMatching: () => void;
}) {
  return (
    <div className="stack">
      <section className="profile-strip glass-panel">
        <Avatar user={currentUser} />
        <div>
          <strong>{currentUser.firstName} {currentUser.lastName}</strong>
          <span>{locationById.get(currentUser.locationId)?.name}</span>
        </div>
        <button>Save</button>
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
          <TimeField label="Start" value={mode === "laterToday" ? "1:00 PM" : "8:00 AM"} />
          <TimeField label="End" value={mode === "laterToday" ? "5:00 PM" : "12:00 PM"} />
          <button className="primary-action">Save Window</button>
        </section>
      )}
      <section className="glass-panel weekend">
        <SectionTitle title="Weekend Availability" />
        <ScheduleRow day="Saturday" times={["9:00 AM - 11:00 AM", "4:00 PM - 6:00 PM"]} />
        <ScheduleRow day="Sunday" times={["9:00 AM - 11:30 AM"]} />
        <button className="ghost-action"><Plus size={16} /> Add Another Window</button>
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

function GameCard({ game, userById, compact, onAssignCourt }: { game: Game; userById: Map<string, User>; compact?: boolean; onAssignCourt?: () => void }) {
  const location = locationById.get(game.locationId)!;
  const players = game.playerIds.map((id) => userById.get(id)!).filter(Boolean);
  const missing = game.requiredPlayers - game.playerIds.length;

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
    </article>
  );
}

function FormingGame({ game, userById, onJoin }: { game: Game; userById: Map<string, User>; onJoin: () => void }) {
  const missing = game.requiredPlayers - game.playerIds.length;
  return (
    <article className="forming-row glass-panel">
      <div>
        <strong>{game.type}</strong>
        <span>{game.playerIds.length}/{game.requiredPlayers} players · Need {missing}</span>
      </div>
      <AvatarStack users={game.playerIds.map((id) => userById.get(id)!).filter(Boolean)} missing={missing} />
      <button onClick={onJoin}>Join</button>
    </article>
  );
}

function PulseCard({ label, value, tone, onClick }: { label: string; value: number; tone: string; onClick: () => void }) {
  return (
    <button className={`pulse-card ${tone}`} onClick={onClick}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>players</small>
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
  return <div className="avatar" aria-label={`${user.firstName} ${user.lastName}`}>{initials(user)}</div>;
}

function AvatarStack({ users, missing }: { users: User[]; missing: number }) {
  return (
    <div className="avatar-stack">
      {users.map((user) => <Avatar key={user.uid} user={user} />)}
      {Array.from({ length: Math.max(0, missing) }).map((_, index) => <div className="avatar empty" key={index}><Plus size={14} /></div>)}
    </div>
  );
}

function TimeField({ label, value }: { label: string; value: string }) {
  return (
    <div className="time-field">
      <span>{label}</span>
      <strong>{value}</strong>
      <Clock3 size={18} />
    </div>
  );
}

function ScheduleRow({ day, times }: { day: string; times: string[] }) {
  return (
    <div className="schedule-row">
      <div><Check size={15} /> <strong>{day}</strong></div>
      {times.map((time) => <button key={time}>{time}<Clock3 size={15} /></button>)}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => undefined);
  });
}
