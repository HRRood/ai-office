// Removes only the Claude Office entries from the user-level Claude Code settings.
import { SETTINGS_PATH, backupSettings, readSettings, stripOurHooks, writeSettings } from './hooks-lib.mjs';

const { settings, existed } = readSettings();
if (!existed) {
  console.log(`Nothing to do: ${SETTINGS_PATH} does not exist.`);
  process.exit(0);
}

const probe = structuredClone(settings);
if (stripOurHooks(probe) === 0) {
  console.log(`Nothing to do: no Claude Office hooks found in ${SETTINGS_PATH}.`);
  process.exit(0);
}

const backup = backupSettings();
const removed = stripOurHooks(settings);
writeSettings(settings);

console.log(`✔ Removed ${removed} Claude Office hook entries from ${SETTINGS_PATH}`);
console.log(`  backup: ${backup}`);
