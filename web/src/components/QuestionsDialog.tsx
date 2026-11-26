import { useEffect, useState } from 'react';
import { shorten } from '../../../shared/names';
import type { PendingQuestion, SessionState } from '../../../shared/types';
import { SESSION_COLORS } from '../engine/sprites';
import { answerQuestion, releaseQuestion } from '../useOffice';

interface Props {
  managerName: string;
  /** Waiting questions, oldest first. */
  questions: PendingQuestion[];
  sessions: SessionState[];
  nicknames: Record<string, string>;
  onClose: () => void;
}

/** Per question: the options you picked, and your own answer ("Other"). */
interface Choice {
  picked: string[];
  other: string;
}

/** The value Claude gets for one question: option label(s) joined by commas, or your own text. */
function valueOf(c: Choice | undefined): string {
  if (!c) return '';
  return [...c.picked, c.other.trim()].filter(Boolean).join(', ');
}

/** Answer Claude's questions (AskUserQuestion) at the Manager's desk. */
export function QuestionsDialog({ managerName, questions, sessions, nicknames, onClose }: Props) {
  const current = questions[0];
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'error'; msg?: string }>({ kind: 'idle' });

  // A fresh form for each question set.
  useEffect(() => {
    setChoices({});
    setState({ kind: 'idle' });
  }, [current?.id]);

  if (!current) {
    return (
      <div className="talk questions" role="dialog" aria-label="Questions">
        <p className="empty">No questions waiting. {managerName} will let you know.</p>
        <div className="talk-actions">
          <button className="primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const session = sessions.find((s) => s.id === current.sessionId);
  const name = shorten(nicknames[current.sessionId] ?? current.name, 40);
  const color = session ? SESSION_COLORS[session.color % SESSION_COLORS.length] : 'var(--muted)';
  const complete = current.questions.every((q) => valueOf(choices[q.question]));

  const update = (question: string, f: (c: Choice) => Choice) =>
    setChoices((all) => ({ ...all, [question]: f(all[question] ?? { picked: [], other: '' }) }));

  const send = async () => {
    if (!complete || state.kind === 'sending') return;
    setState({ kind: 'sending' });
    const answers = Object.fromEntries(current.questions.map((q) => [q.question, valueOf(choices[q.question])]));
    const err = await answerQuestion(current.id, answers);
    setState(err ? { kind: 'error', msg: err } : { kind: 'idle' });
    if (!err && questions.length <= 1) onClose();
  };

  const toTerminal = async () => {
    const err = await releaseQuestion(current.id);
    if (err) setState({ kind: 'error', msg: err });
    else if (questions.length <= 1) onClose();
  };

  return (
    <div
      className="talk questions"
      role="dialog"
      aria-label={`Questions from ${name}`}
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
        <span className="swatch" style={{ background: color }} />
        <div>
          <div className="talk-name">
            ❓ {current.by ? `${current.by} (for ${name})` : name} asks
            {questions.length > 1 && <span className="of"> · 1 of {questions.length} waiting</span>}
          </div>
          <div className="talk-doing">{current.project} · left on {managerName}'s desk</div>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <div className="question-list">
        {current.questions.map((q, qi) => {
          const c = choices[q.question] ?? { picked: [], other: '' };
          const group = `${current.id}-${qi}`;
          return (
            <fieldset key={group} className="question">
              <legend>
                {q.header && <span className="question-chip">{q.header}</span>}
                {q.question}
              </legend>
              {q.options.map((o) => {
                const on = c.picked.includes(o.label);
                return (
                  <label key={o.label} className={`question-option ${on ? 'on' : ''}`}>
                    <input
                      type={q.multiSelect ? 'checkbox' : 'radio'}
                      name={group}
                      checked={on}
                      onChange={() =>
                        update(q.question, (prev) =>
                          q.multiSelect
                            ? { ...prev, picked: on ? prev.picked.filter((l) => l !== o.label) : [...prev.picked, o.label] }
                            : { picked: [o.label], other: '' },
                        )
                      }
                    />
                    <span>
                      <span className="question-label">{o.label}</span>
                      {o.description && <span className="question-desc">{o.description}</span>}
                    </span>
                  </label>
                );
              })}
              <input
                className="question-other"
                type="text"
                maxLength={2000}
                value={c.other}
                placeholder={q.options.length ? 'Other: type your own answer' : 'Your answer'}
                onChange={(e) => {
                  const other = e.target.value;
                  update(q.question, (prev) => ({ picked: q.multiSelect ? prev.picked : [], other }));
                }}
              />
            </fieldset>
          );
        })}
      </div>

      <div className="talk-actions">
        {state.kind === 'error' && <span className="talk-error">{state.msg}</span>}
        <button onClick={() => void toTerminal()} title="Claude Code shows the question in its terminal right away">
          Answer in terminal
        </button>
        <button className="primary" onClick={() => void send()} disabled={!complete || state.kind === 'sending'}>
          {state.kind === 'sending' ? 'Sending…' : 'Send answer  ⌘↵'}
        </button>
      </div>
    </div>
  );
}
