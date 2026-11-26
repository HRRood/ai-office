#!/usr/bin/env node
/*
 * Claude Office hook.
 *
 * Claude Code runs this for each hook event and pipes the event JSON to stdin.
 * We forward a small, metadata-only summary to the local office server.
 *
 * Contract (do not break):
 *   - never prints anything to stdout (stdout is injected into Claude's context
 *     for SessionStart / UserPromptSubmit)
 *   - always exits 0 (exit 2 would block Claude on some events)
 *   - gives up after 500 ms no matter what
 *   - no dependencies, plain Node
 *
 * Privacy: only metadata leaves this script, plus one exception. No prompt text, file contents,
 * tool output, or full commands. The session title (Claude Code's short name for the session,
 * as shown in /resume) is sent so workers can be named after it.
 * Exception: on Stop, Claude's final message of the turn is sent as a report for the Manager's
 * inbox. It only goes to the local office server (127.0.0.1), which keeps it in memory.
 * Set OFFICE_REPORTS=0 to turn this off.
 * The full working directory is sent on a few events so the office can wake a sleeping session.
 */
'use strict';

const exit = () => process.exit(0);
setTimeout(exit, 500); // hard deadline
process.on('uncaughtException', exit);
process.on('unhandledRejection', exit);

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const MAX_STDIN = 20 * 1024 * 1024; // Write/Edit payloads can be large; we only peek at metadata
const CMD_CHARS = 40;
const REPORT_CHARS = 20000;
const TRANSCRIPT_TAIL = 2 * 1024 * 1024; // only read the end of the transcript

/** Text of an assistant message's content (string or content blocks). */
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');
}

/** Claude's final message of the turn: from the hook input, else the end of the transcript. */
function finalMessage(h) {
  if (typeof h.last_assistant_message === 'string' && h.last_assistant_message.trim()) {
    return h.last_assistant_message;
  }
  if (typeof h.transcript_path !== 'string') return undefined;
  const fs = require('fs');
  const fd = fs.openSync(h.transcript_path, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, TRANSCRIPT_TAIL);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        continue; // blank, or cut off at the start of the tail
      }
      if (entry.type === 'user' && !entry.isMeta && typeof entry.message?.content === 'string') break; // the prompt: no reply after it
      if (entry.type !== 'assistant' || entry.isSidechain) continue;
      const text = textOf(entry.message?.content).trim();
      if (text) return text;
    }
  } finally {
    fs.closeSync(fd);
  }
  return undefined;
}

function str(v, max = 200) {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined;
}

// Mask obvious secrets before truncating, e.g. `export API_KEY=abc` or `curl -H "Authorization: Bearer x"`.
function redact(cmd) {
  return cmd
    .replace(/\s+/g, ' ')
    .replace(/\b([A-Za-z_]*(?:key|token|secret|passw(?:or)?d|pwd|auth)[A-Za-z_]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***')
    .trim();
}

function build(h, path) {
  const tool = str(h.tool_name, 120);
  const input = h.tool_input && typeof h.tool_input === 'object' ? h.tool_input : {};
  const ev = {
    v: 1,
    session_id: str(h.session_id),
    event: str(h.hook_event_name, 60),
    ts: Date.now(),
    project: typeof h.cwd === 'string' ? str(path.basename(h.cwd), 120) : undefined,
    tool,
    agent_id: str(h.agent_id, 120),
    agent_type: str(h.agent_type, 120),
    source: str(h.source, 40), // SessionStart: startup|resume|clear|compact|fork
    reason: str(h.reason, 40), // SessionEnd
    notification_type: str(h.notification_type, 60),
    error: str(h.error, 40), // StopFailure: error type enum (PostToolUseFailure's error text is cut short too)
    title: str(h.session_title, 120), // SessionStart / UserPromptSubmit, when the session has one
    // Full working directory, only on SessionStart / UserPromptSubmit / Stop: the local server uses it
    // to wake a sleeping session (claude --resume) in a folder listed in office.projects.json.
    cwd: ['SessionStart', 'UserPromptSubmit', 'Stop'].includes(h.hook_event_name) ? str(h.cwd, 4096) : undefined,
  };

  if (tool && FILE_TOOLS.has(tool)) {
    const fp = str(input.file_path, 4096) || str(input.notebook_path, 4096);
    if (fp) ev.file = path.basename(fp).slice(0, 120);
  }
  if (tool && SHELL_TOOLS.has(tool) && typeof input.command === 'string') {
    ev.cmd = redact(input.command).slice(0, CMD_CHARS).trimEnd();
  }
  if ((tool === 'Agent' || tool === 'Task') && typeof input.subagent_type === 'string') {
    ev.subagent_type = input.subagent_type.slice(0, 80);
  }
  if (h.hook_event_name === 'Stop' && !h.agent_id && process.env.OFFICE_REPORTS !== '0') {
    try {
      const text = finalMessage(h);
      if (text) ev.report = text.slice(0, REPORT_CHARS);
    } catch {
      // no report this time; the event itself still goes out
    }
  }
  if (h.hook_event_name === 'PostToolUseFailure') {
    ev.error = undefined; // free-form error text may echo file/command content
    if (h.is_interrupt === true) ev.interrupted = true;
  }
  return ev;
}

function send(ev, http) {
  if (!ev.session_id || !ev.event) return exit();
  const body = JSON.stringify(ev);
  const req = http.request(
    {
      host: '127.0.0.1',
      port: Number(process.env.OFFICE_PORT) || 4317,
      path: '/event',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      timeout: 400,
    },
    (res) => {
      res.resume();
      res.on('end', exit);
    },
  );
  req.on('timeout', () => {
    req.destroy();
    exit();
  });
  req.on('error', exit); // server not running is fine
  req.end(body);
}

try {
  const http = require('http');
  const path = require('path');
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    raw += chunk;
    if (raw.length > MAX_STDIN) exit();
  });
  process.stdin.on('end', () => {
    try {
      send(build(JSON.parse(raw), path), http);
    } catch {
      exit();
    }
  });
  process.stdin.on('error', exit);
} catch {
  exit();
}
