/**
 * End-to-end handoff regression for #1083.
 *
 * The coordinator explicitly renders a FILE-SCOPE block from the materialized
 * per-agent array. This verifies the real handoff; it does not claim that the
 * native platform injects the block automatically.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectAllow, expectDeny } from '../_helpers/hook-decision.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const MATERIALIZER = resolve(REPO_ROOT, 'scripts/materialize-wave-scope.mjs');
const VALIDATOR = resolve(REPO_ROOT, 'scripts/validate-wave-scope.mjs');
const DISJOINT_HOOK = resolve(REPO_ROOT, 'hooks/pre-task-scope-disjoint.mjs');
const tempRoots = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('wave scope producer handoff (#1083)', () => {
  it('carries a materialized per-agent FILE-SCOPE into a collision-denying dispatch ledger', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'wave-scope-producer-'));
    const stateDir = join(projectRoot, '.claude');
    const aggregatePath = join(stateDir, 'filescopes', 'wave-42.scopes.json');
    const firstAgentPath = join(stateDir, 'filescopes', 'wave-42', 'W42-I1.json');
    const secondAgentPath = join(stateDir, 'filescopes', 'wave-42', 'W42-I2.json');
    const ledgerPath = join(projectRoot, '.orchestrator', 'wave-dispatch-scopes.json');
    tempRoots.push(projectRoot);
    mkdirSync(join(projectRoot, '.orchestrator'), { recursive: true });
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(
      join(stateDir, 'wave-scope.json'),
      JSON.stringify({ wave: 42, role: 'Impl-Core', enforcement: 'warn', allowedPaths: [], blockedCommands: [] }),
    );

    const materialized = spawnSync(
      process.execPath,
      [MATERIALIZER, '--state-dir', stateDir, '--wave', '42', '--json'],
      {
        input: JSON.stringify([
          { id: 'W42-I1', files: ['scripts/shared-scope.mjs'] },
          { id: 'W42-I2', files: ['scripts/shared-scope.mjs'] },
          { id: 'coordinator', files: ['skills/wave-executor/wave-loop.md'] },
        ]),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      },
    );

    expect(materialized.status).toBe(0);
    expect(materialized.stderr).toBe('');
    expect(existsSync(firstAgentPath)).toBe(true);
    expect(existsSync(secondAgentPath)).toBe(true);
    expect(JSON.parse(readFileSync(firstAgentPath, 'utf8'))).toEqual(['scripts/shared-scope.mjs']);
    expect(JSON.parse(readFileSync(secondAgentPath, 'utf8'))).toEqual(['scripts/shared-scope.mjs']);
    expect(JSON.parse(readFileSync(aggregatePath, 'utf8'))).toEqual([
      { id: 'W42-I1', files: ['scripts/shared-scope.mjs'] },
      { id: 'W42-I2', files: ['scripts/shared-scope.mjs'] },
      { id: 'coordinator', files: ['skills/wave-executor/wave-loop.md'] },
    ]);

    const validation = spawnSync(
      process.execPath,
      [VALIDATOR, '--assert-disjoint', aggregatePath, '--union', aggregatePath],
      {
        input: JSON.stringify({ wave: 42, role: 'Impl-Core', enforcement: 'warn', allowedPaths: [], blockedCommands: [] }),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      },
    );

    expect(validation.status).toBe(1);
    expect(validation.stdout).toBe('');
    expect(validation.stderr).toMatch(/wave scope collision/);
    expect(validation.stderr).toMatch(/"W42-I1"/);
    expect(validation.stderr).toMatch(/"W42-I2"/);

    const firstScope = JSON.parse(readFileSync(firstAgentPath, 'utf8'));
    const secondScope = JSON.parse(readFileSync(secondAgentPath, 'utf8'));
    const firstDispatch = spawnSync(
      process.execPath,
      [DISJOINT_HOOK],
      {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          session_id: 'integration-session',
          cwd: projectRoot,
          tool_input: {
            description: 'W42-I1',
            model: 'opus',
            subagent_type: 'code-implementer',
            prompt: `Work on the assigned change.\n\nFILE-SCOPE — exactly these:\n\`\`\`\n${firstScope.join('\n')}\n\`\`\``,
          },
        }),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      },
    );
    expectAllow(firstDispatch);

    const secondDispatch = spawnSync(
      process.execPath,
      [DISJOINT_HOOK],
      {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Agent',
          session_id: 'integration-session',
          cwd: projectRoot,
          tool_input: {
            description: 'W42-I2',
            model: 'opus',
            subagent_type: 'code-implementer',
            prompt: `Work on the assigned change.\n\nFILE-SCOPE — exactly these:\n\`\`\`\n${secondScope.join('\n')}\n\`\`\``,
          },
        }),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      },
    );
    expectDeny(secondDispatch, ['W42-I1', 'W42-I2', 'scripts/shared-scope.mjs']);

    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    expect(ledger.waveKey).toBe('integration-session|w42|Impl-Core');
    expect(ledger.agents).toEqual([
      {
        id: 'W42-I1 (code-implementer)',
        desc: 'W42-I1',
        files: ['scripts/shared-scope.mjs'],
        at: expect.any(String),
      },
    ]);
    expect(JSON.stringify(ledger)).not.toContain('FILE-SCOPE — exactly these:');
  });
});
