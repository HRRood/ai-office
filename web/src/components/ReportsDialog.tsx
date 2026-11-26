import { useEffect, useState } from 'react';
import { shorten } from '../../../shared/names';
import type { Report, SessionState } from '../../../shared/types';
import { SESSION_COLORS } from '../engine/sprites';
import { markReportRead, sendPrompt } from '../useOffice';

interface Props {
  managerName: string;
  reports: Report[];
  sessions: SessionState[];
  nicknames: Record<string, string>;
  /** Open the "start a new session" dialog instead. */
  onLaunch: () => void;
  onClose: () => void;
}

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : new Date(ts).toLocaleDateString();
}

/** The Manager's desk: reports workers handed in when they finished a turn. */
export function ReportsDialog({ managerName, reports, sessions, nicknames, onLaunch, onClose }: Props) {
  const [openId, setOpenId] = useState<number | null>(() => reports.find((r) => !r.read)?.id ?? null);
  const open = reports.find((r) => r.id === openId);
  const unread = reports.filter((r) => !r.read).length;

  const [reply, setReply] = useState('');
  const [sendState, setSendState] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'error'; msg?: string }>({ kind: 'idle' });

  useEffect(() => {
    if (open && !open.read) void markReportRead(open.id);
  }, [open]);

  useEffect(() => {
    setReply('');
    setSendState({ kind: 'idle' });
  }, [openId]);

  /** The worker who wrote the open report, if they're still in the office. */
  const author = open ? sessions.find((s) => s.id === open.sessionId) : undefined;

  const sendReply = async () => {
    const t = reply.trim();
    if (!open || !t || sendState.kind === 'sending') return;
    setSendState({ kind: 'sending' });
    const err = await sendPrompt(open.sessionId, t);
    if (err) setSendState({ kind: 'error', msg: err });
    else {
      setSendState({ kind: 'sent' });
      setReply('');
    }
  };

  const nameOf = (r: Report) => shorten(nicknames[r.sessionId] ?? r.name, 40);
  const colorOf = (r: Report) => {
    const s = sessions.find((x) => x.id === r.sessionId);
    return s ? SESSION_COLORS[s.color % SESSION_COLORS.length] : 'var(--muted, #667)';
  };

  return (
    <div
      className="talk reports"
      role="dialog"
      aria-label={`${managerName}'s reports`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          if (open) setOpenId(null);
          else onClose();
        }
      }}
    >
      <div className="talk-head">
        <div>
          <div className="talk-name">📄 Reports on {managerName}'s desk</div>
          <div className="talk-doing">
            {reports.length === 0
              ? 'Nothing handed in yet. Workers bring their final message here when they finish a turn.'
              : unread
              ? `${unread} unread of ${reports.length}`
              : `All ${reports.length} read`}
          </div>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {open ? (
        <div className="report-view">
          <div className="report-meta">
            <span className="swatch" style={{ background: colorOf(open) }} />
            <strong>{nameOf(open)}</strong>
            <span className="of">
              {open.project} · {ago(open.ts)}
            </span>
          </div>
          <div className="report-text">{open.text}</div>
          {author ? (
            <>
              <label className="talk-label" htmlFor="report-reply">
                Reply to {nameOf(open)}
              </label>
              <textarea
                id="report-reply"
                value={reply}
                maxLength={4000}
                rows={3}
                placeholder="Answer a question in the report, or give the next instruction"
                onChange={(e) => {
                  setReply(e.target.value);
                  if (sendState.kind !== 'sending') setSendState({ kind: 'idle' });
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void sendReply();
                  }
                }}
              />
            </>
          ) : (
            <p className="talk-note">{nameOf(open)} has left the office, so you can't reply here.</p>
          )}
        </div>
      ) : (
        reports.length > 0 && (
          <ul className="report-list">
            {reports.map((r) => (
              <li key={r.id}>
                <button className={r.read ? '' : 'unread'} onClick={() => setOpenId(r.id)}>
                  <span className="swatch" style={{ background: colorOf(r) }} />
                  <span className="report-who">{nameOf(r)}</span>
                  <span className="report-snippet">{r.text.replace(/\s+/g, ' ').slice(0, 90)}</span>
                  <span className="report-when">{ago(r.ts)}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      )}

      <div className="talk-actions">
        {sendState.kind === 'error' && <span className="talk-error">{sendState.msg}</span>}
        {sendState.kind === 'sent' && <span className="talk-ok">📨 Sent to {open ? nameOf(open) : 'them'}</span>}
        {open && <button onClick={() => setOpenId(null)}>← All reports</button>}
        {!open && <button onClick={onLaunch}>Start a new session…</button>}
        {open && author ? (
          <button className="primary" onClick={() => void sendReply()} disabled={!reply.trim() || sendState.kind === 'sending'}>
            {sendState.kind === 'sending' ? 'Sending…' : 'Reply  ⌘↵'}
          </button>
        ) : (
          <button className="primary" onClick={onClose}>
            Close
          </button>
        )}
      </div>
    </div>
  );
}
