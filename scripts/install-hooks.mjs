// Registers the Claude Office hook in the user-level Claude Code settings.
// Merges with existing hooks, backs up first, and is safe to run repeatedly.
import fs from 'node:fs';
import {
  EVENTS,
  HOOK_SCRIPT,
  MAILBOX_SCRIPT,
  SETTINGS_PATH,
  backupSettings,
  readSettings,
  stripOurHooks,
  writeSettings,
} from './hooks-lib.mjs';

if (!fs.existsSync(HOOK_SCRIPT) || !fs.existsSync(MAILBOX_SCRIPT)) {
  console.error(`✖ Hook script not found at ${HOOK_SCRIPT}`);
  process.exit(1);
}

// `node` resolved on PATH by default. Override with OFFICE_NODE=/abs/path/to/node if Claude Code
// is launched from somewhere without node on PATH (e.g. some IDEs).
const nodeCmd = process.env.OFFICE_NODE || 'node';

const { settings } = readSettings();
const backup = backupSettings();

// Drop any previous copies of our entries (e.g. the repo moved), then add fresh ones.
const replaced = stripOurHooks(settings);
settings.hooks ??= {};

for (const event of EVENTS) {
  const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
  groups.push({
    // No matcher = all tools / all sources.
    hooks: [
      {
        type: 'command',
        command: nodeCmd,
        args: [HOOK_SCRIPT],
        async: true, // never make Claude Code wait on us
        timeout: 5,
      },
    ],
  });
  settings.hooks[event] = groups;
}

// Mailbox: after each finished turn, wait in the background for a prompt sent from the office.
// asyncRewake wakes Claude (even when idle) when the hook exits 2 with the prompt on stderr.
settings.hooks.Stop.push({
  hooks: [
    {
      type: 'command',
      command: nodeCmd,
      args: [MAILBOX_SCRIPT],
      asyncRewake: true,
      timeout: 3600,
    },
  ],
});

writeSettings(settings);

console.log(`✔ Claude Office hooks installed in ${SETTINGS_PATH}`);
console.log(`  events: ${EVENTS.join(', ')}`);
console.log(`  hook:   ${nodeCmd} ${HOOK_SCRIPT}`);
console.log(`  mailbox (Stop, asyncRewake): ${nodeCmd} ${MAILBOX_SCRIPT}`);
if (backup) console.log(`  backup: ${backup}`);
if (replaced) console.log(`  (replaced ${replaced} existing Claude Office entries)`);
console.log('\nNew Claude Code sessions pick this up automatically. Already-running sessions may need a restart.');
