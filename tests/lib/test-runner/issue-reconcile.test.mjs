/**
 * tests/lib/test-runner/issue-reconcile.test.mjs
 *
 * Unit tests for scripts/lib/test-runner/issue-reconcile.mjs.
 *
 * Coverage:
 *   - ReconcileError class contract
 *   - dryRun: command shape, no subprocess spawned
 *   - fingerprint dedup: noop when fingerprint already known
 *   - validateFinding: severity, ARG_BOUNDARY_DANGEROUS rejection per field, null/missing
 *   - existingFingerprints validation: must be a Set
 *   - body checks: fingerprint line, severity/check/locator, labels, null-byte guard
 *   - execFile error paths: BINARY_NOT_FOUND (ENOENT via execFile DI seam),
 *     EXEC_FAILURE (execFile DI seam that throws non-ENOENT)
 *
 * Track B extensions (W2/W3 — issues #383, #384, #388, #389):
 *   - triageDecision: fingerprint exact match → ignore, fuzzy title match → update,
 *     no match → create, confidence values, empty candidates
 *   - sanitizeRecommendation (#388): **Fingerprint:** replaced with __Fingerprint__,
 *     non-string passthrough, multiple occurrences
 *   - createFinding (#384): dryRun returns command, body > 65536 bytes → BODY_TOO_LARGE (#389),
 *     title containing newline → VALIDATION, BINARY_NOT_FOUND via execFile DI seam
 *   - listExistingFindings (#384): DI via execFile seam returning empty JSON array
 *
 * Security hardening regressions (ADR-364 §C5 HIGH + #388 MED + #389 MED):
 *   - HIGH: glabPath removed — all 4 functions ignore caller-supplied binary path;
 *     execFile DI seam (opts.execFile) is the only injection point
 *   - MED-1: reconcileFinding body-length cap enforced via BODY_TOO_LARGE
 *   - MED-2: sanitizeRecommendation uses gi flag — lowercase + mixed-case variants caught
 *
 * For execFile error paths we inject a synthetic execFile function —
 * no vi.mock needed, avoids fork-pool fragility (pattern from mr-draft.test.mjs).
 * All expected values are hardcoded literals — no production-logic mirroring.
 */

import { describe, it, expect } from 'vitest';
import {
  reconcileFinding,
  ReconcileError,
  triageDecision,
  createFinding,
  listExistingFindings,
  updateFinding,
} from '@lib/test-runner/issue-reconcile.mjs';
import { fingerprintFinding } from '@lib/test-runner/fingerprint.mjs';

// ---------------------------------------------------------------------------
// Shared test-finding factory
// ---------------------------------------------------------------------------

