import { useEffect, useState } from 'react';
import type { LogEntry, ServerMessage, SessionState } from '../../shared/types';

const PORT = Number(import.meta.env.VITE_OFFICE_PORT) || 4317;
const WS_URL = `ws://127.0.0.1:${PORT}/ws`;
const API = `http://127.0.0.1:${PORT}`;

/** Secret from the server's snapshot; authorises sending prompts. */
let token = '';

/** Put a prompt in a session's mailbox. Resolves with an error message, or null when queued. */
export async function sendPrompt(sessionId: string, text: string): Promise<string | null> {
  if (!token) return 'not connected to the office server';
  try {
    const res = await fetch(`${API}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-office-token': token },
      body: JSON.stringify({ session_id: sessionId, text }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `server said ${res.status}`;
  } catch {
    return 'could not reach the office server';
  }
}

export type ConnState = 'live' | 'connecting' | 'offline';

/** Send a worker home (and stop it, if it's a background session the office started). */
export async function dismissSession(sessionId: string): Promise<string | null> {
  if (!token) return 'not connected to the office server';
  try {
    const res = await fetch(`${API}/dismiss`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-office-token': token },
      body: JSON.stringify({ session_id: sessionId }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `server said ${res.status}`;
  } catch {
    return 'could not reach the office server';
  }
}

export interface LaunchProject {
  id: number;
  name: string;
  folder: string;
}

/** Projects the Manager may start background sessions in (from office.projects.json). */
export async function listProjects(): Promise<{ projects: LaunchProject[]; permissionMode?: string; error?: string }> {
  if (!token) return { projects: [], error: 'not connected to the office server' };
  try {
    const res = await fetch(`${API}/projects`, { headers: { 'x-office-token': token } });
    return (await res.json()) as { projects: LaunchProject[]; permissionMode?: string; error?: string };
  } catch {
    return { projects: [], error: 'could not reach the office server' };
  }
}

/** Start a background session. Resolves with an error message, or null when started. */
export async function launchSession(project: number, prompt: string): Promise<string | null> {
  if (!token) return 'not connected to the office server';
  try {
    const res = await fetch(`${API}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-office-token': token },
      body: JSON.stringify({ project, prompt }),
    });
    if (res.ok) return null;
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return body.error ?? `server said ${res.status}`;
  } catch {
    return 'could not reach the office server';
  }
}

export interface OfficeData {
  connected: boolean;
  /** live = snapshot received; connecting = (re)connecting; offline = several attempts failed in a row */
  conn: ConnState;
  sessions: SessionState[];
  log: LogEntry[];
}

const CONNECT_TIMEOUT_MS = 4000; // give up on an attempt that hangs
const SILENCE_MS = 40_000; // the server sends a heartbeat every 15 s
const MAX_RETRY_MS = 3000;
const OFFLINE_AFTER = 4; // failed attempts before we say "offline"

/** Live office state from the server, reconnecting with backoff. */
export function useOffice(): OfficeData {
  const [data, setData] = useState<OfficeData>({ connected: false, conn: 'connecting', sessions: [], log: [] });

  useEffect(() => {
    let ws: WebSocket | undefined;
    let retry = 300;
    let failures = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let lastMessage = Date.now();
    let closed = false;

    const scheduleRetry = () => {
      if (closed || retryTimer) return;
      failures++;
      setData((d) => ({ ...d, connected: false, conn: failures >= OFFLINE_AFTER ? 'offline' : 'connecting' }));
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        connect();
      }, retry);
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    };

    const connect = () => {
      if (closed) return;
      clearTimeout(connectTimer);
      const sock = new WebSocket(WS_URL);
      ws = sock;
      connectTimer = setTimeout(() => {
        if (sock.readyState === WebSocket.CONNECTING) sock.close(); // hung attempt: onclose retries
      }, CONNECT_TIMEOUT_MS);
      sock.onopen = () => {
        clearTimeout(connectTimer);
        retry = 300;
        failures = 0;
        lastMessage = Date.now();
      };
      sock.onmessage = (ev) => {
        lastMessage = Date.now();
        let msg: ServerMessage;
        try {
          msg = JSON.parse(ev.data) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === 'ping') return;
        setData((d) => reduce(d, msg));
      };
      sock.onclose = () => {
        clearTimeout(connectTimer);
        if (ws !== sock) return; // an older socket we already replaced
        scheduleRetry();
      };
    };

    // Reconnect right away when it makes sense instead of waiting for the backoff.
    const kick = () => {
      if (closed) return;
      const open = ws?.readyState === WebSocket.OPEN;
      const stale = open && Date.now() - lastMessage > SILENCE_MS;
      if (open && !stale) return;
      clearTimeout(retryTimer);
      retryTimer = undefined;
      retry = 300;
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        const old = ws;
        ws = undefined; // so its onclose doesn't schedule another retry
        old.close();
      }
      connect();
    };
    const watchdog = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN && Date.now() - lastMessage > SILENCE_MS) kick();
    }, 5000);
    const onVisible = () => document.visibilityState === 'visible' && kick();
    window.addEventListener('online', kick);
    window.addEventListener('focus', kick);
    document.addEventListener('visibilitychange', onVisible);

    connect();
    return () => {
      closed = true;
      clearTimeout(retryTimer);
      clearTimeout(connectTimer);
      clearInterval(watchdog);
      window.removeEventListener('online', kick);
      window.removeEventListener('focus', kick);
      document.removeEventListener('visibilitychange', onVisible);
      ws?.close();
    };
  }, []);

  return data;
}

function reduce(d: OfficeData, msg: ServerMessage): OfficeData {
  switch (msg.type) {
    case 'snapshot':
      if (msg.token) token = msg.token;
      return { connected: true, conn: 'live', sessions: msg.sessions, log: msg.log };
    case 'session': {
      const i = d.sessions.findIndex((s) => s.id === msg.session.id);
      const sessions = i < 0 ? [...d.sessions, msg.session] : d.sessions.map((s, j) => (j === i ? msg.session : s));
      return { ...d, sessions };
    }
    case 'remove':
      return { ...d, sessions: d.sessions.filter((s) => s.id !== msg.id) };
    case 'log':
      return { ...d, log: [msg.entry, ...d.log].slice(0, 50) };
    case 'ping':
      return d;
  }
}
