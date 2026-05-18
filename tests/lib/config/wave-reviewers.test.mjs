/**
 * wave-reviewers.test.mjs — Unit tests for scripts/lib/config/wave-reviewers.mjs
 *
 * Covers the 3-case backward-compat matrix (#461):
 *   Case A: old key only  → returns value + emits exactly 1 WARN to stderr
 *   Case B: new key only  → returns value + emits NO WARN to stderr
 *   Case C: both keys     → new key wins + emits exactly 1 WARN to stderr
 *
 * Also covers: defaults, enabled, reviewers parsing, mode parsing, CRLF, block boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _parseWaveReviewers } from '@lib/config/wave-reviewers.mjs';

// ---------------------------------------------------------------------------
// Helpers to capture stderr writes emitted by the parser
// ---------------------------------------------------------------------------

let stderrCapture = [];

function captureStderr() {
  stderrCapture = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
    stderrCapture.push(String(msg));
    return true;
  });
}

function restoreStderr() {
  vi.restoreAllMocks();
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

describe('_parseWaveReviewers — defaults', () => {
  beforeEach(captureStderr);
  afterEach(restoreStderr);

  it('returns all defaults on empty string', () => {
    const result = _parseWaveReviewers('');
    expect(result).toEqual({ enabled: false, reviewers: [], mode: 'warn' });
    expect(stderrCapture).toHaveLength(0);
  });

  it('returns all defaults when neither block is present', () => {
    const content = 'persistence: true\nvcs: gitlab\n';
    const result = _parseWaveReviewers(content);
    expect(result).toEqual({ enabled: false, reviewers: [], mode: 'warn' });
    expect(stderrCapture).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Backward-compat matrix (3 cases — the core of #461)
// ---------------------------------------------------------------------------

describe('_parseWaveReviewers — backward-compat matrix', () => {
  beforeEach(captureStderr);
  afterEach(restoreStderr);

  // Case A: old key only → value + 1 WARN
  it('Case A: old key only → returns value and emits exactly 1 deprecation WARN', () => {
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

    // Exactly 1 WARN emitted
    const warns = stderrCapture.filter((m) => m.includes("'persona-reviewers' is deprecated"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('wave-reviewers');
    expect(warns[0]).toContain('v4.0');
  });

  // Case B: new key only → value + NO WARN
  it('Case B: new key only → returns value and emits NO deprecation WARN', () => {
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

    // Zero WARN emitted
    const warns = stderrCapture.filter((m) => m.includes("'persona-reviewers' is deprecated"));
    expect(warns).toHaveLength(0);
  });

  // Case C: both keys present → new key wins + 1 WARN
  it('Case C: both keys present → new key wins and emits exactly 1 WARN', () => {
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

    // Exactly 1 WARN emitted (old key present triggers it)
    const warns = stderrCapture.filter((m) => m.includes("'persona-reviewers' is deprecated"));
    expect(warns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Field parsing
// ---------------------------------------------------------------------------

describe('_parseWaveReviewers — field parsing', () => {
  beforeEach(captureStderr);
  afterEach(restoreStderr);

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
  beforeEach(captureStderr);
  afterEach(restoreStderr);

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
    });
  });
});
