import { useEffect, useRef, useState } from 'react';
import { displayName, shorten } from '../../../shared/names';
import type { SessionState } from '../../../shared/types';
import { SESSION_COLORS } from '../engine/sprites';
import { wakeSession } from '../useOffice';

interface Props {
  managerName: string;
  sessions: SessionState[];
  nicknames: Record<string, string>;
  unreadReports: number;
  totalReports: number;
  questions: number;
  /** Open straight on the wake-up form for this sleeper. */
  wakeId?: string | null;
  onQuestions: () => void;
  onReports: () => void;
  onLaunch: () => void;
  onClose: () => void;
}

function since(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return `${h} h`;
}

/** The Manager's desk: questions, reports, sending the guard to wake sleepers, new sessions. */
export function ManagerDialog(props: Props) {
  const { managerName, sessions, nicknames, unreadReports, totalReports, questions, onClose } = props;
  const sleepers = sessions.filter((s) => s.asleep);
  const [wakeId, setWakeId] = useState<string | null>(props.wakeId ?? null);
  const [text, setText] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'error'; msg?: string }>({ kind: 'idle' });
  const area = useRef<HTMLTextAreaElement>(null);
  const sleeper = sleepers.find((s) => s.id === wakeId);
  const nameOf = (s: SessionState) => shorten(nicknames[s.id] ?? displayName(s), 40);

  useEffect(() => {
    if (wakeId) area.current?.focus();
    setText('');
    setState((s) => (s.kind === 'sent' ? s : { kind: 'idle' }));
  }, [wakeId]);

  const wake = async () => {
    if (!sleeper || state.kind === 'sending') return;
    setState({ kind: 'sending' });
    const err = await wakeSession(sleeper.id, text.trim());
    if (err) setState({ kind: 'error', msg: err });
    else {
      setState({ kind: 'sent', msg: `💂 The guard is fetching ${nameOf(sleeper)}` });
      setWakeId(null);
    }
  };

  return (
    <div
      className="talk manager"
      role="dialog"
      aria-label={`${managerName}'s desk`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (wakeId) setWakeId(null);
          else onClose();
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && sleeper) {
          e.preventDefault();
          void wake();
        }
      }}
    >
      <div className="talk-head">
        <div>
          <div className="talk-name">{managerName}'s desk</div>
          <div className="talk-doing">What do you need?</div>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {sleeper ? (
        <div className="wake-form">
          <p className="talk-note">
            The guard will wake <strong>{nameOf(sleeper)}</strong> ({sleeper.project}, asleep for {since(sleeper.lastSeen)}) and
            bring them back to work with this prompt. Leave it empty and they'll just report where they left off.
          </p>
          <textarea
            ref={area}
            value={text}
            maxLength={4000}
            rows={3}
            placeholder="e.g. Pick up where you left off and finish the tests"
            onChange={(e) => {
              setText(e.target.value);
              if (state.kind === 'error') setState({ kind: 'idle' });
            }}
          />
        </div>
      ) : (
        <div className="manager-menu">
          {questions > 0 && (
            <button className="manager-item urgent" onClick={props.onQuestions}>
              ❓ Answer questions <span className="count">{questions}</span>
            </button>
          )}
          <button className="manager-item" onClick={props.onReports} disabled={!totalReports}>
            📄 Read reports <span className="count">{unreadReports ? `${unreadReports} new` : totalReports || 'none'}</span>
          </button>
          <div className="manager-section">💤 Sleeping Quarters</div>
          {sleepers.length ? (
            <ul className="sleeper-list">
              {sleepers.map((s) => (
                <li key={s.id}>
                  <span className="swatch" style={{ background: SESSION_COLORS[s.color % SESSION_COLORS.length] }} />
                  <span className="report-who">{nameOf(s)}</span>
                  <span className="of">
                    {s.project} · {s.waking ? 'guard on the way' : `${since(s.lastSeen)} asleep`}
                  </span>
                  <button onClick={() => setWakeId(s.id)} disabled={s.waking}>
                    {s.waking ? 'Coming…' : 'Wake up'}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="talk-note">Nobody is asleep. Sessions idle for 15 minutes go to bed there.</p>
          )}
          <button className="manager-item" onClick={props.onLaunch}>
            🚀 Start a new session…
          </button>
        </div>
      )}

      <div className="talk-actions">
        {state.kind === 'error' && <span className="talk-error">{state.msg}</span>}
        {state.kind === 'sent' && <span className="talk-ok">{state.msg}</span>}
        {sleeper ? (
          <>
            <button onClick={() => setWakeId(null)}>Back</button>
            <button className="primary" onClick={() => void wake()} disabled={state.kind === 'sending'}>
              {state.kind === 'sending' ? 'Sending…' : 'Send the guard  ⌘↵'}
            </button>
          </>
        ) : (
          <button className="primary" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}
