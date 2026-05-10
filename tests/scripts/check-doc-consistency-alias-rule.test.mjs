/**
 * tests/scripts/check-doc-consistency-alias-rule.test.mjs
 *
 * Focused unit-fixture tests for the alias-phrasing rule in
 * scripts/check-doc-consistency.sh.
 *
 * Exercises two fixture states in isolation:
 *   A — bare `CLAUDE.md` prose mention (no alias) → script must flag it
 *   B — fully-aliased `CLAUDE.md (or AGENTS.md on Codex CLI)` mention → clean
 *
 * Complements the broader check-doc-consistency.test.mjs without modifying it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT = join(REPO_ROOT, 'scripts', 'check-doc-consistency.sh');

/**
 * Minimal README.md that satisfies the H2/count/live-config checks so the
 * only finding (if any) comes from the alias-phrasing rule.
 */
const MINIMAL_README = [
  '# Plugin',
  '',
  '## Components',
  '',
  '- 1 Skill',
  '',
].join('\n');

/**
 * Minimal CLAUDE.md skeleton — the `## Session Config` block is required by
 * the live-config check; the `## Components` block mirrors README.md to pass
 * the H2 / count checks.
 */
function makeClaude(narrativeLine) {
  return [
    '# Plugin',
    '',
    '## Session Config',
    '',
    'persistence: true',
    '',
    '## Components',
    '',
    '- 1 Skill',
    '',
    '## Current State',
    '',
    narrativeLine,
    '',
  ].join('\n');
}

function runScript(cwd) {
  return spawnSync('sh', [SCRIPT], { cwd, encoding: 'utf8' });
}

describe('check-doc-consistency.sh — alias-phrasing rule', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'alias-rule-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('Fixture A: flags a bare CLAUDE.md prose mention as alias-phrasing drift', () => {
    writeFileSync(join(tmp, 'README.md'), MINIMAL_README);
    // Bare mention — the exact pattern the housekeeping-1 bullet had before the fix
    writeFileSync(
      join(tmp, 'CLAUDE.md'),
      makeClaude(
        'Reconstructed entry from commit `68e5e75` + CLAUDE.md narrative + git stat.',
      ),
    );

    const result = runScript(tmp);

    expect(result.status).toBe(1);
    expect(result.stdout).toContain('alias-phrasing');
    expect(result.stdout).toMatch(/1 alias-phrasing/);
  });

  it('Fixture B: accepts an aliased CLAUDE.md (or AGENTS.md on Codex CLI) mention as clean', () => {
    writeFileSync(join(tmp, 'README.md'), MINIMAL_README);
    // Fully-aliased mention — the corrected form
    writeFileSync(
      join(tmp, 'CLAUDE.md'),
      makeClaude(
        'Reconstructed entry from commit `68e5e75` + CLAUDE.md (or AGENTS.md on Codex CLI) narrative + git stat.',
      ),
    );

    const result = runScript(tmp);

    expect(result.stdout).toContain('=> 0 findings (clean)');
    expect(result.status).toBe(0);
  });
});
