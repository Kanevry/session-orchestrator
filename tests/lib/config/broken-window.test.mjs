/**
 * broken-window.test.mjs — Unit tests for scripts/lib/config/broken-window.mjs (#730/H5)
 *
 * Covers _parseBrokenWindow — tolerant top-level `broken-window-budget:` block parser:
 *   - absent block ⇒ defaults { enabled:false, due-days:7 }, no WARN
 *   - full explicit block (enabled + due-days)
 *   - enabled defaults false; only explicit "true" flips it on
 *   - due-days must be a positive integer; 0 / negative / non-numeric ⇒ fallback 7 + WARN
 *   - partial blocks (one key present, the other defaulted)
 *   - formatting tolerance (inline comments, next top-level key stops the scan)
 *
 * NOTE: no parseSessionConfig integration test — the `broken-window-budget:`
 * block is not yet surfaced by scripts/lib/config.mjs (the connection is owned
 * by that file's scope; see W2-C4 report). The direct-parser coverage below is
 * the full behavioural contract of this module.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { _parseBrokenWindow } from '@lib/config/broken-window.mjs';

// ---------------------------------------------------------------------------
// absent block
// ---------------------------------------------------------------------------

describe('_parseBrokenWindow — absent block', () => {
  it('returns the documented defaults when the block is completely absent', () => {
    expect(_parseBrokenWindow('')).toEqual({ enabled: false, 'due-days': 7 });
  });

  it('returns the documented defaults when only other blocks are present', () => {
    const content = ['persistence: true', 'vcs: gitlab', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
  });

  it('emits no stderr WARN when the block is absent', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    _parseBrokenWindow('persistence: true\n');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// full explicit block
// ---------------------------------------------------------------------------

describe('_parseBrokenWindow — full explicit block', () => {
  it('parses enabled: true and due-days: 14', () => {
    const content = ['broken-window-budget:', '  enabled: true', '  due-days: 14', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: true, 'due-days': 14 });
  });

  it('parses enabled: false explicitly', () => {
    const content = ['broken-window-budget:', '  enabled: false', '  due-days: 3', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 3 });
  });
});

// ---------------------------------------------------------------------------
// enabled parsing — default false, only "true" flips it
// ---------------------------------------------------------------------------

describe('_parseBrokenWindow — enabled parsing', () => {
  it('treats an uppercase TRUE the same as lowercase true', () => {
    const content = ['broken-window-budget:', '  enabled: TRUE', ''].join('\n');
    expect(_parseBrokenWindow(content).enabled).toBe(true);
  });

  it('leaves enabled false for any non-"true" value (e.g. yes)', () => {
    const content = ['broken-window-budget:', '  enabled: yes', ''].join('\n');
    expect(_parseBrokenWindow(content).enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// due-days must be a positive integer — malformed / 0 / negative ⇒ fallback + WARN
// ---------------------------------------------------------------------------

describe('_parseBrokenWindow — due-days validation falls back with a WARN', () => {
  let stderrCapture = [];

  const captureStderr = () => {
    stderrCapture = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrCapture.push(String(msg));
      return true;
    });
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to 7 for a non-numeric value', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: soon', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
  });

  it('emits a stderr WARN naming due-days for a non-numeric value', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: soon', ''].join('\n');
    _parseBrokenWindow(content);
    const warns = stderrCapture.filter((m) => m.includes('due-days'));
    expect(warns).toHaveLength(1);
  });

  it('falls back to 7 for 0 (a 0-day hard due-date is nonsensical)', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: 0', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
  });

  it('emits a stderr WARN for due-days: 0', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: 0', ''].join('\n');
    _parseBrokenWindow(content);
    const warns = stderrCapture.filter((m) => m.includes('due-days'));
    expect(warns).toHaveLength(1);
  });

  it('falls back to 7 for a negative value', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: -5', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
  });

  it('falls back to 7 for an empty value', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: ', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
  });
});

// ---------------------------------------------------------------------------
// partial blocks — one key present, the other defaulted
// ---------------------------------------------------------------------------

describe('_parseBrokenWindow — partial blocks', () => {
  it('applies only the enabled override when due-days is absent', () => {
    const content = ['broken-window-budget:', '  enabled: true', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: true, 'due-days': 7 });
  });

  it('applies only the due-days override when enabled is absent', () => {
    const content = ['broken-window-budget:', '  due-days: 30', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 30 });
  });
});

// ---------------------------------------------------------------------------
// formatting tolerance — stops at the next top-level key, strips inline comments
// ---------------------------------------------------------------------------

describe('_parseBrokenWindow — formatting tolerance', () => {
  it('stops scanning at the next top-level key', () => {
    const content = [
      'broken-window-budget:',
      '  enabled: true',
      'persistence: true',
      '',
    ].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: true, 'due-days': 7 });
  });

  it('strips inline comments from values', () => {
    const content = [
      'broken-window-budget:',
      '  due-days: 7                 # hard due-date horizon',
      '',
    ].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
  });
});
