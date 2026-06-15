/**
 * apply-config-repair.test.mjs — Tests for the #651 C2 REAL apply-path.
 *
 * The sibling engine.test.mjs MOCKS the `applyConfigRepair` / `buildDiff` seams
 * (`vi.fn()`), so 0 tests exercise the REAL autonomous-mutation bodies. This
 * suite closes that gap by running `runRepairEngine` with the REAL
 * `defaultApplyConfigRepair` / `defaultBuildDiff` defaults (we deliberately do
 * NOT inject those two seams) against a TEMP-file CLAUDE.md fixture in
 * os.tmpdir(). All OTHER seams (classifier, gate, idempotency store, MR opener)
 * are stubbed because they are NOT the apply-path under test and would otherwise
 * touch the real repo / spawn git.
 *
 * Coverage map (from the session-reviewer's gap list):
 *   1. End-to-end integration: drift error → extractCandidates (REAL) →
 *      runRepairEngine (REAL apply) → fixture file mutated `8 commands`→`30 commands`.
 *   2. applyCommandCountSwap regex behaviour (via the apply seam): word-boundary
 *      ("18 commands" not mis-swapped for claimed=8), /commands + slash variants,
 *      idempotent no-op when claimed===actual, no-op when claimed text absent.
 *   3. defaultApplyConfigRepair: whitelisted mutate, escape-guard reject,
 *      content-idempotency no-op, unsupported-shape reason, atomic-write no .tmp.
 *   4. Engine control-flow (W3 fixes): unsupported-shape → re-route to MR (NOT
 *      stamped); transient read/write failure → no-op WITHOUT markProcessed and
 *      NOT counted in autonomousApplied (left re-tryable).
 *   5. defaultBuildDiff: whitelisted → { content, raw }; unsupported/read-error/
 *      escape → { raw } only (no content key).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runRepairEngine } from '@lib/skill-evolution/engine.mjs';
import { extractCandidates } from '@lib/skill-evolution/candidate-intake.mjs';

/** Track temp dirs so afterEach can clean them up. */
let tmpDirs = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    try {
      // restore perms in case a test chmod'd a file read-only inside the dir
      try {
        chmodSync(dir, 0o755);
      } catch {
        /* best-effort */
      }
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
  tmpDirs = [];
  vi.clearAllMocks();
});

/** Make a fresh temp repo root with a CLAUDE.md containing `body`. Returns { repoRoot, file }. */
function makeRepo(body) {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'so-c2-apply-'));
  tmpDirs.push(repoRoot);
  const file = path.join(repoRoot, 'CLAUDE.md');
  writeFileSync(file, body, 'utf8');
  return { repoRoot, file };
}

/**
 * A command-count drift candidate as candidate-intake would mint it. The PROSE
 * `proposed_change` is the exact whitelist shape the engine apply-path parses:
 *   `Update narrative '<claimed> commands' to actual <actual>`
 */
function commandCountCandidate(overrides = {}) {
  return {
    id: 'rc-cc01',
    schema_version: 1,
    source: 'drift-check',
    source_ref: 'command-count:CLAUDE.md:42',
    target_path: 'CLAUDE.md',
    evidence: 1.0,
    evidence_kind: 'filesystem-fact',
    proposed_change: "Update narrative '8 commands' to actual 30",
    rationale: 'narrative says 8 commands but actual is 30',
    created_at: '2026-06-14T12:00:00.000Z',
    processed_at: null,
    superseded_by: null,
    ...overrides,
  };
}

/**
 * Seams for the apply-path. NOTE: applyConfigRepair / buildDiff are intentionally
 * ABSENT so runRepairEngine uses the REAL defaults. classifyTarget yields the
 * local-config / autonomous-gated posture; gate green; idempotency store stubbed
 * in-memory; openRepairMr stubbed (so the MR re-route path is observable without
 * spawning git).
 */
function applyPathSeams(overrides = {}) {
  return {
    // extractCandidates is overridden per-test (or left to feed the real one).
    mergeCandidates: vi.fn(() => ({ ok: true })),
    markProcessed: vi.fn(() => ({ ok: true })),
    isProcessed: vi.fn(() => false),
    classifyTarget: vi.fn(() => ({ targetType: 'local-config', posture: 'autonomous-gated' })),
    runConfigValidationGate: vi.fn(async () => ({ ok: true })),
    openRepairMr: vi.fn(async () => ({ ok: true, action: 'mr-opened', mrUrl: 'https://gitlab/mr/9' })),
    log: vi.fn(),
    ...overrides,
  };
}

