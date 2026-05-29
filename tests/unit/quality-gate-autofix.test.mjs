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
 *   - Shell commands: use cross-platform `node -e` stand-ins (PASS/FAIL helpers,
 *     exit 0/1). POSIX `true`/`false`/`test` are NOT cmd.exe builtins, so they
 *     exit 1 on the Windows CI runner — `node` is portable. No real
 *     npm/typecheck invocations.
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
// Cross-platform shell stand-ins (Windows CI portability)
//
// POSIX `true` / `false` / `test` are NOT cmd.exe builtins — on the Windows CI
// runner they are "not recognized" and exit 1, so a gate that should PASS fails.
// The gate sub-process is spawned via `spawnSync(cmd, { shell: true })`, which
// uses cmd.exe on Windows. `node` is guaranteed present (it runs these tests),
// so we use `node -e` as the portable stand-in for every gate command.
// ---------------------------------------------------------------------------
const PASS = 'node -e "process.exit(0)"';
const FAIL = 'node -e "process.exit(1)"';

/** Single-quote + escape a path for safe embedding inside a `node -e "..."` JS string. */
const sq = (p) => `'${String(p).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

/** Portable replacement for `test -f <p>`: exits 0 iff `p` exists on disk. */
const fileExistsCmd = (p) => `node -e "process.exit(require('fs').existsSync(${sq(p)})?0:1)"`;

// Helper: always-pass commands
const PASS_COMMANDS = { lint: PASS, typecheck: PASS, test: PASS };

// Helper: always-fail lint, everything else passes
const FAIL_LINT_COMMANDS = { lint: FAIL, typecheck: PASS, test: PASS };

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
      commands: { lint: FAIL, typecheck: PASS, test: PASS },
    });

    expect(result.finalFailure.gate).toBe('lint');
  });

  it('reports typecheck as failing gate when lint=true and typecheck=false and test=true', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: { lint: PASS, typecheck: FAIL, test: PASS },
    });

    expect(result.finalFailure.gate).toBe('typecheck');
  });

  it('reports test as failing gate when lint=true and typecheck=true and test=false', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer,
      repoRoot,
      commands: { lint: PASS, typecheck: PASS, test: FAIL },
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
    const conditionalLint = fileExistsCmd(flagFile);

    const wrappedFixer = vi.fn().mockImplementation(async (_ctx) => {
      // Create the flag file to make subsequent gate runs pass
      writeFileSync(flagFile, '1', 'utf8');
      await dispatchFixer(_ctx);
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer: wrappedFixer,
      repoRoot,
      commands: { lint: conditionalLint, typecheck: PASS, test: PASS },
    });

    expect(result.ok).toBe(true);
  });

  it('returns attempts: 2 when gate passes on the first retry', async () => {
    const flagFile = join(repoRoot, 'fixed.flag');
    const conditionalLint = fileExistsCmd(flagFile);

    const wrappedFixer = vi.fn().mockImplementation(async () => {
      writeFileSync(flagFile, '1', 'utf8');
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer: wrappedFixer,
      repoRoot,
      commands: { lint: conditionalLint, typecheck: PASS, test: PASS },
    });

    expect(result.attempts).toBe(2);
  });

  // Original L3 if/else branching test removed (test-quality.md violation).
  // Replacement tests are in 'W4-A6 Group H — L3 branch split' below (H1 + H2 — branch-free).
});

// ---------------------------------------------------------------------------
// Group D: coerceMaxRetries variants — tested indirectly via loop count
// W4-A6 owns: D, E, F, G, H, I (distinct describe blocks from W4-A4's A/B/C)
// ---------------------------------------------------------------------------

describe('W4-A6 Group D — coerceMaxRetries variants (indirect via loop count)', () => {
  it('D1: NaN maxRetries coerces to default (2): dispatchFixer called exactly 2 times', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: NaN,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    // NaN → typeof NaN === 'number' but !Number.isFinite(NaN) → returns default 2
    expect(dispatchFixer).toHaveBeenCalledTimes(2);
  });

  it('D2: Infinity maxRetries coerces to default (2): dispatchFixer called exactly 2 times', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: Infinity,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    // Infinity → !Number.isFinite(Infinity) → returns default 2
    expect(dispatchFixer).toHaveBeenCalledTimes(2);
  });

  it('D3: maxRetries=-1 coerces to 0: dispatchFixer is never called', async () => {
    const dispatchFixer = vi.fn();

    await runQualityGateWithRetry({
      maxRetries: -1,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    // -1 → int < 0 → returns 0 → no retries, no fixer calls
    expect(dispatchFixer).not.toHaveBeenCalled();
  });

  it('D4: maxRetries=2.7 coerces to 2 (truncated): dispatchFixer called exactly 2 times', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: 2.7,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    // Math.trunc(2.7) === 2
    expect(dispatchFixer).toHaveBeenCalledTimes(2);
  });

  it('D5: maxRetries="5" (string) coerces to default (2): dispatchFixer called exactly 2 times', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: '5',
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    // typeof '5' !== 'number' → returns default 2
    expect(dispatchFixer).toHaveBeenCalledTimes(2);
  });

  it('D6: maxRetries=null coerces to default (2): dispatchFixer called exactly 2 times', async () => {
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    await runQualityGateWithRetry({
      maxRetries: null,
      dispatchFixer,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    // typeof null !== 'number' → returns default 2
    expect(dispatchFixer).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Group E: runGate timeout + maxBuffer (indirect via runQualityGateWithRetry)
// ---------------------------------------------------------------------------

describe('W4-A6 Group E — runGate timeout + maxBuffer behaviour', () => {
  it('E1: always-failing command returns ok: false within test timeout (no hang)', async () => {
    // runGate has a 15-min ceiling (GATE_TIMEOUT_MS) which is unreasonable in
    // tests. We test the failure result shape via a fast-failing command instead
    // of waiting for the timeout. The actual timeout path is marked below.
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: FAIL, typecheck: PASS, test: PASS },
    });

    expect(result.ok).toBe(false);
    expect(result.finalFailure.exitCode).toBe(1);
  });

  it('E2: command producing large output does not throw (maxBuffer=16MiB path)', async () => {
    // Generate ~512KB of output — enough to exercise buffering without causing
    // test slowness. The real ceiling is 16MiB; we verify the function completes
    // without throwing and captures the gate result. The large-output command
    // exits 0; the test gate (false) makes the overall run fail.
    const bigOutputCmd = `node -e "process.stdout.write('x'.repeat(512*1024))"`;
    // This command outputs ≥512KB then exits 0 — we test it doesn't crash the harness.
    const failWithOutputCmd = `node -e "process.stdout.write('failure line\\n'); process.exit(1)"`;

    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      // lint: large output but exits 0; typecheck: fails with a line
      commands: { lint: bigOutputCmd, typecheck: failWithOutputCmd, test: PASS },
    });

    // typecheck fails → ok: false, but the function returned (no crash/hang)
    expect(result.ok).toBe(false);
    expect(result.finalFailure.gate).toBe('typecheck');
    // typecheck command emits 'failure line' → output is non-empty after truncation
    expect(result.finalFailure.output).toContain('failure line');
  });
});

// ---------------------------------------------------------------------------
// Group F: multi-gate cascade — gate order + fail-fast semantics
// ---------------------------------------------------------------------------

describe('W4-A6 Group F — multi-gate cascade', () => {
  it('F1: all three gates pass → ok: true and dispatchFixer never called', async () => {
    const dispatchFixer = vi.fn();

    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer,
      repoRoot,
      commands: { lint: 'echo lint-ok', typecheck: 'echo tc-ok', test: 'echo test-ok' },
    });

    expect(result.ok).toBe(true);
    expect(dispatchFixer).not.toHaveBeenCalled();
  });

  it('F2: lint fails → ok: false with finalFailure.gate === "lint" (typecheck/test not run)', async () => {
    // We verify fail-fast by checking the gate reported; if typecheck/test ran
    // their echo would appear but we can only observe the gate name in result.
    const dispatchFixer = vi.fn().mockResolvedValue(undefined);

    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer,
      repoRoot,
      commands: { lint: FAIL, typecheck: 'echo tc-never-runs', test: 'echo test-never-runs' },
    });

    expect(result.ok).toBe(false);
    expect(result.finalFailure.gate).toBe('lint');
  });

  it('F3: fixer fixes lint → typecheck → test in multi-retry scenario → ok: true', async () => {
    // Track calls to swap command results via flag files
    const lintFlagFile = join(repoRoot, 'lint-fixed.flag');
    const typecheckFlagFile = join(repoRoot, 'tc-fixed.flag');
    const testFlagFile = join(repoRoot, 'test-fixed.flag');

    // Commands check for flag files
    const lintCmd = fileExistsCmd(lintFlagFile);
    const tcCmd = fileExistsCmd(typecheckFlagFile);
    const testCmd = fileExistsCmd(testFlagFile);

    // Fixer creates all flag files on first call
    const dispatchFixer = vi.fn().mockImplementation(async () => {
      writeFileSync(lintFlagFile, '1', 'utf8');
      writeFileSync(typecheckFlagFile, '1', 'utf8');
      writeFileSync(testFlagFile, '1', 'utf8');
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer,
      repoRoot,
      commands: { lint: lintCmd, typecheck: tcCmd, test: testCmd },
    });

    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Group G: SO_WAVE_ID env var + dispatchFixer defaults
// ---------------------------------------------------------------------------

describe('W4-A6 Group G — SO_WAVE_ID env + dispatchFixer defaults', () => {
  afterEach(() => {
    delete process.env.SO_WAVE_ID;
  });

  it('G1: diagnostics bundle.wave equals SO_WAVE_ID when set', async () => {
    process.env.SO_WAVE_ID = 'wave-3-test';

    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle.wave).toBe('wave-3-test');
  });

  it('G2: diagnostics bundle.wave is null when SO_WAVE_ID is unset', async () => {
    delete process.env.SO_WAVE_ID;

    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    const bundle = JSON.parse(readFileSync(result.diagnosticsBundlePath, 'utf8'));
    expect(bundle.wave).toBeNull();
  });

  it('G3: runQualityGateWithRetry works when dispatchFixer is absent from options', async () => {
    // No dispatchFixer key at all — should not throw, should return ok: false
    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      repoRoot,
      commands: FAIL_LINT_COMMANDS,
    });

    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
  });

  it('G4: runQualityGateWithRetry does not throw when dispatchFixer is a non-function string', async () => {
    await expect(
      runQualityGateWithRetry({
        maxRetries: 1,
        dispatchFixer: 'not a function',
        repoRoot,
        commands: FAIL_LINT_COMMANDS,
      }),
    ).resolves.toMatchObject({ ok: false });
  });

  it('G5: runQualityGateWithRetry does not throw when dispatchFixer is undefined', async () => {
    await expect(
      runQualityGateWithRetry({
        maxRetries: 1,
        dispatchFixer: undefined,
        repoRoot,
        commands: FAIL_LINT_COMMANDS,
      }),
    ).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// Group H: L3 branching split — refactor of the if/else in section 10
//
// The original test at line 627 has an if/else branch inside the test body,
// violating test-quality.md (cyclomatic complexity = 1 rule).
// Per the production implementation, when a gate passes (ok: true), no
// diagnostics bundle is written and diagnosticsBundlePath is undefined.
// We split into two explicit, branch-free tests.
// ---------------------------------------------------------------------------

describe('W4-A6 Group H — no diagnostics bundle on successful gate (L3 split)', () => {
  it('H1: diagnosticsBundlePath is undefined when gate passes after fixer dispatch', async () => {
    const flagFile = join(repoRoot, 'h1-fixed.flag');
    const conditionalLint = fileExistsCmd(flagFile);

    const wrappedFixer = vi.fn().mockImplementation(async () => {
      writeFileSync(flagFile, '1', 'utf8');
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer: wrappedFixer,
      repoRoot,
      commands: { lint: conditionalLint, typecheck: PASS, test: PASS },
    });

    // Gate passes → no abort → no bundle path written
    expect(result.diagnosticsBundlePath).toBeUndefined();
  });

  it('H2: result.ok is true when gate passes after fixer dispatch (confirming no abort occurred)', async () => {
    const flagFile = join(repoRoot, 'h2-fixed.flag');
    const conditionalLint = fileExistsCmd(flagFile);

    const wrappedFixer = vi.fn().mockImplementation(async () => {
      writeFileSync(flagFile, '1', 'utf8');
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 2,
      dispatchFixer: wrappedFixer,
      repoRoot,
      commands: { lint: conditionalLint, typecheck: PASS, test: PASS },
    });

    // If ok === true, the gate passed and no diagnostics bundle is warranted.
    // This confirms the H1 assertion isn't trivially vacuous.
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Group I: maxBuffer overflow path (#528B)
//
// runGate enforces `maxBuffer: 16 * 1024 * 1024` (16 MiB) via spawnSync.
// When a child process emits >16 MiB, spawnSync does NOT throw — it returns
// `result.error.code === 'ENOBUFS'`, `result.status === null`, and truncated
// stdout. The quality-gate code must handle this gracefully: it should return
// a structured failure (exitCode=1, ok=false) rather than crashing.
//
// This was flagged as untested in issue #528B: W4-A5 used 512KB (well under
// the cap). This group generates 21 MiB to actually cross the 16 MiB boundary.
// ---------------------------------------------------------------------------

describe('W4-A6 Group I — maxBuffer overflow (21 MiB output, #528B)', () => {
  // 21 MiB single-write command — crosses the 16 MiB spawnSync maxBuffer cap.
  // Completes in ~60ms (measured); does NOT approach the 15-min GATE_TIMEOUT_MS.
  const OVERFLOW_CMD = `node -e "process.stdout.write('x'.repeat(1024 * 1024 * 21))"`;

  it('I1: does not throw or crash the test process when gate output exceeds 16 MiB', { timeout: 30_000 }, async () => {
    // The test itself is the crash-safety check: if runQualityGateWithRetry
    // propagated an ENOBUFS error or an uncaught exception, this assertion
    // would never be reached and vitest would report a process-level failure.
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: OVERFLOW_CMD, typecheck: PASS, test: PASS },
    });

    // The function returned — no crash.
    expect(result).toBeDefined();
  });

  it('I2: returns ok: false when the overflowing command is the only gate (ENOBUFS is a failure)', { timeout: 30_000 }, async () => {
    // spawnSync with ENOBUFS sets result.status = null, which the quality-gate
    // code maps to exitCode = 1 (non-zero). The gate must be reported as failed,
    // not silently swallowed.
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: OVERFLOW_CMD, typecheck: PASS, test: PASS },
    });

    expect(result.ok).toBe(false);
  });

  it('I3: finalFailure.gate is "lint" when the overflowing command is the lint gate', { timeout: 30_000 }, async () => {
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: OVERFLOW_CMD, typecheck: PASS, test: PASS },
    });

    expect(result.finalFailure).toBeDefined();
    expect(result.finalFailure.gate).toBe('lint');
  });

  it('I4: finalFailure.exitCode is 1 on ENOBUFS overflow (null status mapped to 1)', { timeout: 30_000 }, async () => {
    // spawnSync ENOBUFS: result.status === null, result.signal === 'SIGTERM'.
    // The timedOut check (SIGTERM + ETIMEDOUT) does NOT match ENOBUFS, so the
    // quality-gate code falls through to exitCode = 1.
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: OVERFLOW_CMD, typecheck: PASS, test: PASS },
    });

    expect(result.finalFailure.exitCode).toBe(1);
  });

  it('I5: captured output is truncated well below the 21 MiB input (maxBuffer cap enforced)', { timeout: 30_000 }, async () => {
    // spawnSync with maxBuffer=16 MiB enforces an ENOBUFS at roughly
    // maxBuffer + 64 KiB (observed: 16,842,752 bytes = 16 MiB + 64 KiB).
    // The output passed through runGate's .split('\n').slice(-50).join('\n')
    // tail step — for a single-line write that is the full truncated string.
    //
    // Assertion: the captured tail is well below the 21 MiB input, proving
    // the buffer cap fired. We use 17 MiB as the ceiling (observed max is
    // ~16.06 MiB) and 1 byte as the floor (something was captured).
    const TRUNCATION_CEILING = 17 * 1024 * 1024; // 17 MiB — well below 21 MiB input

    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: OVERFLOW_CMD, typecheck: PASS, test: PASS },
    });

    const outputLen = result.finalFailure.output?.length ?? 0;
    // Something was captured (not silently dropped)
    expect(outputLen).toBeGreaterThan(0);
    // But clearly less than the full 21 MiB (cap was enforced)
    expect(outputLen).toBeLessThan(TRUNCATION_CEILING);
  });

  it('I6: diagnostics bundle is written to disk on overflow-triggered abort', { timeout: 30_000 }, async () => {
    // An ENOBUFS-triggered gate failure is still a gate failure — the
    // diagnostics bundle must be written just like any other abort.
    const result = await runQualityGateWithRetry({
      maxRetries: 0,
      dispatchFixer: async () => {},
      repoRoot,
      commands: { lint: OVERFLOW_CMD, typecheck: PASS, test: PASS },
    });

    expect(result.diagnosticsBundlePath).toBeDefined();
    expect(existsSync(result.diagnosticsBundlePath)).toBe(true);
  });

  it('I7: overflow gate does not prevent downstream gate from running after fixer fixes the overflow gate', { timeout: 30_000 }, async () => {
    // Regression guard: verify the loop re-runs correctly after an overflow
    // failure. The fixer swaps the lint command to a passing one; the retry passes.
    const flagFile = join(repoRoot, 'i7-overflow-fixed.flag');
    // On first run: lint emits 21 MiB (overflow → exit 1); after fixer writes
    // the flag file, the conditional command succeeds.
    // Portable: exit 0 iff flagFile exists; else emit 21 MB and exit 1.
    const conditionalLint = `node -e "const fs=require('fs'); if (fs.existsSync(${sq(flagFile)})) { process.exit(0); } else { process.stdout.write('x'.repeat(1024*1024*21)); process.exit(1); }"`;

    const fixer = vi.fn().mockImplementation(async () => {
      writeFileSync(flagFile, '1', 'utf8');
    });

    const result = await runQualityGateWithRetry({
      maxRetries: 1,
      dispatchFixer: fixer,
      repoRoot,
      commands: { lint: conditionalLint, typecheck: PASS, test: PASS },
    });

    // After fixer creates the flag, the gate passes — ok: true on the retry.
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
  });
});
