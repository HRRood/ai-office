import {
  EVENT_ROOMS,
  describeTool,
  roomForTool,
  type RoomId,
} from '../shared/rooms.config';
import { displayName, shorten } from '../shared/names';
import type {
  LogEntry,
  OfficeEvent,
  ServerMessage,
  SessionState,
  SubagentState,
  WorkerState,
} from '../shared/types';

export const IDLE_AFTER_MS = 2 * 60_000;
export const REMOVE_AFTER_MS = 15 * 60_000;
/** Background sessions wait longer for your next prompt. */
export const HEADLESS_REMOVE_AFTER_MS = 60 * 60_000;
const LOG_SIZE = 50;
const RECENT_SIZE = 20;
const PALETTE_SIZE = 12;

/** Events that only refresh lastSeen and don't deserve a log line. */
const QUIET_EVENTS = new Set(['PostToolUse']);

export const MAILBOX_MAX = 5;
export const PROMPT_MAX_CHARS = 4000;

interface Letter {
  text: string;
  queuedAt: number;
}

export class OfficeState {
  readonly sessions = new Map<string, SessionState>();
  readonly log: LogEntry[] = [];
  private logSeq = 0;
  /** Prompts waiting for delivery, per session. Kept in memory only. */
  private mailbox = new Map<string, Letter[]>();
  /** When each session last started a turn from its own prompt (so stale mailbox pollers can stand down). */
  private lastPromptAt = new Map<string, number>();
  /** Sessions started in the background by the launcher: their mail is delivered by resuming them. */
  private headless = new Set<string>();
  /** Called when a prompt is queued (the launcher continues background sessions). */
  onQueued?: (sessionId: string) => void;
  /** Sessions you sent home: ignored until you start a new turn in them. */
  private dismissed = new Set<string>();

  constructor(private readonly emit: (msg: ServerMessage) => void) {}

  snapshot(): ServerMessage {
    return { type: 'snapshot', sessions: [...this.sessions.values()], log: this.log };
  }

  /** Apply one hook event. Returns the log entry if it produced one (for console output). */
  handle(e: OfficeEvent): LogEntry | undefined {
    const now = Date.now();

    if (e.event === 'SessionEnd') {
      const s = this.sessions.get(e.session_id);
      if (!s) return;
      if (this.headless.has(s.id)) {
        // A background (claude -p) run ends its session after every reply. Keep the worker around:
        // your next prompt resumes the same conversation.
        s.status = 'resting';
        s.room = EVENT_ROOMS.Stop;
        s.action = 'Waiting for your next prompt';
        s.lastSeen = now;
        this.emitSession(s);
        return this.addLog(s, undefined, e.event, 'Finished (background session, talk to it to continue)', s.room, now);
      }
      this.sessions.delete(s.id);
      this.mailbox.delete(s.id);
      this.lastPromptAt.delete(s.id);
      this.emit({ type: 'remove', id: s.id });
      return this.addLog(s, undefined, e.event, `Left the office (${e.reason ?? 'ended'})`, s.room, now);
    }

    if (this.dismissed.has(e.session_id)) {
      // You sent it home. It only comes back when you use it again (new prompt or new start).
      if (e.event !== 'UserPromptSubmit' && e.event !== 'SessionStart') return;
      if (e.agent_id) return;
      this.dismissed.delete(e.session_id);
    }

    const session = this.sessions.get(e.session_id) ?? this.createSession(e, now);
    if (e.project) session.project = e.project;
    if (e.title) session.title = e.title;
    session.lastSeen = now;
    if (e.event === 'UserPromptSubmit' && !e.agent_id) this.lastPromptAt.set(session.id, now);

    // Events fired from inside a subagent carry agent_id.
    let actor: WorkerState = session;
    let sub: SubagentState | undefined;
    if (e.agent_id) {
      if (e.event === 'SubagentStop') {
        const idx = session.subagents.findIndex((a) => a.id === e.agent_id);
        const gone = idx >= 0 ? session.subagents.splice(idx, 1)[0] : undefined;
        this.emitSession(session);
        const type = gone?.agentType ?? e.agent_type ?? 'subagent';
        return this.addLog(session, gone, e.event, `${type} finished`, gone?.room ?? 'meeting', now);
      }
      sub = session.subagents.find((a) => a.id === e.agent_id);
      if (!sub) {
        sub = {
          id: e.agent_id,
          agentType: e.agent_type ?? 'subagent',
          room: 'meeting',
          action: 'Joining',
          status: 'working',
          lastSeen: now,
          startedAt: now,
        };
        session.subagents.push(sub);
      }
      sub.lastSeen = now;
      actor = sub;
    }

    const changed = this.apply(actor, e);
    this.emitSession(session);
    if (!changed || QUIET_EVENTS.has(e.event)) return;

    const entry = this.addLog(session, sub, e.event, actor.action, actor.room, now);
    session.recent.unshift({ ts: now, action: actor.action, room: actor.room, by: sub?.agentType });
    session.recent.length = Math.min(session.recent.length, RECENT_SIZE);
    return entry;
  }

