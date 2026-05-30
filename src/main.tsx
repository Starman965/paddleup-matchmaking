import React, { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
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
import { availabilities, currentUserId, games, locations, playmates as seedPlaymates, users } from "./data";
import type { AvailabilityType, Game, TabKey, User } from "./domain";
import "./styles.css";

const locationById = new Map(locations.map((location) => [location.id, location]));
const userById = new Map(users.map((user) => [user.uid, user]));

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

function formatDay(value: string) {
  const date = new Date(value);
  const now = new Date("2026-05-29T09:41:00");
  if (date.toDateString() === now.toDateString()) return "Today";
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
}

function initials(user: User) {
  return `${user.firstName[0]}${user.lastName[0]}`;
}

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>("home");
  const [playerTab, setPlayerTab] = useState<"playmates" | "community">("playmates");
  const [availabilityMode, setAvailabilityMode] = useState<AvailabilityType>("readyNow");
  const [duration, setDuration] = useState(60);
  const [playmateState, setPlaymateState] = useState(seedPlaymates);
  const [joinedGameIds, setJoinedGameIds] = useState<string[]>([]);
  const [assignedCourts, setAssignedCourts] = useState<Record<string, string>>({ g2: "Court TBD", g3: "Court TBD" });

  const activeLocation = locations[0];
  const currentUser = userById.get(currentUserId)!;
  const playmateIds = new Set(playmateState.filter((p) => p.enabled).map((p) => p.playmateId));
  const visiblePlayers = playerTab === "playmates" ? users.filter((user) => playmateIds.has(user.uid)) : users.filter((user) => user.uid !== currentUserId);
  const nextGame = games.find((game) => game.status === "confirmed" && game.playerIds.includes(currentUserId));

  const liveGames = useMemo(
    () =>
      games.map((game) => ({
        ...game,
        playerIds: joinedGameIds.includes(game.id) && !game.playerIds.includes(currentUserId) ? [...game.playerIds, currentUserId] : game.playerIds,
        court: assignedCourts[game.id] || game.court
      })),
    [assignedCourts, joinedGameIds]
  );

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
          <button className="icon-button" aria-label="Notifications"><Bell size={20} /></button>
        </header>

        <section className="screen">
          {activeTab === "home" && (
            <HomeScreen
              nextGame={nextGame}
              games={liveGames}
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
              games={liveGames}
              onAssignCourt={(gameId) => setAssignedCourts((courts) => ({ ...courts, [gameId]: courts[gameId] === "Court 4" ? "Court TBD" : "Court 4" }))}
            />
          )}
          {activeTab === "me" && (
            <MeScreen
              currentUser={currentUser}
              mode={availabilityMode}
              setMode={setAvailabilityMode}
              duration={duration}
              setDuration={setDuration}
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

function HomeScreen({
  nextGame,
  games,
  onJoin,
  onSetTab,
  onMode
}: {
  nextGame?: Game;
  games: Game[];
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
          <GameCard game={nextGame} compact />
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
          <FormingGame key={game.id} game={game} onJoin={() => onJoin(game.id)} />
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

function GamesScreen({ games, onAssignCourt }: { games: Game[]; onAssignCourt: (gameId: string) => void }) {
  const forming = games.filter((game) => game.status === "forming");
  const confirmed = games.filter((game) => game.status === "confirmed");

  return (
    <div className="stack">
      <SectionTitle title="Forming" />
      {forming.map((game) => <GameCard key={game.id} game={game} onAssignCourt={() => onAssignCourt(game.id)} />)}
      <SectionTitle title="Confirmed" />
      {confirmed.map((game) => <GameCard key={game.id} game={game} onAssignCourt={() => onAssignCourt(game.id)} />)}
    </div>
  );
}

function MeScreen({
  currentUser,
  mode,
  setMode,
  duration,
  setDuration
}: {
  currentUser: User;
  mode: AvailabilityType;
  setMode: (mode: AvailabilityType) => void;
  duration: number;
  setDuration: (duration: number) => void;
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
          <button className="primary-action">Start Matching</button>
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

function GameCard({ game, compact, onAssignCourt }: { game: Game; compact?: boolean; onAssignCourt?: () => void }) {
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

function FormingGame({ game, onJoin }: { game: Game; onJoin: () => void }) {
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
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
