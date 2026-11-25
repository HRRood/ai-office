import { useEffect, useRef, useState } from 'react';
import { launchSession, listProjects, type LaunchProject } from '../useOffice';

/** The Manager's "new assignment" form: start a background Claude Code session in a project. */
export function LaunchDialog({ managerName, onClose }: { managerName: string; onClose: () => void }) {
  const [projects, setProjects] = useState<LaunchProject[] | null>(null);
  const [mode, setMode] = useState<string | undefined>();
  const [loadError, setLoadError] = useState<string | undefined>();
  const [project, setProject] = useState<number | null>(null);
  const [text, setText] = useState('');
  const [state, setState] = useState<{ kind: 'idle' | 'sending' | 'sent' | 'error'; msg?: string }>({ kind: 'idle' });
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void listProjects().then((r) => {
      setProjects(r.projects);
      setMode(r.permissionMode);
      setLoadError(r.error);
      if (r.projects.length) setProject(r.projects[0].id);
    });
    area.current?.focus();
  }, []);

  const send = async () => {
    const t = text.trim();
    if (!t || project === null || state.kind === 'sending') return;
    setState({ kind: 'sending' });
    const err = await launchSession(project, t);
    if (err) setState({ kind: 'error', msg: err });
    else {
      setState({ kind: 'sent' });
      setTimeout(onClose, 1800);
    }
  };

  return (
    <div
      className="talk"
      role="dialog"
      aria-label="Start a new session"
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
        <span className="swatch" style={{ background: '#a01830' }} />
        <div>
          <div className="talk-name">{managerName}</div>
          <div className="talk-doing">"Name the project. I will assign the work."</div>
        </div>
        <button className="close" onClick={onClose} aria-label="Close">
          ×
        </button>
      </div>

      <label className="talk-label" htmlFor="launch-project">
        Project
      </label>
      {projects === null ? (
        <p className="talk-note">Loading projects…</p>
      ) : projects.length === 0 ? (
        <p className="talk-error">
          {loadError ?? 'No projects configured.'} Add folders to <code>office.projects.json</code>.
        </p>
      ) : (
        <select
          id="launch-project"
          className="talk-select"
          value={project ?? ''}
          onChange={(e) => setProject(Number(e.target.value))}
        >
          {projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.folder})
            </option>
          ))}
        </select>
      )}

      <label className="talk-label" htmlFor="launch-text">
        First prompt
      </label>
      <textarea
        id="launch-text"
        ref={area}
        value={text}
        maxLength={4000}
        rows={4}
        placeholder="e.g. Find and fix the failing test in the date parser"
        onChange={(e) => {
          setText(e.target.value);
          if (state.kind === 'error') setState({ kind: 'idle' });
        }}
      />
      <p className="talk-note">
        Runs in the background (no terminal window). It can't ask for permission, so it may only do what
        your config allows{mode ? ` (permission mode: ${mode})` : ''}. Talk to its worker afterwards to continue the
        conversation.
      </p>
      <div className="talk-actions">
        {state.kind === 'error' && <span className="talk-error">{state.msg}</span>}
        {state.kind === 'sent' && <span className="talk-ok">🚀 Started: a new worker is on the way</span>}
        <button onClick={onClose}>Cancel</button>
        <button
          className="primary"
          onClick={() => void send()}
          disabled={!text.trim() || project === null || state.kind === 'sending'}
        >
          {state.kind === 'sending' ? 'Starting…' : 'Start session  ⌘↵'}
        </button>
      </div>
    </div>
  );
}
