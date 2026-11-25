// Fires fake hook events at the office server so you can test without Claude Code.
//   npm run simulate              -> 3 sessions, loops until Ctrl+C
//   npm run simulate -- --once    -> each session runs its script once, then exits
//   npm run simulate -- --sessions 5 --speed 2
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? Number(args[i + 1]) : def;
};
const ONCE = args.includes('--once');
const SESSIONS = opt('sessions', 3);
const SPEED = opt('speed', 1);
const URL = `http://127.0.0.1:${Number(process.env.OFFICE_PORT) || 4317}/event`;

const PROJECTS = ['hyperdrive-api', 'nav-computer', 'cantina-web', 'droid-factory', 'outpost-ops', 'holo-docs'];
const FILES = ['App.tsx', 'index.ts', 'router.ts', 'schema.sql', 'README.md', 'utils.ts', 'Dockerfile', 'styles.css'];
const CMDS = ['npm test', 'npm run build', 'git status', 'git diff --stat', 'ls -la src', 'npx tsc --noEmit', 'docker compose up -d'];
const AGENTS = ['Explore', 'general-purpose', 'Plan'];

const pick = (a) => a[Math.floor(Math.random() * a.length)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const rid = () => Math.random().toString(36).slice(2, 10);

let failures = 0;
async function post(ev) {
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, ts: Date.now(), ...ev }),
    });
    if (!res.ok) console.warn(`server replied ${res.status} for ${ev.event}`);
    failures = 0;
  } catch {
    if (++failures === 1) console.error(`Can't reach ${URL}. Is the server running (npm run dev)?`);
  }
}

function randomTool() {
  const r = Math.random();
  if (r < 0.25) return { tool: pick(['Read', 'Grep', 'Glob']), file: pick(FILES) };
  if (r < 0.5) return { tool: pick(['Edit', 'Write']), file: pick(FILES) };
  if (r < 0.7) return { tool: 'Bash', cmd: pick(CMDS) };
  if (r < 0.78) return { tool: pick(['WebSearch', 'WebFetch']) };
  if (r < 0.86) return { tool: 'TodoWrite' };
  if (r < 0.93) return { tool: pick(['mcp__github__create_issue', 'mcp__slack__post_message']) };
  return { tool: 'NotebookRender' }; // unknown tool -> open office
}

async function toolCall(base, extra = {}) {
  const t = { ...randomTool(), ...extra };
  if (t.file === undefined) delete t.file;
  await post({ ...base, event: 'PreToolUse', ...t });
  await sleep(1500 + Math.random() * 3500);
  await post({ ...base, event: 'PostToolUse', ...t });
}

const active = new Set();

async function runSession(project) {
  const session_id = `sim-${rid()}`;
  active.add(session_id);
  const base = { session_id, project };
  console.log(`▶ ${project} (${session_id})`);
  await post({ ...base, event: 'SessionStart', source: 'startup' });
  await sleep(1500 + Math.random() * 3000);

  do {
    await post({ ...base, event: 'UserPromptSubmit' });
    await sleep(2500);
    const steps = 3 + Math.floor(Math.random() * 6);
    for (let i = 0; i < steps; i++) {
      const roll = Math.random();
      if (roll < 0.12) {
        // permission prompt: worker stops and pulses for a while
        const t = { tool: 'Bash', cmd: pick(CMDS) };
        await post({ ...base, event: 'PreToolUse', ...t });
        await post({ ...base, event: 'PermissionRequest', ...t });
        await post({ ...base, event: 'Notification', notification_type: 'permission_prompt' });
        await sleep(6000 + Math.random() * 4000);
        await post({ ...base, event: 'PostToolUse', ...t });
      } else if (roll < 0.25) {
        await spawnSubagents(base);
      } else {
        await toolCall(base);
      }
      await sleep(500 + Math.random() * 1500);
    }
    await post({ ...base, event: 'Stop' });
    await sleep(8000 + Math.random() * 10000);
  } while (!ONCE);

  await post({ ...base, event: 'SessionEnd', reason: 'prompt_input_exit' });
  active.delete(session_id);
  console.log(`■ ${project} done`);
}

async function spawnSubagents(base) {
  const n = 1 + Math.floor(Math.random() * 2);
  const agents = Array.from({ length: n }, () => ({ agent_id: `agent-${rid()}`, agent_type: pick(AGENTS) }));
  for (const a of agents) await post({ ...base, event: 'PreToolUse', tool: 'Agent', subagent_type: a.agent_type });
  await Promise.all(
    agents.map(async (a) => {
      const sub = { ...base, ...a };
      await post({ ...sub, event: 'SubagentStart' });
      await sleep(2000);
      const steps = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < steps; i++) await toolCall(sub, Math.random() < 0.6 ? { tool: 'Read', file: pick(FILES) } : {});
      await post({ ...sub, event: 'SubagentStop' });
    }),
  );
  for (const a of agents) await post({ ...base, event: 'PostToolUse', tool: 'Agent', subagent_type: a.agent_type });
}

const projects = Array.from({ length: SESSIONS }, (_, i) => PROJECTS[i % PROJECTS.length] + (i >= PROJECTS.length ? `-${i}` : ''));
// Ctrl+C: send everyone home instead of leaving ghosts until the 15-minute timeout.
const shutdown = async () => {
  console.log(`\nEnding ${active.size} simulated session(s)…`);
  await Promise.all([...active].map((session_id) => post({ session_id, event: 'SessionEnd', reason: 'other' })));
  process.exit(0);
};
process.on('SIGINT', shutdown);

await Promise.all(projects.map(async (p, i) => {
  await sleep(i * 2000);
  return runSession(p);
}));
