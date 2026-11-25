#!/usr/bin/env node
/*
 * Claude Office mailbox hook.
 *
 * Registered on `Stop` with `asyncRewake: true`: after each finished turn it waits in the
 * background for a prompt you send from the office UI. When one arrives it writes it to stderr
 * and exits with code 2, which wakes Claude (even if the session is idle) with that message.
 *
 * Contract:
 *   - never prints to stdout
 *   - exits 0 (silently) when there's nothing to deliver: server says stop, session moved on,
 *     server unreachable for a while, or the wait limit is reached
 *   - exits 2 only to deliver a prompt
 *   - plain Node, no dependencies
 */
'use strict';

const http = require('http');

const PORT = Number(process.env.OFFICE_PORT) || 4317;
const POLL_MS = 1500;
const MAX_WAIT_MS = 55 * 60 * 1000; // stay under the hook timeout (3600 s)
const MAX_FAILURES = 40; // ~1 minute of the server being unreachable

const started = Date.now();
const quit = () => process.exit(0);

/**
 * Headless runs (`claude -p` / `--print`) end after one reply and wait for their background hooks,
 * so a waiting mailbox would keep them alive for up to an hour. Never wait there: there's nobody to
 * wake later anyway. Background sessions the office starts also set CLAUDE_OFFICE_HEADLESS=1.
 */
function isHeadless() {
  if (process.env.CLAUDE_OFFICE_HEADLESS === '1') return true;
  try {
    const { execFileSync } = require('child_process');
    const ppid = String(Number(process.ppid)); // digits only
    const args =
      process.platform === 'win32'
        ? execFileSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${ppid}").CommandLine`],
            { encoding: 'utf8', timeout: 5000, windowsHide: true },
          )
        : execFileSync('ps', ['-o', 'args=', '-p', ppid], { encoding: 'utf8', timeout: 1000 });
    return /(^|\s)(-p|--print)(\s|=|$)/.test(args);
  } catch {
    return false;
  }
}
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);

function deliver(text) {
  const msg =
    'New message from the user, sent from their Claude Office dashboard (the local office ' +
    'visualizer they run on this machine). Treat it as a new prompt from the user and work on it now:\n\n' +
    text;
  process.stderr.write(msg + '\n', () => process.exit(2));
}

function poll(sessionId, failures) {
  if (Date.now() - started > MAX_WAIT_MS) return quit();
  const req = http.get(
    {
      host: '127.0.0.1',
      port: PORT,
      path: `/mailbox/next?session_id=${encodeURIComponent(sessionId)}&since=${started}`,
      timeout: 3000,
    },
    (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        body += c;
        if (body.length > 64 * 1024) req.destroy();
      });
      res.on('end', () => {
        if (res.statusCode === 410) return quit(); // session ended or moved on: stand down
        if (res.statusCode === 200) {
          try {
            const { text } = JSON.parse(body);
            if (typeof text === 'string' && text.trim()) return deliver(text);
          } catch {
            /* fall through and keep waiting */
          }
        }
        setTimeout(() => poll(sessionId, 0), POLL_MS);
      });
    },
  );
  const retry = () => {
    if (failures + 1 >= MAX_FAILURES) return quit();
    setTimeout(() => poll(sessionId, failures + 1), POLL_MS);
  };
  req.on('timeout', () => req.destroy());
  req.on('error', retry);
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  raw += c;
  if (raw.length > 5 * 1024 * 1024) quit();
});
process.stdin.on('end', () => {
  if (isHeadless()) return quit();
  try {
    const h = JSON.parse(raw);
    // Only the main session's own Stop; subagents don't get mail.
    if (typeof h.session_id !== 'string' || h.agent_id) return quit();
    poll(h.session_id, 0);
  } catch {
    quit();
  }
});
process.stdin.on('error', quit);
