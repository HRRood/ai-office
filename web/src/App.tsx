import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { displayName, shorten } from '../../shared/names';
import type { RoomId } from '../../shared/rooms.config';
import { OfficeCanvas, type OfficeApi } from './components/OfficeCanvas';
import { LaunchDialog } from './components/LaunchDialog';
import { PromptDialog } from './components/PromptDialog';
import { ReportsDialog } from './components/ReportsDialog';
import { QuestionsDialog } from './components/QuestionsDialog';
import { ManagerDialog } from './components/ManagerDialog';
import { SidePanel } from './components/SidePanel';
import type { CameraState, Pick, Selection } from './engine/renderer';
import { useOffice } from './useOffice';
import { useNicknames } from './nicknames';
import { HOLIDAY_INFO, currentHoliday } from './engine/holidays';

function ShiftClock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);
  const override = new URLSearchParams(location.search).get('hour'); // same test hook as the renderer
  const h = override !== null && !Number.isNaN(Number(override)) ? Number(override) : now.getHours();
  const shift = h >= 8 && h < 18 ? 'day shift' : h >= 21 || h < 5 ? 'night shift' : h >= 18 ? 'evening shift' : 'early shift';
  return (
    <span className="clock">
      {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {shift}
    </span>
  );
}

function HolidayBadge({ api }: { api: React.MutableRefObject<OfficeApi | null> }) {
  const h = currentHoliday();
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem('claude-office.visitors') !== '0';
    } catch {
      return true;
    }
  });
  if (!h) return null;
  return (
    <>
      <span className={`holiday ${h}`}>{HOLIDAY_INFO[h].badge}</span>
      {h === 'sinterklaas' && (
        <button
          className={`visitors ${on ? 'on' : ''}`}
          aria-pressed={on}
          title={on ? 'Send Sinterklaas and the pieten home' : 'Invite Sinterklaas and the pieten back'}
          onClick={() => {
            api.current?.setVisitors(!on);
            setOn(!on);
          }}
        >
          Visitors {on ? 'on' : 'off'}
        </button>
      )}
    </>
  );
}

const NONE: Selection = { sessionId: null, workerId: null, roomId: null };

