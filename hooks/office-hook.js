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
 * Privacy: only metadata leaves this script. No prompt text, file contents,
 * tool output, assistant messages, or full commands. The session title (Claude Code's
 * short name for the session, as shown in /resume) is sent so workers can be named after it.
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
