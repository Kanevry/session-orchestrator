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
// Additional positive E2E redaction tests (patterns previously only
// structurally-asserted via exported constant shape — now verified end-to-end
// through redactDiagnosticsBundle behavior).
// ---------------------------------------------------------------------------

describe('W4-A6 Group II — additional positive E2E redaction patterns', () => {
  it('II1: redacts AWS Access Key (AKIA…) — replaces with ***AWS_ACCESS_KEY***', () => {
    const input = { stdout: 'key=AKIAIOSFODNN7EXAMPLE23 detected in output' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('***AWS_ACCESS_KEY***');
    expect(result.stdout).not.toContain('AKIAIOSFODNN7EXAMPLE23');
  });

  it('II2: redacts OpenAI API key (sk-…) — replaces with ***OPENAI_KEY***', () => {
    // 40 purely alphanumeric chars after "sk-" — matches sk-[A-Za-z0-9]{40,}
    const input = { stdout: 'key=sk-abcdef1234567890abcdef1234567890abcdef12 used' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('***OPENAI_KEY***');
    expect(result.stdout).not.toContain('sk-abcdef1234567890abcdef1234567890abcdef12');
  });

  it('II3: redacts JWT (eyJ…) — replaces with ***JWT***', () => {
    const input = {
      stdout: 'token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c present',
    };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('***JWT***');
    expect(result.stdout).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('II4: redacts Slack bot token (xoxb-…) — replaces with ***SLACK_TOKEN***', () => {
    const input = { stdout: 'SLACK_BOT_TOKEN=xoxb-1234567890-1234567890123-abcdefghijklmnop' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('***SLACK_TOKEN***');
    expect(result.stdout).not.toContain('xoxb-1234567890');
  });

  it('II5: redacts Stripe live secret key (sk_live_…) — replaces with ***STRIPE_KEY***', () => {
    const input = { stdout: 'stripe_key=sk_live_4eC39HqLyjWDarjtT1zdp7dc reported in config' };

    const result = redactDiagnosticsBundle(input);

    expect(result.stdout).toContain('***STRIPE_KEY***');
    expect(result.stdout).not.toContain('sk_live_4eC39HqLyjWDarjtT1zdp7dc');
  });
});
