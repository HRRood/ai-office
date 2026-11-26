// Today's Claude spend, worked out from Claude Code's own session transcripts.
//
// Claude Code writes every response's token usage into ~/.claude/projects/<project>/<session>.jsonl
// (sub-agents under <session>/subagents/). We tail today's files, keep one usage record per message
// (a response is logged once per content block, all with the same message id), and price the tokens.
// Only the numbers in `message.usage`, `message.model` and the timestamp are read; message content is
// never parsed or kept. Set OFFICE_COSTS=0 to turn this off.
//
// The figure is what the tokens would cost at Anthropic's API list prices. On a Claude subscription
// (Pro / Max) you don't pay per token, so there it is an API-equivalent figure, not a bill.
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CostSummary } from '../shared/types';

/** $ per million tokens. `read` = cache read; cache writes are 1.25x input (5 min) and 2x input (1 h). */
interface Price {
  in: number;
  out: number;
  read?: number;
  /** Long-prompt rates (prompt over `over` tokens). */
  long?: { over: number; in: number; out: number };
}

// Anthropic first-party list prices (checked 2026-11). Matched by model id prefix, longest first.
const PRICE_LIST: Array<[string, Price]> = [
  ['claude-fable-5-2', { in: 8, out: 40, read: 0.2 }],
  ['claude-mythos-5-2', { in: 8, out: 40, read: 0.2 }],
  ['claude-fable-5-1', { in: 10, out: 50 }],
  ['claude-mythos-5-1', { in: 10, out: 50 }],
  ['claude-fable-5', { in: 10, out: 50 }],
  ['claude-mythos-5', { in: 10, out: 50 }],
  ['claude-opus-5-5', { in: 4, out: 20, read: 0.2 }],
  ['claude-opus-5', { in: 5, out: 25 }],
  ['claude-opus-4-8', { in: 5, out: 25 }],
  ['claude-opus-4-7', { in: 5, out: 25 }],
  ['claude-opus-4-6', { in: 5, out: 25 }],
  ['claude-opus-4-5', { in: 5, out: 25 }],
  ['claude-opus-4', { in: 15, out: 75 }], // Opus 4 / 4.1
  ['claude-sonnet-5-5', { in: 2, out: 10, read: 0.1 }],
  ['claude-sonnet-5', { in: 2, out: 10 }],
  ['claude-sonnet-4', { in: 3, out: 15 }], // Sonnet 4 / 4.5 / 4.6
  ['claude-haiku-5-5', { in: 0.1, out: 0.5, long: { over: 100_000, in: 0.5, out: 2.5 } }],
  ['claude-haiku-4-5', { in: 1, out: 5 }],
  ['claude-3-5-haiku', { in: 0.8, out: 4 }],
];
const PRICES = [...PRICE_LIST].sort((a, b) => b[0].length - a[0].length);

function priceOf(model: string): Price | undefined {
  const id = model.replace(/^anthropic\./, '').replace(/\[.*\]$/, '');
  return PRICES.find(([p]) => id.startsWith(p))?.[1];
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  speed?: string;
}

/** Dollar cost of one response's usage, or undefined for a model we have no price for. */
export function costOf(model: string, u: Usage): number | undefined {
  const p = priceOf(model);
  if (!p) return undefined;
  const input = u.input_tokens ?? 0;
  const read = u.cache_read_input_tokens ?? 0;
  const write = u.cache_creation_input_tokens ?? 0;
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = u.cache_creation ? (u.cache_creation.ephemeral_5m_input_tokens ?? 0) : write;
  const prompt = input + read + write;
  const rate = p.long && prompt > p.long.over ? { ...p, in: p.long.in, out: p.long.out, read: undefined } : p;
  const readRate = rate.read ?? rate.in * 0.1;
  let usd = (input * rate.in + w5m * rate.in * 1.25 + w1h * rate.in * 2 + read * readRate + (u.output_tokens ?? 0) * rate.out) / 1e6;
  if (u.speed === 'fast') usd *= 2; // fast mode is billed at twice the standard rates
  return usd;
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

export class CostTracker {
  private day = startOfToday();
  /** Bytes already read per transcript file, and any partial last line. */
  private files = new Map<string, { offset: number; rest: string }>();
  /** message id -> [model, usd, output tokens] (the record with the most output wins). */
  private messages = new Map<string, { model: string; usd: number; out: number }>();
  private unpriced = new Set<string>();
  private last = '';
  private busy = false;

  constructor(
    private readonly onChange: (c: CostSummary) => void,
    private readonly root = join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'projects'),
  ) {}

  start(everyMs = 5000) {
    if (process.env.OFFICE_COSTS === '0') return;
    void this.scan();
    setInterval(() => void this.scan(), everyMs).unref();
  }

  summary(): CostSummary {
    const byModel: Record<string, number> = {};
    let usd = 0;
    for (const m of this.messages.values()) {
      usd += m.usd;
      byModel[m.model] = (byModel[m.model] ?? 0) + m.usd;
    }
    return { day: this.day, usd, responses: this.messages.size, byModel, unpriced: [...this.unpriced] };
  }

  private async scan() {
    if (this.busy) return;
    this.busy = true;
    try {
      const today = startOfToday();
      if (today !== this.day) {
        // a new day: start counting from zero
        this.day = today;
        this.files.clear();
        this.messages.clear();
        this.unpriced.clear();
      }
      for (const f of await this.todaysFiles(this.root, 0)) await this.readNew(f);
      const s = this.summary();
      const key = `${s.day}:${s.usd.toFixed(4)}:${s.responses}`;
      if (key !== this.last) {
        this.last = key;
        this.onChange(s);
      }
    } catch {
      // transcripts folder missing or unreadable: no counter
    } finally {
      this.busy = false;
    }
  }

  /** Every .jsonl under the projects folder that changed today (projects/<p>/<s>.jsonl and subagents). */
  private async todaysFiles(dir: string, depth: number): Promise<string[]> {
    if (depth > 3) return [];
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...(await this.todaysFiles(p, depth + 1)));
      else if (e.name.endsWith('.jsonl')) {
        try {
          if ((await stat(p)).mtimeMs >= this.day) out.push(p);
        } catch {
          // vanished
        }
      }
    }
    return out;
  }

  private async readNew(file: string) {
    const st = await stat(file);
    const known = this.files.get(file) ?? { offset: 0, rest: '' };
    if (st.size < known.offset) Object.assign(known, { offset: 0, rest: '' }); // rewritten
    if (st.size === known.offset) return;
    const fh = await open(file, 'r');
    try {
      const len = st.size - known.offset;
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, known.offset);
      known.offset = st.size;
      const lines = (known.rest + buf.toString('utf8')).split('\n');
      known.rest = lines.pop() ?? '';
      for (const line of lines) if (line.includes('"usage"')) this.take(line);
    } finally {
      await fh.close();
      this.files.set(file, known);
    }
  }

  private take(line: string) {
    let o: { type?: string; timestamp?: string; requestId?: string; message?: { id?: string; model?: string; usage?: Usage } };
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    const msg = o.message;
    if (o.type !== 'assistant' || !msg?.usage || !msg.model || msg.model === '<synthetic>') return;
    const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
    if (!(ts >= this.day)) return;
    const id = msg.id ?? o.requestId;
    if (!id) return;
    const usd = costOf(msg.model, msg.usage);
    if (usd === undefined) {
      this.unpriced.add(msg.model);
      return;
    }
    const out = msg.usage.output_tokens ?? 0;
    const prev = this.messages.get(id);
    if (!prev || out >= prev.out) this.messages.set(id, { model: msg.model, usd, out });
  }
}
