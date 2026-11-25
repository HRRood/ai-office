// Starts background (headless) Claude Code sessions in configured projects, and continues them
// when you send them prompts from the office.
//
//   new session:  echo <prompt> | claude -p --output-format stream-json --verbose --permission-mode …
//   follow-up:    echo <prompt> | claude -p --resume <session-id> …
//
// Prompts go through stdin (never the command line). Only folders listed in office.projects.json
// can be used. Headless runs can't show permission prompts: permissionMode / allowedTools in the
// config decide what they may do on their own; anything else is refused.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { OfficeState } from './state';

const CONFIG_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../office.projects.json');
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions']);

export interface ProjectInfo {
  id: number;
  name: string;
  /** folder name only; full paths stay on the server */
  folder: string;
}

interface Config {
  projects: Array<{ name: string; path: string }>;
  permissionMode: string;
  allowedTools: string[];
  claudePath: string;
  maxConcurrent: number;
}

interface Run {
  proc: ChildProcess;
  cwd: string;
  project: string;
  sessionId?: string;
  startedAt: number;
  /** stopped on purpose (sent home): not an error */
  stopped?: boolean;
}

export class Launcher {
  private runs = new Set<Run>();
  /** Sessions this launcher started: session id -> folder (for follow-ups). */
  private headless = new Map<string, { cwd: string; project: string }>();

  constructor(private readonly office: OfficeState) {
    // A prompt arrived for one of our sessions: run it if the session isn't busy.
    office.onQueued = (sessionId) => this.pump(sessionId);
  }

