// Shared helpers for install-hooks / uninstall-hooks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../hooks');
export const HOOK_SCRIPT = path.join(HOOKS_DIR, 'office-hook.js');
/** Waits after each finished turn for prompts sent from the office (asyncRewake). */
export const MAILBOX_SCRIPT = path.join(HOOKS_DIR, 'office-mailbox.js');
const HOOK_MARKERS = ['office-hook.js', 'office-mailbox.js'];

// Claude Code honours CLAUDE_CONFIG_DIR; default is ~/.claude
export const SETTINGS_PATH = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json');

export const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'StopFailure',
  'SessionEnd',
];

/** True if a single hook handler is one of ours. */
export function isOurHandler(h) {
  if (!h || typeof h !== 'object') return false;
  const parts = [h.command, ...(Array.isArray(h.args) ? h.args : [])];
  return parts.some((p) => typeof p === 'string' && HOOK_MARKERS.some((m) => p.includes(m)));
}

/** Remove our handlers from settings.hooks in place. Returns number removed. */
export function stripOurHooks(settings) {
  let removed = 0;
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== 'object') return 0;
  for (const event of Object.keys(hooks)) {
    const groups = hooks[event];
    if (!Array.isArray(groups)) continue;
    const kept = [];
    for (const g of groups) {
      if (!g || !Array.isArray(g.hooks)) {
        kept.push(g);
        continue;
      }
      const before = g.hooks.length;
      const rest = g.hooks.filter((h) => !isOurHandler(h));
      removed += before - rest.length;
      if (rest.length > 0) kept.push(rest.length === before ? g : { ...g, hooks: rest });
    }
    if (kept.length > 0) hooks[event] = kept;
    else delete hooks[event];
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  return removed;
}

export function readSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return { settings: {}, existed: false };
  const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
  if (raw.trim() === '') return { settings: {}, existed: true };
  try {
    const settings = JSON.parse(raw);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not a JSON object');
    return { settings, existed: true };
  } catch (err) {
    console.error(`✖ Could not parse ${SETTINGS_PATH}: ${err.message}\n  Nothing was changed. Fix the file and try again.`);
    process.exit(1);
  }
}

export function backupSettings() {
  if (!fs.existsSync(SETTINGS_PATH)) return null;
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  // Never overwrite an earlier backup (two runs in the same second would otherwise collide).
  for (let n = 0; ; n++) {
    const dest = `${SETTINGS_PATH}.bak-${stamp}${n ? `-${n}` : ''}`;
    try {
      fs.copyFileSync(SETTINGS_PATH, dest, fs.constants.COPYFILE_EXCL);
      return dest;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
  }
}

/** Write via temp file + rename so a crash never leaves a half-written settings.json. */
export function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
  const tmp = `${SETTINGS_PATH}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, SETTINGS_PATH);
}
