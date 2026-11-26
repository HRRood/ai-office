import { randomBytes, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Launcher } from './launcher';
import { OfficeState, PROMPT_MAX_CHARS, REPORT_MAX_CHARS } from './state';
import { ROOM_LABELS } from '../shared/rooms.config';
import type { AskedQuestion, OfficeEvent, ServerMessage } from '../shared/types';

const HOST = '127.0.0.1';
const PORT = Number(process.env.OFFICE_PORT) || 4317;

// Only accept requests addressed to localhost (defeats DNS-rebinding) and, for WebSockets,
// only from localhost pages, so a random website can't read your activity feed.
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const LOCAL_ORIGIN = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/**
 * Secret for POST /prompt. Generated per run and only handed to WebSocket clients, which must be
 * localhost pages (see verifyClient). A page on another site can't open the socket, so it can't learn it.
 */
const TOKEN = randomBytes(24).toString('hex');

const office = new OfficeState(broadcast);
const launcher = new Launcher(office);
const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => (LOCAL_HOST.test(req.headers.host ?? '') ? next() : res.status(403).end()));

// express.json only parses `application/json`, which a cross-site form/fetch can't send
// without a CORS preflight that we never answer.
app.post('/event', express.json({ limit: '128kb' }), (req, res) => {
  const e = parseEvent(req.body);
  if (!e) return res.status(400).json({ error: 'invalid event' });
  const entry = office.handle(e);
  logLine(e, entry?.action, entry?.room);
  res.status(204).end();
});

// ---------- mailbox: send a prompt to a session from the office UI ----------

// CORS only for localhost pages (the Vite dev server runs on another port). Anyone else gets no
// CORS headers, so the browser refuses to send the request.
app.use(['/prompt', '/launch', '/projects', '/dismiss', '/reports/read', '/reports/read-all', '/reports/clear', '/question/answer', '/question/release', '/wake'], (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && LOCAL_ORIGIN.test(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Headers', 'content-type, x-office-token');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Vary', 'Origin');
  } else if (origin) return res.status(403).end();
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function tokenOk(req: express.Request) {
  const given = Buffer.from(String(req.headers['x-office-token'] ?? ''));
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

app.post('/prompt', express.json({ limit: '32kb' }), (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id : '';
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) return res.status(400).json({ error: 'empty prompt' });
  if (text.length > PROMPT_MAX_CHARS) return res.status(400).json({ error: `prompt too long (max ${PROMPT_MAX_CHARS})` });
  const err = office.queuePrompt(sessionId, text);
  if (err) return res.status(err === 'unknown session' ? 404 : 409).json({ error: err });
  console.log(`📨 prompt queued for ${sessionId.slice(0, 8)} (${text.length} chars)`);
  res.status(202).json({ ok: true });
});

// ---------- launcher: start background sessions in configured projects ----------

app.get('/projects', (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  res.json(launcher.list());
});

app.post('/launch', express.json({ limit: '32kb' }), (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  const projectId = Number(req.body?.project);
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
  if (!Number.isInteger(projectId)) return res.status(400).json({ error: 'pick a project' });
  if (!prompt) return res.status(400).json({ error: 'empty prompt' });
  if (prompt.length > PROMPT_MAX_CHARS) return res.status(400).json({ error: `prompt too long (max ${PROMPT_MAX_CHARS})` });
  const err = launcher.launch(projectId, prompt);
  if (err) return res.status(409).json({ error: err });
  res.status(202).json({ ok: true });
});

// Send a worker home. Background sessions the office started are also stopped.
app.post('/dismiss', express.json({ limit: '4kb' }), (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id : '';
  const stopped = launcher.stop(sessionId);
  if (!office.dismiss(sessionId) && !stopped) return res.status(404).json({ error: 'unknown session' });
  console.log(`🚪 sent ${sessionId.slice(0, 8)} home${stopped ? ' (background run stopped)' : ''}`);
  res.json({ ok: true, stopped });
});

// You opened a report in the Manager's inbox.
app.post('/reports/read', express.json({ limit: '4kb' }), (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  if (!office.markReportRead(Number(req.body?.id))) return res.status(404).json({ error: 'unknown report' });
  res.json({ ok: true });
});

app.post('/reports/read-all', (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  office.markAllReportsRead();
  res.json({ ok: true });
});

app.post('/reports/clear', (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  res.json({ ok: true, removed: office.clearReadReports() });
});

// ---------- waking: the Manager sends the guard to fetch a sleeping session ----------

/** How long the guard takes to walk over and shake them awake (matches the animation). */
const GUARD_WALK_MS = 7000;
const WAKE_DEFAULT_PROMPT =
  'The user woke you up from their Claude Office dashboard. In two or three sentences, say where you ' +
  'left off and what you would do next, then wait for instructions.';

app.post('/wake', express.json({ limit: '32kb' }), (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  const sessionId = typeof req.body?.session_id === 'string' ? req.body.session_id : '';
  const text = (typeof req.body?.text === 'string' ? req.body.text.trim() : '') || WAKE_DEFAULT_PROMPT;
  if (text.length > PROMPT_MAX_CHARS) return res.status(400).json({ error: `prompt too long (max ${PROMPT_MAX_CHARS})` });
  const session = office.sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'unknown session' });

  // Their own mailbox hook is still listening (or the office runs them): the prompt reaches them as is.
  // Otherwise resume them in the background, which only works in a configured project folder.
  const viaMailbox = office.mailboxListening(sessionId) || launcher.isHeadless(sessionId) || !!session.headless;
  const cwd = office.cwdOf(sessionId);
  if (!viaMailbox) {
    const check = launcher.resumable(cwd);
    if (check.error) return res.status(409).json({ error: check.error });
  }
  const err = office.startWaking(sessionId);
  if (err) return res.status(409).json({ error: err });
  console.log(`💂 waking ${sessionId.slice(0, 8)} (${viaMailbox ? 'mailbox' : 'background resume'})`);

  setTimeout(() => {
    if (!office.finishWaking(sessionId)) return; // left, or woke up on their own meanwhile
    if (viaMailbox) {
      const qErr = office.queuePrompt(sessionId, text);
      if (qErr) office.failWaking(sessionId, qErr);
      return;
    }
    const wErr = launcher.wake(sessionId, cwd!, text);
    if (wErr) office.failWaking(sessionId, wErr);
  }, GUARD_WALK_MS).unref?.();

  res.status(202).json({ ok: true, via: viaMailbox ? 'mailbox' : 'resume' });
});

