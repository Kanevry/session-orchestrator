/**
 * engine.test.mjs — Unit tests for the #647 C2 auto-repair ORCHESTRATOR
 * (`runRepairEngine`).
 *
 * Scope: the gate-per-artifact-type DECISION MATRIX (autonomy × posture × gate ×
 * evidence) plus the 4 acceptance gherkins (G1..G4) and the R6 / off / empty-set /
 * dry-run invariants. ALL DI seams are mocked (`vi.fn()`) so NO real sibling
 * module or subprocess runs — the matrix is driven by:
 *   - `classifyTarget` → the (targetType, posture) the row wants,
 *   - `runConfigValidationGate` → the { ok } gate result the row wants,
 *   - candidate `evidence` + config `autonomy` / `evidence-floor`.
 *
 * Assertions target the SUT's real output (`outcomes[].decision`, `summary`),
 * with seam-invocation spies used ONLY where the invocation IS the behaviour
 * under test (G2 apply+stamp, G4 no-side-effect) — per .claude/rules/testing.md
 * BE-012.
 */

import { describe, it, test, expect, vi, beforeEach } from 'vitest';
import { runRepairEngine } from '@lib/skill-evolution/engine.mjs';

const REPO_ROOT = '/tmp/repo';
const FLOOR = 0.5;

/**
 * A single repair candidate with the shape the engine reads
 * ({ id, target_path, evidence, proposed_change }).
 */
function candidate(overrides = {}) {
  return {
    id: 'cand-1',
    target_path: 'CLAUDE.md',
    evidence: 0.9,
    proposed_change: 'tighten the stale default',
    ...overrides,
  };
}

/** Build a full parsed Session Config with a skill-evolution block. */
function configFor(autonomy, evidenceFloor = FLOOR) {
  return { 'skill-evolution': { autonomy, 'evidence-floor': evidenceFloor, judge: false } };
}

/** Posture/targetType pairs the classifier can yield. */
const CLASSIFICATIONS = {
  'plugin-skill': { targetType: 'plugin-skill', posture: 'always-mr' },
  'local-skill': { targetType: 'local-skill', posture: 'always-mr' },
  'local-config': { targetType: 'local-config', posture: 'autonomous-gated' },
  unknown: { targetType: 'unknown', posture: 'always-mr' },
};

/**
 * Build a fresh set of mocked seams. Defaults: one candidate returned by
 * extractCandidates, never previously processed, MR opener reports `mr-opened`,
 * gate green, apply applied + stamp ok. Callers override per test.
 */
function makeSeams(overrides = {}) {
  return {
    extractCandidates: vi.fn(() => [candidate()]),
    mergeCandidates: vi.fn(() => ({ ok: true })),
    markProcessed: vi.fn(() => ({ ok: true })),
    isProcessed: vi.fn(() => false),
    classifyTarget: vi.fn(() => CLASSIFICATIONS['local-config']),
    runConfigValidationGate: vi.fn(async () => ({ ok: true })),
    openRepairMr: vi.fn(async () => ({ action: 'mr-opened', mrUrl: 'https://gitlab/mr/1' })),
    applyConfigRepair: vi.fn(async () => ({ ok: true, applied: true })),
    buildDiff: vi.fn(() => ({ raw: 'diff' })),
    log: vi.fn(),
    ...overrides,
  };
}

