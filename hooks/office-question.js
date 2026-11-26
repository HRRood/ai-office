#!/usr/bin/env node
/*
 * Claude Office question hook.
 *
 * Registered on `PreToolUse` for `AskUserQuestion` (synchronous). It hands Claude's question to the
 * office so you can answer it at the Manager, then gives Claude your answers by returning the
 * tool input with `answers` filled in (documented PreToolUse `updatedInput`).
 *
 * The question only waits for the office when the office page is open in a browser. Otherwise,
 * or when you press "Answer in terminal", the hook exits silently and Claude Code shows its normal
 * question dialog.
 *
 * Contract:
 *   - prints to stdout only to deliver answers (one JSON object)
 *   - always exits 0
 *   - plain Node, no dependencies
 *
 * Env: OFFICE_QUESTIONS=0 turns it off; OFFICE_QUESTION_WAIT_S sets how long to wait (default 600).
 */
'use strict';

const http = require('http');

const PORT = Number(process.env.OFFICE_PORT) || 4317;
const POLL_MS = 1000;
const WAIT_MS = (Number(process.env.OFFICE_QUESTION_WAIT_S) || 600) * 1000; // hook timeout is 900 s
const MAX_FAILURES = 15;

const quit = () => process.exit(0);
process.on('uncaughtException', quit);
process.on('unhandledRejection', quit);

function request(method, path, body, timeout = 3000) {
  return new Promise((resolve) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method,
        timeout,
        headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
          if (text.length > 256 * 1024) req.destroy();
        });
        res.on('end', () => {
          let json;
          try {
            json = text ? JSON.parse(text) : undefined;
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode, json });
        });
      },
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 0 }));
    req.end(data);
  });
}

/** Only the fields the office needs to show the question. */
function questionsOf(input) {
  if (!input || !Array.isArray(input.questions)) return [];
  return input.questions
    .filter((q) => q && typeof q.question === 'string')
    .map((q) => ({
      question: q.question.slice(0, 2000),
      header: typeof q.header === 'string' ? q.header.slice(0, 60) : undefined,
      multiSelect: q.multiSelect === true,
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o) => o && typeof o.label === 'string')
        .map((o) => ({
          label: o.label.slice(0, 200),
          description: typeof o.description === 'string' ? o.description.slice(0, 1000) : undefined,
        })),
    }));
}

function answer(input, answers) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: 'Answered from the Claude Office dashboard',
      updatedInput: { ...input, answers },
    },
  };
  process.stdout.write(JSON.stringify(out), quit);
}

async function main(h) {
  if (process.env.OFFICE_QUESTIONS === '0') return quit();
  if (h.tool_name !== 'AskUserQuestion' || typeof h.session_id !== 'string') return quit();
  const input = h.tool_input && typeof h.tool_input === 'object' ? h.tool_input : {};
  const questions = questionsOf(input);
  if (!questions.length) return quit();

  const reg = await request('POST', '/question', {
    session_id: h.session_id,
    agent_id: typeof h.agent_id === 'string' ? h.agent_id : undefined,
    questions,
  });
  // 204: nobody has the office open, so answer in the terminal as usual.
  if (reg.status !== 201 || typeof reg.json?.id !== 'string') return quit();
  const id = reg.json.id;

  const deadline = Date.now() + WAIT_MS;
  let failures = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    const res = await request('GET', `/question/poll?id=${encodeURIComponent(id)}`);
    if (res.status === 200 && res.json && typeof res.json.answers === 'object') return answer(input, res.json.answers);
    if (res.status === 410) return quit(); // released to the terminal, or the session moved on
    if (res.status === 0 && ++failures >= MAX_FAILURES) return quit(); // server went away
    if (res.status !== 0) failures = 0;
  }
  await request('POST', '/question/expire', { id }, 1000); // let the office know it's back in the terminal
  quit();
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => {
  raw += c;
  if (raw.length > 5 * 1024 * 1024) quit();
});
process.stdin.on('end', () => {
  try {
    main(JSON.parse(raw));
  } catch {
    quit();
  }
});
process.stdin.on('error', quit);