  /** Update a worker for an event. Returns false when nothing visible changed. */
  private apply(w: WorkerState, e: OfficeEvent): boolean {
    const set = (room: RoomId, action: string, status: WorkerState['status']) => {
      w.room = room;
      w.action = action;
      w.status = status;
      return true;
    };

    switch (e.event) {
      case 'SessionStart':
        return set(EVENT_ROOMS.SessionStart, e.source === 'resume' ? 'Back at work' : 'Clocking in', 'resting');
      case 'UserPromptSubmit':
        return set(EVENT_ROOMS.UserPromptSubmit, 'New task!', 'working');
      case 'SubagentStart':
        return set(EVENT_ROOMS.SubagentStart, `${e.agent_type ?? 'Helper'} reporting`, 'working');
      case 'PreToolUse':
        return set(roomForTool(e.tool), describeTool(e), 'working');
      case 'PostToolUse':
        // Tool finished; if we were waiting on permission, it was granted.
        if (w.status === 'waiting') w.status = 'working';
        return false;
      case 'PostToolUseFailure':
        return set(w.room, e.interrupted ? 'Interrupted' : `${describeTool(e)} failed`, 'working');
      case 'PermissionRequest':
        // Stop in place; keep the room.
        return set(w.room, `Needs OK: ${describeTool(e)}`, 'waiting');
      case 'Notification':
        switch (e.notification_type) {
          case 'permission_prompt':
            // PermissionRequest usually got here first with a more specific message.
            return w.status === 'waiting' ? false : set(w.room, 'Waiting for permission', 'waiting');
          case 'elicitation_dialog':
            return set(w.room, 'Question for you', 'waiting');
          case 'idle_prompt':
            return set(w.room, 'Waiting for your reply', 'resting');
          default:
            return false;
        }
      case 'Stop':
        return set(EVENT_ROOMS.Stop, 'Coffee break', 'resting');
      case 'StopFailure':
        return set(EVENT_ROOMS.StopFailure, `Error: ${e.error ?? 'unknown'}`, 'resting');
      default:
        return false; // unknown events just refresh lastSeen
    }
  }

  /** Called periodically: mark idle workers, drop abandoned ones. */
  sweep(now = Date.now()): void {
    for (const s of this.sessions.values()) {
      let changed = false;
      s.subagents = s.subagents.filter((a) => {
        if (now - a.lastSeen > REMOVE_AFTER_MS) return (changed = true) && false;
        if (now - a.lastSeen > IDLE_AFTER_MS && a.status === 'working') {
          a.status = 'idle';
          changed = true;
        }
        return true;
      });

      const quiet = now - s.lastSeen;
      const removeAfter = this.headless.has(s.id) ? HEADLESS_REMOVE_AFTER_MS : REMOVE_AFTER_MS;
      if (quiet > removeAfter && s.subagents.length === 0) {
        this.sessions.delete(s.id);
        this.headless.delete(s.id);
        this.mailbox.delete(s.id);
        this.emit({ type: 'remove', id: s.id });
        this.addLog(s, undefined, 'Timeout', `Went home (idle ${Math.round(removeAfter / 60_000)} min)`, s.room, now);
        continue;
      }
      // A pending permission prompt stays visible however long it waits.
      if (quiet > IDLE_AFTER_MS && s.status !== 'idle' && s.status !== 'waiting') {
        s.status = 'idle';
        changed = true;
      }
      if (changed) this.emitSession(s);
    }
  }

