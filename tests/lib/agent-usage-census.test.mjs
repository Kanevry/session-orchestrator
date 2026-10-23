/**
 * tests/lib/agent-usage-census.test.mjs — #1617.
 *
 * One synthetic transcript tree (tmp dir, invented ids, no real content) drives
 * the census end to end. Bugs these catch:
 *   - streaming lines counted as separate turns, or the FIRST partial output kept
 *     (turns doubled / output understated — the #950/#963 class);
 *   - a cache rebuild counted on a short gap, or when cache_read dominates;
 *   - a run whose first turn predates the window leaking in;
 *   - a malformed line crashing the run or vanishing uncounted;
 *   - Workflow agents (nested one level deeper) or meta-less runs dropped;
 *   - a `subagents` symlink followed, counting the same runs twice.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCensus } from '@lib/agent-usage-census.mjs';

const CLI = fileURLToPath(new URL('../../scripts/agent-usage-census.mjs', import.meta.url));
const NOW = Date.parse('2026-10-14T12:00:00Z');
const iso = (offsetSec) => new Date(NOW - 3_600_000 + offsetSec * 1000).toISOString();

const turn = ({ req, at, model = 'claude-opus-5-5', inp = 2, cc = 0, cr = 0, out = 0 }) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: iso(at),
    ...(req ? { requestId: req } : {}),
    message: {
      id: `msg_${req ?? at}`,
      model,
      usage: { input_tokens: inp, cache_creation_input_tokens: cc, cache_read_input_tokens: cr, output_tokens: out },
    },
  });

let root;

function writeRun(dir, id, agentType, lines) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `agent-${id}.jsonl`), lines.join('\n') + '\n');
  if (agentType !== null) writeFileSync(join(dir, `agent-${id}.meta.json`), JSON.stringify({ agentType }));
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'agent-usage-census-'));
  const sub = join(root, '-proj-a', 'sess-1', 'subagents');

  // worker run: 3 API turns written as 5 streaming lines; one >300 s gap with a
  // real rebuild, one >300 s gap where cache_read dominates (no rebuild).
  writeRun(sub, 'w1', 'worker', [
    JSON.stringify({ type: 'user', timestamp: iso(0) }),
    turn({ req: 'r1', at: 1, cc: 30_000, cr: 0, out: 1 }),
    turn({ req: 'r1', at: 2, cc: 30_000, cr: 0, out: 400 }),
    '{"type":"assistant","timestamp":', // torn line
    turn({ req: 'r2', at: 400, cc: 25_000, cr: 5_000, out: 100 }), // gap 399 s → rebuild
    turn({ req: 'r3', at: 1000, cc: 30_000, cr: 40_000, out: 1 }), // gap, but read ≥ creation
    turn({ req: 'r3', at: 1001, cc: 30_000, cr: 40_000, out: 50 }),
  ]);
  // second worker run, sonnet, a 299 s gap with a big creation → no rebuild
  writeRun(sub, 'w2', 'worker', [
    turn({ req: 's1', at: 10, model: 'claude-sonnet-5-5', cc: 10_000, out: 10 }),
    turn({ req: 's2', at: 309, model: 'claude-sonnet-5-5', cc: 50_000, out: 30 }),
  ]);
  // Workflow agent nested one level deeper, without a meta.json
  writeRun(join(sub, 'workflows', 'wf_x'), 'n1', null, [turn({ req: 'n1', at: 5, out: 7 })]);
  // run that started before the 1-day window → excluded although mtime is fresh
  const old = new Date(NOW - 3 * 86_400_000).toISOString();
  writeRun(sub, 'old', 'worker', [turn({ req: 'o1', at: 0, out: 9 }).replace(iso(0), old)]);
  // stale file (mtime outside window) is never opened
  writeRun(sub, 'stale', 'worker', [turn({ req: 'x1', at: 0, out: 9 })]);
  const staleT = new Date(NOW - 5 * 86_400_000);
  utimesSync(join(sub, 'agent-stale.jsonl'), staleT, staleT);
  // a second session whose `subagents` is a symlink to the first: never followed
  mkdirSync(join(root, '-proj-a', 'sess-2'), { recursive: true });
  symlinkSync(sub, join(root, '-proj-a', 'sess-2', 'subagents'));
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe('agent-usage-census', () => {
  it('dedups streaming lines, applies the rebuild rule, the window and counts malformed lines', async () => {
    const r = await runCensus({ root, days: 1, now: NOW });

    expect(r.files_scanned).toBe(4); // stale file filtered by mtime, sess-2 symlink skipped
    expect(r.runs).toBe(3);
    expect(r.runs_outside_window).toBe(1);
    expect(r.malformed_lines).toBe(1);
    expect(r.turns).toBe(6); // 3 + 2 + 1 API turns, not 8 lines
    expect(r.assistant_lines).toBe(8);
    expect(r.models['claude-opus-5-5']).toEqual({ turns: 4, share: 0.6667 });

    const worker = r.by_agent_type.find((t) => t.agent_type === 'worker');
    expect(worker.dispatches).toBe(2);
    expect(worker.turns).toBe(5);
    expect(worker.cache_rebuilds).toBe(1);
    expect(worker.runs_with_cache_rebuild).toBe(1);
    // w1 output 400 + 100 + 50 = 550 (last snapshot wins), w2 40 → median 295
    expect(worker.output_tokens_per_run_median).toBe(295);
    expect(worker.turns_per_run_median).toBe(2.5);
    // first-turn context: w1 2 + 30000, w2 2 + 10000 → median 20002
    expect(worker.start_context_median).toBe(20_002);

    const nested = r.by_agent_type.find((t) => t.agent_type === '(no-meta)');
    expect(nested.dispatches).toBe(1);
  });

  it('CLI: --json emits the envelope and exits 0; an unknown flag exits 1', () => {
    const ok = spawnSync(process.execPath, [CLI, '--root', root, '--days', '30', '--json'], { encoding: 'utf8' });
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout).schema).toBe('agent-usage-census/1');

    const bad = spawnSync(process.execPath, [CLI, '--bogus'], { encoding: 'utf8' });
    expect(bad.status).toBe(1);
  });
});