  /** Read and validate the config on every use, so edits apply without a restart. */
  private config(): { cfg?: Config; error?: string } {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      return { error: e.code === 'ENOENT' ? 'no office.projects.json (copy office.projects.example.json)' : `office.projects.json: ${e.message}` };
    }
    const o = (raw ?? {}) as Record<string, unknown>;
    const projects = (Array.isArray(o.projects) ? o.projects : [])
      .map((p) => p as { name?: unknown; path?: unknown })
      .filter((p) => typeof p.path === 'string' && path.isAbsolute(p.path))
      .map((p) => ({ name: typeof p.name === 'string' && p.name ? p.name : path.basename(p.path as string), path: p.path as string }));
    const permissionMode = typeof o.permissionMode === 'string' && PERMISSION_MODES.has(o.permissionMode) ? o.permissionMode : 'default';
    const allowedTools = Array.isArray(o.allowedTools) ? o.allowedTools.filter((t): t is string => typeof t === 'string') : [];
    const claudePath = typeof o.claudePath === 'string' && o.claudePath ? o.claudePath : 'claude';
    const maxConcurrent = typeof o.maxConcurrent === 'number' && o.maxConcurrent > 0 ? Math.min(o.maxConcurrent, 10) : 3;
    return { cfg: { projects, permissionMode, allowedTools, claudePath, maxConcurrent } };
  }

  /** What the Manager can offer (names and folder names only). */
  list(): { projects: ProjectInfo[]; permissionMode?: string; error?: string } {
    const { cfg, error } = this.config();
    if (!cfg) return { projects: [], error };
    return {
      projects: cfg.projects.map((p, id) => ({ id, name: p.name, folder: path.basename(p.path) })),
      permissionMode: cfg.permissionMode,
    };
  }

  isHeadless(sessionId: string) {
    return this.headless.has(sessionId);
  }

  /** Stop a background session: kill its current run (if any) and forget it. */
  stop(sessionId: string): boolean {
    const known = this.headless.delete(sessionId);
    let killed = false;
    for (const r of this.runs)
      if (r.sessionId === sessionId) {
        r.sessionId = undefined; // don't resume it when the process closes
        r.stopped = true;
        r.proc.kill('SIGTERM');
        killed = true;
      }
    if (killed) console.log(`🛑 stopped background run of ${sessionId.slice(0, 8)}`);
    return known || killed;
  }

  /** Start a new background session. Returns an error message, or null. */
  launch(projectId: number, prompt: string): string | null {
    const { cfg, error } = this.config();
    if (!cfg) return error ?? 'no config';
    const p = cfg.projects[projectId];
    if (!p) return 'unknown project';
    try {
      if (!fs.statSync(p.path).isDirectory()) return `${p.path} is not a folder`;
    } catch {
      return `${p.path} does not exist`;
    }
    if (this.runs.size >= cfg.maxConcurrent) return `already ${this.runs.size} background runs (max ${cfg.maxConcurrent})`;
    this.start(cfg, p.path, p.name, prompt);
    this.office.notice(p.name, `🚀 Started a background session in ${p.name}`);
    return null;
  }

  /** If a background session is free and has mail, continue it with the next prompt. */
  private pump(sessionId: string) {
    const info = this.headless.get(sessionId);
    if (!info) return;
    if ([...this.runs].some((r) => r.sessionId === sessionId)) return; // still running; we'll pump on exit
    const { cfg } = this.config();
    if (!cfg || this.runs.size >= cfg.maxConcurrent) return;
    const text = this.office.takePrompt(sessionId);
    if (text) this.start(cfg, info.cwd, info.project, text, sessionId);
  }

  private start(cfg: Config, cwd: string, project: string, prompt: string, resume?: string) {
    const args = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', cfg.permissionMode];
    if (cfg.allowedTools.length) args.push('--allowedTools', cfg.allowedTools.join(','));
    if (resume) args.push('--resume', resume);
    // On Windows `claude` is a .cmd shim, which can only be started through the shell. The prompt
    // never goes on the command line (it's written to stdin), and every argument is quoted.
    const win = process.platform === 'win32';
    const proc = spawn(win ? winQuote(cfg.claudePath) : cfg.claudePath, win ? args.map(winQuote) : args, {
      cwd,
      shell: win,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // our own mailbox hook must not wait inside a headless run
      env: { ...process.env, CLAUDE_OFFICE_HEADLESS: '1' },
    });
    const run: Run = { proc, cwd, project, sessionId: resume, startedAt: Date.now() };
    this.runs.add(run);
    if (resume) this.headless.set(resume, { cwd, project });

    let buf = '';
    let lastError = '';
    proc.stdout?.setEncoding('utf8');
    proc.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const m = JSON.parse(line) as { session_id?: string; type?: string; is_error?: boolean; result?: string };
          if (m.session_id && !run.sessionId) {
            run.sessionId = m.session_id;
            this.headless.set(m.session_id, { cwd, project });
            this.office.markHeadless(m.session_id);
          }
          if (m.type === 'result' && m.is_error) lastError = String(m.result ?? 'error').slice(0, 160);
        } catch {
          /* not JSON: ignore */
        }
      }
    });
    proc.stderr?.setEncoding('utf8');
    proc.stderr?.on('data', (c: string) => {
      const line = c.trim().split('\n').pop();
      if (line) lastError = line.slice(0, 160);
    });
    proc.on('error', (err: NodeJS.ErrnoException) => {
      lastError = err.code === 'ENOENT' ? `"${cfg.claudePath}" not found (set claudePath in office.projects.json)` : err.message;
    });
    proc.on('close', (code) => {
      this.runs.delete(run);
      const secs = Math.round((Date.now() - run.startedAt) / 1000);
      console.log(`🤖 background run in ${project} ended (code ${code}, ${secs}s)`);
      if (code !== 0 && !run.stopped) this.office.notice(project, `⚠ Background run in ${project} stopped: ${lastError || `exit ${code}`}`);
      // anything waiting in its mailbox? then keep going
      if (run.sessionId) this.pump(run.sessionId);
    });

    proc.stdin?.end(prompt);
    console.log(`🤖 ${resume ? 'continuing' : 'starting'} background run in ${project}${resume ? ` (${resume.slice(0, 8)})` : ''}`);
  }
}

/** Quote one argument for cmd.exe (used only on Windows, where .cmd shims need a shell). */
function winQuote(arg: string): string {
  if (/^[\w.:/\\=-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["%^])/g, '^$1')}"`;
}