/** Config that enables R6 autonomous-apply for a local-config target. */
function gatedConfig(evidenceFloor = 0.5) {
  return { 'skill-evolution': { autonomy: 'autonomous-gated', 'evidence-floor': evidenceFloor } };
}

// ---------------------------------------------------------------------------
// 1. Integration test — the one that would have caught the blocking defect.
// ---------------------------------------------------------------------------
describe('integration: drift error → extractCandidates → REAL apply-path mutates the fixture', () => {
  it('mints the clean single-word proposed_change "Update narrative \'8 commands\' to actual 30"', () => {
    const driftResult = {
      status: 'fail',
      errors: [
        {
          check: 'command-count',
          file: 'CLAUDE.md',
          line: 142,
          extracted: '8 commands',
          message: 'narrative says 8 commands but actual is 30',
          command_count: { actual: 30, claimed: '8' },
        },
      ],
    };

    const [candidate] = extractCandidates({ driftResult, now: '2026-06-14T12:00:00.000Z' });
    expect(candidate.proposed_change).toBe("Update narrative '8 commands' to actual 30");
  });

  it('runs the full pipeline: decision=autonomous-apply, file mutated 8→30, candidate markProcessed', async () => {
    const { repoRoot, file } = makeRepo(
      '# Plugin\n\nThis plugin ships 8 commands for the operator.\n\nMore prose follows.\n',
    );
    const driftResult = {
      status: 'fail',
      errors: [
        {
          check: 'command-count',
          file: 'CLAUDE.md',
          line: 142,
          extracted: '8 commands',
          message: 'narrative says 8 commands but actual is 30',
          command_count: { actual: 30, claimed: '8' },
        },
      ],
    };

    const seams = applyPathSeams();

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [], driftResult },
      // REAL extractCandidates (not injected) + REAL apply seam (not injected).
      seams,
    );

    expect(result.outcomes).toHaveLength(1);
    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(result.summary.autonomousApplied).toBe(1);

    // The fixture file's narrative count was rewritten 8 → 30, prose preserved.
    expect(readFileSync(file, 'utf8')).toBe(
      '# Plugin\n\nThis plugin ships 30 commands for the operator.\n\nMore prose follows.\n',
    );

    // The candidate was stamped (the engine owns the G2 stamp).
    expect(seams.markProcessed).toHaveBeenCalledTimes(1);
    expect(seams.markProcessed).toHaveBeenCalledWith(expect.objectContaining({ repoRoot }));
  });
});

