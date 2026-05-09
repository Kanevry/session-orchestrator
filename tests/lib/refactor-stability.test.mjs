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

// ---------------------------------------------------------------------------
// session-schema.mjs — after W2 fresh split
// ---------------------------------------------------------------------------

describe('refactor-stability — session-schema.mjs public API after W2 split', () => {
  it('exports all 7 expected symbols', async () => {
    const mod = await import('../../scripts/lib/session-schema.mjs');
    expect(mod.ValidationError).toBeDefined();
    expect(mod.CURRENT_SESSION_SCHEMA_VERSION).toBeDefined();
    expect(mod.SESSION_KEY_ALIASES).toBeDefined();
    expect(mod.validateSession).toBeDefined();
    expect(mod.normalizeSession).toBeDefined();
    expect(mod.clampTimestampsMonotonic).toBeDefined();
    expect(mod.aliasLegacyEndedAt).toBeDefined();
  });

  it('CURRENT_SESSION_SCHEMA_VERSION === 1', async () => {
    const mod = await import('../../scripts/lib/session-schema.mjs');
    expect(mod.CURRENT_SESSION_SCHEMA_VERSION).toBe(1);
  });

  it('SESSION_KEY_ALIASES is frozen with key count in range [1, 50]', async () => {
    const mod = await import('../../scripts/lib/session-schema.mjs');
    expect(Object.isFrozen(mod.SESSION_KEY_ALIASES)).toBe(true);
    // Floor/ceiling per test-quality.md "Dynamic Artifact Counts" rule.
    // Current count: 11 safe-rename aliases. Allow growth but catch empty export.
    const keyCount = Object.keys(mod.SESSION_KEY_ALIASES).length;
    expect(keyCount).toBeGreaterThanOrEqual(1);
    expect(keyCount).toBeLessThanOrEqual(50);
  });

  it('ValidationError is a class; instances have the correct name and inherit Error', async () => {
    const mod = await import('../../scripts/lib/session-schema.mjs');
    expect(typeof mod.ValidationError).toBe('function');
    const err = new mod.ValidationError('test message');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ValidationError');
    expect(err.message).toBe('test message');
  });

  it('smoke: validateSession({}) throws ValidationError (missing required field)', async () => {
    const mod = await import('../../scripts/lib/session-schema.mjs');
    expect(() => mod.validateSession({})).toThrow(mod.ValidationError);
  });

  it('smoke: normalizeSession({}) returns an object (never throws)', async () => {
    const mod = await import('../../scripts/lib/session-schema.mjs');
    const result = mod.normalizeSession({});
    expect(typeof result).toBe('object');
    // schema_version tagged as 0 for records without it (legacy sentinel)
    expect(result.schema_version).toBe(0);
  });

  it('smoke: clampTimestampsMonotonic is a function that returns unchanged entry when timestamps are valid', async () => {
    const mod = await import('../../scripts/lib/session-schema.mjs');
    expect(typeof mod.clampTimestampsMonotonic).toBe('function');
    const entry = { started_at: '2026-01-01T00:00:00Z', completed_at: '2026-01-01T01:00:00Z' };
    const result = mod.clampTimestampsMonotonic(entry);
    // No inversion — should be returned unchanged
    expect(result.completed_at).toBe('2026-01-01T01:00:00Z');
    expect(result._clamped).toBeUndefined();
  });

  it('smoke: aliasLegacyEndedAt is a function that aliases ended_at to completed_at', async () => {
    const mod = await import('../../scripts/lib/session-schema.mjs');
    expect(typeof mod.aliasLegacyEndedAt).toBe('function');
    const entry = { started_at: '2026-01-01T00:00:00Z', ended_at: '2026-01-01T01:00:00Z' };
    const result = mod.aliasLegacyEndedAt(entry);
    expect(result.completed_at).toBe('2026-01-01T01:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// owner-config.mjs — after W2 fresh split
// ---------------------------------------------------------------------------

describe('refactor-stability — owner-config.mjs public API after W2 split', () => {
  it('exports all 10 expected symbols', async () => {
    const mod = await import('../../scripts/lib/owner-config.mjs');
    expect(mod.CURRENT_OWNER_SCHEMA_VERSION).toBeDefined();
    expect(mod.VALID_TONE_STYLES).toBeDefined();
    expect(mod.VALID_OUTPUT_LEVELS).toBeDefined();
    expect(mod.VALID_PREAMBLE_LEVELS).toBeDefined();
    expect(mod.VALID_COMMENTS_LEVELS).toBeDefined();
    expect(mod.OwnerConfigError).toBeDefined();
    expect(mod.defaults).toBeDefined();
    expect(mod.validate).toBeDefined();
    expect(mod.coerce).toBeDefined();
    expect(mod.merge).toBeDefined();
  });

  it('CURRENT_OWNER_SCHEMA_VERSION === 1', async () => {
    const mod = await import('../../scripts/lib/owner-config.mjs');
    expect(mod.CURRENT_OWNER_SCHEMA_VERSION).toBe(1);
  });

  it('all VALID_* arrays are frozen with expected member counts', async () => {
    const mod = await import('../../scripts/lib/owner-config.mjs');
    // Floor/ceiling per test-quality.md "Dynamic Artifact Counts" rule.
    expect(Object.isFrozen(mod.VALID_TONE_STYLES)).toBe(true);
    expect(mod.VALID_TONE_STYLES.length).toBeGreaterThanOrEqual(2);
    expect(mod.VALID_TONE_STYLES.length).toBeLessThanOrEqual(10);

    expect(Object.isFrozen(mod.VALID_OUTPUT_LEVELS)).toBe(true);
    expect(mod.VALID_OUTPUT_LEVELS.length).toBeGreaterThanOrEqual(2);
    expect(mod.VALID_OUTPUT_LEVELS.length).toBeLessThanOrEqual(10);

    expect(Object.isFrozen(mod.VALID_PREAMBLE_LEVELS)).toBe(true);
    expect(mod.VALID_PREAMBLE_LEVELS.length).toBeGreaterThanOrEqual(2);
    expect(mod.VALID_PREAMBLE_LEVELS.length).toBeLessThanOrEqual(10);

    expect(Object.isFrozen(mod.VALID_COMMENTS_LEVELS)).toBe(true);
    expect(mod.VALID_COMMENTS_LEVELS.length).toBeGreaterThanOrEqual(1);
    expect(mod.VALID_COMMENTS_LEVELS.length).toBeLessThanOrEqual(10);
  });

  it('OwnerConfigError is a class extending Error with .errors array', async () => {
    const mod = await import('../../scripts/lib/owner-config.mjs');
    expect(typeof mod.OwnerConfigError).toBe('function');
    const err = new mod.OwnerConfigError('bad config', ['field A is missing']);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('OwnerConfigError');
    expect(Array.isArray(err.errors)).toBe(true);
    expect(err.errors).toContain('field A is missing');
  });

  it('smoke: defaults() returns object with schema-version field equal to CURRENT_OWNER_SCHEMA_VERSION', async () => {
    const mod = await import('../../scripts/lib/owner-config.mjs');
    expect(typeof mod.defaults).toBe('function');
    const d = mod.defaults();
    expect(typeof d).toBe('object');
    expect(d['schema-version']).toBe(mod.CURRENT_OWNER_SCHEMA_VERSION);
  });

  it('smoke: validate({}) returns {ok: false, errors: [...], value: null}', async () => {
    const mod = await import('../../scripts/lib/owner-config.mjs');
    expect(typeof mod.validate).toBe('function');
    const result = mod.validate({});
    expect(result.ok).toBe(false);
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.value).toBeNull();
  });

  it('smoke: coerce({}) throws OwnerConfigError', async () => {
    const mod = await import('../../scripts/lib/owner-config.mjs');
    expect(typeof mod.coerce).toBe('function');
    expect(() => mod.coerce({})).toThrow(mod.OwnerConfigError);
  });

  it('smoke: merge(null, null) returns a default-filled object', async () => {
    const mod = await import('../../scripts/lib/owner-config.mjs');
    expect(typeof mod.merge).toBe('function');
    const result = mod.merge(null, null);
    expect(typeof result).toBe('object');
    expect(result['schema-version']).toBe(mod.CURRENT_OWNER_SCHEMA_VERSION);
    expect(typeof result.owner).toBe('object');
    expect(typeof result.tone).toBe('object');
    expect(typeof result.efficiency).toBe('object');
  });
});

// ---------------------------------------------------------------------------
// worktree.mjs — after W2 fresh split
// ---------------------------------------------------------------------------

describe('refactor-stability — worktree.mjs public API after W2 split', () => {
  it('exports all 7 expected symbols', async () => {
    const mod = await import('../../scripts/lib/worktree.mjs');
    expect(mod.WORKTREE_META_DIR).toBeDefined();
    expect(mod.metaPathFor).toBeDefined();
    expect(mod.applyWorktreeExcludes).toBeDefined();
    expect(mod.cleanupAllWorktrees).toBeDefined();
    expect(mod.createWorktree).toBeDefined();
    expect(mod.listWorktrees).toBeDefined();
    expect(mod.removeWorktree).toBeDefined();
  });

  it('WORKTREE_META_DIR is a string ending with the expected segment', async () => {
    const mod = await import('../../scripts/lib/worktree.mjs');
    expect(typeof mod.WORKTREE_META_DIR).toBe('string');
    // The canonical path ends with 'worktree-meta' — catch accidental renames.
    expect(mod.WORKTREE_META_DIR.endsWith('worktree-meta')).toBe(true);
  });

  it('metaPathFor is a function; returns a string containing the given suffix', async () => {
    const mod = await import('../../scripts/lib/worktree.mjs');
    expect(typeof mod.metaPathFor).toBe('function');
    const result = mod.metaPathFor('test-suffix');
    expect(typeof result).toBe('string');
    expect(result).toContain('test-suffix');
  });

  it('all async lifecycle functions are present and typeof === "function"', async () => {
    const mod = await import('../../scripts/lib/worktree.mjs');
    // Do NOT call createWorktree/cleanupAllWorktrees — they touch git.
    expect(typeof mod.createWorktree).toBe('function');
    expect(typeof mod.removeWorktree).toBe('function');
    expect(typeof mod.cleanupAllWorktrees).toBe('function');
  });

  it('applyWorktreeExcludes is a function', async () => {
    const mod = await import('../../scripts/lib/worktree.mjs');
    expect(typeof mod.applyWorktreeExcludes).toBe('function');
  });

  it('listWorktrees is a function', async () => {
    const mod = await import('../../scripts/lib/worktree.mjs');
    expect(typeof mod.listWorktrees).toBe('function');
  });
});
