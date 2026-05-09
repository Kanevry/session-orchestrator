/**
 * refactor-stability.test.mjs
 *
 * Adapter tests verifying that the public API of the 4 hotspot modules
 * (autopilot.mjs, state-md.mjs, mode-selector.mjs, learnings.mjs) remains
 * intact after the #358 submodule-split refactor performed by parallel W3
 * agents.
 *
 * Focus: import-shape integrity + one smoke call per re-exported symbol to
 * confirm functional routing works end-to-end. Detailed behavioral coverage
 * lives in the individual module test files.
 *
 * See: .claude/rules/test-quality.md "Dynamic Artifact Counts" for
 * floor/ceiling pattern used on KILL_SWITCHES key count.
 */

import { describe, it, expect } from 'vitest';

// ---------------------------------------------------------------------------
// autopilot.mjs — after #358 kill-switches split
// ---------------------------------------------------------------------------

describe('refactor-stability — autopilot.mjs public API after #358 split', () => {
  it('exports KILL_SWITCHES as a frozen object with expected key count', async () => {
    const mod = await import('../../scripts/lib/autopilot.mjs');
    expect(mod.KILL_SWITCHES).toBeDefined();
    expect(typeof mod.KILL_SWITCHES).toBe('object');
    expect(Object.isFrozen(mod.KILL_SWITCHES)).toBe(true);
    // Floor/ceiling per test-quality.md "Dynamic Artifact Counts" rule.
    // Current count: 9 (6 pre-iteration + 3 post-session). Allow growth to ~15
    // but catch accidental deletions below 8.
    const keys = Object.keys(mod.KILL_SWITCHES);
    expect(keys.length).toBeGreaterThanOrEqual(8);
    expect(keys.length).toBeLessThanOrEqual(15);
    // Spot-check a sample of specific keys to verify the re-export is live
    // (not a stale snapshot):
    expect(keys).toContain('TOKEN_BUDGET_EXCEEDED'); // newest kill-switch (#355)
    expect(keys).toContain('MAX_SESSIONS_REACHED');
    expect(keys).toContain('CARRYOVER_TOO_HIGH');
  });

  it('exports FLAG_BOUNDS as a frozen object with the 4 expected bound keys', async () => {
    const mod = await import('../../scripts/lib/autopilot.mjs');
    expect(mod.FLAG_BOUNDS).toBeDefined();
    expect(Object.isFrozen(mod.FLAG_BOUNDS)).toBe(true);
    expect(typeof mod.FLAG_BOUNDS.maxSessions).toBe('object');
    expect(typeof mod.FLAG_BOUNDS.maxHours).toBe('object');
    expect(typeof mod.FLAG_BOUNDS.confidenceThreshold).toBe('object');
    expect(typeof mod.FLAG_BOUNDS.maxTokens).toBe('object');
  });

  it('exports parseFlags as a function', async () => {
    const mod = await import('../../scripts/lib/autopilot.mjs');
    expect(typeof mod.parseFlags).toBe('function');
  });

  it('smoke: parseFlags([]) returns defaults from FLAG_BOUNDS', async () => {
    const mod = await import('../../scripts/lib/autopilot.mjs');
    const result = mod.parseFlags([]);
    expect(typeof result.maxSessions).toBe('number');
    expect(typeof result.maxHours).toBe('number');
    expect(typeof result.confidenceThreshold).toBe('number');
    expect(typeof result.dryRun).toBe('boolean');
    expect(result.maxSessions).toBe(mod.FLAG_BOUNDS.maxSessions.default);
    expect(result.maxHours).toBe(mod.FLAG_BOUNDS.maxHours.default);
    expect(result.dryRun).toBe(false);
  });

  it('exports runLoop as a function', async () => {
    const mod = await import('../../scripts/lib/autopilot.mjs');
    expect(typeof mod.runLoop).toBe('function');
  });

  it('exports telemetry re-exports: writeAutopilotJsonl, defaultRunId, readHostClass, finalizeState', async () => {
    const mod = await import('../../scripts/lib/autopilot.mjs');
    expect(typeof mod.writeAutopilotJsonl).toBe('function');
    expect(typeof mod.defaultRunId).toBe('function');
    expect(typeof mod.readHostClass).toBe('function');
    expect(typeof mod.finalizeState).toBe('function');
  });

  it('exports SCHEMA_VERSION as a number', async () => {
    const mod = await import('../../scripts/lib/autopilot.mjs');
    expect(typeof mod.SCHEMA_VERSION).toBe('number');
    expect(mod.SCHEMA_VERSION).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// state-md.mjs — after #358 recommendations submodule split
// ---------------------------------------------------------------------------

describe('refactor-stability — state-md.mjs public API after #358 split', () => {
  it('exports parseRecommendations (re-exported from state-md/recommendations.mjs)', async () => {
    const mod = await import('../../scripts/lib/state-md.mjs');
    expect(typeof mod.parseRecommendations).toBe('function');
  });

  it('smoke: parseRecommendations({}) returns null — no recommendation keys present', async () => {
    const mod = await import('../../scripts/lib/state-md.mjs');
    const result = mod.parseRecommendations({});
    expect(result).toBeNull();
  });

  it('smoke: parseRecommendations with a known key returns an object with mode/priorities/rationale fields', async () => {
    const mod = await import('../../scripts/lib/state-md.mjs');
    const result = mod.parseRecommendations({ 'recommended-mode': 'feature' });
    expect(result).not.toBeNull();
    expect(typeof result).toBe('object');
    expect(result.mode).toBe('feature');
    expect('priorities' in result).toBe(true);
    expect('carryoverRatio' in result).toBe(true);
    expect('completionRate' in result).toBe(true);
    expect('rationale' in result).toBe(true);
  });

  it('exports core state-md functions: parseStateMd, serializeStateMd, touchUpdatedField, updateFrontmatterFields', async () => {
    const mod = await import('../../scripts/lib/state-md.mjs');
    expect(typeof mod.parseStateMd).toBe('function');
    expect(typeof mod.serializeStateMd).toBe('function');
    expect(typeof mod.touchUpdatedField).toBe('function');
    expect(typeof mod.updateFrontmatterFields).toBe('function');
  });

  it('exports readCurrentTask, appendDeviation, parseMissionStatus, writeMissionStatus, setMissionStatus, readMissionStatus', async () => {
    const mod = await import('../../scripts/lib/state-md.mjs');
    expect(typeof mod.readCurrentTask).toBe('function');
    expect(typeof mod.appendDeviation).toBe('function');
    expect(typeof mod.parseMissionStatus).toBe('function');
    expect(typeof mod.writeMissionStatus).toBe('function');
    expect(typeof mod.setMissionStatus).toBe('function');
    expect(typeof mod.readMissionStatus).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// mode-selector.mjs — after #358 context-pressure submodule split
// ---------------------------------------------------------------------------

describe('refactor-stability — mode-selector.mjs public API after #358 split', () => {
  it('exports selectMode as a function', async () => {
    const mod = await import('../../scripts/lib/mode-selector.mjs');
    expect(typeof mod.selectMode).toBe('function');
  });

  it('exports computeContextPressure (re-exported from mode-selector/context-pressure.mjs)', async () => {
    const mod = await import('../../scripts/lib/mode-selector.mjs');
    expect(typeof mod.computeContextPressure).toBe('function');
  });

  it('smoke: selectMode(null) returns a Recommendation with required fields', async () => {
    const mod = await import('../../scripts/lib/mode-selector.mjs');
    const result = mod.selectMode(null);
    expect(typeof result).toBe('object');
    expect(typeof result.mode).toBe('string');
    expect(typeof result.rationale).toBe('string');
    expect(typeof result.confidence).toBe('number');
    expect(Array.isArray(result.alternatives)).toBe(true);
    expect(typeof result.context_pressure).toBe('object');
  });

  it('smoke: computeContextPressure({}) returns score/components/level', async () => {
    const mod = await import('../../scripts/lib/mode-selector.mjs');
    const result = mod.computeContextPressure({});
    expect(typeof result.score).toBe('number');
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(typeof result.level).toBe('string');
    expect(['low', 'medium', 'high']).toContain(result.level);
    expect(typeof result.components).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// learnings.mjs — after #358 io + filters submodule split
// ---------------------------------------------------------------------------

describe('refactor-stability — learnings.mjs public API after #358 split', () => {
  it('exports validateLearning and normalizeLearning as functions', async () => {
    const mod = await import('../../scripts/lib/learnings.mjs');
    expect(typeof mod.validateLearning).toBe('function');
    expect(typeof mod.normalizeLearning).toBe('function');
  });

  it('exports I/O re-exports: readLearnings, appendLearning, rewriteLearnings', async () => {
    const mod = await import('../../scripts/lib/learnings.mjs');
    expect(typeof mod.readLearnings).toBe('function');
    expect(typeof mod.appendLearning).toBe('function');
    expect(typeof mod.rewriteLearnings).toBe('function');
  });

  it('exports filter re-exports: filterByScope, filterByHostClass, filterByType', async () => {
    const mod = await import('../../scripts/lib/learnings.mjs');
    expect(typeof mod.filterByScope).toBe('function');
    expect(typeof mod.filterByHostClass).toBe('function');
    expect(typeof mod.filterByType).toBe('function');
  });

  it('exports ValidationError class', async () => {
    const mod = await import('../../scripts/lib/learnings.mjs');
    expect(typeof mod.ValidationError).toBe('function');
    const err = new mod.ValidationError('test');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('test');
  });

  it('smoke: validateLearning({}) throws ValidationError (missing required field: id)', async () => {
    const mod = await import('../../scripts/lib/learnings.mjs');
    expect(() => mod.validateLearning({})).toThrow(mod.ValidationError);
  });

  it('smoke: validateLearning(null) throws ValidationError', async () => {
    const mod = await import('../../scripts/lib/learnings.mjs');
    expect(() => mod.validateLearning(null)).toThrow(mod.ValidationError);
  });

  it('smoke: normalizeLearning returns object with scope/host_class/anonymized defaults', async () => {
    const mod = await import('../../scripts/lib/learnings.mjs');
    const input = { id: 'x', type: 'fragile-file', subject: 's', insight: 'i',
      evidence: 'e', confidence: 0.8, source_session: 'test', created_at: '2026-01-01T00:00:00Z',
      expires_at: '2026-06-01T00:00:00Z' };
    const result = mod.normalizeLearning(input);
    expect(result.scope).toBe('local');
    expect(result.host_class).toBeNull();
    expect(result.anonymized).toBe(false);
    expect(result.schema_version).toBe(0); // no schema_version in input → defaulted to 0
  });

  it('exports constants: VALID_SCOPES, CURRENT_SCHEMA_VERSION, LEARNING_TTL_DAYS', async () => {
    const mod = await import('../../scripts/lib/learnings.mjs');
    expect(Array.isArray(mod.VALID_SCOPES)).toBe(true);
    expect(mod.VALID_SCOPES).toContain('local');
    expect(mod.VALID_SCOPES).toContain('private');
    expect(mod.VALID_SCOPES).toContain('public');
    expect(typeof mod.CURRENT_SCHEMA_VERSION).toBe('number');
    expect(typeof mod.LEARNING_TTL_DAYS).toBe('object');
  });
});
