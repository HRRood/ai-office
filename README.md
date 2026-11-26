# Claude Office

A realtime, top-down pixel-art space-station office that visualizes your Claude Code activity.
Every active Claude Code session, in any project on your machine, shows up as a crew member who
walks to the room matching what Claude is doing, with a speech bubble showing the current action.
Subagents appear as small helper droids that walk out of the meeting room.

```
Claude Code ──hook (node)──▶ POST 127.0.0.1:4317/event ──▶ server (in-memory state) ──ws──▶ browser (canvas)
```

## Quick start

Requires **Node.js 22.12 or newer** (any current LTS works: 22, 24 or 26) and Claude Code. Check with `node -v`.

```bash
npm install
npm run install-hooks   # registers the hook in ~/.claude/settings.json (backs it up first)
npm run dev             # server on :4317 + web UI on http://127.0.0.1:5173
```

Open http://127.0.0.1:5173 and use Claude Code in any project. New sessions pick up the hooks
automatically.

To start sessions from the office (via the Manager), also create your projects list:
`cp office.projects.example.json office.projects.json` and fill in your folders. See
[Starting new sessions from the Manager](#starting-new-sessions-from-the-manager).

No Claude Code handy? `npm run simulate` fires fake events:

| Command | What it does |
| --- | --- |
| `npm run simulate` | 3 fake sessions, loops until Ctrl+C (which ends them cleanly) |
| `npm run simulate -- --once` | each session runs one task, then leaves |
| `npm run simulate -- --sessions 5 --speed 2` | more sessions, twice as fast |

## Installing on another computer

You install Claude Office **once per computer**, not per project: the hooks go into your user-level
Claude Code settings, so one install shows every session in every project on that machine.

```bash
git clone <your repo> claude-office && cd claude-office
npm install
cp office.projects.example.json office.projects.json   # list this machine's project folders
npm run install-hooks
npm run dev
```

- `office.projects.json` is personal (absolute paths) and ignored by git. Each machine has its own.
- The hook paths are absolute: run `npm run install-hooks` again after moving or re-cloning the folder.
- Nicknames, the Visitors toggle and "left the office" are stored in the browser, so they don't move with you.
- Tested on macOS; Linux should work the same. Windows is supported in the code but untested: `claude`
  is started as `claude.cmd`, so set `claudePath` in `office.projects.json` if it lives somewhere else.

## Scripts

| Script | |
| --- | --- |
| `npm run dev` | server (auto-restarts) + Vite frontend |
| `npm run dev:server` / `npm run dev:web` | either half on its own |
| `npm run install-hooks` | add our hooks to your user-level Claude Code settings |
| `npm run uninstall-hooks` | remove only our hooks |
| `npm run simulate` | fake events for testing |
| `npm run typecheck` | TypeScript, server + web |
| `npm run build` | production build of the frontend into `dist/` |

## Reports

When a session finishes a turn, its worker walks Claude's final message over to the Manager's Office
and hands it in before their coffee break. The Manager's name tag shows 📄 with the number of unread
reports. Press **E** next to him (or click **📄 Reports** in the header) to read them. The server keeps
the last 50 reports in memory only: they're gone when it restarts, and they aren't included in the
`/state` debug endpoint.

You can also **reply** from an open report: your reply goes to that session's mailbox, like talking
to the worker. Handy when Claude ended its turn with a question.

**Mark all read** clears the unread count, and **Clear read** throws away the reports you've read.

## Cost counter

The header shows **💲 spent today**: what today's Claude Code usage would cost at Anthropic's API list
prices, updated every few seconds. Hover it for the split per model. The server works it out from
Claude Code's own transcripts in `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`): it reads only
each response's model, timestamp and token counts, never the message content, and counts each response
once. It resets at local midnight. On a Pro or Max subscription you aren't billed per token, so there
the figure is the API-equivalent cost, not a bill. Prices live in `server/costs.ts`; models without a
price are listed in the tooltip and not counted. Set `OFFICE_COSTS=0` to turn the counter off.

## Sleeping and waking

Sessions that go quiet for 15 minutes don't leave any more: they go to bed in the **Sleeping
Quarters** (right of the Open Office), watched over by **the Guard**. To get one back, press **E**
next to the Manager, pick them under 💤 Sleeping Quarters, optionally type what they should do, and
**Send the guard**. The guard walks over, shakes them awake, and they come back to work with your
prompt (empty: they tell you where they left off). Talking to a sleeper directly sends you to the
Manager too.

How they're woken depends on the session:

- **Terminal session whose mailbox hook is still listening** (up to 55 min after its last turn): the
  prompt goes straight into that terminal session.
- **Background session the Manager started:** it's resumed with your prompt, like any follow-up.
- **Terminal session that stopped listening:** it's resumed in the background with
  `claude -p --resume`, using `permissionMode` / `allowedTools` from `office.projects.json`. This only
  works when its folder is listed there (the same rule as starting sessions); otherwise wake it in its
  terminal. It continues as a background session from then on. If its terminal is still open, the
  terminal won't show what happened in the background.

Sleepers go home after a day without activity. Typing in a sleeper's terminal wakes it on its own.
`OFFICE_SLEEP_AFTER_S` changes how long it takes to fall asleep.

## Answering Claude's questions at the Manager

When Claude asks you something with its question dialog (`AskUserQuestion`), the worker walks to the
Manager's Office, the Manager's name tag shows ❓, and a **❓ Questions** button appears in the header.
Press **E** next to the Manager (or click the button), pick the options or type your own answer, and
**Send answer**. Claude continues with your answers as if you'd picked them in the terminal.

- This only happens while the office page is open. Otherwise the question appears in the terminal as
  usual.
- While a question waits at the Manager, the terminal doesn't show it. Click **Answer in terminal**
  to hand it back; after 10 minutes without an answer it goes back to the terminal by itself
  (`OFFICE_QUESTION_WAIT_S` changes that).
- It's a separate hook (`hooks/office-question.js`, `PreToolUse` for `AskUserQuestion`). Run
  `npm run install-hooks` again to add it, and set `OFFICE_QUESTIONS=0` to turn it off.

## Starting new sessions from the Manager

Walk up to the Manager (you can talk to him across his desk), press **E**, pick a project, and type
the first prompt. The server starts a **background** Claude Code session there:

```
echo <prompt> | claude -p --output-format stream-json --verbose --permission-mode <mode> [--allowedTools …]
```

A new worker walks in for it. Talk to that worker later and your prompt **continues the same
conversation** (`claude -p --resume <session>`), as soon as its previous run has finished. Between
runs the worker waits in the lounge ("Waiting for your next prompt") for up to an hour.

Projects come from **`office.projects.json`** in this folder. Copy `office.projects.example.json` to
start, then list the folders, each with a name. Only those folders can be used, and the browser only
ever sees names and folder names, never full paths. The file is reread on every launch.

| Key | Meaning |
| --- | --- |
| `projects` | `[{ "name": "…", "path": "/absolute/path" }]` |
| `permissionMode` | what runs may do without asking: `default`, `acceptEdits` (default: may edit files in the project), `plan`, … |
| `allowedTools` | extra tools allowed without asking, e.g. `["Bash(npm test:*)"]` |
| `claudePath` | the `claude` binary (default: `claude` on PATH) |
| `maxConcurrent` | max background runs at once (default 3) |

Background runs can't show permission prompts, so anything the mode and `allowedTools` don't allow is
refused. Prompts go through stdin, never the command line. Launching needs the same secret token as
sending prompts.

## How prompts reach a session (the mailbox)

`hooks/office-mailbox.js` is registered on `Stop` with `asyncRewake: true` and a one-hour timeout.
After each finished turn it waits in the background, asking the server every 1.5 s whether you've
sent this session a prompt. When one arrives it prints it to stderr and exits with code 2, and Claude
Code wakes the session with it (even when it's idle at the prompt).

- In headless runs (`claude -p`, including your own scripts) it exits immediately, so it never keeps
  them waiting.
- It stops quietly when the session starts a turn on its own, ends, or after 55 minutes, and gives up
  if the server is unreachable for about a minute. It never prints to stdout.
- A session that has been idle for more than about 55 minutes only picks up office prompts after its
  next turn.

Sending is protected. The server makes a random token at startup and gives it only to localhost
pages over the origin-checked WebSocket. Every action endpoint (`/prompt`, `/launch`, `/projects`,
`/dismiss`) requires that token, and CORS is only granted to localhost origins. Prompts are kept in
memory until they're delivered, and never written to disk.

## How the hooks are installed and removed

`npm run install-hooks`:

1. Reads `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR/settings.json`). If the file isn't
   valid JSON it stops without changing anything.
2. Copies it to `settings.json.bak-YYYYMMDD-HHMMSS` (never overwrites an earlier backup).
3. Removes any earlier Claude Office entries, then **appends** one entry per event, so your own
   hooks are kept. Running it twice doesn't create duplicates.
4. Writes atomically (temp file + rename).

Each entry looks like this:

```json
{ "hooks": [{ "type": "command", "command": "node", "args": ["/abs/path/hooks/office-hook.js"], "async": true, "timeout": 5 }] }
```

Plus one extra `Stop` entry for the mailbox: `{ "args": ["…/hooks/office-mailbox.js"], "asyncRewake": true, "timeout": 3600 }`.

Events: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`,
`PermissionRequest`, `Notification`, `SubagentStart`, `SubagentStop`, `Stop`, `StopFailure`, `SessionEnd`.

`npm run uninstall-hooks` makes a backup, then removes every handler whose command or args reference
`office-hook.js` or `office-mailbox.js`, and drops event arrays left empty. Everything else stays as
it was.

**If you move this folder**, run `npm run install-hooks` again (the hook path is absolute).

**If `node` isn't on Claude Code's PATH** (some IDE launchers), install with an absolute path:
`OFFICE_NODE=$(which node) npm run install-hooks`. With nvm, re-run it after switching Node versions.

### The hook can't hurt Claude Code

`hooks/office-hook.js` is plain Node with no dependencies. It:

- runs as an **async** hook, so Claude Code doesn't wait for it,
- gives up after **500 ms** no matter what, swallows every error, and **always exits 0**,
- **prints nothing** (stdout from some hooks is injected into Claude's context).

If the office server isn't running, events are dropped silently.

### Privacy

Only metadata leaves the hook, and only to `127.0.0.1`:

- session id, event name, tool name, project name (basename of the working directory)
- the file **basename** for Read/Edit/Write/MultiEdit/NotebookEdit
- the **session title** (Claude Code's name for the session, as in `/resume`), so workers can be named
  after their session. Titles are usually a short summary of the session's first prompt.
- the first **40 characters** of Bash commands, with obvious secrets masked
  (`API_KEY=***`, `Bearer ***`)
- subagent id/type, notification type, session start/end reason, timestamp
- the full **working directory** on `SessionStart`, `UserPromptSubmit` and `Stop`, so the guard can
  wake a sleeping session there (it stays on the server and isn't shown in the page)
- on `Stop` only: Claude's **final message of the turn**, as a report for the Manager's inbox (see
  [Reports](#reports)). Set `OFFICE_REPORTS=0` in your environment to turn this off.

Other than that final message, it never sends prompt text, file contents, tool output, assistant
messages, notification text or web search queries/URLs.

The server binds to `127.0.0.1` only. It rejects requests whose `Host` isn't localhost (stops
DNS-rebinding), only accepts `application/json` posts (stops cross-site form posts), and only allows
WebSocket connections from localhost pages. Other websites can't read your activity feed.

## What you'll see

The office is a weathered "used future" space station in 3/4 perspective: worn deck plating, ribbed
bulkheads, amber console screens, blast-door frames, and viewports that now and then make a hyperspace
jump. All characters are original designs.

| Activity | Room |
| --- | --- |
| New prompt (`UserPromptSubmit`) | Manager's Office: the manager hands out the task |
| Read, Grep, Glob, LS | Library |
| Edit, Write, MultiEdit, NotebookEdit | Dev Room (sits at a desk and types) |
| Bash | Server Room |
| WebSearch, WebFetch | Research (window desks) |
| TodoWrite, plan mode | Whiteboard |
| Agent / Task (spawning a subagent) | Meeting Room, and a helper droid joins |
| `mcp__*` tools | Mailroom |
| Permission needed | Stops in place: red pulsing bubble, "!" and ring |
| Turn finished (`Stop`) | Lounge |
| Anything else | Open Office |

- **Sending someone home:** the worker's card has **🚪 Send home** (asks once to confirm). The worker
  leaves the office and stays out, ignoring its own leftover activity, until you start a new prompt in
  that session. For background sessions the Manager started, the button is **Stop & send home**: it
  also stops a run in progress and forgets the session. Sessions in your own terminals are never
  stopped from the office, only cleared from view.
- **Renaming:** click anyone (workers, helpers, the Manager, the holiday visitors, or yourself)
  and use **✎ Rename** in their card. An empty name goes back to the default. Names are stored in
  this browser only, and renaming a worker doesn't change the session's title in Claude Code.
- **Names:** each worker is named after its session's title, shortened to 22 characters on the map
  (40 in the panel, full title on hover). Until a session has a title, its project folder is used.
  The shortening is `shorten()` in `shared/names.ts`.
- **Statuses:** working, waiting (needs you), resting (turn finished), idle (no events for 2 min,
  shown faded with "zZ"). After 15 min without events a session goes to bed in the **Sleeping
  Quarters** (background sessions started by the Manager stay up 60 min); see
  [Sleeping and waking](#sleeping-and-waking). Sessions leave on `SessionEnd`, or after sleeping for
  a day. A pending permission prompt or question keeps them "waiting" however long it takes.
- **Side panel:** a "needs you" alert, the crew list, details for the selected session (recent
  actions, helpers), and a live log of the last 50 events. The tab title shows `(n!)` while
  someone is waiting on you.
- **The Manager** sits behind the desk in the Manager's Office: an original dark commander in black
  armor, with an angular horned helmet, a glowing red visor, and a cape with a red lining that sways
  when he turns to look around the room. A red aura pulses around his desk. When a session arrives
  with a new prompt he hands out the assignment ("hyperdrive-api. You have your orders."), and now
  and then he has a stern remark for the room. Whenever he speaks the office lights dim. He isn't a
  session, so he doesn't show up in the panel.
- **You** (the captain in the white uniform): walk around with the **arrow keys / WASD**. The camera
  follows you, and you bump into walls and furniture. Walk up to someone and press **E** (or Enter):
  - next to a **worker** this opens a prompt box. Type a prompt and send it with ⌘/Ctrl+Enter, and it
    goes into that Claude Code session's **mailbox**. If the session is free it starts on it right away;
    if it's busy it gets it as soon as it finishes the current turn. Up to 5 prompts can wait per session,
    and the name tag shows 📨 while something is waiting. Prompts to a helper go to its main session.
  - the Manager, Sinterklaas and the pieten have something to say back.
  - to **leave the office**, walk onto the entrance airlock on the left of the Manager's Office and
    keep walking left. Click **🚪 Enter the office** to come back in. Your browser remembers that you
    left, so a reload keeps you outside.
- **Camera:** scroll (or pinch) to zoom toward the cursor (50%–600%), drag to pan, or use the
  + / − / ⤢ buttons in the corner. Keyboard: `+` `-` zoom, `0` whole office. (Arrow keys walk your
  captain; the camera follows.)
- **Rooms:** click a room to highlight it and open its card: who's in it, what each person is
  doing, recent activity there, and which tools send people there. Double-click a room (or click
  its chip in the **Rooms** bar) to zoom to it.
- **People:** click a worker (or a row, or a log line) to select it. It hops and turns to face you.
  The card shows what they're doing now, which room they're in, their recent actions and their
  helpers. Helpers can be selected on their own. **Follow** keeps the camera on them as they walk
  (or double-click the worker); dragging the map stops following. **Esc** clears the selection.
- **After hours (16:30–00:00):** anyone with nothing to do (resting or idle) heads to the
  **Cantina**, which is the Lounge with its neon sign on. They dance to the jukebox with a beer, take
  sips, and shout "Cheers!", under sweeping disco lights and floating music notes. As soon as a
  session gets a task, its worker walks back to work. This only changes the picture: the panel still
  shows each session's real status and room. Preview with `?hour=20`. The times are `CANTINA_FROM` /
  `CANTINA_UNTIL` in `web/src/engine/renderer.ts`.
- **Holidays** switch on by date (visual only):
  - **Sinterklaas** (15 Nov – 5 Dec): bunting on the walls, a shoe with a carrot under the window,
    chocolate letters on desks, pepernoten on the tables, presents in every room, snow, and Sinterklaas himself with two
    roetveegpieten. They keep to the background: they stroll around now and then, only say hello to
    workers who are resting or idle (each at most once every 10 minutes), their bubbles fade quickly,
    and their name tags are dimmed. Use **Visitors on/off** in the header to send them home.
  - **Christmas** (6 Dec – 6 Jan): fairy lights, the plants become decorated trees, Santa hats for
    everyone, snow, and a big decorated tree in the Open Office that gets one more present under it
    every day (1 on 6 Dec, 19 on Christmas Eve).
  - In both seasons the wall tops are covered in snow. Decorations block the floor they stand on, and
    are only placed where every room stays reachable.
  - The header shows a badge, and Cantina toasts match the season. Preview with `?holiday=christmas`,
    `?holiday=sinterklaas`, `?holiday=none` or `?date=2026-12-20`. Dates and decorations live in
    `web/src/engine/holidays.ts`.
- **Day/night:** lighting follows your local time. Screens and holograms glow at night. Preview with
  `http://127.0.0.1:5173/?hour=23`.

## Customizing

### Room mapping: `shared/rooms.config.ts`

The one place that decides where activities go and what bubbles say. The server and the frontend
both use it.

- `TOOL_ROOMS`: exact tool name → room (`Bash: 'serverRoom'`)
- `TOOL_PREFIX_ROOMS`: prefix → room (`['mcp__', 'mailroom']`)
- `EVENT_ROOMS`: lifecycle events → room (`Stop: 'lounge'`)
- `DEFAULT_ROOM`: where unknown tools go
- `describeTool()`: speech-bubble text

Example: send `mcp__github__*` to the Research room instead of the Mailroom:

```ts
export const TOOL_PREFIX_ROOMS = [['mcp__github__', 'research'], ['mcp__', 'mailroom']];
```

The server restarts by itself under `npm run dev`. Reload the page after that.

### The map: `web/src/map.json`

```jsonc
{
  "tileSize": 16,
  "walkable": [".", "D", "E"],      // tiles workers can walk on
  "entrance": [0, 12],              // where new sessions walk in
  "rooms": {
    "library": { "label": "Library", "rect": [0, 0, 11, 8] }  // wall rectangle [x0, y0, x1, y1], inclusive
  },
  "tiles": ["############VVVV…", "#BBBBBBBBBB#.dd…", …]       // one string per row, one char per tile
}
```

| Char | Tile | Char | Tile |
| --- | --- | --- | --- |
| `.` | floor | `T` | table |
| `#` | wall | `A` | comm dish |
| `D` | door (walkable) | `R` | manager's desk (the Manager sits behind the right end) |
| `E` | entrance airlock | `P` | plant |
| `X` | secret door (walkable, looks like a wall panel) | `b` | bunk bed (two tiles wide) |
| `V` | viewport (starfield) | `s` | sofa |
| `B` | data-cartridge rack | `W` | whiteboard |
| `d` | console desk (seats in front of it) | `K` | coffee machine |
| `H` | holo-projector | `F` | fridge |
| `J` | jukebox | `Q` | beer taps |
| `S` | server rack | `M` | cargo crates |

Rules:

- All rows must be the same length.
- Every room id in `shared/rooms.config.ts` should exist in `rooms`. A missing room falls back to
  `openOffice`, which must exist.
- Workers stand on floor tiles next to furniture in their room, so adding a desk adds a standing
  spot. Tiles next to doors are kept clear.
- Leave at least one door per room, so workers can walk in. If a spot can't be reached, the worker
  teleports instead of getting stuck.

Vite hot-reloads map changes.

### Ports

The default port is `4317`. If something else uses it (it's also the OpenTelemetry collector
default), set `OFFICE_PORT` for the server and hook, and `VITE_OFFICE_PORT` for the frontend:

```bash
OFFICE_PORT=4400 VITE_OFFICE_PORT=4400 npm run dev
```

The hook runs inside Claude Code, so it reads `OFFICE_PORT` from Claude Code's environment. Export
it in your shell profile if you change it.

## Project layout

```
hooks/office-hook.js         activity hook (plain Node, CommonJS, zero deps)
hooks/office-mailbox.js      Stop hook that delivers prompts you send from the office
scripts/                     install / uninstall / simulate
shared/rooms.config.ts       room mapping + bubble text (server + web)
shared/names.ts              session naming + shortening
shared/types.ts              event + state types
server/state.ts              session state machine, mailbox
server/launcher.ts           background sessions started by the Manager
server/index.ts              Express + ws, endpoints and security checks
office.projects.example.json template for your (git-ignored) office.projects.json
web/src/map.json             office layout
web/src/engine/              map, A* pathfinding, tile + sprite art, holidays, canvas renderer
web/src/components/          canvas, side panel, talk + launch dialogs
ideas.md                     feature ideas checklist (built + backlog)
```

## Troubleshooting

- **Nothing shows up.** Is `npm run dev` running? Check `curl http://127.0.0.1:4317/health`. Did you
  run `install-hooks`? Run Claude Code with `--debug` to see whether hooks fire.
- **"Port 4317 is in use".** Another server is running. Stop it or change the port (see above).
- **The badge says "connecting…" or "server offline".** The page lost its connection to the
  server. It retries on its own (at most every 3 s, and right away when you switch back to the
  tab), so it only stays red while the server is actually down. Check that `npm run dev` is still
  running. While you edit server code, the dev server restarts and the page reconnects within a
  couple of seconds.
- **Workers look frozen.** Browsers pause animation in background tabs. They catch up when the
  tab is visible again.
- **The Manager says "No projects configured".** Create `office.projects.json` from the example and
  list your folders (absolute paths).
- **A prompt from the office doesn't arrive.** The session needs the mailbox hook (run
  `npm run install-hooks` after updating) and must have finished a turn since then. Sessions idle for
  more than about 55 minutes pick it up after their next turn.
- **Inspect live state:** `curl http://127.0.0.1:4317/state`. In dev, the renderer is
  `window.__office` in the browser console.

## Ideas & roadmap

See [`ideas.md`](ideas.md): everything that's built (ticked) and a backlog of ideas to pick from.
