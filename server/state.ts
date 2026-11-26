import {
  EVENT_ROOMS,
  SLEEP_ROOM,
  describeTool,
  roomForTool,
  type RoomId,
} from '../shared/rooms.config';
import { displayName, shorten } from '../shared/names';
import { randomBytes } from 'node:crypto';
import {
  REPORT_ACTION,
  type AskedQuestion,
  type PendingQuestion,
  type LogEntry,
  type OfficeEvent,
  type Report,
  type ServerMessage,
  type SessionState,
  type SubagentState,
  type WorkerState,
} from '../shared/types';

export const IDLE_AFTER_MS = 2 * 60_000;
/** Helpers that go quiet this long are dropped. */
export const REMOVE_AFTER_MS = 15 * 60_000;
/** Sessions this quiet go to sleep in the Sleeping Quarters (the guard can fetch them back). */
export const SLEEP_AFTER_MS = (Number(process.env.OFFICE_SLEEP_AFTER_S) || 15 * 60) * 1000;
/** Background sessions stay up longer waiting for your next prompt. */
export const HEADLESS_SLEEP_AFTER_MS = 60 * 60_000;
/** Sleepers this quiet finally go home. */
export const GONE_AFTER_MS = 24 * 60 * 60_000;
/** The mailbox hook polls every 1.5 s; quieter than this means nobody is listening. */
const MAILBOX_LISTENING_MS = 10_000;
const LOG_SIZE = 50;
const RECENT_SIZE = 20;
const PALETTE_SIZE = 12;

/** Events that only refresh lastSeen and don't deserve a log line. */
const QUIET_EVENTS = new Set(['PostToolUse']);

export const MAILBOX_MAX = 5;
export const PROMPT_MAX_CHARS = 4000;

