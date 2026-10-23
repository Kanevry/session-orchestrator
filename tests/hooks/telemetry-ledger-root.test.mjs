/**
 * tests/hooks/telemetry-ledger-root.test.mjs
 *
 * Wiring test for #1722: a telemetry hook running in a LINKED worktree of a repo
 * that gitignores its ledgers must write the main checkout's copy. Measured
 * leak: `so-1e/.orchestrator/metrics/skill-invocations.jsonl` stranded in the
 * worktree, while its reader (`scripts/lib/skill-health/join.mjs`) reads the
 * main checkout — the record was lost with the worktree.
 *
 * Spawns each hook the way the harness does: stdin JSON, CLAUDE_PROJECT_DIR =
 * the worktree, cwd = the worktree. The resolver's own decision table (ignored
 * vs tracked) lives in tests/lib/ledger-path.test.mjs and is not repeated here.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { makeLinkedWorktree } from '../_helpers/linked-worktree.mjs';

const HOOKS = path.resolve(import.meta.dirname, '../../hooks');

let fixture;
afterEach(() => {
  fixture?.cleanup();
  fixture = undefined;
});

describe('telemetry hooks in a linked worktree with gitignored ledgers (#1722)', () => {
  it.each([
    {
      hook: 'skill-invocation-telemetry.mjs',
      ledger: 'skill-invocations.jsonl',
      payload: { tool_name: 'Skill', tool_input: { skill: 'debug' }, session_id: 'wt-ledger-test' },
    },
    {
      hook: 'subagent-telemetry.mjs',
      ledger: 'subagents.jsonl',
      payload: { hook_event_name: 'SubagentStart', agent_id: 'wt-ledger-agent', agent_type: 'test-writer' },
    },
  ])('$hook writes $ledger to the main checkout, not the worktree', ({ hook, ledger, payload }) => {
    fixture = makeLinkedWorktree('telemetry-ledger-root-', {
      files: { '.gitignore': '.orchestrator/metrics/*.jsonl\n' },
    });
    const { wt, mainMetrics, wtMetrics } = fixture;

    const r = spawnSync(process.execPath, [path.join(HOOKS, hook)], {
      cwd: wt,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: wt,
        SO_HOOK_PROFILE: 'full',
        SO_DISABLED_HOOKS: '',
        SO_TELEMETRY_DISABLED: '1',
        DO_NOT_TRACK: '1',
      },
      timeout: 10_000,
    });

    expect(r.status).toBe(0);
    expect(existsSync(path.join(wtMetrics, ledger))).toBe(false);
    const lines = readFileSync(path.join(mainMetrics, ledger), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
  });
});