  private createSession(e: OfficeEvent, now: number): SessionState {
    const used = new Set([...this.sessions.values()].map((s) => s.color));
    let color = [...e.session_id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE_SIZE;
    for (let i = 0; i < PALETTE_SIZE && used.has(color); i++) color = (color + 1) % PALETTE_SIZE;

    const s: SessionState = {
      id: e.session_id,
      project: e.project ?? 'unknown',
      room: 'reception',
      action: 'Arriving',
      status: 'working',
      lastSeen: now,
      startedAt: now,
      color,
      subagents: [],
      recent: [],
      mailbox: 0,
      headless: this.headless.has(e.session_id) || undefined,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  // ---------- mailbox: prompts you send from the office ----------

  /** Queue a prompt for a session. Returns an error string, or null on success. */
  queuePrompt(sessionId: string, text: string): string | null {
    const s = this.sessions.get(sessionId);
    if (!s) return 'unknown session';
    const box = this.mailbox.get(sessionId) ?? [];
    if (box.length >= MAILBOX_MAX) return `mailbox full (${MAILBOX_MAX} waiting)`;
    box.push({ text, queuedAt: Date.now() });
    this.mailbox.set(sessionId, box);
    s.mailbox = box.length;
    this.emitSession(s);
    this.addLog(s, undefined, 'Mailbox', `📨 You sent a prompt (${box.length} waiting)`, s.room, Date.now());
    this.onQueued?.(sessionId);
    return null;
  }

  /** Send a worker home: it leaves the office and stays out until you use the session again. */
  dismiss(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.sessions.delete(sessionId);
    this.mailbox.delete(sessionId);
    this.headless.delete(sessionId);
    this.lastPromptAt.set(sessionId, Date.now()); // any waiting mailbox poller stands down
    this.dismissed.add(sessionId);
    this.emit({ type: 'remove', id: sessionId });
    this.addLog(s, undefined, 'Dismissed', 'Sent home by you', s.room, Date.now());
    return true;
  }

  /** The launcher started this session in the background. */
  markHeadless(sessionId: string) {
    this.headless.add(sessionId);
    const s = this.sessions.get(sessionId);
    if (s && !s.headless) {
      s.headless = true;
      this.emitSession(s);
    }
  }

  /** Take the next prompt for a background session (the launcher runs it). */
  takePrompt(sessionId: string): string | null {
    const s = this.sessions.get(sessionId);
    const box = this.mailbox.get(sessionId);
    if (!s || !box?.length) return null;
    const letter = box.shift()!;
    s.mailbox = box.length;
    s.room = 'reception';
    s.action = 'New task (from you)!';
    s.status = 'working';
    s.lastSeen = Date.now();
    this.emitSession(s);
    this.addLog(s, undefined, 'Mailbox', '📨 Delivered your prompt', s.room, Date.now());
    return letter.text;
  }

  /** A line in the activity log that isn't about a particular session (launcher messages). */
  notice(project: string, text: string) {
    const entry: LogEntry = {
      id: ++this.logSeq,
      ts: Date.now(),
      sessionId: 'launcher',
      project,
      event: 'Launcher',
      action: text,
      room: 'reception',
    };
    this.log.unshift(entry);
    this.log.length = Math.min(this.log.length, LOG_SIZE);
    this.emit({ type: 'log', entry });
  }

  /**
   * Called by the mailbox hook that waits after each finished turn.
   *   'stop'  -> this poller should exit: the session ended, or it started a new turn on its own
   *   null    -> nothing yet, keep waiting
   *   string  -> a prompt to deliver (removed from the queue)
   */
  claimPrompt(sessionId: string, since: number): 'stop' | null | string {
    const s = this.sessions.get(sessionId);
    if (!s || this.dismissed.has(sessionId)) return 'stop';
    if (this.headless.has(sessionId)) return 'stop'; // background sessions get mail by being resumed
    if ((this.lastPromptAt.get(sessionId) ?? 0) > since) return 'stop';
    const box = this.mailbox.get(sessionId);
    if (!box?.length) return null;
    const letter = box.shift()!;
    s.mailbox = box.length;
    // Claude starts working on it now: show that right away.
    s.room = 'reception';
    s.action = 'New task (from you)!';
    s.status = 'working';
    s.lastSeen = Date.now();
    this.lastPromptAt.set(sessionId, Date.now());
    this.emitSession(s);
    this.addLog(s, undefined, 'Mailbox', '📨 Delivered your prompt', s.room, Date.now());
    s.recent.unshift({ ts: Date.now(), action: '📨 Got a prompt from you', room: s.room });
    s.recent.length = Math.min(s.recent.length, RECENT_SIZE);
    return letter.text;
  }

  private emitSession(s: SessionState) {
    this.emit({ type: 'session', session: s });
  }

  private addLog(
    s: SessionState,
    sub: SubagentState | undefined,
    event: string,
    action: string,
    room: RoomId,
    ts: number,
  ): LogEntry {
    const entry: LogEntry = {
      id: ++this.logSeq,
      ts,
      sessionId: s.id,
      project: shorten(displayName(s), 32),
      agentId: sub?.id,
      agentType: sub?.agentType,
      event,
      action,
      room,
    };
    this.log.unshift(entry);
    this.log.length = Math.min(this.log.length, LOG_SIZE);
    this.emit({ type: 'log', entry });
    return entry;
  }
}