/** Reports the Manager keeps (oldest dropped first). */
export const REPORTS_MAX = 50;
export const REPORT_MAX_CHARS = 20_000;
/** How long a worker spends walking their report to the Manager before their coffee break. */
const REPORT_WALK_MS = 9000;

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
  /** Each session's working directory (server only), for waking it with claude --resume. */
  private cwds = new Map<string, string>();
  /** When each session's mailbox hook last asked for mail. */
  private lastPollAt = new Map<string, number>();

  /** Final messages of finished turns, newest first. Kept in memory only. */
  readonly reports: Report[] = [];
  private reportSeq = 0;

  constructor(private readonly emit: (msg: ServerMessage) => void) {}

  /** AskUserQuestion calls waiting for an answer at the Manager, by id. */
  private questions = new Map<string, PendingQuestion>();
  /** Answers you gave, waiting for the question hook to pick them up. */
  private answers = new Map<string, Record<string, string>>();

  /** `withReports` only for WebSocket clients: report and question text stays off the /state debug endpoint. */
  snapshot(withReports = false): ServerMessage {
    return {
      type: 'snapshot',
      sessions: [...this.sessions.values()],
      log: this.log,
      ...(withReports ? { reports: this.reports, questions: this.pendingQuestions() } : {}),
    };
  }

  // ---------- questions: answer AskUserQuestion at the Manager ----------

  pendingQuestions(): PendingQuestion[] {
    return [...this.questions.values()].sort((a, b) => a.ts - b.ts);
  }

  private emitQuestions() {
    this.emit({ type: 'questions', questions: this.pendingQuestions() });
  }

  /** The question hook hands over an AskUserQuestion call. Returns its id. */
  askQuestion(sessionId: string, agentId: string | undefined, questions: AskedQuestion[]): string {
    const now = Date.now();
    const s = this.sessions.get(sessionId);
    const sub = agentId ? s?.subagents.find((a) => a.id === agentId) : undefined;
    const q: PendingQuestion = {
      id: randomBytes(12).toString('hex'),
      sessionId,
      name: s ? displayName(s) : 'A session',
      project: s?.project ?? 'unknown',
      by: sub?.agentType,
      ts: now,
      questions,
    };
    this.questions.set(q.id, q);
    this.emitQuestions();
    if (s) this.addLog(s, sub, 'Question', `❓ Has a question for you (answer at the Manager)`, 'reception', now);
    return q.id;
  }

  /**
   * The question hook polls for your answer.
   *   'gone'  -> stop waiting: released to the terminal, or the session moved on
   *   null    -> not answered yet
   *   object  -> your answers (removed)
   */
  pollQuestion(id: string): 'gone' | null | Record<string, string> {
    const a = this.answers.get(id);
    if (a) {
      this.answers.delete(id);
      return a;
    }
    return this.questions.has(id) ? null : 'gone';
  }

  /** You answered at the Manager. Returns an error string, or null on success. */
  answerQuestion(id: string, answers: unknown): string | null {
    const q = this.questions.get(id);
    if (!q) return 'that question is no longer waiting';
    if (!answers || typeof answers !== 'object') return 'no answers';
    const out: Record<string, string> = {};
    for (const item of q.questions) {
      const v = (answers as Record<string, unknown>)[item.question];
      if (typeof v !== 'string' || !v.trim()) return `answer "${item.header ?? item.question}" first`;
      out[item.question] = v.trim().slice(0, 2000);
    }
    this.questions.delete(id);
    this.answers.set(id, out);
    this.emitQuestions();
    const s = this.sessions.get(q.sessionId);
    if (s) {
      this.addLog(s, undefined, 'Question', '❓ You answered their question', 'reception', Date.now());
      const w = q.by ? s.subagents.find((a) => a.agentType === q.by) : s;
      if (w && w.status === 'waiting') {
        w.status = 'working';
        w.action = 'Got your answer';
        this.emitSession(s);
      }
    }
    // The hook should pick it up within a second or two; don't keep it forever if it never does.
    setTimeout(() => this.answers.delete(id), 60_000).unref?.();
    return null;
  }

  /** "Answer in terminal": the hook stops waiting and Claude Code shows its own dialog. */
  releaseQuestion(id: string): boolean {
    if (!this.questions.delete(id)) return false;
    this.emitQuestions();
    return true;
  }

  /** Drop questions a session no longer waits on (it moved on, ended, or was sent home). */
  private dropQuestions(sessionId: string) {
    let changed = false;
    for (const [id, q] of this.questions) if (q.sessionId === sessionId && this.questions.delete(id)) changed = true;
    if (changed) this.emitQuestions();
  }

  /** You opened a report. Returns false if it no longer exists. */
  markReportRead(id: number): boolean {
    const r = this.reports.find((x) => x.id === id);
    if (!r) return false;
    if (!r.read) {
      r.read = true;
      this.emit({ type: 'report', report: r });
    }
    return true;
  }

  /** A turn finished with a final message: file it with the Manager and walk it over. */
  private fileReport(s: SessionState, text: string, now: number) {
    const report: Report = {
      id: ++this.reportSeq,
      sessionId: s.id,
      name: displayName(s),
      project: s.project,
      ts: now,
      text: text.slice(0, REPORT_MAX_CHARS),
      read: false,
    };
    this.reports.unshift(report);
    this.reports.length = Math.min(this.reports.length, REPORTS_MAX);
    this.emit({ type: 'report', report });

    s.room = 'reception';
    s.action = REPORT_ACTION;
    s.status = 'working';
    // After the hand-in, the usual coffee break, unless something else happened in the meantime.
    setTimeout(() => {
      const cur = this.sessions.get(s.id);
      if (!cur || cur.action !== REPORT_ACTION) return;
      cur.room = EVENT_ROOMS.Stop;
      cur.action = 'Coffee break';
      cur.status = 'resting';
      this.emitSession(cur);
    }, REPORT_WALK_MS).unref?.();
  }

  /** Apply one hook event. Returns the log entry if it produced one (for console output). */
  handle(e: OfficeEvent): LogEntry | undefined {
    const now = Date.now();

    // A question stops waiting once the session has clearly moved past it.
    const movedOn =
      e.event === 'SessionEnd' ||
      e.event === 'Stop' ||
      e.event === 'StopFailure' ||
      (e.event === 'UserPromptSubmit' && !e.agent_id) ||
      ((e.event === 'PostToolUse' || e.event === 'PostToolUseFailure') && e.tool === 'AskUserQuestion');
    if (movedOn) this.dropQuestions(e.session_id);

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
    if (e.cwd) this.cwds.set(session.id, e.cwd);
    session.lastSeen = now;
    if (session.asleep) {
      // Activity: they're up again (you typed in their terminal, or the guard woke them).
      session.asleep = undefined;
      session.waking = undefined;
    }
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

    let changed = this.apply(actor, e);
    if (e.event === 'Stop' && !sub && e.report?.trim()) {
      this.fileReport(session, e.report.trim(), now);
      changed = true;
    }
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
        // A question waits on you, like a permission prompt.
        return set(roomForTool(e.tool), describeTool(e), e.tool === 'AskUserQuestion' ? 'waiting' : 'working');
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
      if (quiet > GONE_AFTER_MS && s.subagents.length === 0) {
        this.forget(s.id);
        this.emit({ type: 'remove', id: s.id });
        this.addLog(s, undefined, 'Timeout', 'Went home (asleep for a day)', s.room, now);
        continue;
      }
      if (s.asleep) continue; // sleeping: nothing changes until they're woken
      const sleepAfter = this.headless.has(s.id) ? HEADLESS_SLEEP_AFTER_MS : SLEEP_AFTER_MS;
      // A pending question or permission prompt keeps them up.
      if (quiet > sleepAfter && s.subagents.length === 0 && s.status !== 'waiting') {
        s.asleep = true;
        s.room = SLEEP_ROOM;
        s.status = 'idle';
        s.action = 'Sleeping 💤';
        this.emitSession(s);
        this.addLog(s, undefined, 'Timeout', `Fell asleep (idle ${Math.round(sleepAfter / 60_000)} min)`, s.room, now);
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

  private forget(sessionId: string) {
    this.sessions.delete(sessionId);
    this.headless.delete(sessionId);
    this.mailbox.delete(sessionId);
    this.cwds.delete(sessionId);
    this.lastPollAt.delete(sessionId);
    this.dropQuestions(sessionId);
  }

  // ---------- sleeping: the guard fetches long-idle sessions back ----------

  /** The session's mailbox hook is waiting right now, so a prompt reaches it directly. */
  mailboxListening(sessionId: string): boolean {
    return Date.now() - (this.lastPollAt.get(sessionId) ?? 0) < MAILBOX_LISTENING_MS;
  }

  cwdOf(sessionId: string): string | undefined {
    return this.cwds.get(sessionId);
  }

  /** The Manager sent the guard. Returns an error string, or null. */
  startWaking(sessionId: string): string | null {
    const s = this.sessions.get(sessionId);
    if (!s) return 'unknown session';
    if (!s.asleep) return `${displayName(s)} is already awake: talk to them directly`;
    if (s.waking) return 'the guard is already on the way';
    s.waking = true;
    s.action = '💂 The guard is coming…';
    this.emitSession(s);
    this.addLog(s, undefined, 'Wake', '💂 The Manager sent the guard to wake them', s.room, Date.now());
    return null;
  }

  /** The guard got them up: back to the lounge, ready for your prompt. False if they're gone. */
  finishWaking(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s || !s.waking) return false;
    s.asleep = undefined;
    s.waking = undefined;
    s.room = EVENT_ROOMS.Stop;
    s.status = 'resting';
    s.action = 'Awake! Reporting back';
    s.lastSeen = Date.now();
    this.emitSession(s);
    return true;
  }

  /** Waking failed (e.g. the background run couldn't start): back to sleep. */
  failWaking(sessionId: string, why: string) {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.asleep = true;
    s.waking = undefined;
    s.room = SLEEP_ROOM;
    s.status = 'idle';
    s.action = 'Sleeping 💤';
    this.emitSession(s);
    this.addLog(s, undefined, 'Wake', `⚠ Couldn't wake them: ${why}`, s.room, Date.now());
  }

  /** Send a worker home: it leaves the office and stays out until you use the session again. */
  dismiss(sessionId: string): boolean {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    this.sessions.delete(sessionId);
    this.mailbox.delete(sessionId);
    this.headless.delete(sessionId);
    this.dropQuestions(sessionId);
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
    this.lastPollAt.set(sessionId, Date.now());
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

