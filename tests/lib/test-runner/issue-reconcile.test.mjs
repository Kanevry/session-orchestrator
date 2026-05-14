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
 *   - execFile error paths: BINARY_NOT_FOUND (ENOENT via non-existent binary),
 *     EXEC_FAILURE (real binary exits non-zero)
 *
 * For execFile error paths we use real binaries via glabPath injection —
 * no vi.mock needed, avoids fork-pool fragility (pattern from mr-draft.test.mjs).
 * All expected values are hardcoded literals — no production-logic mirroring.
 */

import { describe, it, expect } from 'vitest';
import { reconcileFinding, ReconcileError } from '../../../scripts/lib/test-runner/issue-reconcile.mjs';
import { fingerprintFinding } from '../../../scripts/lib/test-runner/fingerprint.mjs';

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
// execFile error paths — real binary injection via glabPath parameter
// ---------------------------------------------------------------------------

describe('reconcileFinding — BINARY_NOT_FOUND via non-existent glabPath', () => {
  it('throws ReconcileError when glabPath points to a non-existent binary', async () => {
    await expect(
      reconcileFinding({
        finding: validFinding(),
        existingFingerprints: new Set(),
        glabPath: '/definitely/not/a/real/binary/xyz_nonexistent_4829',
        dryRun: false,
      }),
    ).rejects.toThrow(ReconcileError);
  });

  it('error has code BINARY_NOT_FOUND when binary is not found (ENOENT)', async () => {
    try {
      await reconcileFinding({
        finding: validFinding(),
        existingFingerprints: new Set(),
        glabPath: '/definitely/not/a/real/binary/xyz_nonexistent_4829',
        dryRun: false,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.code).toBe('BINARY_NOT_FOUND');
    }
  });

  it('BINARY_NOT_FOUND error message includes the binary path', async () => {
    try {
      await reconcileFinding({
        finding: validFinding(),
        existingFingerprints: new Set(),
        glabPath: '/definitely/not/a/real/binary/xyz_nonexistent_4829',
        dryRun: false,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err.message).toContain('/definitely/not/a/real/binary/xyz_nonexistent_4829');
    }
  });
});

describe('reconcileFinding — EXEC_FAILURE via binary that exits non-zero', () => {
  it('throws ReconcileError(EXEC_FAILURE) when binary exits with non-zero code', async () => {
    // /usr/bin/false exits with code 1 — triggers EXEC_FAILURE (not ENOENT)
    try {
      await reconcileFinding({
        finding: validFinding(),
        existingFingerprints: new Set(),
        glabPath: '/usr/bin/false',
        dryRun: false,
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ReconcileError);
      expect(err.code).toBe('EXEC_FAILURE');
    }
  });
});
