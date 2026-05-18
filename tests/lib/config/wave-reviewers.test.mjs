/**
 * wave-reviewers.test.mjs — Unit tests for scripts/lib/config/wave-reviewers.mjs
 *
 * Covers the 3-case backward-compat matrix (#461, #478):
 *   Case A: old key only  → returns value + deprecated: true (WARN emitted by caller)
 *   Case B: new key only  → returns value + deprecated: false (no WARN)
 *   Case C: both keys     → new key wins + deprecated: true (WARN emitted by caller)
 *
 * Also covers: defaults, enabled, reviewers parsing, mode parsing, CRLF, block boundary.
 *
 * NOTE: The actual stderr WARN emission is tested at the config.mjs level in
 * tests/lib/config/cross-repo.test.mjs (B.6 requirement — purity fix #478).
 */

import { describe, it, expect } from 'vitest';
import { _parseWaveReviewers } from '@lib/config/wave-reviewers.mjs';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('_parseWaveReviewers — defaults', () => {
  it('returns all defaults on empty string', () => {
    const result = _parseWaveReviewers('');
    expect(result).toEqual({ enabled: false, reviewers: [], mode: 'warn', deprecated: false });
  });

  it('returns all defaults when neither block is present', () => {
    const content = 'persistence: true\nvcs: gitlab\n';
    const result = _parseWaveReviewers(content);
    expect(result).toEqual({ enabled: false, reviewers: [], mode: 'warn', deprecated: false });
  });
});

// ---------------------------------------------------------------------------
// Backward-compat matrix (3 cases — the core of #461)
// ---------------------------------------------------------------------------

describe('_parseWaveReviewers — backward-compat matrix', () => {
  // Case A: old key only → value + deprecated: true
  it('Case A: old key only → returns value and deprecated: true', () => {
    const content = [
      'persona-reviewers:',
      '  enabled: true',
      '  reviewers: [architect-reviewer, qa-strategist]',
      '  mode: strict',
      '',
    ].join('\n');

    const result = _parseWaveReviewers(content);

    // Value is read from the old key
    expect(result.enabled).toBe(true);
    expect(result.reviewers).toEqual(['architect-reviewer', 'qa-strategist']);
    expect(result.mode).toBe('strict');

    // deprecated flag set — caller (config.mjs) emits the WARN
    expect(result.deprecated).toBe(true);
  });

  // Case B: new key only → value + deprecated: false
  it('Case B: new key only → returns value and deprecated: false', () => {
    const content = [
      'wave-reviewers:',
      '  enabled: true',
      '  reviewers: [analyst]',
      '  mode: warn',
      '',
    ].join('\n');

    const result = _parseWaveReviewers(content);

    expect(result.enabled).toBe(true);
    expect(result.reviewers).toEqual(['analyst']);
    expect(result.mode).toBe('warn');

    // No deprecation — flag is false
    expect(result.deprecated).toBe(false);
  });

  // Case C: both keys present → new key wins + deprecated: true
  it('Case C: both keys present → new key wins and deprecated: true', () => {
    const content = [
      'wave-reviewers:',
      '  enabled: true',
      '  reviewers: [architect-reviewer]',
      '  mode: strict',
      'persona-reviewers:',
      '  enabled: false',
      '  reviewers: [qa-strategist]',
      '  mode: off',
      '',
    ].join('\n');

    const result = _parseWaveReviewers(content);

    // New key wins
    expect(result.enabled).toBe(true);
    expect(result.reviewers).toEqual(['architect-reviewer']);
    expect(result.mode).toBe('strict');

    // Old key present → deprecated flag set
    expect(result.deprecated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

describe('_parseWaveReviewers — field parsing', () => {
  it('parses enabled: false explicitly', () => {
    const content = 'wave-reviewers:\n  enabled: false\n';
    expect(_parseWaveReviewers(content).enabled).toBe(false);
  });

  it('defaults enabled to false when absent from block', () => {
    const content = 'wave-reviewers:\n  mode: strict\n';
    expect(_parseWaveReviewers(content).enabled).toBe(false);
  });

  it('parses reviewers empty array []', () => {
    const content = 'wave-reviewers:\n  reviewers: []\n';
    expect(_parseWaveReviewers(content).reviewers).toEqual([]);
  });

  it('parses reviewers multi-value inline array', () => {
    const content = 'wave-reviewers:\n  reviewers: [architect-reviewer, qa-strategist, analyst]\n';
    expect(_parseWaveReviewers(content).reviewers).toEqual([
      'architect-reviewer',
      'qa-strategist',
      'analyst',
    ]);
  });

  it('parses mode: off', () => {
    const content = 'wave-reviewers:\n  mode: off\n';
    expect(_parseWaveReviewers(content).mode).toBe('off');
  });

  it('silently defaults mode to "warn" on invalid value', () => {
    const content = 'wave-reviewers:\n  mode: invalid-mode\n';
    expect(_parseWaveReviewers(content).mode).toBe('warn');
  });

  it('strips inline YAML comments', () => {
    const content = 'wave-reviewers:\n  enabled: true  # opt-in\n  mode: warn  # default\n';
    const result = _parseWaveReviewers(content);
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('warn');
  });

  it('handles CRLF line endings', () => {
    const content = 'wave-reviewers:\r\n  enabled: true\r\n  mode: strict\r\n';
    const result = _parseWaveReviewers(content);
    expect(result.enabled).toBe(true);
    expect(result.mode).toBe('strict');
  });
});

// ---------------------------------------------------------------------------
// Block boundary
// ---------------------------------------------------------------------------

describe('_parseWaveReviewers — block boundary', () => {
  it('stops parsing at next top-level key', () => {
    const content = [
      'wave-reviewers:',
      '  enabled: true',
      'other-section:',
      '  enabled: false',
      '',
    ].join('\n');
    expect(_parseWaveReviewers(content).enabled).toBe(true);
  });

  it('parses full block with all fields', () => {
    const content = [
      'wave-reviewers:',
      '  enabled: true',
      '  reviewers: [architect-reviewer, qa-strategist]',
      '  mode: strict',
      '',
    ].join('\n');
    expect(_parseWaveReviewers(content)).toEqual({
      enabled: true,
      reviewers: ['architect-reviewer', 'qa-strategist'],
      mode: 'strict',
      deprecated: false,
    });
  });
});
