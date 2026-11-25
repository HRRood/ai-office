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
  | { type: 'snapshot'; sessions: SessionState[]; log: LogEntry[]; token?: string }
  | { type: 'session'; session: SessionState }
  | { type: 'remove'; id: string }
  | { type: 'log'; entry: LogEntry }
  /** Heartbeat every 15 s so the page can tell a quiet office from a dead connection. */
  | { type: 'ping' };
