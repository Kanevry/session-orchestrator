/**
 * tests/integration/qg-command-drift-banner.integration.test.mjs
 *
 * Integration tests for qg-command-drift-banner — real CLAUDE.md fixtures,
 * no mocks. The unit tests in qg-command-drift-banner.test.mjs mock
 * `loadCommandsFromSessionConfig`; these tests exercise the real config-parse
 * path: CLAUDE.md → parse-config.mjs → loadCommandsFromSessionConfig →
 * checkQgCommandDrift.
 *
 * Design notes:
 *   - Each test writes its own CLAUDE.md inside an isolated tmpdir.
 *   - `git init -q` is required so parse-config.mjs anchors the project root
 *     at the tmpdir rather than walking up to the real repo's CLAUDE.md.
 *   - All mandatory Session Config fields are included to pass validate-config
 *     (persistence, enforcement, waves, agents-per-wave, *-command).
 *   - PROJECT_DEFAULTS: { lint: 'npm run lint', typecheck: 'npm run typecheck',
 *     test: 'npm test' }  — from qg-command-drift-banner.mjs source.
 *   - parse-config.mjs builtin defaults differ from PROJECT_DEFAULTS:
 *     { lint: 'pnpm lint', typecheck: 'tsgo --noEmit', test: 'pnpm test --run' }
 *     so a CLAUDE.md with NO Session Config block yields drift on all three.
 *
 * Coverage (4 tests):
 *   A. All three commands match PROJECT_DEFAULTS → returns null (no drift)
 *   B. test-command deviates → returns warn banner mentioning "test-command"
 *   C. typecheck-command and lint-command both deviate → banner mentions both keys
 *   D. Missing CLAUDE.md → returns null (graceful no-op)
 *
 * Refs: #530 MED-5, #525, #526
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkQgCommandDrift } from '../../scripts/lib/qg-command-drift-banner.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Minimal mandatory Session Config block that satisfies validate-config.mjs.
 * Commands use PROJECT_DEFAULTS values — no drift by default.
 */
const MANDATORY_FIELDS = `persistence: true
enforcement: warn
waves: 5
agents-per-wave: 6`;

/**
 * Write CLAUDE.md with a Session Config block containing the given command
 * overrides merged with the mandatory fields.
 *
 * @param {string} repoDir  — absolute path to the git-init'd tmpdir
 * @param {object} cmds     — { testCommand?, typecheckCommand?, lintCommand? }
 */
function writeClaudeMdWithCommands(repoDir, { testCommand, typecheckCommand, lintCommand }) {
  const content = `# Test Project

## Session Config

${MANDATORY_FIELDS}
test-command: ${testCommand}
typecheck-command: ${typecheckCommand}
lint-command: ${lintCommand}
`;
  writeFileSync(join(repoDir, 'CLAUDE.md'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('qg-command-drift-banner integration (MED-5 — real CLAUDE.md parse path)', () => {
  let tmpRepo;

  beforeEach(() => {
    tmpRepo = mkdtempSync(join(tmpdir(), 'so-qg-drift-it-'));
    // parse-config.mjs anchors project root at the first directory containing
    // .git (or CLAUDE.md). git init ensures the tmpdir is the root, preventing
    // walk-up to the real repo's CLAUDE.md.
    execFileSync('git', ['init', '-q'], { cwd: tmpRepo });
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // A: No drift — all three commands match PROJECT_DEFAULTS
  // -------------------------------------------------------------------------

  it('returns null when all three commands match PROJECT_DEFAULTS (no drift)', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'npm test',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result).toBeNull();
  });

  // -------------------------------------------------------------------------
  // B: test-command drifts — banner must name the key and its values
  // -------------------------------------------------------------------------

  it('returns {severity: "warn"} when test-command deviates from PROJECT_DEFAULTS', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'pnpm run test:ci',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
  });

  it('banner message contains "test-command" when test-command deviates', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'pnpm run test:ci',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result.message).toContain('test-command');
  });

  it('banner message contains the deviated test-command value "pnpm run test:ci"', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'pnpm run test:ci',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result.message).toContain('pnpm run test:ci');
  });

  it('banner message contains the PROJECT_DEFAULT "npm test" as the comparison baseline', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'pnpm run test:ci',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result.message).toContain('npm test');
  });

  // -------------------------------------------------------------------------
  // C: Multiple commands drift — banner must mention all deviated keys
  // -------------------------------------------------------------------------

  it('banner message contains "typecheck-command" when typecheck-command deviates', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'npm test',
      typecheckCommand: 'tsc --noEmit',
      lintCommand: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result).not.toBeNull();
    expect(result.message).toContain('typecheck-command');
  });

  it('banner message contains "lint-command" when lint-command deviates', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'npm test',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'biome lint .',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result).not.toBeNull();
    expect(result.message).toContain('lint-command');
  });

  it('banner message lists all three deviating keys when all three differ from PROJECT_DEFAULTS', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'vitest run',
      typecheckCommand: 'tsc --noEmit',
      lintCommand: 'biome lint .',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result).not.toBeNull();
    expect(result.severity).toBe('warn');
    expect(result.message).toContain('test-command');
    expect(result.message).toContain('typecheck-command');
    expect(result.message).toContain('lint-command');
  });

  it('banner message contains "Session Config drift" header phrase', async () => {
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'vitest run',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result.message).toContain('Session Config drift');
  });

  it('only deviated commands appear in banner — matching command is absent from drift list', async () => {
    // Only lint deviates; test and typecheck match defaults.
    writeClaudeMdWithCommands(tmpRepo, {
      testCommand: 'npm test',
      typecheckCommand: 'npm run typecheck',
      lintCommand: 'eslint .',
    });

    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result).not.toBeNull();
    expect(result.message).toContain('lint-command');
    expect(result.message).not.toContain('test-command');
    expect(result.message).not.toContain('typecheck-command');
  });

  // -------------------------------------------------------------------------
  // D: Missing CLAUDE.md — graceful no-op, returns null
  // -------------------------------------------------------------------------

  it('returns null when CLAUDE.md is absent (no config file in repo)', async () => {
    // tmpRepo has .git but no CLAUDE.md — parse-config exits non-zero,
    // loadCommandsFromSessionConfig returns {}, checkQgCommandDrift returns null.
    const result = await checkQgCommandDrift({ repoRoot: tmpRepo });

    expect(result).toBeNull();
  });
});