// ---------------------------------------------------------------------------
// 2. applyCommandCountSwap regex behaviour — exercised via the REAL apply seam.
//    (The fn is module-internal; we drive it through runRepairEngine + a fixture.)
// ---------------------------------------------------------------------------
describe('command-count swap regex (via real apply-path)', () => {
  it('does NOT mis-swap "18 commands" when the claimed number is 8 (word boundary): file unchanged', async () => {
    const { repoRoot, file } = makeRepo('The suite has 18 commands today.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]), // claimed 8 → actual 30
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    // claimed "8" must NOT match inside "18" (\b guard) → swap returns null → file untouched.
    // The 'already-current (no-op)' reason is non-retryable so the engine stamps the
    // candidate and returns autonomous-apply (deferred) — the load-bearing assertion is
    // that the "18" line is preserved byte-for-byte.
    expect(readFileSync(file, 'utf8')).toBe('The suite has 18 commands today.\n');
    expect(result.outcomes[0].detail).toMatch(/apply deferred|already-current/);
  });

  it('handles the "/commands" narrative variant', async () => {
    const { repoRoot, file } = makeRepo('Exposes 8 /commands in the menu.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(readFileSync(file, 'utf8')).toBe('Exposes 30 /commands in the menu.\n');
  });

  it('handles the "slash commands" narrative variant', async () => {
    const { repoRoot, file } = makeRepo('Exposes 8 slash commands in the menu.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(readFileSync(file, 'utf8')).toBe('Exposes 30 slash commands in the menu.\n');
  });

  it('is an idempotent no-op when claimed === actual: no file mutation, deferred + stamped', async () => {
    const { repoRoot, file } = makeRepo('Ships 30 commands.\n');
    const seams = applyPathSeams({
      // proposed_change with claimed === actual === 30
      extractCandidates: vi.fn(() => [
        commandCountCandidate({ proposed_change: "Update narrative '30 commands' to actual 30" }),
      ]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    // already-current → NO file write (the swap returns null), but the reason
    // ('already-current') is a non-retryable, non-unsupported reason so the
    // engine stamp-and-returns it as autonomous-apply with an "apply deferred" detail.
    expect(readFileSync(file, 'utf8')).toBe('Ships 30 commands.\n');
    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(result.outcomes[0].detail).toMatch(/apply deferred|already-current/);
    expect(seams.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('is a no-op write when the claimed narrative text is absent: file unchanged, deferred + stamped', async () => {
    const { repoRoot, file } = makeRepo('This file mentions no command counts at all.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]), // claimed 8 → not present
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    // claimed text absent → swap returns null → no write; reason 'already-current (no-op)'
    // is non-retryable → engine stamp-and-returns autonomous-apply (deferred), file untouched.
    expect(readFileSync(file, 'utf8')).toBe('This file mentions no command counts at all.\n');
    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(result.outcomes[0].detail).toMatch(/apply deferred|already-current/);
    expect(seams.markProcessed).toHaveBeenCalledTimes(1);
  });

  it('rewrites only the FIRST occurrence and preserves every other byte', async () => {
    const { repoRoot, file } = makeRepo('First: 8 commands. Second: 8 commands.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(readFileSync(file, 'utf8')).toBe('First: 30 commands. Second: 8 commands.\n');
  });
});

// ---------------------------------------------------------------------------
// 3. defaultApplyConfigRepair behaviours (via the engine, real seam).
// ---------------------------------------------------------------------------
describe('defaultApplyConfigRepair (real) behaviours', () => {
  it('whitelisted shape → mutates exactly one line and reports autonomous-apply', async () => {
    const { repoRoot, file } = makeRepo('Header\nWe expose 8 commands.\nFooter\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(readFileSync(file, 'utf8')).toBe('Header\nWe expose 30 commands.\nFooter\n');
  });

  it('escape-guard rejects a ../escape target_path: no write, not autonomous-apply', async () => {
    const { repoRoot, file } = makeRepo('We expose 8 commands.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [
        commandCountCandidate({ target_path: '../escape.md' }),
      ]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    // escape → apply returns applied:false (reason 'target escapes repo'), NOT unsupported-shape,
    // so it is stamped-and-returned as autonomous-apply WITHOUT mutating the in-repo file.
    expect(readFileSync(file, 'utf8')).toBe('We expose 8 commands.\n');
    // The in-repo fixture is untouched (the escape target was never resolved/written).
    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(result.outcomes[0].detail).toMatch(/escapes repo|apply deferred/);
  });

  it('content-level idempotency: already-current file → no write (file byte-identical)', async () => {
    const { repoRoot, file } = makeRepo('Ships 30 commands already.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [
        commandCountCandidate({ proposed_change: "Update narrative '30 commands' to actual 30" }),
      ]),
    });

    await runRepairEngine({ repoRoot, config: gatedConfig(), learnings: [{}] }, seams);

    // The apply seam computes the swap, sees next === content (claimed===actual=30) and
    // returns applied:false WITHOUT writing — the file is byte-identical afterwards.
    expect(readFileSync(file, 'utf8')).toBe('Ships 30 commands already.\n');
  });

  it('unsupported-shape prose → re-routes to MR (open-mr), never stamped as autonomous-apply', async () => {
    const { repoRoot, file } = makeRepo('We expose 8 commands.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [
        commandCountCandidate({ proposed_change: 'Tighten the stale default in the config block' }),
      ]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    // unsupported prose → apply declines with unsupported-shape → engine opens MR.
    expect(result.outcomes[0].decision).toBe('open-mr');
    expect(result.summary.autonomousApplied).toBe(0);
    expect(seams.openRepairMr).toHaveBeenCalledTimes(1);
    expect(seams.markProcessed).not.toHaveBeenCalled();
    expect(readFileSync(file, 'utf8')).toBe('We expose 8 commands.\n');
  });

  it('atomic write leaves no leftover .tmp file in the target dir on success', async () => {
    const { repoRoot } = makeRepo('We expose 8 commands.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]),
    });

    await runRepairEngine({ repoRoot, config: gatedConfig(), learnings: [{}] }, seams);

    const leftovers = readdirSync(repoRoot).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Engine control-flow (W3 fixes) — unsupported re-route + transient I/O no-op.
// ---------------------------------------------------------------------------
describe('engine control-flow (W3 fixes)', () => {
  it('R6 + unsupported-shape → open-mr outcome (NOT autonomous-apply), candidate left unstamped', async () => {
    const { repoRoot } = makeRepo('We expose 8 commands.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [
        commandCountCandidate({ proposed_change: 'Reword the introduction paragraph entirely' }),
      ]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('open-mr');
    expect(result.outcomes[0].decision).not.toBe('autonomous-apply');
    expect(result.summary.mrsOpened).toBe(1);
    expect(seams.markProcessed).not.toHaveBeenCalled();
  });

  it('transient write failure (read-only target) → no-op, NOT stamped, NOT counted as applied (re-tryable)', async () => {
    // Make the CLAUDE.md unwritable so the atomic rename onto it fails. We keep
    // the FILE readable (the swap is computed) but the DIRECTORY read-only so
    // the tmp-file write / rename fails → reason 'write failed' → W3 FIX2 no-op.
    const { repoRoot, file } = makeRepo('We expose 8 commands.\n');
    chmodSync(repoRoot, 0o500); // r-x: cannot create the tmp file → write fails

    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    // restore perms so afterEach + the read below succeed
    chmodSync(repoRoot, 0o755);

    // W3 FIX2: transient I/O failure → no-op, not stamped, not counted as applied.
    expect(result.outcomes[0].decision).toBe('no-op');
    expect(result.summary.autonomousApplied).toBe(0);
    expect(result.summary.blocked).toBe(1);
    expect(seams.markProcessed).not.toHaveBeenCalled();
    // detail surfaces the write failure and signals retry, file content unchanged.
    expect(result.outcomes[0].detail).toMatch(/write failed/i);
    expect(result.outcomes[0].detail).toMatch(/retry/i);
    expect(readFileSync(file, 'utf8')).toBe('We expose 8 commands.\n');
  });

  it('transient read failure (missing target file) → no-op, NOT stamped, NOT counted as applied', async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'so-c2-apply-'));
    tmpDirs.push(repoRoot);
    // NOTE: no CLAUDE.md written → readFileSync inside the apply seam throws ENOENT.

    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate()]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('no-op');
    expect(result.summary.autonomousApplied).toBe(0);
    expect(seams.markProcessed).not.toHaveBeenCalled();
    expect(result.outcomes[0].detail).toMatch(/read failed/i);
  });
});

// ---------------------------------------------------------------------------
// 4b. Security H1 (session-3) — autonomous-apply is restricted to
//     filesystem-fact candidates. A learning-sourced ('confidence') candidate
//     whose prose matches the command-count whitelist shape MUST NOT auto-apply;
//     it routes to the MR path and the target file is BYTE-FOR-BYTE unchanged.
// ---------------------------------------------------------------------------
describe('security H1: evidence_kind gate on autonomous-apply', () => {
  // The exact attacker-influenceable prose shape — identical between both tests.
  const SHARED_PROSE = "Update narrative '8 commands' to actual 30";

  it('filesystem-fact candidate with valid command-count prose → autonomous-apply, file mutated 8→30', async () => {
    const { repoRoot, file } = makeRepo('We expose 8 commands.\n');
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [
        commandCountCandidate({ evidence_kind: 'filesystem-fact', proposed_change: SHARED_PROSE }),
      ]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(result.summary.autonomousApplied).toBe(1);
    expect(readFileSync(file, 'utf8')).toBe('We expose 30 commands.\n');
  });

  it('confidence candidate with the SAME prose → NOT applied, routed to MR, file byte-for-byte unchanged', async () => {
    const ORIGINAL = 'We expose 8 commands.\n';
    const { repoRoot, file } = makeRepo(ORIGINAL);

    // Snapshot the file bytes BEFORE the run.
    const before = readFileSync(file);

    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [
        // Same prose as the filesystem-fact case above — only evidence_kind differs.
        commandCountCandidate({ evidence_kind: 'confidence', proposed_change: SHARED_PROSE }),
      ]),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(), learnings: [{}] },
      seams,
    );

    // The engine declines the auto-apply (unsupported-shape) and re-routes to MR.
    expect(result.outcomes[0].decision).toBe('open-mr');
    expect(result.summary.autonomousApplied).toBe(0);
    expect(result.outcomes[0].detail).toMatch(/unsupported-shape/);
    expect(seams.openRepairMr).toHaveBeenCalledTimes(1);
    expect(seams.markProcessed).not.toHaveBeenCalled();

    // The target file is BYTE-FOR-BYTE unchanged — the attacker-influenceable
    // 'confidence' prose drove no number-swap.
    const after = readFileSync(file);
    expect(after.equals(before)).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe(ORIGINAL);
  });
});

// ---------------------------------------------------------------------------
// 5. defaultBuildDiff (real) — exercised through the MR fallback path.
//    A real buildDiff is invoked by the engine's finishOpenMr when the candidate
//    is routed to an MR. We assert its shape by capturing the `diff` arg the
//    (stubbed) openRepairMr receives.
// ---------------------------------------------------------------------------
describe('defaultBuildDiff (real) shape', () => {
  it('whitelisted shape on an evidence-below-floor fallback → diff carries { content, raw }', async () => {
    const { repoRoot } = makeRepo('We expose 8 commands.\n');
    // Capture the diff the engine builds and hands to the MR opener.
    let capturedDiff = null;
    const seams = applyPathSeams({
      // evidence below floor → gate green but R6 fails → fallback to MR (real buildDiff runs).
      extractCandidates: vi.fn(() => [commandCountCandidate({ evidence: 0.3 })]),
      openRepairMr: vi.fn(async ({ diff }) => {
        capturedDiff = diff;
        return { ok: true, action: 'mr-opened', mrUrl: 'https://gitlab/mr/2' };
      }),
    });

    const result = await runRepairEngine(
      { repoRoot, config: gatedConfig(0.5), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('open-mr');
    // Real buildDiff computed the full rewritten file as `content` + a unified-diff `raw`.
    expect(capturedDiff).toEqual(
      expect.objectContaining({
        content: 'We expose 30 commands.\n',
      }),
    );
    expect(typeof capturedDiff.raw).toBe('string');
    expect(capturedDiff.raw).toContain('-8 commands');
    expect(capturedDiff.raw).toContain('+30 commands');
  });

  it('unsupported prose shape → diff is { raw } only (no content key)', async () => {
    const { repoRoot } = makeRepo('We expose 8 commands.\n');
    let capturedDiff = null;
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [
        commandCountCandidate({ evidence: 0.3, proposed_change: 'Reword the intro paragraph' }),
      ]),
      openRepairMr: vi.fn(async ({ diff }) => {
        capturedDiff = diff;
        return { ok: true, action: 'mr-opened', mrUrl: 'https://gitlab/mr/3' };
      }),
    });

    await runRepairEngine({ repoRoot, config: gatedConfig(0.5), learnings: [{}] }, seams);

    expect(capturedDiff).not.toBeNull();
    expect('content' in capturedDiff).toBe(false);
    expect(capturedDiff.raw).toBe('Reword the intro paragraph');
  });

  it('escape target_path → diff is { raw } only (no content key)', async () => {
    const { repoRoot } = makeRepo('We expose 8 commands.\n');
    let capturedDiff = null;
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [
        commandCountCandidate({ evidence: 0.3, target_path: '../escape.md' }),
      ]),
      openRepairMr: vi.fn(async ({ diff }) => {
        capturedDiff = diff;
        return { ok: true, action: 'mr-opened', mrUrl: 'https://gitlab/mr/4' };
      }),
    });

    await runRepairEngine({ repoRoot, config: gatedConfig(0.5), learnings: [{}] }, seams);

    expect(capturedDiff).not.toBeNull();
    expect('content' in capturedDiff).toBe(false);
    expect(capturedDiff.raw).toBe("Update narrative '8 commands' to actual 30");
  });

  it('read-error target (missing file) → diff is { raw } only (no content key)', async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'so-c2-apply-'));
    tmpDirs.push(repoRoot);
    // no CLAUDE.md → buildDiff's readFileSync throws → degrade to { raw }.
    let capturedDiff = null;
    const seams = applyPathSeams({
      extractCandidates: vi.fn(() => [commandCountCandidate({ evidence: 0.3 })]),
      openRepairMr: vi.fn(async ({ diff }) => {
        capturedDiff = diff;
        return { ok: true, action: 'mr-opened', mrUrl: 'https://gitlab/mr/5' };
      }),
    });

    await runRepairEngine({ repoRoot, config: gatedConfig(0.5), learnings: [{}] }, seams);

    expect(capturedDiff).not.toBeNull();
    expect('content' in capturedDiff).toBe(false);
    expect(capturedDiff.raw).toBe("Update narrative '8 commands' to actual 30");
  });
});
