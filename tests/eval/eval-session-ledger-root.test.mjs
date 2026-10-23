/**
 * tests/eval/eval-session-ledger-root.test.mjs
 *
 * Wiring test for GitLab #1722: `scripts/eval-session.mjs` started from a
 * LINKED worktree without `--metrics-dir` must append its record to the main
 * checkout's `eval.jsonl`, the same ledger the engine already reads
 * `sessions.jsonl` from (`resolveEventsLedgerRoot`, #1592). Before the fix the
 * default `.orchestrator/metrics` was joined to the cwd, so the record landed
 * in `<worktree>/.orchestrator/metrics/eval.jsonl` (gitignored) and was lost
 * with the worktree — measured 2026-10-22 in session session-orchestrator-66.
 *
 * `--verify` is the second half: it reads `eval.jsonl` through the same default
 * and must find the record it just wrote from the same worktree.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scenarioCleanCompleted } from '../fixtures/eval/metrics-tree/build.mjs';
import { makeLinkedWorktree } from '../_helpers/linked-worktree.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, '../../scripts/eval-session.mjs');

const cleanups = [];

afterEach(() => {
  while (cleanups.length) {
    try {
      cleanups.pop()();
    } catch {
      /* best-effort */
    }
  }
});

function runCli(args, cwd) {
  const env = { ...process.env };
  // The launch-dir rung of resolveEventsLedgerRoot would otherwise answer with
  // the harness's own project dir instead of the fixture's.
  for (const name of ['ANTHROPIC_MODEL', 'CLAUDE_PROJECT_DIR', 'CODEX_PROJECT_DIR', 'CURSOR_PROJECT_DIR', 'PI_PROJECT_DIR']) {
    delete env[name];
  }
  const res = spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env, maxBuffer: 20 * 1024 * 1024 });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

describe('eval-session CLI from a linked worktree (#1722)', () => {
  it('appends to the main checkout ledger and --verify finds the record there', () => {
    const fx = scenarioCleanCompleted();
    cleanups.push(() => rmSync(fx.dir, { recursive: true, force: true }));
    // Ignored like in this repo (.gitignore:57): the worktree copy would be lost.
    const wt = makeLinkedWorktree('eval-ledger-root-', { files: { '.gitignore': '.orchestrator/metrics/*.jsonl\n' } });
    cleanups.push(wt.cleanup);
    for (const name of ['sessions.jsonl', 'events.jsonl']) {
      if (existsSync(path.join(fx.dir, name))) copyFileSync(path.join(fx.dir, name), path.join(wt.mainMetrics, name));
    }

    const run = runCli(['--rubric', fx.rubricPath, '--model-id', 'm', '--json'], wt.wt);
    expect(run.stderr).not.toContain('append failed');
    expect(run.status).toBe(0);
    const record = JSON.parse(run.stdout);

    expect(existsSync(path.join(wt.wtMetrics, 'eval.jsonl'))).toBe(false);
    const lines = readFileSync(path.join(wt.mainMetrics, 'eval.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).run_id).toBe(record.run_id);

    const verify = runCli(['--verify', record.run_id, '--rubric', fx.rubricPath, '--json'], wt.wt);
    expect(verify.stderr).not.toContain('run-id not found');
    expect(verify.status).toBe(0);
  });
});
