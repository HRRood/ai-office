import { useEffect, useState } from 'react';
import { displayName, shorten } from '../../../shared/names';
import { ROOM_IDS, ROOM_LABELS, roomPurpose, type RoomId } from '../../../shared/rooms.config';
import type { LogEntry, SessionState, WorkerStatus } from '../../../shared/types';
import { NPC_INFO, type Selection } from '../engine/renderer';
import { NAME_MAX } from '../nicknames';
import { dismissSession } from '../useOffice';
import { SESSION_COLORS } from '../engine/sprites';

const colorOf = (s: SessionState | undefined) => (s ? SESSION_COLORS[s.color % SESSION_COLORS.length] : '#555');

function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function ago(ts: number, now: number) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ${m % 60}m ago`;
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** A person in the office: a session's main worker or one of its helpers. */
interface Person {
  workerId: string;
  session: SessionState;
  isSub: boolean;
  name: string;
  agentType?: string;
  room: RoomId;
  status: WorkerStatus;
  action: string;
  lastSeen: number;
  startedAt: number;
  /** helpers: their session's (nick)name */
  parentName?: string;
}

function people(sessions: SessionState[], nick: Record<string, string>): Person[] {
  const out: Person[] = [];
  for (const s of sessions) {
    out.push({ workerId: s.id, session: s, isSub: false, name: shorten(nick[s.id] ?? displayName(s), 40), room: s.room, status: s.status, action: s.action, lastSeen: s.lastSeen, startedAt: s.startedAt });
    for (const a of s.subagents)
      out.push({ parentName: shorten(nick[s.id] ?? displayName(s), 32), workerId: `${s.id}:${a.id}`, session: s, isSub: true, name: nick[`${s.id}:${a.id}`] ?? a.agentType, agentType: a.agentType, room: a.room, status: a.status, action: a.action, lastSeen: a.lastSeen, startedAt: a.startedAt });
  }
  return out;
}

interface Props {
  sessions: SessionState[];
  log: LogEntry[];
  selection: Selection;
  following: string | null;
  onSelectPerson: (workerId: string, focus: boolean) => void;
  onSelectRoom: (roomId: RoomId | null, focus: boolean) => void;
  onClear: () => void;
  onFollow: (workerId: string | null) => void;
  onZoomTo: (workerId: string) => void;
  nicknames: Record<string, string>;
  onRename: (workerId: string, name: string) => void;
}

export function SidePanel(props: Props) {
  const { sessions, log, selection, onSelectPerson, onSelectRoom } = props;
  const now = useNow();
  const { nicknames } = props;
  const all = people(sessions, nicknames);
  const sessionName = (s: SessionState) => shorten(nicknames[s.id] ?? displayName(s), 28);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const waiting = all.filter((p) => p.status === 'waiting');
  const person = selection.workerId ? all.find((p) => p.workerId === selection.workerId) : undefined;

  return (
    <aside>
      {waiting.length > 0 && (
        <div className="alert">
          <strong>{waiting.length === 1 ? '1 worker needs you' : `${waiting.length} workers need you`}</strong>
          {waiting.map((p) => (
            <button key={p.workerId} onClick={() => onSelectPerson(p.workerId, true)}>
              {p.isSub ? `${p.name} (${sessionName(p.session)})` : p.name}: {p.action}
            </button>
          ))}
        </div>
      )}

      <section>
        <h2>Rooms</h2>
        <div className="rooms">
          {ROOM_IDS.map((id) => {
            const n = all.filter((p) => p.room === id).length;
            return (
              <button
                key={id}
                className={`room-chip ${selection.roomId === id ? 'on' : ''} ${n ? 'busy' : ''}`}
                onClick={() => onSelectRoom(selection.roomId === id ? null : id, selection.roomId !== id)}
                title={`Show ${ROOM_LABELS[id]}`}
              >
                {ROOM_LABELS[id]}
                <span className="count">{n}</span>
              </button>
            );
          })}
        </div>
      </section>

      {selection.roomId && <RoomCard {...props} roomId={selection.roomId} all={all} now={now} />}
      {person && <PersonCard {...props} person={person} now={now} />}
      {selection.workerId?.startsWith('npc:') && NPC_INFO[selection.workerId] && (
        <NpcCard {...props} id={selection.workerId} />
      )}

      {!selection.roomId && !person && !selection.workerId?.startsWith('npc:') && (
        <section>
          <h2>Crew on deck ({sessions.length})</h2>
          {sessions.length === 0 && (
            <p className="empty">
              No active sessions. Start Claude Code in any project, or run <code>npm run simulate</code>.
            </p>
          )}
          <PeopleList list={all.filter((p) => !p.isSub)} showRoom onPick={(id) => onSelectPerson(id, true)} />
        </section>
      )}

      <section className="log">
        <h2>Activity log</h2>
        {log.length === 0 && <p className="empty">Waiting for activity…</p>}
        <ul>
          {log.map((e) => {
            const s = byId.get(e.sessionId);
            const wid = e.agentId ? `${e.sessionId}:${e.agentId}` : e.sessionId;
            return (
              <li
                key={e.id}
                className={e.sessionId === selection.sessionId ? 'on' : ''}
                onClick={() => s && onSelectPerson(all.some((p) => p.workerId === wid) ? wid : e.sessionId, true)}
              >
                <span className="time">{clock(e.ts)}</span>
                <span className="dot" style={{ background: colorOf(s) }} />
                <span className="who">
                  {s ? sessionName(s) : e.project}
                  {e.agentType ? `/${nicknames[wid] ?? e.agentType}` : ''}
                </span>
                <span className="what">{e.action}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}

function PeopleList({ list, showRoom, onPick }: { list: Person[]; showRoom?: boolean; onPick: (id: string) => void }) {
  return (
    <ul className="sessions">
      {list.map((p) => (
        <li key={p.workerId}>
          <button onClick={() => onPick(p.workerId)}>
            <span className="swatch" style={{ background: colorOf(p.session), opacity: p.isSub ? 0.6 : 1 }} />
            <span className="body">
              <span className="proj">
                {p.isSub && <span className="helper-tag">helper</span>}
                {p.name}
                <span className={`status ${p.status}`}>{p.status}</span>
              </span>
              {p.isSub && <span className="of">for {p.parentName}</span>}
              {!p.isSub && p.session.title && <span className="of">{p.session.project}</span>}
              <span className="act">
                {p.action}
                {showRoom && <span className="room"> · {ROOM_LABELS[p.room]}</span>}
              </span>
              {!p.isSub && p.session.subagents.length > 0 && (
                <span className="subs">
                  +{p.session.subagents.length} helper{p.session.subagents.length > 1 ? 's' : ''}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function RoomCard({ roomId, all, log, now, onSelectPerson, onClear }: Props & { roomId: RoomId; all: Person[]; now: number }) {
  const here = all.filter((p) => p.room === roomId);
  const recent = log.filter((e) => e.room === roomId).slice(0, 8);
  return (
    <section className="card">
      <div className="card-head">
        <h2>{ROOM_LABELS[roomId]}</h2>
        <button className="close" onClick={onClear} aria-label="Close room">
          ×
        </button>
      </div>
      <p className="purpose">For: {roomPurpose(roomId).join(' · ') || '—'}</p>
      <h3>
        In this room ({here.length})
      </h3>
      {here.length === 0 ? <p className="empty">Nobody here right now.</p> : <PeopleList list={here} onPick={(id) => onSelectPerson(id, true)} />}
      <h3>Recent activity here</h3>
      <ul className="mini">
        {recent.length === 0 && <li className="empty">Nothing yet</li>}
        {recent.map((e) => (
          <li key={e.id}>
            <span className="time">{ago(e.ts, now)}</span> <b>{e.agentType ?? e.project}</b> {e.action}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PersonCard({
  person: p,
  log,
  now,
  following,
  onSelectPerson,
  onSelectRoom,
  onClear,
  onFollow,
  onZoomTo,
  nicknames,
  onRename,
}: Props & { person: Person; now: number }) {
  const s = p.session;
  const isFollowing = following === p.workerId;
  // What this person did: helpers see their own lines, the main worker sees everything in the session.
  const feed = log
    .filter((e) => e.sessionId === s.id && (!p.isSub || e.agentId === p.workerId.split(':')[1]))
    .slice(0, 15);
  const recent = p.isSub ? s.recent.filter((r) => r.by === p.agentType) : s.recent;

  return (
    <section className="card">
      <div className="card-head">
        <RenameTitle
          id={p.workerId}
          name={p.name}
          defaultName={p.isSub ? (p.agentType ?? 'helper') : displayName(s)}
          renamed={p.workerId in nicknames}
          color={colorOf(s)}
          prefix={p.isSub ? <span className="helper-tag">helper</span> : null}
          onRename={onRename}
        />
        <button className="close" onClick={onClear} aria-label="Close details">
          ×
        </button>
      </div>
      {!p.isSub && s.title && <p className="purpose">{s.project}</p>}

      <div className={`now-doing ${p.status}`}>
        <span className={`status ${p.status}`}>{p.status}</span>
        <div className="doing">{p.action || '—'}</div>
        <button className="link" onClick={() => onSelectRoom(p.room, true)}>
          in the {ROOM_LABELS[p.room]} →
        </button>
      </div>

      <div className="actions">
        <button className={isFollowing ? 'on' : ''} onClick={() => onFollow(isFollowing ? null : p.workerId)}>
          {isFollowing ? 'Stop following' : 'Follow'}
        </button>
        <button onClick={() => onZoomTo(p.workerId)}>Zoom to</button>
        {!p.isSub && <SendHome session={s} />}
      </div>

      <dl>
        {p.isSub ? (
          <>
            <dt>Works for</dt>
            <dd>
              <button className="link" onClick={() => onSelectPerson(s.id, true)}>
                {shorten(nicknames[s.id] ?? displayName(s), 32)}
              </button>
            </dd>
          </>
        ) : (
          <>
            <dt>Session</dt>
            <dd className="mono">{s.id.slice(0, 8)}</dd>
          </>
        )}
        <dt>On shift</dt>
        <dd>since {clock(p.startedAt)}</dd>
        <dt>Last seen</dt>
        <dd>{ago(p.lastSeen, now)}</dd>
      </dl>

      {!p.isSub && s.subagents.length > 0 && (
        <>
          <h3>Helpers</h3>
          <ul className="mini clickable">
            {s.subagents.map((a) => (
              <li key={a.id} onClick={() => onSelectPerson(`${s.id}:${a.id}`, true)}>
                <b>{nicknames[`${s.id}:${a.id}`] ?? a.agentType}</b> {a.action} <span className="room">· {ROOM_LABELS[a.room]}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>What they've been doing</h3>
      <ul className="mini timeline">
        {recent.length === 0 && feed.length === 0 && <li className="empty">Nothing yet</li>}
        {(recent.length ? recent : feed.map((e) => ({ ts: e.ts, action: e.action, room: e.room, by: e.agentType }))).map((r, i) => (
          <li key={i}>
            <span className="time">{clock(r.ts)}</span>
            <span>
              {!p.isSub && r.by && <b>{r.by}: </b>}
              {r.action} <span className="room">· {ROOM_LABELS[r.room]}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Card name with an inline ✎ Rename. Saving an empty name goes back to the default. */
function RenameTitle({
  id,
  name,
  defaultName,
  renamed,
  color,
  prefix,
  onRename,
}: {
  id: string;
  name: string;
  defaultName: string;
  renamed: boolean;
  color: string;
  prefix?: React.ReactNode;
  onRename: (id: string, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(name);
  useEffect(() => {
    setEditing(false);
    setDraft(name);
  }, [id, name]);

  if (!editing)
    return (
      <div className="rename">
        <h2 style={{ color }} title={renamed ? `Default name: ${defaultName}` : undefined}>
          {prefix}
          {name}
        </h2>
        <button className="link" onClick={() => setEditing(true)} aria-label={`Rename ${name}`}>
          ✎ Rename
        </button>
      </div>
    );

  const save = () => {
    onRename(id, draft);
    setEditing(false);
  };
  return (
    <form
      className="rename editing"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <input
        autoFocus
        value={draft}
        maxLength={NAME_MAX}
        placeholder={defaultName}
        aria-label="New name"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setEditing(false);
            setDraft(name);
          }
        }}
      />
      <button type="submit" className="link">
        Save
      </button>
      {renamed && (
        <button
          type="button"
          className="link"
          onClick={() => {
            onRename(id, '');
            setEditing(false);
          }}
        >
          Reset
        </button>
      )}
    </form>
  );
}

/** You, the Manager and the holiday visitors aren't sessions; their card is just a name and a role. */
function NpcCard({ id, nicknames, onRename, onClear }: Props & { id: string }) {
  const info = NPC_INFO[id];
  const name = nicknames[id] ?? info.name;
  return (
    <section className="card">
      <div className="card-head">
        <RenameTitle id={id} name={name} defaultName={info.name} renamed={id in nicknames} color="#e8eefc" onRename={onRename} />
        <button className="close" onClick={onClear} aria-label="Close">
          ×
        </button>
      </div>
      <p className="purpose">{info.role}</p>
    </section>
  );
}

/** Send a worker home. Background sessions the office started are stopped too. Asks once to confirm. */
function SendHome({ session }: { session: SessionState }) {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setConfirming(false);
    setError(null);
  }, [session.id]);
  const label = session.headless ? 'Stop & send home' : 'Send home';
  if (!confirming)
    return (
      <button className="danger" onClick={() => setConfirming(true)} title={session.headless ? 'Stops its background run and sends it home' : 'Clears it from the office; it comes back when you use the session again'}>
        🚪 {label}
      </button>
    );
  return (
    <span className="confirm">
      <button
        className="danger on"
        autoFocus
        onClick={async () => {
          const err = await dismissSession(session.id);
          if (err) setError(err);
          setConfirming(false);
        }}
      >
        {session.headless && session.status === 'working' ? 'Yes, stop its run' : 'Yes, send home'}
      </button>
      <button onClick={() => setConfirming(false)}>Cancel</button>
      {error && <span className="talk-error">{error}</span>}
    </span>
  );
}
