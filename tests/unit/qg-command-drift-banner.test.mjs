/**
 * tests/unit/qg-command-drift-banner.test.mjs
 *
 * Vitest unit tests for scripts/lib/qg-command-drift-banner.mjs
 * (W2-A6 — session-start Phase 4 drift banner probe, issue #525).
 *
 * Covers:
 *   Group A: PROJECT_DEFAULTS shape and immutability
 *   Group B: checkQgCommandDrift — no-drift cases (returns null)
 *   Group C: checkQgCommandDrift — drift detection (returns banner string)
 *   Group D: checkQgCommandDrift — graceful failure cases (returns null)
 *
 * Key implementation detail: parseSessionConfig (config.mjs) applies its own
 * internal defaults when *-command keys are absent:
 *   lint-command   → 'pnpm lint'
 *   typecheck-command → 'tsgo --noEmit'
 *   test-command   → 'pnpm test --run'
 * These differ from PROJECT_DEFAULTS ('npm run lint', etc.), so a fixture that
 * omits all *-command keys will trigger a drift banner (not null). To assert
 * null, the fixture must explicitly set all three commands to match
 * PROJECT_DEFAULTS.
 *
 * All assertions use hardcoded literals — no in-test formula mirrors.
 * Each test dir is created via mkdtempSync and cleaned in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { checkQgCommandDrift, PROJECT_DEFAULTS } from '@lib/qg-command-drift-banner.mjs';

// ---------------------------------------------------------------------------
// Shared cleanup helpers
// ---------------------------------------------------------------------------

let testDirs = [];

afterEach(() => {
  for (const d of testDirs) rmSync(d, { recursive: true, force: true });
  testDirs = [];
});

/**
 * Create a temp repo dir. If claudemd is a string, write it as CLAUDE.md.
 */
function createRepo(claudemd) {
  const d = mkdtempSync(join(tmpdir(), 'qg-drift-'));
  testDirs.push(d);
  if (typeof claudemd === 'string') writeFileSync(join(d, 'CLAUDE.md'), claudemd, 'utf8');
  return d;
}

// ---------------------------------------------------------------------------
// Canonical Session Config block where ALL *-command values match
// PROJECT_DEFAULTS — produces null (no drift).
// ---------------------------------------------------------------------------
const NO_DRIFT_CLAUDE_MD = `# Test project

## Session Config

persistence: true
waves: 5
lint-command: npm run lint
typecheck-command: npm run typecheck
test-command: npm test
`;

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
  it('returns null when CLAUDE.md is missing from repoRoot', async () => {
    const repoRoot = createRepo(null);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toBe(null);
  });

  it('returns null when all three *-command values explicitly match PROJECT_DEFAULTS', async () => {
    const repoRoot = createRepo(NO_DRIFT_CLAUDE_MD);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toBe(null);
  });

  it('returns null with only lint-command absent when other two explicitly match and lint also matches', async () => {
    // All three set to exact PROJECT_DEFAULTS values → no drift
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: npm run typecheck
test-command: npm test
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toBe(null);
  });

  it('does not throw when called with no arguments (defaults repoRoot to process.cwd())', async () => {
    // Exercises the default-repoRoot path. We cannot guarantee null or string
    // since the project root may or may not have drift. Test only for non-throw.
    const result = await checkQgCommandDrift();

    expect(typeof result === 'string' || result === null).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group C: drift detection — must return a banner string
// ---------------------------------------------------------------------------

describe('checkQgCommandDrift — drift detected (returns banner)', () => {
  it('returns a string when test-command deviates (all three explicitly set)', async () => {
    // Set lint and typecheck to PROJECT_DEFAULTS to isolate just test-command drift.
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: npm run typecheck
test-command: pnpm test:custom
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(typeof result).toBe('string');
  });

  it('banner includes "test-command" when test-command deviates', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: npm run typecheck
test-command: pnpm test:custom
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('test-command');
  });

  it('banner includes the deviated test-command value "pnpm test:custom"', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: npm run typecheck
test-command: pnpm test:custom
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('pnpm test:custom');
  });

  it('banner includes the PROJECT_DEFAULT test value "npm test" as comparison', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: npm run typecheck
test-command: pnpm test:custom
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('npm test');
  });

  it('banner includes "Session Config drift" header phrase', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: npm run typecheck
test-command: pnpm test:custom
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('Session Config drift');
  });

  it('returns a string when typecheck-command deviates (others match defaults)', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: tsc --noEmit
test-command: npm test
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(typeof result).toBe('string');
  });

  it('banner includes "typecheck-command" when typecheck-command deviates', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: tsc --noEmit
test-command: npm test
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('typecheck-command');
  });

  it('banner includes the deviated typecheck-command value "tsc --noEmit"', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: tsc --noEmit
test-command: npm test
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('tsc --noEmit');
  });

  it('returns a string when lint-command deviates (others match defaults)', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: biome lint
typecheck-command: npm run typecheck
test-command: npm test
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(typeof result).toBe('string');
  });

  it('banner includes "lint-command" when lint-command deviates', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: biome lint
typecheck-command: npm run typecheck
test-command: npm test
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('lint-command');
  });

  it('banner includes the deviated lint-command value "biome lint"', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: biome lint
typecheck-command: npm run typecheck
test-command: npm test
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('biome lint');
  });

  it('banner lists all three deviating command keys when all three differ', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: biome lint
typecheck-command: tsc --noEmit
test-command: pnpm test:custom
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('lint-command');
    expect(result).toContain('typecheck-command');
    expect(result).toContain('test-command');
  });

  it('banner includes cross-reference to quality-gates-autofix.md', async () => {
    const repoRoot = createRepo(`# Test project

## Session Config

lint-command: npm run lint
typecheck-command: npm run typecheck
test-command: pnpm test:custom
`);

    const result = await checkQgCommandDrift({ repoRoot });

    expect(result).toContain('quality-gates-autofix.md');
  });
});

// ---------------------------------------------------------------------------
// Group D: graceful failure cases — must return null, never throw
// ---------------------------------------------------------------------------

describe('checkQgCommandDrift — graceful failure (returns null)', () => {
  it('returns null when repoRoot points to a non-existent directory', async () => {
    const result = await checkQgCommandDrift({ repoRoot: '/nonexistent/path/12345' });

    expect(result).toBe(null);
  });

  it('does not throw when CLAUDE.md contains a completely malformed Session Config block', async () => {
    // Use a Section Config block where every line is malformed enough to parse
    // as empty KV — the implementation must handle this without throwing.
    const repoRoot = createRepo(`# Test project

## Session Config

!!!not-a-key
@@@@@
:::broken
`);

    // Must not throw — result is either null or a string (both are valid)
    const result = await checkQgCommandDrift({ repoRoot });

    expect(typeof result === 'string' || result === null).toBe(true);
  });
});
