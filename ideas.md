# Claude Office: ideas

A running list of what's built and what could come next. Tick a box when something ships.

**Size:** `S` an afternoon · `M` a day or two · `L` bigger project
**Source:** where the data or inspiration comes from (Claude Code feature or similar tool)
⭐ = top picks: high fun, or high value for the effort

> Heads-up: other pixel-office visualizers exist (Pixel Agents, pixtuoid, PixelHQ, and a separate
> "Claude Office Visualizer"). Worth knowing if this project is ever shared under its current name.

---

## ✅ Already built

### Core
- [x] Hooks for 12 Claude Code events, installed in user settings (backup, merge, uninstall)
- [x] Privacy-first hook: metadata only, 500 ms cap, never blocks Claude
- [x] Localhost-only server with WebSocket live updates, heartbeat and reconnect
- [x] Session state machine (working / waiting / resting / idle), auto-cleanup
- [x] `npm run simulate` for testing without Claude Code

### Office & characters
- [x] 10-room space station, editable `map.json`, tool → room mapping in one config file
- [x] 3/4 perspective with depth sorting, shadows, "used future" styling
- [x] A* walking, walk cycles, speech bubbles with overlap avoidance
- [x] Original character archetypes with per-session colors; subagents as helper droids
- [x] Workers named after the session title; rename anyone
- [x] Dev Room: workers sit at a desk and type (code on screen, keystroke particles)
- [x] Manager NPC who hands out tasks (dims the lights when he speaks)
- [x] Permission waits: red pulsing "!", ring, "needs you" alert, `(n!)` tab title

### Interaction
- [x] Zoom / pan / follow, click rooms and people, room & person cards
- [x] Playable captain (arrow keys / WASD), leave via airlock and come back
- [x] Talk to a worker → send its session a prompt (mailbox via `asyncRewake`)
- [x] Start background sessions from the Manager (`office.projects.json`), resume them
- [x] Send workers home / stop background runs

### Ambience & seasons
- [x] Day/night lighting, blinking racks, hologram, hyperspace jumps in viewports
- [x] After-hours Cantina (16:30–00:00) with dancing, beer, disco lights, music notes
- [x] Sinterklaas season (visitors, gifts, snow) and Christmas (trees, daily gifts, Santa hats)

---

## 🎮 Gamification & progression

- [ ] ⭐ **XP & levels** per worker and for the whole station (tool calls, edits, finished turns) · `M` · *Code::Stats*
- [ ] ⭐ **Achievements with pixel badges**: "First 100 Bash runs", "Night Owl", "Five agents at once", "Survived a compaction" · `M` · *DevGotchi*
- [ ] **Daily streaks & daily quests** ("close 3 sessions today") · `S` · *DevGotchi*
- [ ] **Station credits & upgrades**: earn credits from work, buy a better coffee machine, plants, bigger racks · `L` · *management sims*
- [ ] **Room prestige (1–5 stars)** from decor; higher prestige = faster resting · `M` · *management sims*
- [ ] ⭐ **Weekly "wrapped" recap**: busiest worker, top tools, longest session, lines changed · `M`
- [ ] ⭐ **Bug boss**: a pixel bug monster appears in the Dev Room when commands keep failing, and is defeated when they pass · `M` · *DevGotchi*
- [ ] **Unlockable cosmetics** (hats, droid paint jobs) tied to achievements · `M`
- [ ] **Commit & PR trophies** on a shelf in the Manager's Office · `S` · *OTel `commit.count`, `pull_request.count`*

## 🧑‍🚀 Characters & personality

- [ ] ⭐ **Traits** per worker from the session hash ("Caffeinated": walks faster, "Tidy", "Night owl") · `S` · *colony sims*
- [ ] **Mood with moodlets** (+ tests passed, − permission denied, − context nearly full), shown as a face icon · `M` · *colony sims*
- [ ] ⭐ **Fatigue = context window**: workers get visibly tired as context fills, perk up after compaction · `M` · *statusline `context_window.used_percentage`, `PreCompact`/`PostCompact`*
- [ ] ⭐ **Compaction animation**: the worker stuffs papers into a trash compactor · `S` · *`PreCompact`/`PostCompact`*
- [ ] **Paper pile at the desk** that grows with tokens used (hover for the number) · `S`
- [ ] **Character wardrobe**: pick archetype, colors and accessories per worker · `M`
- [ ] **Done quips**: a short line when a worker finishes a task · `S`
- [ ] **Relationships**: workers on the same project chat at the water cooler or high-five · `M` · *generative-agents sims*
- [ ] **Model badges**: tiny pin showing which model a worker runs, animation on model switch · `S` · *`SessionStart.model`, `PostModelSwitch`*

## 🛰️ World & environment

