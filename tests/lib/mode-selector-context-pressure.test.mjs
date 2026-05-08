/**
 * tests/lib/mode-selector-context-pressure.test.mjs
 *
 * Vitest suite for computeContextPressure() in scripts/lib/mode-selector.mjs
 * (issue #332 — context-pressure signal).
 *
 * Covers: empty signals, scope component (low / clamped), keyword detection,
 * carryover derivation (ratio 0.5, clamped at 0.25), combined high-pressure
 * scenario, and score range invariant.
 */

import { describe, it, expect } from 'vitest';
import { computeContextPressure } from '../../scripts/lib/mode-selector.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build an array of N recent-session objects where each has the given
 * carryover / planned_issues ratio.
 *
 * @param {number} count
 * @param {{ carryover: number, planned_issues: number }} effectiveness
 */
function sessions(count, effectiveness) {
  return Array.from({ length: count }, () => ({ effectiveness }));
}

// ---------------------------------------------------------------------------
// computeContextPressure
// ---------------------------------------------------------------------------

describe('computeContextPressure', () => {
  it('empty signals object → score=0, level=low, all components are 0', () => {
    const result = computeContextPressure({});

    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
    expect(result.components.scope).toBe(0);
    expect(result.components.keywords).toBe(0);
    expect(result.components.carryover).toBe(0);
  });

  it('2 priorities, no keywords, no carryover → score=0, level=low', () => {
    const result = computeContextPressure({ topPriorities: [1, 2] });

    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
  });

  it('8 priorities → scope=0.5, score=0.5, level=medium', () => {
    const result = computeContextPressure({
      topPriorities: [1, 2, 3, 4, 5, 6, 7, 8],
    });

    expect(result.components.scope).toBe(0.5);
    expect(result.score).toBe(0.5);
    expect(result.level).toBe('medium');
  });

  it('13 priorities → scope clamped at 0.5 (does not exceed 0.5)', () => {
    const result = computeContextPressure({
      topPriorities: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
    });

    expect(result.components.scope).toBe(0.5);
  });

  it('task description contains "across all skills" → keywords=0.25', () => {
    const result = computeContextPressure({
      taskDescriptionText: 'refactor across all skills in the plugin',
    });

    expect(result.components.keywords).toBe(0.25);
    expect(result.score).toBe(0.25);
  });

  it('task description contains "rename across" → keywords=0.25', () => {
    const result = computeContextPressure({
      taskDescriptionText: 'rename across all modules to follow the new convention',
    });

    expect(result.components.keywords).toBe(0.25);
    expect(result.score).toBe(0.25);
  });

  it('carryover ratio 0.5 per session → carryover component=0.2, score=0.2', () => {
    // effectiveness.carryover / effectiveness.planned_issues = 2/4 = 0.5
    // mean over 5 sessions = 0.5; component = 0.5 - 0.3 = 0.2
    const result = computeContextPressure({
      recentSessions: sessions(5, { carryover: 2, planned_issues: 4 }),
    });

    expect(result.components.carryover).toBe(0.2);
    expect(result.score).toBe(0.2);
  });

  it('carryover ratio 0.55 per session → carryover component clamped at 0.25', () => {
    // effectiveness.carryover / effectiveness.planned_issues = 11/20 = 0.55
    // component = 0.55 - 0.3 = 0.25 (at the ceiling)
    const result = computeContextPressure({
      recentSessions: sessions(5, { carryover: 11, planned_issues: 20 }),
    });

    expect(result.components.carryover).toBe(0.25);
  });

  it('combined: 8 priorities + "rename across" keyword + carryover ratio 0.4 → score=0.85, level=high', () => {
    // scope = (8-3)/10 = 0.5
    // keywords = 0.25
    // carryover = 2/5 = 0.4; component = 0.4-0.3 = 0.1
    // total = 0.5 + 0.25 + 0.1 = 0.85
    const result = computeContextPressure({
      topPriorities: [1, 2, 3, 4, 5, 6, 7, 8],
      taskDescriptionText: 'rename across all repos to match the new schema',
      recentSessions: sessions(5, { carryover: 2, planned_issues: 5 }),
    });

    expect(result.score).toBe(0.85);
    expect(result.level).toBe('high');
    expect(result.components.scope).toBe(0.5);
    expect(result.components.keywords).toBe(0.25);
    expect(result.components.carryover).toBe(0.1);
  });

  it('score is always in [0, 1] under extreme inputs', () => {
    // Extremely large priority list + keyword + perfect carryover
    const result = computeContextPressure({
      topPriorities: Array.from({ length: 100 }, (_, i) => i),
      taskDescriptionText: 'massive refactor every skill every agent repo-wide',
      recentSessions: sessions(5, { carryover: 1, planned_issues: 1 }),
    });

    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('null signals → score=0, level=low, all components are 0', () => {
    const result = computeContextPressure(null);

    expect(result.score).toBe(0);
    expect(result.level).toBe('low');
    expect(result.components.scope).toBe(0);
    expect(result.components.keywords).toBe(0);
    expect(result.components.carryover).toBe(0);
  });

  it('carryover ratio at the 0.3 boundary (exactly 0.3) → carryover component=0', () => {
    // 3/10 = 0.3; component = 0.3 - 0.3 = 0 (no contribution at exact boundary)
    const result = computeContextPressure({
      recentSessions: sessions(5, { carryover: 3, planned_issues: 10 }),
    });

    expect(result.components.carryover).toBe(0);
    expect(result.score).toBe(0);
  });

  it('result always has exactly the expected shape: score, components, level', () => {
    const result = computeContextPressure({ topPriorities: [1, 2, 3] });

    expect(Object.keys(result).sort()).toEqual(['components', 'level', 'score']);
    expect(Object.keys(result.components).sort()).toEqual(['carryover', 'keywords', 'scope']);
  });
});