export function App() {
  const { connected, conn, sessions, log, reports, questions } = useOffice();
  /** The Manager's reports inbox is open. */
  const [readingReports, setReadingReports] = useState(false);
  const unreadReports = reports.filter((r) => !r.read).length;
  /** Claude's questions are open at the Manager's desk. */
  const [answering, setAnswering] = useState(false);
  // Close the questions dialog once nothing is waiting (answered in the terminal, say).
  useEffect(() => {
    if (!questions.length) setAnswering(false);
  }, [questions.length]);
  /** The Manager's desk menu is open (optionally straight on waking someone). */
  const [desk, setDesk] = useState<{ wakeId: string | null } | null>(null);
  const closeDesk = () => {
    setReadingReports(false);
    setAnswering(false);
    setDesk(null);
  };
  const [selection, setSelection] = useState<Selection>(NONE);
  const [camera, setCamera] = useState<CameraState>({ zoom: 1, following: null });
  const api = useRef<OfficeApi | null>(null);
  /** Worker you're talking to (prompt dialog open). */
  const [talkTo, setTalkTo] = useState<string | null>(null);
  const [nicknames, rename] = useNicknames();
  const [launching, setLaunching] = useState(false);

  const selectPerson = useCallback((workerId: string) => {
    // characters that aren't sessions (you, the manager, holiday visitors) have ids like 'npc:sint'
    const sessionId = workerId.startsWith('npc:') ? workerId : workerId.split(':')[0];
    setSelection({ sessionId, workerId, roomId: null });
  }, []);
  const selectRoom = useCallback((roomId: RoomId | null) => setSelection({ ...NONE, roomId }), []);
  const clear = useCallback(() => setSelection(NONE), []);

  const onPick = useCallback(
    (p: Pick) => {
      if (!p) clear();
      else if (p.kind === 'worker') selectPerson(p.workerId);
      else selectRoom(p.roomId);
    },
    [clear, selectPerson, selectRoom],
  );

  // Drop a selected person when they leave.
  useEffect(() => {
    const { sessionId, workerId } = selection;
    if (!sessionId || sessionId.startsWith('npc:')) return;
    const s = sessions.find((x) => x.id === sessionId);
    const gone = !s || (workerId !== sessionId && !s.subagents.some((a) => `${s.id}:${a.id}` === workerId));
    if (gone) setSelection(s ? { sessionId: s.id, workerId: s.id, roomId: null } : NONE);
  }, [sessions, selection]);

  // Esc clears the selection.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setTalkTo(null);
      setLaunching(false);
      closeDesk();
      clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [clear]);

  const waiting = Math.max(sessions.filter((s) => s.status === 'waiting').length, questions.length);
  useEffect(() => {
    document.title = waiting ? `(${waiting}!) Claude Office` : 'Claude Office';
  }, [waiting]);

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of sessions) {
      const name = shorten(nicknames[s.id] ?? displayName(s), 32);
      m.set(s.id, name);
      for (const a of s.subagents) m.set(`${s.id}:${a.id}`, `${nicknames[`${s.id}:${a.id}`] ?? a.agentType} (${name})`);
    }
    return m;
  }, [sessions, nicknames]);

  return (
    <div className="app">
      <header>
        <h1>Claude Office</h1>
        <span className={`conn ${conn === 'live' ? 'on' : conn}`} title={conn === 'offline' ? 'Start it with: npm run dev' : undefined}>
          {conn === 'live' ? 'live' : conn === 'offline' ? 'server offline — is npm run dev running?' : 'connecting…'}
        </span>
        <span className="spacer" />
        {questions.length > 0 && (
          <button
            className="reports-btn question"
            title="Claude is waiting for your answer"
            onClick={() => {
              setTalkTo(null);
              setLaunching(false);
              setReadingReports(false);
              setAnswering((v) => !v);
            }}
          >
            ❓ Questions ({questions.length})
          </button>
        )}
        <button
          className={`reports-btn ${unreadReports ? 'unread' : ''}`}
          title="Reports workers handed to the Manager"
          onClick={() => {
            setTalkTo(null);
            setLaunching(false);
            setAnswering(false);
            setReadingReports((v) => !v);
          }}
        >
          📄 Reports{unreadReports ? ` (${unreadReports})` : ''}
        </button>
        <HolidayBadge api={api} />
        <ShiftClock />
      </header>
      <main>
        <OfficeCanvas
          sessions={sessions}
          ready={connected}
          selection={selection}
          onPick={onPick}
          apiRef={api}
          onCamera={setCamera}
          workerName={(id) => names.get(id)}
          nicknames={nicknames}
          unreadReports={unreadReports}
          openQuestions={questions.length}
          onManager={() => {
            setTalkTo(null);
            // Questions waiting on you go first. With reports or sleepers around he opens his desk;
            // otherwise he takes a new assignment.
            if (questions.length) setAnswering(true);
            else if (reports.length || sessions.some((s) => s.asleep)) setDesk({ wakeId: null });
            else setLaunching(true);
          }}
          onTalk={(id) => {
            setLaunching(false);
            closeDesk();
            setTalkTo(id);
            selectPerson(id);
          }}
        />
        {desk && !launching && !answering && !readingReports && (
          <ManagerDialog
            managerName={nicknames['npc:boss'] ?? 'The Manager'}
            sessions={sessions}
            nicknames={nicknames}
            unreadReports={unreadReports}
            totalReports={reports.length}
            questions={questions.length}
            wakeId={desk.wakeId}
            onQuestions={() => {
              setDesk(null);
              setAnswering(true);
            }}
            onReports={() => {
              setDesk(null);
              setReadingReports(true);
            }}
            onLaunch={() => {
              setDesk(null);
              setLaunching(true);
            }}
            onClose={() => setDesk(null)}
          />
        )}
        {answering && !launching && (
          <QuestionsDialog
            managerName={nicknames['npc:boss'] ?? 'The Manager'}
            questions={questions}
            sessions={sessions}
            nicknames={nicknames}
            onClose={() => setAnswering(false)}
          />
        )}
        {readingReports && !launching && !answering && (
          <ReportsDialog
            managerName={nicknames['npc:boss'] ?? 'The Manager'}
            reports={reports}
            sessions={sessions}
            nicknames={nicknames}
            onLaunch={() => {
              setReadingReports(false);
              setLaunching(true);
            }}
            onClose={() => setReadingReports(false)}
          />
        )}
        {launching && <LaunchDialog managerName={nicknames['npc:boss'] ?? 'The Manager'} onClose={() => setLaunching(false)} />}
        {talkTo && (
          <PromptDialog
            workerId={talkTo}
            sessions={sessions}
            nicknames={nicknames}
            onClose={() => setTalkTo(null)}
            onWake={(id) => {
              setTalkTo(null);
              closeDesk();
              setLaunching(false);
              setDesk({ wakeId: id });
            }}
          />
        )}
        <SidePanel
          sessions={sessions}
          log={log}
          selection={selection}
          following={camera.following}
          onSelectPerson={(id, focus) => {
            selectPerson(id);
            api.current?.poke(id);
            if (focus) api.current?.focusWorker(id);
          }}
          onSelectRoom={(id, focus) => {
            selectRoom(id);
            if (id && focus) api.current?.focusRoom(id);
          }}
          onClear={clear}
          onFollow={(id) => api.current?.follow(id)}
          onZoomTo={(id) => api.current?.focusWorker(id)}
          nicknames={nicknames}
          onRename={rename}
        />
      </main>
    </div>
  );
}