describe('runRepairEngine — decision matrix', () => {
  // table: autonomy | classification key | gate ok | candidate evidence | expected decision
  test.each([
    // autonomy 'off' — advisory-only ALWAYS (every target type, gate/evidence irrelevant)
    ['off', 'plugin-skill', true, 0.9, 'advisory-only'],
    ['off', 'local-config', true, 0.9, 'advisory-only'],
    ['off', 'local-skill', true, 0.9, 'advisory-only'],
    ['off', 'unknown', true, 0.9, 'advisory-only'],
    // autonomy 'advisory'
    ['advisory', 'plugin-skill', true, 0.9, 'open-mr'],
    ['advisory', 'local-config', true, 0.9, 'advisory-only'], // gate green but advisory ⇒ advisory
    ['advisory', 'local-config', false, 0.9, 'advisory-only'], // gate fail ⇒ advisory
    // autonomy 'autonomous-gated' — prose targets always route to MR
    ['autonomous-gated', 'plugin-skill', true, 0.9, 'open-mr'],
    ['autonomous-gated', 'local-skill', true, 0.9, 'open-mr'],
    ['autonomous-gated', 'unknown', true, 0.9, 'open-mr'],
    // autonomy 'autonomous-gated' + local-config — the R6 row + its fallbacks
    ['autonomous-gated', 'local-config', true, 0.9, 'autonomous-apply'], // R6 — the ONLY one
    ['autonomous-gated', 'local-config', true, 0.3, 'open-mr'], // evidence < floor ⇒ MR
    ['autonomous-gated', 'local-config', false, 0.9, 'open-mr'], // gate fail ⇒ MR
    ['autonomous-gated', 'local-config', false, 0.3, 'open-mr'], // both fail ⇒ MR
  ])(
    'autonomy=%s posture=%s gate=%s evidence=%s → %s',
    async (autonomy, classKey, gateOk, evidence, expected) => {
      const seams = makeSeams({
        extractCandidates: vi.fn(() => [candidate({ evidence })]),
        classifyTarget: vi.fn(() => CLASSIFICATIONS[classKey]),
        runConfigValidationGate: vi.fn(async () => ({ ok: gateOk })),
      });

      const result = await runRepairEngine(
        { repoRoot: REPO_ROOT, config: configFor(autonomy), learnings: [{}], driftResult: null },
        seams,
      );

      expect(result.outcomes).toHaveLength(1);
      expect(result.outcomes[0].decision).toBe(expected);
    },
  );

  it('honours a stringified evidence-floor ("0.9") instead of silently defaulting to 0.5', async () => {
    // R5/LOW2 hardening: a config evidence-floor of "0.9" (string) must be coerced
    // so a 0.6 candidate falls BELOW the operator's stricter floor → open-mr, NOT
    // autonomous-apply (which is what the old isFinite-on-string default-to-0.5 gave).
    const seams = makeSeams({
      extractCandidates: vi.fn(() => [candidate({ evidence: 0.6 })]),
      classifyTarget: vi.fn(() => CLASSIFICATIONS['local-config']),
      runConfigValidationGate: vi.fn(async () => ({ ok: true })),
    });

    const result = await runRepairEngine(
      {
        repoRoot: REPO_ROOT,
        config: configFor('autonomous-gated', '0.9'),
        learnings: [{}],
        driftResult: null,
      },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('open-mr');
    expect(seams.applyConfigRepair).not.toHaveBeenCalled();
  });

  test.each([
    // autonomous-gated + local-config + gate green + evidence MISSING/NaN ⇒ open-mr
    ['undefined evidence', undefined],
    ['NaN evidence', Number.NaN],
  ])(
    'autonomy=autonomous-gated posture=local-config gate=green %s → open-mr (fail-closed)',
    async (_label, evidence) => {
      const seams = makeSeams({
        extractCandidates: vi.fn(() => [candidate({ evidence })]),
        classifyTarget: vi.fn(() => CLASSIFICATIONS['local-config']),
        runConfigValidationGate: vi.fn(async () => ({ ok: true })),
      });

      const result = await runRepairEngine(
        { repoRoot: REPO_ROOT, config: configFor('autonomous-gated'), learnings: [{}] },
        seams,
      );

      expect(result.outcomes[0].decision).toBe('open-mr');
    },
  );
});

describe('runRepairEngine — acceptance gherkins', () => {
  // G1: plugin-skill OR local-skill → open-mr (autonomy != off), NEVER autonomous-apply,
  // regardless of gate/evidence/autonomy variation.
  test.each([
    ['plugin-skill', 'advisory', true, 0.9],
    ['plugin-skill', 'autonomous-gated', false, 0.1],
    ['local-skill', 'advisory', false, 0.9],
    ['local-skill', 'autonomous-gated', true, 0.95],
  ])(
    'G1: %s under autonomy=%s gate=%s evidence=%s → open-mr, never autonomous-apply',
    async (classKey, autonomy, gateOk, evidence) => {
      const seams = makeSeams({
        extractCandidates: vi.fn(() => [candidate({ evidence })]),
        classifyTarget: vi.fn(() => CLASSIFICATIONS[classKey]),
        runConfigValidationGate: vi.fn(async () => ({ ok: gateOk })),
      });

      const result = await runRepairEngine(
        { repoRoot: REPO_ROOT, config: configFor(autonomy), learnings: [{}] },
        seams,
      );

      expect(result.outcomes[0].decision).toBe('open-mr');
      expect(result.summary).toEqual({
        autonomousApplied: 0,
        mrsOpened: 1,
        advisories: 0,
        blocked: 0,
        total: 1,
      });
      expect(seams.applyConfigRepair).not.toHaveBeenCalled();
    },
  );

  // G2: autonomous-gated + local-config + gate GREEN + evidence>=floor → autonomous-apply.
  // The apply + stamp seam invocations ARE the behaviour under test here.
  it('G2: autonomous-gated + local-config + gate green + evidence≥floor → autonomous-apply (applies + stamps)', async () => {
    const seams = makeSeams({
      extractCandidates: vi.fn(() => [candidate({ evidence: 0.9 })]),
      classifyTarget: vi.fn(() => CLASSIFICATIONS['local-config']),
      runConfigValidationGate: vi.fn(async () => ({ ok: true })),
    });

    const result = await runRepairEngine(
      { repoRoot: REPO_ROOT, config: configFor('autonomous-gated'), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(result.summary.autonomousApplied).toBe(1);
    expect(seams.applyConfigRepair).toHaveBeenCalledTimes(1);
    expect(seams.markProcessed).toHaveBeenCalledTimes(1);
    expect(seams.markProcessed).toHaveBeenCalledWith({ id: 'cand-1', repoRoot: REPO_ROOT });
  });

  // G3: autonomous-gated + local-config + gate FAIL → open-mr (no apply, no stamp).
  it('G3: autonomous-gated + local-config + gate fail → open-mr (no apply, no markProcessed)', async () => {
    const seams = makeSeams({
      extractCandidates: vi.fn(() => [candidate({ evidence: 0.9 })]),
      classifyTarget: vi.fn(() => CLASSIFICATIONS['local-config']),
      runConfigValidationGate: vi.fn(async () => ({ ok: false })),
    });

    const result = await runRepairEngine(
      { repoRoot: REPO_ROOT, config: configFor('autonomous-gated'), learnings: [{}] },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('open-mr');
    expect(result.summary.mrsOpened).toBe(1);
    expect(result.summary.autonomousApplied).toBe(0);
    expect(seams.applyConfigRepair).not.toHaveBeenCalled();
    expect(seams.markProcessed).not.toHaveBeenCalled();
  });

  // G4: autonomy off (default) → ALL outcomes advisory-only; NO mutating seam fires.
  it('G4: autonomy off → all advisory-only, no openRepairMr/applyConfigRepair/markProcessed', async () => {
    const seams = makeSeams({
      extractCandidates: vi.fn(() => [
        candidate({ id: 'cfg', target_path: 'CLAUDE.md', evidence: 0.99 }),
        candidate({ id: 'skill', target_path: 'skills/foo/SKILL.md', evidence: 0.99 }),
      ]),
      // classifier would return different postures, but autonomy off short-circuits anyway.
      classifyTarget: vi.fn((path) =>
        path === 'CLAUDE.md' ? CLASSIFICATIONS['local-config'] : CLASSIFICATIONS['plugin-skill'],
      ),
      runConfigValidationGate: vi.fn(async () => ({ ok: true })),
    });

    const result = await runRepairEngine(
      { repoRoot: REPO_ROOT, config: configFor('off'), learnings: [{}, {}] },
      seams,
    );

    expect(result.outcomes.map((o) => o.decision)).toEqual(['advisory-only', 'advisory-only']);
    expect(result.summary).toEqual({
      autonomousApplied: 0,
      mrsOpened: 0,
      advisories: 2,
      blocked: 0,
      total: 2,
    });
    expect(seams.openRepairMr).not.toHaveBeenCalled();
    expect(seams.applyConfigRepair).not.toHaveBeenCalled();
    expect(seams.markProcessed).not.toHaveBeenCalled();
  });
});

describe('runRepairEngine — invariants', () => {
  // autonomous-apply occurs ONLY in (autonomous-gated ∧ local-config ∧ green ∧ evidence≥floor).
  // Prove it never occurs for prose targets even with maximally-favourable gate+evidence.
  test.each([['plugin-skill'], ['local-skill'], ['unknown']])(
    'autonomous-apply NEVER occurs for %s even with gate green + evidence≥floor',
    async (classKey) => {
      const seams = makeSeams({
        extractCandidates: vi.fn(() => [candidate({ evidence: 1.0 })]),
        classifyTarget: vi.fn(() => CLASSIFICATIONS[classKey]),
        runConfigValidationGate: vi.fn(async () => ({ ok: true })),
      });

      const result = await runRepairEngine(
        { repoRoot: REPO_ROOT, config: configFor('autonomous-gated'), learnings: [{}] },
        seams,
      );

      expect(result.outcomes[0].decision).not.toBe('autonomous-apply');
      expect(result.summary.autonomousApplied).toBe(0);
    },
  );

  // Empty candidate set ⇒ outcomes:[], summary all-zero, mergeCandidates NOT called (no disk touch).
  it('empty candidate set → outcomes:[], summary all-zero, mergeCandidates not called', async () => {
    const seams = makeSeams({ extractCandidates: vi.fn(() => []) });

    const result = await runRepairEngine(
      { repoRoot: REPO_ROOT, config: configFor('autonomous-gated'), learnings: [] },
      seams,
    );

    expect(result.outcomes).toEqual([]);
    expect(result.summary).toEqual({
      autonomousApplied: 0,
      mrsOpened: 0,
      advisories: 0,
      blocked: 0,
      total: 0,
    });
    expect(seams.mergeCandidates).not.toHaveBeenCalled();
    expect(seams.classifyTarget).not.toHaveBeenCalled();
  });

  // dryRun:true on an R6-qualifying candidate → autonomous-apply with dry-run detail,
  // but applyConfigRepair + markProcessed NOT called (preview only).
  it('dryRun on R6-qualifying candidate → autonomous-apply (preview), no apply, no stamp', async () => {
    const seams = makeSeams({
      extractCandidates: vi.fn(() => [candidate({ evidence: 0.9 })]),
      classifyTarget: vi.fn(() => CLASSIFICATIONS['local-config']),
      runConfigValidationGate: vi.fn(async () => ({ ok: true })),
    });

    const result = await runRepairEngine(
      {
        repoRoot: REPO_ROOT,
        config: configFor('autonomous-gated'),
        learnings: [{}],
        dryRun: true,
      },
      seams,
    );

    expect(result.outcomes[0].decision).toBe('autonomous-apply');
    expect(result.outcomes[0].detail).toMatch(/dry-run|preview/i);
    expect(result.summary.autonomousApplied).toBe(1);
    expect(seams.applyConfigRepair).not.toHaveBeenCalled();
    expect(seams.markProcessed).not.toHaveBeenCalled();
  });
});

// Defensive: assert beforeEach mock hygiene is not relied upon for cross-test leakage —
// every test constructs fresh seams via makeSeams(), so there is no shared mutable state.
beforeEach(() => {
  vi.clearAllMocks();
});
