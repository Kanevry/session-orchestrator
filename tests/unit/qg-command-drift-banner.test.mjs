/**
 * tests/unit/qg-command-drift-banner.test.mjs
 *
 * Vitest unit tests for scripts/lib/qg-command-drift-banner.mjs
 * (W2-A6 — session-start Phase 4 drift banner probe, issues #525 / #526).
 *
 * Covers:
 *   Group A: PROJECT_DEFAULTS shape and immutability
 *   Group B: checkQgCommandDrift — no-drift cases (returns null)
 *   Group C: checkQgCommandDrift — drift detection (returns {severity, message})
 *   Group D: checkQgCommandDrift — graceful failure cases (returns null)
 *
 * Return shape contract (post-#526 refactor):
 *   null                                        — no drift / load failure
 *   { severity: 'warn', message: <string> }     — drift detected
 *
 * Config-read is mocked via `loadCommandsFromSessionConfigDetailed` from
 * `scripts/lib/quality-gate.mjs`. The banner module depends on that helper
 * exclusively (the spurious-drift footgun caused by `parseSessionConfig`
 * default substitution is gone — missing keys cannot drift).
 *
 * All assertions use hardcoded literals — no in-test formula mirrors.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the quality-gate dependency BEFORE importing the SUT.
vi.mock('../../scripts/lib/quality-gate.mjs', () => ({
  loadCommandsFromSessionConfigDetailed: vi.fn(),
}));

import { loadCommandsFromSessionConfigDetailed } from '../../scripts/lib/quality-gate.mjs';
import { checkQgCommandDrift, PROJECT_DEFAULTS } from '@lib/qg-command-drift-banner.mjs';

// ---------------------------------------------------------------------------
// Mock reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(loadCommandsFromSessionConfigDetailed).mockReset();
});

/**
 * Stub a SUCCESSFUL config read returning `commands` (no `degraded` key).
 * Keeps every existing case expressed in terms of the commands it declares.
 *
 * @param {object} commands
 */
function mockCommands(commands) {
  vi.mocked(loadCommandsFromSessionConfigDetailed).mockReturnValue({ commands });
}

// ---------------------------------------------------------------------------
// Group A: PROJECT_DEFAULTS
// ---------------------------------------------------------------------------

describe('PROJECT_DEFAULTS', () => {
  it('has exactly the keys lint, typecheck, and test (3 keys total)', () => {
    expect(Object.keys(PROJECT_DEFAULTS).sort()).toEqual(['lint', 'test', 'typecheck']);
  });

  it('is frozen (immutable)', () => {
    expect(Object.isFrozen(PROJECT_DEFAULTS)).toBe(true);
  });

  it('lint default equals "npm run lint"', () => {
    expect(PROJECT_DEFAULTS.lint).toBe('npm run lint');
  });

  it('typecheck default equals "npm run typecheck"', () => {
    expect(PROJECT_DEFAULTS.typecheck).toBe('npm run typecheck');
  });

  it('test default equals "npm test"', () => {
    expect(PROJECT_DEFAULTS.test).toBe('npm test');
  });
});

// ---------------------------------------------------------------------------
// Group B: no-drift cases — must return null
// ---------------------------------------------------------------------------