- [ ] ⭐ **Station pet**: a maintenance cat-bot that roams, naps next to idle workers, drops hearts when you pet it (E) · `M`
- [ ] **Viewport events**: meteor showers, nebula storms, a passing freighter, a distant planet rising · `S`
- [ ] **Multiple decks**: one deck per project, an elevator between them, a new deck opens when one is full · `L`
- [ ] **In-app layout editor**: drag furniture and walls, save to `map.json` · `L` · *Pixel Agents*
- [ ] **Monitor glow per tool** (Edit blue, Bash amber, Web green) visible from a distance · `S`
- [ ] **Fabricator/printer** in the Mailroom that animates when a document or report is written · `S`
- [ ] **Safety board sign**: "N tool calls since last compaction" · `S`
- [ ] **Worktree desks**: a worker moves to a temporary desk while working in a git worktree · `M` · *`WorktreeCreate`/`WorktreeRemove`*

## 📊 Data & insights

- [ ] ⭐ **Cost & token meters** per worker and for the station · `M` · *statusline `cost.total_cost_usd`, `context_window.*`, or OTel `cost.usage`/`token.usage`*
- [ ] ⭐ **Usage-limit gauges** (5-hour and 7-day) as big wall meters in the Manager's Office · `S` · *statusline `rate_limits.five_hour` / `seven_day` (Pro/Max)*
- [ ] **Wall screens with modes**: task board, tool-use pie chart, org chart of agents/subagents, activity heat map, news ticker · `L`
- [ ] **Command center view**: columns Needs you / Working / Done across all sessions · `M`
- [ ] **Lines-changed ticker** (+/−) on a wall display · `S` · *statusline `cost.total_lines_added/removed`*
- [ ] **Git status terminal** in the Dev Room · `M`
- [ ] **Task board** from Claude's task events (todo cards move across a whiteboard) · `M` · *`TaskCreated`/`TaskCompleted` (field names to verify)*
- [ ] **History & stats** that survive server restarts (SQLite or JSON file) · `M` · *gap: state is in memory only*
- [ ] **Session replay**: scrub through a past session's activity on the map · `L` · *`transcript_path` (format is internal: best-effort)*

## 🕹️ Interaction & control

- [ ] ⭐ **Approve/deny permission requests from the office**: walk to the waiting worker, press E, choose Allow / Deny · `M` · *`PermissionRequest` hook decision (needs token + origin checks)*
- [ ] **Player emotes** (wave, thumbs up, coffee) that workers react to · `S` · *virtual offices*
- [ ] **Focus / Do-not-disturb** status per worker with an emoji · `S` · *virtual offices*
- [ ] **Archive cabinet**: browse and resume past sessions · `M` · *`--resume`, `claude agents --json`*
- [ ] **Templates at the Manager**: saved prompts ("run tests and fix", "review my diff") · `S`
- [ ] **Mini window / PWA**: an always-on-top mini office or phone view · `M` · *Pixel Agents*
- [ ] **Pause the station** when the tab is hidden (save CPU) · `S`
- [ ] **Background runs that can ask permission** via a permission-prompt tool / SDK `canUseTool` · `L`

## 🔊 Audio

- [ ] ⭐ **Jukebox radio**: procedural chiptune/lofi that follows time of day and activity (Cantina gets dance beats) · `M`
- [ ] **Sound effects**: chime when someone needs you, keyboard clacks, airlock whoosh, with a mute button · `S`
- [ ] **Proximity audio**: server hum and typing get louder when your captain walks closer · `M` · *virtual offices*

## 🎉 Events & seasons

- [ ] ⭐ **Random station events**: power flicker during heavy Bash use, a supply drone with snacks, a small "fire" a droid puts out when a command fails · `M` · *management sims*
- [ ] **Pomodoro mode**: the Manager calls a coffee break, everyone heads to the Lounge · `S` · *DevGotchi*
- [ ] **More holidays**: New Year fireworks, King's Day (orange), Halloween, Easter · `S` each
- [ ] **Vacation mode**: freezes streaks while you're away · `S`
- [ ] **Birthday of a session**: cake in the Lounge when a project hits N sessions · `S`

## 👥 Social / multiplayer (optional)

- [ ] **Team snapshots**: share level/XP/streaks as small JSON files in git, visit a colleague's station (read-only) · `L` · *DevGotchi team mode*
- [ ] **Read-only share link** for a teammate on the same network (with a token) · `M`

## 🛠️ Quality & tech

- [ ] **Tests**: hook privacy, install/uninstall merge, room mapping, pathfinding · `M` · *gap*
- [ ] **Lint/format + CI** · `S` · *gap*
- [ ] **Settings screen**: Cantina hours, holidays on/off, NPCs on/off, sound · `M`
- [ ] **Configurable language** for NPC lines (some are Dutch now) · `S`
- [ ] **Git repository + first commit** · `S`

---

## Suggested next batch

1. **Approve permissions from the office**: biggest practical win, you stop context-switching to terminals.
2. **Cost/token + usage-limit meters**: statusline data gives real numbers cheaply.
3. **Compaction animation + fatigue**: makes context a visible, funny "need".
4. **Achievements + weekly recap**: the "come back tomorrow" hook.
5. **Station pet + jukebox radio**: pure fun, low risk.