/** Minimal valid finding object. */
function validFinding(overrides = {}) {
  return {
    scope: 'a11y',
    checkId: 'axe-color-contrast',
    locator: '.btn-primary',
    severity: 'high',
    title: 'Color contrast insufficient',
    description: 'Text does not meet WCAG AA contrast requirements.',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// ReconcileError — class contract
// ---------------------------------------------------------------------------

describe('ReconcileError', () => {
  it('is an instance of Error', () => {
    const e = new ReconcileError('something failed', 'VALIDATION');
    expect(e).toBeInstanceOf(Error);
  });

  it('stores the provided code on .code', () => {
    const e = new ReconcileError('msg', 'EXEC_FAILURE');
    expect(e.code).toBe('EXEC_FAILURE');
  });

  it('has .name === ReconcileError', () => {
    const e = new ReconcileError('msg', 'BINARY_NOT_FOUND');
    expect(e.name).toBe('ReconcileError');
  });

  it('stores the message', () => {
    const e = new ReconcileError('custom message', 'VALIDATION');
    expect(e.message).toBe('custom message');
  });
});

// ---------------------------------------------------------------------------
// dryRun mode — returns command without spawning
// ---------------------------------------------------------------------------

describe('reconcileFinding — dryRun mode', () => {
  it('returns {action: "create"} with dryRun: true', async () => {
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    expect(result.action).toBe('create');
  });

  it('returns a command array starting with ["issue", "create"]', async () => {
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    expect(result.command[0]).toBe('issue');
    expect(result.command[1]).toBe('create');
  });

  it('command contains --title with [Test] prefix and the finding title', async () => {
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const titleIdx = result.command.indexOf('--title');
    expect(result.command[titleIdx + 1]).toBe('[Test] Color contrast insufficient');
  });

  it('command contains --label with from:test-runner', async () => {
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const labelIdx = result.command.indexOf('--label');
    expect(result.command[labelIdx + 1]).toContain('from:test-runner');
  });

  it('command --label includes the finding severity', async () => {
    const result = await reconcileFinding({
      finding: validFinding({ severity: 'critical' }),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const labelIdx = result.command.indexOf('--label');
    expect(result.command[labelIdx + 1]).toContain('severity:critical');
  });

  it('does not include an iid in dryRun result', async () => {
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    expect(result.iid).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue body content — fingerprint, severity, check, locator
// ---------------------------------------------------------------------------

describe('reconcileFinding — issue body content', () => {
  it('body contains the fingerprint in backtick-quoted form', async () => {
    // Pre-computed fingerprint for the validFinding fields:
    // scope='a11y', checkId='axe-color-contrast', locator='.btn-primary'
    // → abe64d526549f1e0
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    expect(body).toContain('**Fingerprint:** `abe64d526549f1e0`');
  });

  it('body contains **Severity:** with the finding severity', async () => {
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    expect(body).toContain('**Severity:** high');
  });

  it('body contains **Check:** with the checkId', async () => {
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    expect(body).toContain('**Check:** axe-color-contrast');
  });

  it('body contains **Locator:** with the locator in backticks', async () => {
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    expect(body).toContain('**Locator:** `.btn-primary`');
  });
});

// ---------------------------------------------------------------------------
// Fingerprint dedup — noop when fingerprint already in existingFingerprints
// ---------------------------------------------------------------------------

describe('reconcileFinding — fingerprint dedup', () => {
  it('returns {action: "noop"} when fingerprint is in existingFingerprints', async () => {
    // Compute the real fingerprint using the same pure function —
    // this is NOT tautological: we compute it separately and verify the dedup branch fires.
    const fp = fingerprintFinding({
      scope: 'a11y',
      checkId: 'axe-color-contrast',
      locator: '.btn-primary',
    });
    // The pre-computed value is abe64d526549f1e0 — using the real function call
    // is correct here since we are testing a SET MEMBERSHIP side-effect, not the hash itself.
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set([fp]),
      dryRun: false,
    });
    expect(result.action).toBe('noop');
  });

  it('noop result does not contain a command array', async () => {
    const fp = fingerprintFinding({
      scope: 'a11y',
      checkId: 'axe-color-contrast',
      locator: '.btn-primary',
    });
    const result = await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set([fp]),
      dryRun: false,
    });
    expect(result.command).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// validateFinding — severity validation
// ---------------------------------------------------------------------------

describe('reconcileFinding — severity validation', () => {
  it('throws ReconcileError(VALIDATION) for an unknown severity', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding({ severity: 'wat' }),
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('error code is VALIDATION for unknown severity', async () => {
    try {
      await reconcileFinding({
        finding: validFinding({ severity: 'urgent' }),
        existingFingerprints: new Set(),
        dryRun: true,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('VALIDATION');
    }
  });

  it('accepts all valid severities without throwing', async () => {
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      await expect(
        reconcileFinding({
          finding: validFinding({ severity }),
          existingFingerprints: new Set(),
          dryRun: true,
        }),
      ).resolves.toMatchObject({ action: 'create' });
    }
  });
});

// ---------------------------------------------------------------------------
// validateFinding — ARG_BOUNDARY_DANGEROUS rejection
// ---------------------------------------------------------------------------

describe('reconcileFinding — newline/CR/null-byte rejection in finding fields', () => {
  it('rejects scope containing a newline', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding({ scope: 'a11y\ninjected' }),
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('rejects title containing a newline', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding({ title: 'Fix bug\nrm -rf /' }),
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('rejects title containing a carriage return', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding({ title: 'Fix bug\rmalicious' }),
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('rejects locator containing a null byte', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding({ locator: '.btn\0extra' }),
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('thrown error has code VALIDATION for newline in scope', async () => {
    try {
      await reconcileFinding({
        finding: validFinding({ scope: 'a\nb' }),
        existingFingerprints: new Set(),
        dryRun: true,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// Body null-byte guard — recommendation field is not in REQUIRED_STRING_FIELDS
// but is used in the body — null byte in recommendation reaches the body check
// ---------------------------------------------------------------------------

describe('reconcileFinding — body null-byte guard', () => {
  it('throws ReconcileError(VALIDATION) when recommendation contains a null byte', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding({ recommendation: 'Fix\0malicious' }),
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('null-byte-in-recommendation error has code VALIDATION', async () => {
    try {
      await reconcileFinding({
        finding: validFinding({ recommendation: 'Use\0 alt color' }),
        existingFingerprints: new Set(),
        dryRun: true,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// validateFinding — missing or null finding object
// ---------------------------------------------------------------------------

describe('reconcileFinding — finding object validation', () => {
  it('throws ReconcileError(VALIDATION) when finding is null', async () => {
    await expect(
      reconcileFinding({
        finding: null,
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('throws ReconcileError(VALIDATION) when finding is an empty object', async () => {
    await expect(
      reconcileFinding({
        finding: {},
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('null-finding error has code VALIDATION', async () => {
    try {
      await reconcileFinding({
        finding: null,
        existingFingerprints: new Set(),
        dryRun: true,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// existingFingerprints validation — must be a Set
// ---------------------------------------------------------------------------

describe('reconcileFinding — existingFingerprints validation', () => {
  it('throws ReconcileError(VALIDATION) when existingFingerprints is an array', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding(),
        existingFingerprints: ['abe64d526549f1e0'],
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('thrown error has code VALIDATION for array existingFingerprints', async () => {
    try {
      await reconcileFinding({
        finding: validFinding(),
        existingFingerprints: [],
        dryRun: true,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('VALIDATION');
    }
  });
});

// ---------------------------------------------------------------------------
// execFile error paths — synthetic execFile DI seam (no real binary spawned)
// ---------------------------------------------------------------------------

/** Synthetic execFile that throws ENOENT (simulates missing binary). */
function makeEnoentExecFile() {
  return async (_bin, _args, _opts) => {
    const err = new Error("ENOENT: no such file or directory, spawn 'glab'");
    err.code = 'ENOENT';
    throw err;
  };
}

/** Synthetic execFile that throws a non-zero exit error (simulates EXEC_FAILURE). */
function makeFailingExecFile() {
  return async (_bin, _args, _opts) => {
    const err = new Error('Command failed: exited with code 1');
    err.code = 1;
    throw err;
  };
}

describe('reconcileFinding — BINARY_NOT_FOUND via execFile DI seam', () => {
  it('throws ReconcileError when execFile throws ENOENT', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding(),
        existingFingerprints: new Set(),
        execFile: makeEnoentExecFile(),
        dryRun: false,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('error has code BINARY_NOT_FOUND when execFile throws ENOENT', async () => {
    try {
      await reconcileFinding({
        finding: validFinding(),
        existingFingerprints: new Set(),
        execFile: makeEnoentExecFile(),
        dryRun: false,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('BINARY_NOT_FOUND');
    }
  });

  it('BINARY_NOT_FOUND error message mentions glab (the allowlisted binary)', async () => {
    try {
      await reconcileFinding({
        finding: validFinding(),
        existingFingerprints: new Set(),
        execFile: makeEnoentExecFile(),
        dryRun: false,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.message).toContain('glab');
    }
  });
});

describe('reconcileFinding — EXEC_FAILURE via execFile DI seam', () => {
  it('throws ReconcileError(EXEC_FAILURE) when execFile exits non-zero', async () => {
    try {
      await reconcileFinding({
        finding: validFinding(),
        existingFingerprints: new Set(),
        execFile: makeFailingExecFile(),
        dryRun: false,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReconcileError);
      expect(err.code).toBe('EXEC_FAILURE');
    }
  });
});

// ===========================================================================
// Track B extensions — triageDecision, createFinding, listExistingFindings
// ===========================================================================

// ---------------------------------------------------------------------------
// triageDecision — pure function
// ---------------------------------------------------------------------------

describe('triageDecision — fingerprint exact match', () => {
  it('returns action "ignore" when a candidate body contains the exact fingerprint', () => {
    const finding = {
      fingerprint: 'abcd1234ef567890',
      title: 'Color contrast insufficient',
    };
    const candidates = [
      {
        iid: 42,
        title: 'Some issue',
        body: '**Fingerprint:** `abcd1234ef567890`\n**Severity:** high',
      },
    ];
    const result = triageDecision(finding, candidates);
    expect(result.action).toBe('ignore');
    expect(result.target).toBe(42);
    expect(result.reason).toBe('fingerprint exact match');
  });

  it('confidence is 1.0 on fingerprint exact match', () => {
    const finding = {
      fingerprint: 'abcd1234ef567890',
      title: 'Some title',
    };
    const candidates = [
      {
        iid: 7,
        title: 'Old issue',
        body: '**Fingerprint:** `abcd1234ef567890`',
      },
    ];
    const result = triageDecision(finding, candidates);
    expect(result.confidence).toBe(1.0);
  });
});

describe('triageDecision — fuzzy title match', () => {
  it('returns action "update" when a candidate title has Levenshtein distance ≤ 2', () => {
    const finding = {
      fingerprint: 'aaaa0000bbbb1111',
      title: 'Fix color contrast',
    };
    const candidates = [
      {
        iid: 12,
        title: 'Fix colour contrast',
        body: '**Fingerprint:** `cccc2222dddd3333`',
      },
    ];
    const result = triageDecision(finding, candidates);
    expect(result.action).toBe('update');
    expect(result.target).toBe(12);
    expect(result.reason).toBe('fuzzy title match');
  });

  it('confidence is 0.7 on fuzzy title match', () => {
    const finding = {
      fingerprint: 'aaaa0000bbbb1111',
      title: 'Fix color contrast',
    };
    const candidates = [
      {
        iid: 12,
        title: 'Fix colour contrast',
        body: '**Fingerprint:** `cccc2222dddd3333`',
      },
    ];
    const result = triageDecision(finding, candidates);
    expect(result.confidence).toBe(0.7);
  });
});

describe('triageDecision — no match', () => {
  it('returns action "create" when no candidate matches', () => {
    const finding = {
      fingerprint: 'aaaa0000bbbb1111',
      title: 'Completely unique issue title here',
    };
    const candidates = [
      {
        iid: 5,
        title: 'Unrelated issue about login',
        body: '**Fingerprint:** `cccc2222dddd3333`',
      },
    ];
    const result = triageDecision(finding, candidates);
    expect(result.action).toBe('create');
    expect(result.reason).toBe('no match');
    expect(result.confidence).toBe(1.0);
  });

  it('returns action "create" with empty candidates list', () => {
    const finding = {
      fingerprint: 'aaaa0000bbbb1111',
      title: 'Some finding title',
    };
    const result = triageDecision(finding, []);
    expect(result.action).toBe('create');
    expect(result.reason).toBe('no match');
  });
});

// ---------------------------------------------------------------------------
// sanitizeRecommendation — tested indirectly via createFinding dryRun body
// ---------------------------------------------------------------------------
// sanitizeRecommendation is not exported, so we test its effect through the
// public API: reconcileFinding dryRun with a crafted recommendation.

describe('sanitizeRecommendation (#388) — via reconcileFinding body', () => {
  it('replaces **Fingerprint:** literal in recommendation with __Fingerprint__', async () => {
    const result = await reconcileFinding({
      finding: validFinding({
        recommendation: 'See **Fingerprint:** `aaaa0000bbbb1111` for tracking',
      }),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    // The sentinel injection attack should be neutralized
    expect(body).toContain('__Fingerprint__');
    expect(body).not.toContain('**Fingerprint:** `aaaa0000bbbb1111`');
  });

  it('leaves the authoritative fingerprint sentinel intact (only free-text is sanitized)', async () => {
    const result = await reconcileFinding({
      finding: validFinding({
        recommendation: 'See **Fingerprint:** `aaaa0000bbbb1111` for tracking',
      }),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    // The real fingerprint sentinel appended by buildIssueBody must still appear
    expect(body).toMatch(/\*\*Fingerprint:\*\* `[0-9a-f]{16}`/);
  });

  it('replaces all occurrences of **Fingerprint:** in the recommendation', async () => {
    const result = await reconcileFinding({
      finding: validFinding({
        recommendation: '**Fingerprint:** first, **Fingerprint:** second',
      }),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    // Both occurrences must be sanitized — no raw **Fingerprint:** should survive
    // except the authoritative sentinel which uses backtick form with a hex value
    const unsanitizedCount = (body.match(/\*\*Fingerprint:\*\* (?!`[0-9a-f]{16}`)/g) || []).length;
    expect(unsanitizedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// createFinding — dryRun mode
// ---------------------------------------------------------------------------

describe('createFinding — dryRun mode', () => {
  it('returns ok: true with action "create" and a command array without spawning', async () => {
    const result = await createFinding({
      fingerprint: 'abcd1234ef567890',
      title: 'Test finding title',
      body: 'Test body content',
      dryRun: true,
    });
    expect(result.ok).toBe(true);
    expect(result.action).toBe('create');
    expect(Array.isArray(result.command)).toBe(true);
    expect(result.command[0]).toBe('issue');
    expect(result.command[1]).toBe('create');
  });

  it('dryRun command contains --title with the supplied title', async () => {
    const result = await createFinding({
      fingerprint: 'abcd1234ef567890',
      title: 'Specific issue title',
      body: 'body text',
      dryRun: true,
    });
    const titleIdx = result.command.indexOf('--title');
    expect(result.command[titleIdx + 1]).toBe('Specific issue title');
  });
});

// ---------------------------------------------------------------------------
// createFinding — body > 65536 bytes → BODY_TOO_LARGE (#389)
// ---------------------------------------------------------------------------

describe('createFinding — BODY_TOO_LARGE (#389)', () => {
  it('returns ok: false with code BODY_TOO_LARGE when body exceeds 65536 bytes', async () => {
    // 65537 ASCII characters = 65537 bytes > 65536 limit
    const oversizedBody = 'x'.repeat(65537);
    const result = await createFinding({
      fingerprint: 'abcd1234ef567890',
      title: 'Test title',
      body: oversizedBody,
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BODY_TOO_LARGE');
  });

  it('BODY_TOO_LARGE error message mentions the byte limits', async () => {
    const oversizedBody = 'y'.repeat(65537);
    const result = await createFinding({
      fingerprint: 'abcd1234ef567890',
      title: 'Test title',
      body: oversizedBody,
      dryRun: true,
    });
    expect(result.error.message).toContain('65536');
  });
});

// ---------------------------------------------------------------------------
// createFinding — arg-boundary rejection on title containing newline
// ---------------------------------------------------------------------------

describe('createFinding — newline in title rejected', () => {
  it('returns ok: false with code VALIDATION when title contains a newline', async () => {
    const result = await createFinding({
      fingerprint: 'abcd1234ef567890',
      title: 'Injected\nnewline',
      body: 'body text',
      dryRun: true,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('VALIDATION');
  });
});

// ---------------------------------------------------------------------------
// createFinding — BINARY_NOT_FOUND via execFile DI seam
// ---------------------------------------------------------------------------

describe('createFinding — BINARY_NOT_FOUND via execFile DI seam', () => {
  it('returns ok: false with code BINARY_NOT_FOUND when execFile throws ENOENT', async () => {
    const result = await createFinding({
      execFile: makeEnoentExecFile(),
      fingerprint: 'abcd1234ef567890',
      title: 'Test finding',
      body: 'test body',
      dryRun: false,
    });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BINARY_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// listExistingFindings — DI via execFile seam returning JSON
// ---------------------------------------------------------------------------

describe('listExistingFindings — DI via execFile seam returning empty JSON array', () => {
  it('returns ok: true with empty issues and fingerprints when execFile returns []', async () => {
    const fakeExecFile = async (_bin, _args, _opts) => ({ stdout: '[]', stderr: '' });
    const result = await listExistingFindings({
      execFile: fakeExecFile,
      label: 'from:test-runner',
    });
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.fingerprints).toBeInstanceOf(Set);
    expect(result.fingerprints.size).toBe(0);
  });

  it('returns ok: true with extracted fingerprints when execFile returns issues with bodies', async () => {
    const issues = [
      { iid: 1, title: 'Issue 1', description: '**Fingerprint:** `abcd1234ef567890`\n' },
      { iid: 2, title: 'Issue 2', description: '**Fingerprint:** `1234abcd5678efab`\n' },
    ];
    const fakeExecFile = async (_bin, _args, _opts) => ({
      stdout: JSON.stringify(issues),
      stderr: '',
    });
    const result = await listExistingFindings({ execFile: fakeExecFile });
    expect(result.ok).toBe(true);
    expect(result.fingerprints.has('abcd1234ef567890')).toBe(true);
    expect(result.fingerprints.has('1234abcd5678efab')).toBe(true);
  });

  it('returns ok: false with BINARY_NOT_FOUND when execFile throws ENOENT', async () => {
    const result = await listExistingFindings({ execFile: makeEnoentExecFile() });
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe('BINARY_NOT_FOUND');
  });
});

// ===========================================================================
// Security hardening regressions (#388 MED-2 + #389 MED-1 + ADR-364 HIGH)
// ===========================================================================

// ---------------------------------------------------------------------------
// HIGH regression: glabPath is ignored — allowlisted binary always used
// ---------------------------------------------------------------------------

describe('Security HIGH — glabPath no longer accepted; execFile DI seam is the only injection point', () => {
  it('reconcileFinding: execFile receives the allowlisted binary name "glab", never a caller-supplied path', async () => {
    const capturedBins = [];
    const spyExecFile = async (bin, _args, _opts) => {
      capturedBins.push(bin);
      const { stdout } = { stdout: 'https://gitlab.example.com/-/issues/99' };
      return { stdout };
    };
    await reconcileFinding({
      finding: validFinding(),
      existingFingerprints: new Set(),
      execFile: spyExecFile,
      dryRun: false,
    });
    // The binary passed to execFile must always be the allowlisted bare name.
    expect(capturedBins).toHaveLength(1);
    expect(capturedBins[0]).toBe('glab');
  });

  it('createFinding: execFile receives "glab" (allowlisted), not an attacker-supplied path', async () => {
    const capturedBins = [];
    const spyExecFile = async (bin, _args, _opts) => {
      capturedBins.push(bin);
      return { stdout: 'https://gitlab.example.com/-/issues/42' };
    };
    await createFinding({
      execFile: spyExecFile,
      fingerprint: 'abcd1234ef567890',
      title: 'Test issue',
      body: 'test body',
      dryRun: false,
    });
    expect(capturedBins).toHaveLength(1);
    expect(capturedBins[0]).toBe('glab');
  });

  it('listExistingFindings: execFile receives "glab" (allowlisted)', async () => {
    const capturedBins = [];
    const spyExecFile = async (bin, _args, _opts) => {
      capturedBins.push(bin);
      return { stdout: '[]' };
    };
    await listExistingFindings({ execFile: spyExecFile });
    expect(capturedBins).toHaveLength(1);
    expect(capturedBins[0]).toBe('glab');
  });

  it('updateFinding: execFile receives "glab" (allowlisted)', async () => {
    const capturedBins = [];
    const spyExecFile = async (bin, _args, _opts) => {
      capturedBins.push(bin);
      return { stdout: '' };
    };
    await updateFinding({
      execFile: spyExecFile,
      iid: 1,
      comment: 'test comment',
      dryRun: false,
    });
    expect(capturedBins).toHaveLength(1);
    expect(capturedBins[0]).toBe('glab');
  });
});

// ---------------------------------------------------------------------------
// MED-1 regression: reconcileFinding body-length cap (#389)
// ---------------------------------------------------------------------------

describe('Security MED-1 — reconcileFinding BODY_TOO_LARGE body-length cap (#389)', () => {
  it('throws ReconcileError with code BODY_TOO_LARGE when rendered body exceeds 65536 bytes', async () => {
    // description alone is 70000 bytes → buildIssueBody will produce a body > 65536 bytes
    const longDescription = 'A'.repeat(70000);
    await expect(
      reconcileFinding({
        finding: validFinding({ description: longDescription }),
        existingFingerprints: new Set(),
        dryRun: true,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('BODY_TOO_LARGE error code is set on the thrown ReconcileError', async () => {
    const longDescription = 'B'.repeat(70000);
    try {
      await reconcileFinding({
        finding: validFinding({ description: longDescription }),
        existingFingerprints: new Set(),
        dryRun: true,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('BODY_TOO_LARGE');
    }
  });
});

// ---------------------------------------------------------------------------
// MED-2 regression: sanitizeRecommendation case-insensitive flag (#388)
// ---------------------------------------------------------------------------
// sanitizeRecommendation is not exported; we test via reconcileFinding body.

describe('Security MED-2 — sanitizeRecommendation gi flag covers case variants (#388)', () => {
  it('sanitizes lowercase **fingerprint:** variant in recommendation', async () => {
    const result = await reconcileFinding({
      finding: validFinding({
        recommendation: 'See **fingerprint:** `aaaa0000bbbb1111` for tracking',
      }),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    expect(body).toContain('__Fingerprint__');
    expect(body).not.toContain('**fingerprint:** `aaaa0000bbbb1111`');
  });

  it('sanitizes ALLCAPS **FINGERPRINT:** variant in recommendation', async () => {
    const result = await reconcileFinding({
      finding: validFinding({
        recommendation: 'See **FINGERPRINT:** `aaaa0000bbbb1111` for tracking',
      }),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    expect(body).toContain('__Fingerprint__');
    expect(body).not.toContain('**FINGERPRINT:** `aaaa0000bbbb1111`');
  });

  it('sanitizes mixed-case **FingerPrint:** variant in recommendation', async () => {
    const result = await reconcileFinding({
      finding: validFinding({
        recommendation: '**FingerPrint:** is the mixed-case variant',
      }),
      existingFingerprints: new Set(),
      dryRun: true,
    });
    const descIdx = result.command.indexOf('--description');
    const body = result.command[descIdx + 1];
    expect(body).toContain('__Fingerprint__');
    expect(body).not.toContain('**FingerPrint:**');
  });
});