describe('checkQgCommandDrift — no drift (returns null)', () => {
  it('returns null when config helper returns an empty object (no *-command keys present)', async () => {
    mockCommands({});

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });

  it('returns null when all three commands explicitly match PROJECT_DEFAULTS', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });

  it('returns null when only lint matches default and the other keys are absent (missing keys cannot drift)', async () => {
    mockCommands({
      lint: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });

  it('does not throw when called with no arguments (defaults repoRoot to process.cwd())', async () => {
    mockCommands({});

    const result = await checkQgCommandDrift();

    expect(result).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Group C: drift detection — must return {severity: 'warn', message: string}
// ---------------------------------------------------------------------------

describe('checkQgCommandDrift — drift detected (returns banner object)', () => {
  it('returns {severity: "warn", message: <string>} when test-command deviates (others match defaults)', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toMatchObject({ severity: 'warn', message: expect.any(String) });
  });

  it('banner message includes "test-command" when test-command deviates', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('test-command');
  });

  it('banner message includes the deviated test-command value "pnpm test:custom"', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('pnpm test:custom');
  });

  it('banner message includes the PROJECT_DEFAULT test value "npm test" as comparison', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('npm test');
  });

  it('banner message includes "Session Config drift" header phrase', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('Session Config drift');
  });

  it('returns {severity: "warn", message: <string>} when typecheck-command deviates', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'tsc --noEmit',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toMatchObject({ severity: 'warn', message: expect.any(String) });
  });

  it('banner message includes "typecheck-command" when typecheck-command deviates', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'tsc --noEmit',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('typecheck-command');
  });

  it('banner message includes the deviated typecheck-command value "tsc --noEmit"', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'tsc --noEmit',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('tsc --noEmit');
  });

  it('returns {severity: "warn", message: <string>} when lint-command deviates', async () => {
    mockCommands({
      lint: 'biome lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toMatchObject({ severity: 'warn', message: expect.any(String) });
  });

  it('banner message includes "lint-command" when lint-command deviates', async () => {
    mockCommands({
      lint: 'biome lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('lint-command');
  });

  it('banner message includes the deviated lint-command value "biome lint"', async () => {
    mockCommands({
      lint: 'biome lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('biome lint');
  });

  it('banner message lists all three deviating command keys when all three differ', async () => {
    mockCommands({
      lint: 'biome lint',
      typecheck: 'tsc --noEmit',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('lint-command');
    expect(result.message).toContain('typecheck-command');
    expect(result.message).toContain('test-command');
  });

  it('banner message includes cross-reference to quality-gates-autofix.md', async () => {
    mockCommands({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('quality-gates-autofix.md');
  });
});

// ---------------------------------------------------------------------------
// Group D: graceful failure cases — must return null, never throw
// ---------------------------------------------------------------------------

describe('checkQgCommandDrift — unreadable config (returns a degraded banner)', () => {
  it('reports degraded when the loader throws — an all-clear was never measured', async () => {
    vi.mocked(loadCommandsFromSessionConfigDetailed).mockImplementation(() => {
      throw new Error('config read failed');
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toEqual({
      severity: 'warn',
      message: '\u26a0 Session Config command drift could not be checked (parse-error)',
      degraded: 'parse-error',
    });
  });

  it('reports degraded when the loader returns a non-object (defensive)', async () => {
    vi.mocked(loadCommandsFromSessionConfigDetailed).mockReturnValue(null);

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toEqual({
      severity: 'warn',
      message: '\u26a0 Session Config command drift could not be checked (parse-error)',
      degraded: 'parse-error',
    });
  });

  it('still returns null when the read SUCCEEDED but the commands object is degenerate', async () => {
    // A successful read whose `commands` half is not an object is not a failed
    // read — it stays on the silent path.
    vi.mocked(loadCommandsFromSessionConfigDetailed).mockReturnValue({ commands: null });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Group E: three-state contract (#1031 follow-up)
//
// TV-001 — the bug these catch: `checkQgCommandDrift` returned `null` (which
// the session-start banner renders as "checked, no drift") for a config it
// never managed to READ. `loadCommandsFromSessionConfig` folded
// script-missing / spawn-failure / parse-error into the same `{}` an empty
// config produces, so the banner could not tell them apart. No existing test
// covered a failed read at all — the two Group D cases above asserted the
// silent all-clear as if it were correct.
// ---------------------------------------------------------------------------

describe('checkQgCommandDrift — three-state contract (#1031 follow-up)', () => {
  for (const reason of ['script-missing', 'spawn-failed', 'parse-error']) {
    it(`surfaces degraded='${reason}' instead of a silent null`, async () => {
      vi.mocked(loadCommandsFromSessionConfigDetailed).mockReturnValue({
        commands: {},
        degraded: reason,
      });

      const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

      expect(result).not.toBeNull();
      expect(result.severity).toBe('warn');
      expect(result.degraded).toBe(reason);
      expect(result.message).toBe(
        `\u26a0 Session Config command drift could not be checked (${reason})`,
      );
    });
  }

  it('empty-but-SUCCESSFUL config read still returns null (no false alarm)', async () => {
    mockCommands({});

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });

  it('a successful read with drift carries NO degraded key', async () => {
    mockCommands({ lint: 'eslint .' });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.severity).toBe('warn');
    expect(result.message).toContain('lint-command');
    expect('degraded' in result).toBe(false);
  });
});
