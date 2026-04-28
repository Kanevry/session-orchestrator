/**
 * tests/lib/harness-audit/helpers.test.mjs
 *
 * Unit tests for pass()/fail() in
 * scripts/lib/harness-audit/categories/helpers.mjs (issue #227).
 *
 * Covers:
 *   - Options-object form (new preferred API)
 *   - Backward-compat positional form (shim)
 *   - One-time deprecation warning on first positional call
 *   - Correct output shape in both calling forms
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { pass, fail, _resetWarnFlags } from '../../../scripts/lib/harness-audit/categories/helpers.mjs';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  _resetWarnFlags();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// pass() — options-object form
// ---------------------------------------------------------------------------

describe('pass() — options-object form', () => {
  it('returns correct shape with all fields set', () => {
    const result = pass({
      checkId: 'state-md-present',
      points: 3,
      maxPoints: 3,
      path: '.claude/STATE.md',
      evidence: { hasYaml: true },
      message: 'STATE.md present and valid',
    });

    expect(result).toEqual({
      check_id: 'state-md-present',
      status: 'pass',
      points: 3,
      max_points: 3,
      path: '.claude/STATE.md',
      evidence: { hasYaml: true },
      message: 'STATE.md present and valid',
    });
  });

  it('status is always "pass"', () => {
    const result = pass({ checkId: 'x', points: 1, maxPoints: 2, path: 'p', evidence: {}, message: 'm' });
    expect(result.status).toBe('pass');
  });

  it('points matches the provided value', () => {
    const result = pass({ checkId: 'x', points: 5, maxPoints: 10, path: 'p', evidence: {}, message: 'm' });
    expect(result.points).toBe(5);
    expect(result.max_points).toBe(10);
  });

  it('does not emit a deprecation warning for options-object calls', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    pass({ checkId: 'x', points: 1, maxPoints: 1, path: 'p', evidence: {}, message: 'm' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// fail() — options-object form
// ---------------------------------------------------------------------------

describe('fail() — options-object form', () => {
  it('returns correct shape with all fields set', () => {
    const result = fail({
      checkId: 'sessions-jsonl-growth',
      maxPoints: 3,
      path: '.orchestrator/metrics/sessions.jsonl',
      evidence: { lineCount: 0, validLines: 0 },
      message: 'sessions.jsonl missing',
    });

    expect(result).toEqual({
      check_id: 'sessions-jsonl-growth',
      status: 'fail',
      points: 0,
      max_points: 3,
      path: '.orchestrator/metrics/sessions.jsonl',
      evidence: { lineCount: 0, validLines: 0 },
      message: 'sessions.jsonl missing',
    });
  });

  it('status is always "fail"', () => {
    const result = fail({ checkId: 'x', maxPoints: 2, path: 'p', evidence: {}, message: 'm' });
    expect(result.status).toBe('fail');
  });

  it('points is always 0', () => {
    const result = fail({ checkId: 'x', maxPoints: 5, path: 'p', evidence: {}, message: 'm' });
    expect(result.points).toBe(0);
    expect(result.max_points).toBe(5);
  });

  it('does not emit a deprecation warning for options-object calls', () => {
    const warnSpy = vi.spyOn(console, 'warn');
    fail({ checkId: 'x', maxPoints: 1, path: 'p', evidence: {}, message: 'm' });
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// pass() — backward-compat positional shim
// ---------------------------------------------------------------------------

describe('pass() — positional shim (backward compat)', () => {
  it('returns the same shape as the options-object form', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = pass('state-md-present', 3, 3, '.claude/STATE.md', { hasYaml: true }, 'STATE.md present');

    expect(result).toEqual({
      check_id: 'state-md-present',
      status: 'pass',
      points: 3,
      max_points: 3,
      path: '.claude/STATE.md',
      evidence: { hasYaml: true },
      message: 'STATE.md present',
    });
  });

  it('emits a deprecation warning on the first positional call', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pass('check-id', 1, 1, 'path', {}, 'message');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('emits the deprecation warning only once across multiple positional calls', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pass('c1', 1, 1, 'p', {}, 'm');
    pass('c2', 2, 2, 'p', {}, 'm');
    pass('c3', 3, 3, 'p', {}, 'm');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warning message mentions pass() and options-object form', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pass('x', 1, 1, 'p', {}, 'm');
    const [msg] = warnSpy.mock.calls[0];
    expect(msg).toContain('pass()');
    expect(msg).toContain('options-object');
  });
});

// ---------------------------------------------------------------------------
// fail() — backward-compat positional shim
// ---------------------------------------------------------------------------

describe('fail() — positional shim (backward compat)', () => {
  it('returns the same shape as the options-object form', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = fail('sessions-jsonl-growth', 3, '.orchestrator/metrics/sessions.jsonl', { lineCount: 0 }, 'missing');

    expect(result).toEqual({
      check_id: 'sessions-jsonl-growth',
      status: 'fail',
      points: 0,
      max_points: 3,
      path: '.orchestrator/metrics/sessions.jsonl',
      evidence: { lineCount: 0 },
      message: 'missing',
    });
  });

  it('emits a deprecation warning on the first positional call', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fail('check-id', 2, 'path', {}, 'message');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
  });

  it('emits the deprecation warning only once across multiple positional calls', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fail('c1', 1, 'p', {}, 'm');
    fail('c2', 2, 'p', {}, 'm');
    fail('c3', 3, 'p', {}, 'm');
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('warning message mentions fail() and options-object form', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fail('x', 1, 'p', {}, 'm');
    const [msg] = warnSpy.mock.calls[0];
    expect(msg).toContain('fail()');
    expect(msg).toContain('options-object');
  });
});

// ---------------------------------------------------------------------------
// Output shape unchanged — both forms produce identical structures
// ---------------------------------------------------------------------------

describe('output shape parity: options-object vs positional', () => {
  it('pass() options-object and positional produce identical output', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = pass({ checkId: 'c', points: 2, maxPoints: 4, path: 'x', evidence: { a: 1 }, message: 'ok' });
    const pos  = pass('c', 2, 4, 'x', { a: 1 }, 'ok');
    expect(opts).toEqual(pos);
  });

  it('fail() options-object and positional produce identical output', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = fail({ checkId: 'c', maxPoints: 4, path: 'x', evidence: { b: 2 }, message: 'bad' });
    const pos  = fail('c', 4, 'x', { b: 2 }, 'bad');
    expect(opts).toEqual(pos);
  });
});

// ---------------------------------------------------------------------------
// _resetWarnFlags — test isolation helper
// ---------------------------------------------------------------------------

describe('_resetWarnFlags()', () => {
  it('re-enables the deprecation warning after reset', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    pass('x', 1, 1, 'p', {}, 'm');
    expect(warnSpy).toHaveBeenCalledOnce();

    _resetWarnFlags();
    warnSpy.mockClear();

    pass('x', 1, 1, 'p', {}, 'm');
    expect(warnSpy).toHaveBeenCalledOnce();
  });
});