// ---------- questions: answer Claude's AskUserQuestion at the Manager ----------

/** Someone has the office open, so a question can wait there for an answer. */
const officeOpen = () => [...wss.clients].some((c) => c.readyState === WebSocket.OPEN);

function parseQuestions(v: unknown): AskedQuestion[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 8).flatMap((q): AskedQuestion[] => {
    const o = (q ?? {}) as Record<string, unknown>;
    const question = s(o.question, 2000);
    if (!question) return [];
    const options = (Array.isArray(o.options) ? o.options : []).slice(0, 12).flatMap((x) => {
      const opt = (x ?? {}) as Record<string, unknown>;
      const label = s(opt.label, 200);
      return label ? [{ label, description: s(opt.description, 1000) }] : [];
    });
    return [{ question, header: s(o.header, 60), multiSelect: o.multiSelect === true, options }];
  });
}

// The question hook (hooks/office-question.js) hands over an AskUserQuestion call.
// 204 = nobody has the office open: answer in the terminal as usual.
app.post('/question', express.json({ limit: '128kb' }), (req, res) => {
  const sessionId = s(req.body?.session_id);
  const questions = parseQuestions(req.body?.questions);
  if (!sessionId || !questions.length) return res.status(400).json({ error: 'invalid question' });
  if (!officeOpen()) return res.status(204).end();
  const id = office.askQuestion(sessionId, s(req.body?.agent_id, 120), questions);
  console.log(`❓ question from ${sessionId.slice(0, 8)} waiting at the Manager`);
  res.status(201).json({ id });
});

app.get('/question/poll', (req, res) => {
  const r = office.pollQuestion(String(req.query.id ?? ''));
  if (r === 'gone') return res.status(410).end();
  if (r === null) return res.status(204).end();
  res.json({ answers: r });
});

// The hook gave up waiting (time limit): the question is back in the terminal.
app.post('/question/expire', express.json({ limit: '4kb' }), (req, res) => {
  office.releaseQuestion(String(req.body?.id ?? ''));
  res.status(204).end();
});

app.post('/question/answer', express.json({ limit: '64kb' }), (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  const err = office.answerQuestion(String(req.body?.id ?? ''), req.body?.answers);
  if (err) return res.status(409).json({ error: err });
  console.log('❓ question answered from the office');
  res.json({ ok: true });
});

app.post('/question/release', express.json({ limit: '4kb' }), (req, res) => {
  if (!tokenOk(req)) return res.status(403).json({ error: 'bad token' });
  if (!office.releaseQuestion(String(req.body?.id ?? ''))) return res.status(404).json({ error: 'that question is no longer waiting' });
  res.json({ ok: true });
});

