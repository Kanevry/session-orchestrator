/**
 * tests/unit/quality-gate-diagnostics.test.mjs
 *
 * Group I — Unit tests for scripts/lib/quality-gate/diagnostics.mjs
 * (W3 extracted module, #525 AC C — redaction pass tests).
 *
 * Covers:
 *   - Each REDACTION_PATTERN: GitHub PAT, GitLab PAT, npm token, Bearer token,
 *     /Users/<name>/ path replacement
 *   - SECRET_ENV_NAME_RE env-var value redaction, non-secret env vars pass through
 *   - Deep-clone semantics (input not mutated)
 *   - Null/missing-field edge cases
 *
 * Isolation: redactDiagnosticsBundle is a pure function (JSON in, JSON out).
 * No mocks needed. No filesystem I/O.
 */

import { describe, it, expect } from 'vitest';
import {
  redactDiagnosticsBundle,
  REDACTION_PATTERNS,
  SECRET_ENV_NAME_RE,
} from '@lib/quality-gate/diagnostics.mjs';

// ---------------------------------------------------------------------------
// Group I: redactDiagnosticsBundle unit tests
// ---------------------------------------------------------------------------

describe('W4-A6 Group I — redactDiagnosticsBundle redaction patterns', () => {
  it('I1: redacts GitHub PAT (ghp_*) — replaces with ***GITHUB_PAT***', () => {
    const input = { stdout: 'token=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('***GITHUB_PAT***');
    expect(result.stdout).not.toContain('ghp_');
  });

  it('I2: redacts GitLab PAT (glpat-*) — replaces with ***GITLAB_PAT***', () => {
    const input = { stdout: 'token=glpat-aaaaaaaaaaaaaaaaaaaa' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('***GITLAB_PAT***');
    expect(result.stdout).not.toContain('glpat-');
  });

  it('I3: redacts npm token (npm_*) — replaces with ***NPM_TOKEN***', () => {
    const input = { stdout: 'npm_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('***NPM_TOKEN***');
    expect(result.stdout).not.toContain('npm_aaa');
  });

  it('I4: redacts Bearer token — replaces with Bearer ***REDACTED***', () => {
    const input = { stdout: 'Authorization: Bearer abc.def.ghi' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('Bearer ***REDACTED***');
    expect(result.stdout).not.toContain('abc.def.ghi');
  });

  it('I5: redacts /Users/<name>/ paths — replaces username with <redacted>', () => {
    const input = { stdout: '/Users/alice/project/file.ts' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('/Users/<redacted>/project/file.ts');
    expect(result.stdout).not.toContain('/Users/alice/');
  });

  it('I6: redacts secret-bearing env-var values matched by SECRET_ENV_NAME_RE', () => {
    const input = {
      env: {
        API_TOKEN: 'secret123',
        PATH: '/usr/bin',
      },
    };

    const result = redactDiagnosticsBundle(input);

    expect(result.env.API_TOKEN).toBe('***REDACTED***');
    // Non-secret env var must pass through unchanged
    expect(result.env.PATH).toBe('/usr/bin');
  });

  it('I7: does not mutate the input bundle (deep-clone guarantee)', () => {
    const originalPat = 'ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const input = { stdout: `token=${originalPat}` };

    redactDiagnosticsBundle(input);

    // Input must be unchanged after redaction
    expect(input.stdout).toBe(`token=${originalPat}`);
  });

  it('I8: handles null bundle — returns an empty object without throwing', () => {
    const result = redactDiagnosticsBundle(null);

    expect(result).toBeDefined();
    expect(typeof result).toBe('object');
    // Null → JSON.parse(JSON.stringify(null ?? {})) → {}
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('I9: handles bundle without an env field — returns object with stdout intact', () => {
    const input = { stdout: 'some output with no secrets' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toBe('some output with no secrets');
    // No env key in input → no crash, no env key in output
    expect(result.env).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Supporting export surface tests
// ---------------------------------------------------------------------------

describe('W4-A6 Group I — exported constants', () => {
  it('REDACTION_PATTERNS is an array of [RegExp, string] tuples', () => {
    expect(Array.isArray(REDACTION_PATTERNS)).toBe(true);
    // Each entry must be [RegExp, string]
    for (const entry of REDACTION_PATTERNS) {
      expect(entry[0]).toBeInstanceOf(RegExp);
      expect(typeof entry[1]).toBe('string');
    }
  });

  it('REDACTION_PATTERNS has at least 8 entries (covers the documented token types)', () => {
    // Floor assertion: at least 8 patterns cover the documented types.
    // Ceiling: no accidental explosion. Floor/ceiling per test-quality.md.
    expect(REDACTION_PATTERNS.length).toBeGreaterThanOrEqual(8);
    expect(REDACTION_PATTERNS.length).toBeLessThanOrEqual(100);
  });

  it('SECRET_ENV_NAME_RE matches expected secret-bearing env var name patterns', () => {
    expect(SECRET_ENV_NAME_RE.test('API_TOKEN')).toBe(true);
    expect(SECRET_ENV_NAME_RE.test('DB_PASSWORD')).toBe(true);
    expect(SECRET_ENV_NAME_RE.test('STRIPE_SECRET')).toBe(true);
    expect(SECRET_ENV_NAME_RE.test('PATH')).toBe(false);
    expect(SECRET_ENV_NAME_RE.test('NODE_ENV')).toBe(false);
  });
});
