import { useEffect, useRef, useState } from 'react';
import { displayName, shorten } from '../../../shared/names';
import { ROOM_LABELS } from '../../../shared/rooms.config';
import type { SessionState } from '../../../shared/types';
import { SESSION_COLORS } from '../engine/sprites';
import { sendPrompt } from '../useOffice';

interface Props {
  /** Worker you're talking to: a session id, or `${sessionId}:${agentId}` for a helper. */
  workerId: string;
  sessions: SessionState[];
  nicknames: Record<string, string>;
  onClose: () => void;
  /** They're asleep: ask the Manager to send the guard. */
  onWake: (sessionId: string) => void;
}

/** Talk to a worker: type a prompt and it goes into that Claude Code session's mailbox. */
export function PromptDialog({ workerId, sessions, nicknames, onClose, onWake }: Props) {
  const [sessionId, agentId] = workerId.split(':');
  const session = sessions.find((s) => s.id === sessionId);
  const helper = agentId ? session?.subagents.find((a) => a.id === agentId) : undefined;
  const [text, setText] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'error'; msg?: string }>({ kind: 'idle' });
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => area.current?.focus(), []);

  if (!session) {
    return (
      <div className="talk" role="dialog" aria-label="Talk">
        <p className="empty">That session has left the office.</p>
        <div className="talk-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    );
  }

  const name = shorten(nicknames[session.id] ?? displayName(session), 40);
  if (session.asleep) {
    return (
      <div className="talk" role="dialog" aria-label={`${name} is asleep`}>
        <p className="talk-note">
          💤 {name} is fast asleep. Shouting won't help: ask the Manager to send the guard to wake them.
        </p>
        <div className="talk-actions">
          <button onClick={onClose}>Cancel</button>
          <button className="primary" onClick={() => onWake(session.id)} disabled={session.waking}>
            {session.waking ? 'Guard on the way…' : 'Ask the Manager'}
          </button>
        </div>
      </div>
    );
  }
  const busy = session.status === 'working' || session.status === 'waiting';
  const when = session.headless
    ? busy
      ? `${name} runs in the background — your prompt continues the conversation when its current run finishes.`
      : `${name} runs in the background — your prompt continues the conversation right away.`
    : busy
    ? `${name} is busy — it gets your prompt as soon as it finishes the current turn.`
    : `${name} is free — it starts on your prompt right away.`;

  const send = async () => {
    const t = text.trim();
    if (!t || state.kind === 'sending') return;
    setState({ kind: 'sending' });
    const err = await sendPrompt(session.id, t);
    if (err) setState({ kind: 'error', msg: err });
    else {
      setState({ kind: 'sent' });
      setText('');
      setTimeout(onClose, 1400);
    }
  };

  return (
    <div
      className="talk"
      role="dialog"
      aria-label={`Send a prompt to ${name}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void send();
        }
      }}
    >
      <div className="talk-head">
        <span className="swatch" style={{ background: SESSION_COLORS[session.color % SESSION_COLORS.length] }} />
        <div>
          <div className="talk-name">
            {helper ? (
              <>
                <span className="helper-tag">helper</span>
                {nicknames[workerId] ?? helper.agentType} <span className="of">for {name}</span>
              </>
            ) : (
              <span title={displayName(session)}>{name}</span>
            )}
            <span className={`status ${(helper ?? session).status}`}>{(helper ?? session).status}</span>
          </div>
          {session.title && <div className="of">{session.project}</div>}
          <div className="talk-doing">
            {(helper ?? session).action} <span className="room">· {ROOM_LABELS[(helper ?? session).room]}</span>
          </div>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      {helper && <p className="talk-note">Helpers take orders from their session, so this goes to {name}.</p>}
      <label className="talk-label" htmlFor="talk-text">
        Send a prompt to {name}
      </label>
      <textarea
        id="talk-text"
        ref={area}
        value={text}
        maxLength={4000}
        rows={4}
        placeholder="e.g. Add tests for the date parser and run them"
        onChange={(e) => {
          setText(e.target.value);
          if (state.kind === 'error') setState({ kind: 'idle' });
        }}
      />
      <p className="talk-note">
        {when}
        {session.mailbox > 0 && ` ${session.mailbox} already waiting.`}
      </p>
      <div className="talk-actions">
        {state.kind === 'error' && <span className="talk-error">{state.msg}</span>}
        {state.kind === 'sent' && <span className="talk-ok">📨 Sent to {name}'s mailbox</span>}
        <button onClick={onClose}>Cancel</button>
        <button className="primary" onClick={() => void send()} disabled={!text.trim() || state.kind === 'sending'}>
          {state.kind === 'sending' ? 'Sending…' : 'Send  ⌘↵'}
        </button>
      </div>
    </div>
  );
}