// The mailbox hook (hooks/office-mailbox.js) polls this after each finished turn.
app.get('/mailbox/next', (req, res) => {
  const sessionId = String(req.query.session_id ?? '');
  const since = Number(req.query.since) || 0;
  const r = office.claimPrompt(sessionId, since);
  if (r === 'stop') return res.status(410).end();
  if (r === null) return res.status(204).end();
  console.log(`📨 prompt delivered to ${sessionId.slice(0, 8)}`);
  res.json({ text: r });
});

app.get('/state', (_req, res) => res.json(office.snapshot()));
app.get('/health', (_req, res) => res.json({ ok: true, sessions: office.sessions.size }));

const server = createServer(app);
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ origin, req }: { origin?: string; req: { headers: Record<string, unknown> } }) =>
    LOCAL_HOST.test(String(req.headers.host ?? '')) && (!origin || LOCAL_ORIGIN.test(origin)),
});

// Errors on the WebSocket server (e.g. while the port is still being released) must never crash us.
wss.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code !== 'EADDRINUSE') console.error('websocket server error:', err.message); // port races are retried below
});

// Track liveness with protocol-level pings; drop clients that stop answering (sleeping laptops etc).
const alive = new WeakMap<WebSocket, boolean>();
wss.on('connection', (ws) => {
  alive.set(ws, true);
  ws.on('pong', () => alive.set(ws, true));
  ws.on('error', () => ws.terminate());
  ws.send(JSON.stringify({ ...office.snapshot(true), token: TOKEN }));
});
setInterval(() => {
  for (const ws of wss.clients) {
    if (!alive.get(ws)) {
      ws.terminate();
      continue;
    }
    alive.set(ws, false);
    ws.ping();
  }
  broadcast({ type: 'ping' }); // app-level heartbeat the browser can see
}, 15_000).unref();

function broadcast(msg: ServerMessage) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
}

setInterval(() => office.sweep(), 15_000).unref();

// On a dev restart the previous process may still be releasing the port for a moment: retry a few
// times before giving up, instead of crashing and leaving the page stuck on "connecting".
let listenAttempts = 0;
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE' && ++listenAttempts <= 20) {
    setTimeout(() => server.listen(PORT, HOST), 250);
    return;
  }
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is in use. Stop the other process or set OFFICE_PORT (export it for Claude Code too, so the hook uses the same port).`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST);
server.on('listening', () => {
  console.log(`🛰  Claude Office server on http://${HOST}:${PORT}  (ws: /ws, debug: /state)`);
});

// ---------- helpers ----------

function s(v: unknown, max = 200): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

function parseEvent(b: unknown): OfficeEvent | undefined {
  if (!b || typeof b !== 'object') return;
  const o = b as Record<string, unknown>;
  const session_id = s(o.session_id);
  const event = s(o.event, 60);
  if (!session_id || !event) return;
  return {
    session_id,
    event,
    ts: typeof o.ts === 'number' ? o.ts : undefined,
    project: s(o.project, 120),
    tool: s(o.tool, 120),
    file: s(o.file, 120),
    cmd: s(o.cmd, 60),
    subagent_type: s(o.subagent_type, 80),
    agent_id: s(o.agent_id, 120),
    agent_type: s(o.agent_type, 120),
    source: s(o.source, 40),
    reason: s(o.reason, 40),
    notification_type: s(o.notification_type, 60),
    error: s(o.error, 40),
    interrupted: o.interrupted === true,
    title: s(o.title, 120),
    report: s(o.report, REPORT_MAX_CHARS),
    cwd: s(o.cwd, 4096),
  };
}

const C = { dim: '\x1b[2m', cyan: '\x1b[36m', yellow: '\x1b[33m', mag: '\x1b[35m', reset: '\x1b[0m' };

function logLine(e: OfficeEvent, action?: string, room?: keyof typeof ROOM_LABELS) {
  const t = new Date().toLocaleTimeString();
  const who = `${e.project ?? '?'}${e.agent_type && e.agent_id ? `/${e.agent_type}` : ''}`;
  const detail = action ? ` ${action}${room ? ` ${C.dim}→ ${ROOM_LABELS[room]}${C.reset}` : ''}` : '';
  console.log(
    `${C.dim}${t}${C.reset} ${C.cyan}${who.padEnd(22)}${C.reset} ${C.yellow}${e.event.padEnd(18)}${C.reset}` +
      `${e.tool ? `${C.mag}${e.tool}${C.reset}` : ''}${detail} ${C.dim}[${e.session_id.slice(0, 8)}]${C.reset}`,
  );
}
