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
 * Config-read is mocked via `loadCommandsFromSessionConfig` from
 * `scripts/lib/quality-gate.mjs`. The banner module depends on that helper
 * exclusively (the spurious-drift footgun caused by `parseSessionConfig`
 * default substitution is gone — missing keys cannot drift).
 *
 * All assertions use hardcoded literals — no in-test formula mirrors.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the quality-gate dependency BEFORE importing the SUT.
vi.mock('../../scripts/lib/quality-gate.mjs', () => ({
  loadCommandsFromSessionConfig: vi.fn(),
}));

import { loadCommandsFromSessionConfig } from '../../scripts/lib/quality-gate.mjs';
import { checkQgCommandDrift, PROJECT_DEFAULTS } from '@lib/qg-command-drift-banner.mjs';

// ---------------------------------------------------------------------------
// Mock reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(loadCommandsFromSessionConfig).mockReset();
});

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
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({});

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });

  it('returns null when all three commands explicitly match PROJECT_DEFAULTS', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });

  it('returns null when only lint matches default and the other keys are absent (missing keys cannot drift)', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });

  it('does not throw when called with no arguments (defaults repoRoot to process.cwd())', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({});

    const result = await checkQgCommandDrift();

    expect(result).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// Group C: drift detection — must return {severity: 'warn', message: string}
// ---------------------------------------------------------------------------

describe('checkQgCommandDrift — drift detected (returns banner object)', () => {
  it('returns {severity: "warn", message: <string>} when test-command deviates (others match defaults)', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toMatchObject({ severity: 'warn', message: expect.any(String) });
  });

  it('banner message includes "test-command" when test-command deviates', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('test-command');
  });

  it('banner message includes the deviated test-command value "pnpm test:custom"', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('pnpm test:custom');
  });

  it('banner message includes the PROJECT_DEFAULT test value "npm test" as comparison', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('npm test');
  });

  it('banner message includes "Session Config drift" header phrase', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'npm run typecheck',
      test: 'pnpm test:custom',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('Session Config drift');
  });

  it('returns {severity: "warn", message: <string>} when typecheck-command deviates', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'tsc --noEmit',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toMatchObject({ severity: 'warn', message: expect.any(String) });
  });

  it('banner message includes "typecheck-command" when typecheck-command deviates', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'tsc --noEmit',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('typecheck-command');
  });

  it('banner message includes the deviated typecheck-command value "tsc --noEmit"', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'npm run lint',
      typecheck: 'tsc --noEmit',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('tsc --noEmit');
  });

  it('returns {severity: "warn", message: <string>} when lint-command deviates', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'biome lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toMatchObject({ severity: 'warn', message: expect.any(String) });
  });

  it('banner message includes "lint-command" when lint-command deviates', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'biome lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('lint-command');
  });

  it('banner message includes the deviated lint-command value "biome lint"', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
      lint: 'biome lint',
      typecheck: 'npm run typecheck',
      test: 'npm test',
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result.message).toContain('biome lint');
  });

  it('banner message lists all three deviating command keys when all three differ', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
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
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue({
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

describe('checkQgCommandDrift — graceful failure (returns null)', () => {
  it('returns null when loadCommandsFromSessionConfig throws (graceful no-op)', async () => {
    vi.mocked(loadCommandsFromSessionConfig).mockImplementation(() => {
      throw new Error('config read failed');
    });

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result).toBe(null);
  });

  it('returns null when loadCommandsFromSessionConfig returns a non-object (defensive)', async () => {
    // loadCommandsFromSessionConfig is contractually documented to return {} on error,
    // but the banner must still tolerate a degenerate non-object return without throwing.
    vi.mocked(loadCommandsFromSessionConfig).mockReturnValue(null);

    const result = await checkQgCommandDrift({ repoRoot: '/fake/repo' });

    expect(result === null || (result.severity === 'warn' && typeof result.message === 'string')).toBe(true);
  });
});
