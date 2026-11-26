import type { RoomId } from './rooms.config';

/** What the hook POSTs to /event. Metadata only. */
export interface OfficeEvent {
  v?: number;
  session_id: string;
  event: string;
  ts?: number;
  project?: string;
  tool?: string;
  file?: string;
  cmd?: string;
  subagent_type?: string;
  agent_id?: string;
  agent_type?: string;
  source?: string;
  reason?: string;
  notification_type?: string;
  error?: string;
  interrupted?: boolean;
  /** Claude Code's session title, when it has one. */
  title?: string;
  /** Stop: Claude's final message of the turn, handed to the Manager as a report. */
  report?: string;
  /** Working directory (full path; stays on the local server, used to wake a sleeping session). */
  cwd?: string;
}

/** One question from Claude's AskUserQuestion tool. */
export interface AskedQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
}

/** An AskUserQuestion call waiting for your answer at the Manager. Kept in server memory only. */
export interface PendingQuestion {
  id: string;
  sessionId: string;
  /** Session name when it asked. */
  name: string;
  project: string;
  /** Asked by a helper (subagent type), if it wasn't the session itself. */
  by?: string;
  ts: number;
  questions: AskedQuestion[];
}

/** What a worker says while walking their report over to the Manager. */
export const REPORT_ACTION = '📄 Handing in my report';

/** A finished turn's final message, delivered to the Manager. Kept in server memory only. */
export interface Report {
  id: number;
  sessionId: string;
  /** Session name when the report was handed in (the worker may have left since). */
  name: string;
  project: string;
  ts: number;
  text: string;
  read: boolean;
}

/**
 * working: actively using tools
 * waiting: blocked on the user's permission / answer
 * resting: turn finished, in the lounge
 * idle:    no events for a while
 */
export type WorkerStatus = 'working' | 'waiting' | 'resting' | 'idle';

export interface WorkerState {
  id: string;
  room: RoomId;
  action: string;
  status: WorkerStatus;
  lastSeen: number;
}

export interface SubagentState extends WorkerState {
  agentType: string;
  startedAt: number;
}

export interface ActionEntry {
  ts: number;
  action: string;
  room: RoomId;
  /** Subagent type if a subagent did it. */
  by?: string;
}

export interface SessionState extends WorkerState {
  project: string;
  /** Claude Code's session title (as in /resume), once it has one. */
  title?: string;
  /** Stable palette index, distinct among live sessions. */
  color: number;
  startedAt: number;
  subagents: SubagentState[];
  recent: ActionEntry[];
  /** Prompts you sent from the office that are waiting to be delivered to this session. */
  mailbox: number;
  /** Started by the office in the background (claude -p); follow-ups resume it. */
  headless?: boolean;
  /** Idle for a long time: sleeping in the Sleeping Quarters until the guard fetches them. */
  asleep?: boolean;
  /** The guard is on the way to wake them. */
  waking?: boolean;
}

export interface LogEntry {
  id: number;
  ts: number;
  sessionId: string;
  project: string;
  agentId?: string;
  agentType?: string;
  event: string;
  action: string;
  room: RoomId;
}

export type ServerMessage =
  /** `token` authorises POST /prompt; only sent to (localhost-only) WebSocket clients. */
  /** `reports` is only sent to WebSocket clients (not the /state debug endpoint). */
  | { type: 'snapshot'; sessions: SessionState[]; log: LogEntry[]; token?: string; reports?: Report[]; questions?: PendingQuestion[] }
  /** The questions waiting at the Manager changed (all of them, oldest first). */
  | { type: 'questions'; questions: PendingQuestion[] }
  /** A new report arrived, or one changed (marked read). */
  | { type: 'report'; report: Report }
  /** The whole report list changed at once (all marked read, or read ones cleared). Newest first. */
  | { type: 'reports'; reports: Report[] }
  | { type: 'session'; session: SessionState }
  | { type: 'remove'; id: string }
  | { type: 'log'; entry: LogEntry }
  /** Heartbeat every 15 s so the page can tell a quiet office from a dead connection. */
  | { type: 'ping' };
