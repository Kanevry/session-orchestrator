/**
 * tests/lib/validate/check-dead-bridge.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-dead-bridge.mjs (#671).
 *
 * The orchestrator owns the real-fs RepoContext, drives the frozen detectors,
 * prints PASS/FAIL lines, and sets the exit code:
 *   0 = all bridges intact, 1 = at least one dead bridge, 2 = tool error.
 *
 * `runCheckDeadBridge` MUST be import-safe (no execution / process.exit on
 * import). Two surfaces are exercised:
 *   - In-process: runCheckDeadBridge against the live repo → returns 0 (clean).
 *   - Subprocess (spawnSync): a tmp plugin-root with a planted dangling
 *     subagent ref → exit 1 + 'FAIL' in stdout; a resolvable variant → exit 0.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { runCheckDeadBridge } from '@lib/validate/check-dead-bridge.mjs';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SCRIPT = join(REPO_ROOT, 'scripts', 'lib', 'validate', 'check-dead-bridge.mjs');

// ---------------------------------------------------------------------------
// Fixture helpers — build a tmp plugin-root with valid rules + bootstrap so
// that ONLY the planted defect (or its absence) drives the exit code.
// ---------------------------------------------------------------------------

const tmpRoots = [];

/**
 * Build a tmp plugin-root with a valid .claude/rules/ + skills/bootstrap/ guard
 * so the dangling-rule-reference and dangling-bootstrap-bridge sub-rules pass.
 * The caller plants the subagent ref (and optionally the resolving agent).
 */
function makeFixture({ subagentRef, withResolvingAgent = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'check-dead-bridge-'));
  tmpRoots.push(root);

  mkdirSync(join(root, 'skills', 'wave'), { recursive: true });
  mkdirSync(join(root, 'skills', 'bootstrap'), { recursive: true });
  mkdirSync(join(root, '.claude', 'rules'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });

  // Valid rules surface (security.md is self-contained, no dangling refs).
  writeFileSync(join(root, '.claude', 'rules', 'security.md'), '# security\n', 'utf8');
  // Valid bootstrap guard pointing at an existing fetch-baseline.mjs.
  writeFileSync(
    join(root, 'skills', 'bootstrap', 'SKILL.md'),
    '[ -f "$PLUGIN_ROOT/scripts/lib/fetch-baseline.mjs" ]\n',
    'utf8',
  );
  writeFileSync(join(root, 'scripts', 'lib', 'fetch-baseline.mjs'), '// baseline fetcher\n', 'utf8');

  if (subagentRef) {
    writeFileSync(
      join(root, 'skills', 'wave', 'SKILL.md'),
      `subagent_type: "session-orchestrator:${subagentRef}"\n`,
      'utf8',
    );
  }
  if (withResolvingAgent && subagentRef) {
    mkdirSync(join(root, 'agents'), { recursive: true });
    writeFileSync(join(root, 'agents', `${subagentRef}.md`), `# ${subagentRef}\n`, 'utf8');
  }

  return root;
}

function run(pluginRoot) {
  return spawnSync('node', [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
}

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// In-process: import-safety + live repo clean
// ---------------------------------------------------------------------------

describe('runCheckDeadBridge — in-process against the live repo', () => {
  it('returns 0 (clean) for the real repo — all declared bridges intact', () => {
    expect(runCheckDeadBridge(REPO_ROOT)).toBe(0);
  });

  it('returns 0 when invoked with process.cwd() (the repo root)', () => {
    expect(runCheckDeadBridge(process.cwd())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Subprocess: planted dangling subagent ref → exit 1 + FAIL
// ---------------------------------------------------------------------------

describe('check-dead-bridge CLI — dangling subagent reference', () => {
  it('exits 1 and prints a FAIL line when a subagent_type names a non-existent agent', () => {
    const root = makeFixture({ subagentRef: 'ghost-agent-xyz' });

    const r = run(root);

    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL');
    expect(r.stdout).toContain('ghost-agent-xyz');
    expect(r.stdout).toContain('Results: 1 passed, 1 failed');
  });

  it('exits 0 when the planted subagent_type resolves to an existing agent', () => {
    const root = makeFixture({ subagentRef: 'ghost-agent-xyz', withResolvingAgent: true });

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('FAIL');
    expect(r.stdout).toContain('Results: 2 passed, 0 failed');
  });
});

// ---------------------------------------------------------------------------
// Subprocess: output format header + usage error
// ---------------------------------------------------------------------------

describe('check-dead-bridge CLI — output format and usage', () => {
  it('prints the check header and a Results summary line for a clean root', () => {
    const root = makeFixture({ subagentRef: 'code-implementer', withResolvingAgent: true });

    const r = run(root);

    expect(r.status).toBe(0);
    expect(r.stdout).toContain('--- Check: dead-bridge validator');
    expect(r.stdout).toContain('Results:');
  });

  it('exits 2 and writes usage to stderr when no plugin-root argument is supplied', () => {
    const r = spawnSync('node', [SCRIPT], { encoding: 'utf8', timeout: 15_000 });

    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: check-dead-bridge.mjs <plugin-root>');
  });
});
