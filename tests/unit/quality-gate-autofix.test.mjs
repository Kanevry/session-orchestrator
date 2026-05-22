/**
 * tests/unit/quality-gate-autofix.test.mjs
 *
 * Vitest unit tests for scripts/lib/quality-gate.mjs — runQualityGateWithRetry
 * (Pattern 4 — Verification-Auto-Fix-Loop, issue #521).
 *
 * Covers (per PRD § 3 Gherkin + § 3.A EARS Feature Area 4):
 *   - Happy path: gate passes on first attempt, no fixer dispatched
 *   - Retry-on-failure: dispatchFixer called up to maxRetries, then hard abort
 *   - Diagnostics bundle written with correct schema on abort
 *   - Correct failureContext shape passed to dispatchFixer
 *   - correctiveContext sourced from .orchestrator/current-session.json
 *   - maxRetries bounds: coerce < 0 → 0, coerce > 10 → 10
 *   - dispatchFixer throwing is handled gracefully (fixer-failure, not uncaught)
 *   - maxRetries=0 with failing gate: no fixer called, diagnostics bundle still written
 *   - Gate order: first failing gate reported in finalFailure.gate
 *
 * Isolation strategy:
 *   - runQualityGateWithRetry is NOT mocked — it is the system under test.
 *   - dispatchFixer is a vi.fn() — it IS mocked (external I/O: subagent dispatch).
 *   - Shell commands: use POSIX `true` (exit 0) and `false` (exit 1) as
 *     deterministic stand-ins. No real npm/typecheck invocations.
 *   - File system: each test gets a fresh mkdtempSync() repoRoot.
 *     beforeEach/afterEach clean up reliably.
 *
 * Design note: scripts/lib/quality-gate.mjs does not exist yet when this file
 * is first committed (Agent A implements it in parallel). Tests will be RED
 * until Agent A's commit lands. This is expected per the wave plan.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runQualityGateWithRetry } from '@lib/quality-gate.mjs';

// ---------------------------------------------------------------------------
// Per-test filesystem isolation
// ---------------------------------------------------------------------------

let repoRoot;

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'qg-autofix-'));
  // Pre-create the diagnostics-bundle directory so implementations can write
  // there without needing to mkdir themselves.
  mkdirSync(join(repoRoot, '.orchestrator', 'metrics', 'verification-failures'), {
    recursive: true,
  });
});

afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Helper: always-pass commands (POSIX `true` exits 0)
// ---------------------------------------------------------------------------
const PASS_COMMANDS = { lint: 'true', typecheck: 'true', test: 'true' };

// Helper: always-fail lint, everything else passes
const FAIL_LINT_COMMANDS = { lint: 'false', typecheck: 'true', test: 'true' };

// ---------------------------------------------------------------------------
// 1. Happy path
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — happy path', () => {
  it('returns { ok: true } when first attempt passes', async () => {
    const dispatchFixer = vi.fn();

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: PASS_COMMANDS,
    });

    expect(result.ok).toBe(true);
  });

  it('returns { attempts: 1 } when first attempt passes (no retries needed)', async () => {
    const dispatchFixer = vi.fn();

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: PASS_COMMANDS,
    });

    expect(result.attempts).toBe(1);
  });

  it('does not call dispatchFixer when gate passes on first attempt', async () => {
    const dispatchFixer = vi.fn();

    await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: PASS_COMMANDS,
    });

    expect(dispatchFixer).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. Retry-on-failure — core loop behaviour
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — retry on failure', () => {
  it('returns { ok: false } when gate keeps failing after all retries', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(result.ok).toBe(false);
  });

  it('calls dispatchFixer exactly maxRetries=2 times before aborting', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(dispatchFixer).toHaveBeenCalledTimes(2);
  });

  it('reports attempts = initial + maxRetries (3 total for maxRetries=2)', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(result.attempts).toBe(3);
  });

  it('reports finalFailure.gate as "lint" when lint is the failing command', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(result.finalFailure).toBeDefined();
    expect(result.finalFailure.gate).toBe('lint');
  });

  it('sets diagnosticsBundlePath to a defined string path on abort', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(typeof result.diagnosticsBundlePath).toBe('string');
  });

  it('creates the diagnostics bundle file on disk on abort', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(existsSync(result.diagnosticsBundlePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Diagnostics bundle schema
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — diagnostics bundle schema', () => {
  it('written bundle contains a "gate" field', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async () => {},
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle).toHaveProperty('gate');
  });

  it('written bundle contains a "retryAttempts" field', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async () => {},
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle).toHaveProperty('retryAttempts');
  });

  it('written bundle contains a "finalError" field', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async () => {},
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle).toHaveProperty('finalError');
  });

  it('written bundle contains a "changedFiles" field', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async () => {},
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle).toHaveProperty('changedFiles');
  });

  it('bundle retryAttempts reflects total gate attempts run (maxRetries=1 → 2 total attempts)', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async () => {},
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    // totalAttempts = maxRetries + 1 = 2: initial run + 1 fixer-driven retry
    expect(bundle.retryAttempts).toBe(2);
  });

  it('bundle gate field equals "lint" when lint is the failing gate', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: async () => {},
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle.gate).toBe('lint');
  });
});

// ---------------------------------------------------------------------------
// 4. dispatchFixer call contract (failureContext shape)
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — dispatchFixer call contract', () => {
  it('calls dispatchFixer with a "failures" property', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const callArg = dispatchFixer.mock.calls[0][0];
    expect(callArg).toHaveProperty('failures');
  });

  it('calls dispatchFixer with a "correctiveContext" property', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const callArg = dispatchFixer.mock.calls[0][0];
    expect(callArg).toHaveProperty('correctiveContext');
  });

  it('calls dispatchFixer with a "changedFiles" property', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const callArg = dispatchFixer.mock.calls[0][0];
    expect(callArg).toHaveProperty('changedFiles');
  });
});

// ---------------------------------------------------------------------------
// 5. correctiveContext sourced from current-session.json
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — correctiveContext sourcing', () => {
  it('reads corrective_context from .orchestrator/current-session.json when present', async () => {
    const sessionFile = join(repoRoot, '.orchestrator', 'current-session.json');
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    // corrective_context must be an array — the implementation reads
    // parsed.corrective_context and checks Array.isArray() before slicing.
    writeFileSync(
      sessionFile,
      JSON.stringify({ corrective_context: ['some-prior-fix-hint'] }),
      'utf8',
    );

    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const callArg = dispatchFixer.mock.calls[0][0];
    expect(callArg.correctiveContext).toContain('some-prior-fix-hint');
  });

  it('correctiveContext is defined even when current-session.json is absent', async () => {
    // No current-session.json written; should not throw, should provide some value
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const callArg = dispatchFixer.mock.calls[0][0];
    // Must be present (string or null/empty string) — never undefined/missing key
    expect('correctiveContext' in callArg).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. maxRetries boundary conditions
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — maxRetries bounds', () => {
  it('coerces maxRetries < 0 to 0: dispatchFixer is never called', async () => {
    const dispatchFixer = vi.fn();

    await runQualityGateWithRetry({
      maxRetries: -5,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(dispatchFixer).not.toHaveBeenCalled();
  });

  it('coerces maxRetries < 0 to 0: result is still ok: false', async () => {
    const dispatchFixer = vi.fn();

    const result = await runQualityGateWithRetry({
      maxRetries: -5,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(result.ok).toBe(false);
  });

  it('caps maxRetries > 10 at 10: dispatchFixer called at most 10 times', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 100,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(dispatchFixer.mock.calls.length).toBeLessThanOrEqual(10);
  });

  it('caps maxRetries > 10 at 10: dispatchFixer called at least once', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 100,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    // With a persistent failure and cap-at-10 behaviour, it must dispatch at
    // least once (not zero — that would be the maxRetries=0 behaviour).
    expect(dispatchFixer.mock.calls.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 7. dispatchFixer throws — graceful handling
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — dispatchFixer throwing', () => {
  it('does not throw (propagate) when dispatchFixer rejects', async () => {
    const dispatchFixer = vi.fn().mockRejectedValue(new Error('fixer crashed'));

    // Must resolve, not reject
    await expect(
      runQualityGateWithRetry({
        maxRetries: 1,
        dispatchFixer,
        repoRoot,
        commands: FAIL_LINT_COMMANDS,
      }),
    ).resolves.toBeDefined();
  });

  it('returns ok: false when dispatchFixer throws and gate was never fixed', async () => {
    const dispatchFixer = vi.fn().mockRejectedValue(new Error('fixer crashed'));

    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(result.ok).toBe(false);
  });

  it('calls dispatchFixer exactly once before exhausting budget (maxRetries=1, fixer throws)', async () => {
    const dispatchFixer = vi.fn().mockRejectedValue(new Error('fixer crashed'));

    await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(dispatchFixer).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 8. maxRetries=0 — no retries, but diagnostics bundle still written per PRD
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — maxRetries=0 with failing gate', () => {
  it('returns ok: false when maxRetries=0 and gate is red', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: vi.fn(),
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(result.ok).toBe(false);
  });

  it('returns attempts: 1 (only the initial run, no retries) when maxRetries=0', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: vi.fn(),
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(result.attempts).toBe(1);
  });

  it('writes a diagnostics bundle even on first-attempt fail (maxRetries=0)', async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: vi.fn(),
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    // PRD § 4 Architecture: diagnostics bundle on abort. First-attempt fail with
    // maxRetries=0 is still an abort.
    expect(result.diagnosticsBundlePath).toBeDefined();
    expect(existsSync(result.diagnosticsBundlePath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Gate order — first failing gate is the reported one
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — gate order', () => {
  it('reports lint as failing gate when lint=false and typecheck=true and test=true', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: { lint: 'false', typecheck: 'true', test: 'true' },
    });

    expect(result.finalFailure.gate).toBe('lint');
  });

  it('reports typecheck as failing gate when lint=true and typecheck=false and test=true', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: { lint: 'true', typecheck: 'false', test: 'true' },
    });

    expect(result.finalFailure.gate).toBe('typecheck');
  });

  it('reports test as failing gate when lint=true and typecheck=true and test=false', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: { lint: 'true', typecheck: 'true', test: 'false' },
    });

    expect(result.finalFailure.gate).toBe('test');
  });
});

// ---------------------------------------------------------------------------
// 10. Successful retry: fixer fixes the issue on first retry
// ---------------------------------------------------------------------------

describe('runQualityGateWithRetry — fixer succeeds on first retry', () => {
  it('returns ok: true when the gate passes after fixer dispatch', async () => {
    // Simulate: first gate run fails (lint=false), fixer runs, second run passes.
    // We swap the command after the first call by having the fixer mutate state.
    const dispatchFixer = vi.fn();

    // We need commands that fail first and pass after. Use a script that checks
    // a shared flag. Since commands are shell strings, we use a temp file flag.
    const flagFile = join(repoRoot, 'fixed.flag');
    const conditionalLint = `test -f ${flagFile}`;

    const wrappedFixer = vi.fn().mockImplementation(async (_ctx) => {
      // Create the flag file to make subsequent gate runs pass
      writeFileSync(flagFile, '1', 'utf8');
      await dispatchFixer(_ctx);
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer: wrappedFixer,
      repoRoot,
      commands: { lint: conditionalLint, typecheck: 'true', test: 'true' },
    });

    expect(result.ok).toBe(true);
  });

  it('returns attempts: 2 when gate passes on the first retry', async () => {
    const flagFile = join(repoRoot, 'fixed.flag');
    const conditionalLint = `test -f ${flagFile}`;

    const wrappedFixer = vi.fn().mockImplementation(async () => {
      writeFileSync(flagFile, '1', 'utf8');
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer: wrappedFixer,
      repoRoot,
      commands: { lint: conditionalLint, typecheck: 'true', test: 'true' },
    });

    expect(result.attempts).toBe(2);
  });

  it('does not write a diagnostics bundle when gate eventually passes', async () => {
    const flagFile = join(repoRoot, 'fixed.flag');
    const conditionalLint = `test -f ${flagFile}`;

    const wrappedFixer = vi.fn().mockImplementation(async () => {
      writeFileSync(flagFile, '1', 'utf8');
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer: wrappedFixer,
      repoRoot,
      commands: { lint: conditionalLint, typecheck: 'true', test: 'true' },
    });

    // No abort → no bundle (or bundle path undefined)
    if (result.diagnosticsBundlePath !== undefined) {
      expect(existsSync(result.diagnosticsBundlePath)).toBe(false);
    } else {
      expect(result.diagnosticsBundlePath).toBeUndefined();
    }
  });
});
