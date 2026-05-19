/**
 * tests/lib/getConfinementRoot-lockstep.test.mjs
 *
 * Verifies that getConfinementRoot() behaves correctly and that all 4 callers
 * delegate to the helper instead of re-implementing inline ternaries.
 *
 * Issue #483 Q4-MED-3: prevents drift back to per-caller inline logic.
 *
 * Grep-canary approach: reading the caller source and asserting the import +
 * call pattern is present. If a caller reverts to an inline ternary, both the
 * import assertion and the call-site assertion fail. No production code is mocked.
 *
 * Falsification check:
 *   - Deleting getConfinementRoot() causes the behaviour tests to fail.
 *   - Removing the import from a caller file causes that grep canary to fail.
 *   - Replacing getConfinementRoot() calls with inline ternaries in promote-vault-strict
 *     causes the ≥2 callsites count test to fail.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { getConfinementRoot } from '../../scripts/lib/config/cross-repo.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

// ---------------------------------------------------------------------------
// Helper: save/restore env vars cleanly across tests
// ---------------------------------------------------------------------------

let savedEnv;

afterEach(() => {
  if (savedEnv !== undefined) {
    if (savedEnv === null) {
      delete process.env.CROSS_REPO_CONFINEMENT_ROOT;
    } else {
      process.env.CROSS_REPO_CONFINEMENT_ROOT = savedEnv;
    }
    savedEnv = undefined;
  }
});

// ---------------------------------------------------------------------------
// Behaviour tests
// ---------------------------------------------------------------------------

describe('getConfinementRoot — behaviour', () => {
  it('returns the value of CROSS_REPO_CONFINEMENT_ROOT when the env var is set', () => {
    savedEnv = process.env.CROSS_REPO_CONFINEMENT_ROOT ?? null;
    process.env.CROSS_REPO_CONFINEMENT_ROOT = '/tmp/test-confinement-root';

    expect(getConfinementRoot()).toBe('/tmp/test-confinement-root');
  });

  it('returns a path containing "Projects" when CROSS_REPO_CONFINEMENT_ROOT is unset', () => {
    savedEnv = process.env.CROSS_REPO_CONFINEMENT_ROOT ?? null;
    delete process.env.CROSS_REPO_CONFINEMENT_ROOT;

    // Default is join(homedir(), 'Projects') per cross-repo.mjs:32
    const expected = join(homedir(), 'Projects');
    expect(getConfinementRoot()).toBe(expected);
  });

  it('returns a non-empty string in all cases', () => {
    savedEnv = process.env.CROSS_REPO_CONFINEMENT_ROOT ?? null;
    delete process.env.CROSS_REPO_CONFINEMENT_ROOT;

    const result = getConfinementRoot();
    expect(typeof result).toBe('string');
    expect(result.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Caller grep canaries — 3 of the 4 files (promote-vault-strict uses 2 callsites,
// tested separately below; all three scripts are distinct files)
// ---------------------------------------------------------------------------

describe('getConfinementRoot — all 4 callers delegate to the helper (grep canary)', () => {
  const singleCallsiteCallers = [
    'scripts/run-migrate-v2-cross-repo.mjs',
    'scripts/vault-integration-watcher.mjs',
  ];

  it.each(singleCallsiteCallers)(
    '%s imports getConfinementRoot from cross-repo.mjs',
    (relPath) => {
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf8');
      // Must have an import statement referencing the helper
      expect(content).toMatch(/import[^'"]*getConfinementRoot[^'"]*from/);
    },
  );

  it.each(singleCallsiteCallers)(
    '%s calls getConfinementRoot() at least once',
    (relPath) => {
      const content = readFileSync(join(REPO_ROOT, relPath), 'utf8');
      expect(content).toMatch(/getConfinementRoot\(\)/);
    },
  );

  it('scripts/promote-vault-strict.mjs imports getConfinementRoot from cross-repo.mjs', () => {
    const content = readFileSync(join(REPO_ROOT, 'scripts/promote-vault-strict.mjs'), 'utf8');
    expect(content).toMatch(/import[^'"]*getConfinementRoot[^'"]*from/);
  });

  it('scripts/promote-vault-strict.mjs calls getConfinementRoot() at least 2 times (2 distinct callsites)', () => {
    const content = readFileSync(join(REPO_ROOT, 'scripts/promote-vault-strict.mjs'), 'utf8');
    const callsites = (content.match(/getConfinementRoot\(\)/g) ?? []).length;
    expect(callsites).toBeGreaterThanOrEqual(2);
  });
});
