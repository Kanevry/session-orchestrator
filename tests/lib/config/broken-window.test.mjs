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
 * Plus a `parseSessionConfig integration` block (#730/H5 — the W2-C4 wiring
 * gap): scripts/lib/config.mjs now surfaces cfg['broken-window-budget']
 * end-to-end, exercised here against inline fixtures AND the committed repo
 * CLAUDE.md. The 3-line config.mjs wiring landed AFTER the C4 unit-suite, so
 * these integration cases are the guard that the parser is actually reachable.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { _parseBrokenWindow } from '@lib/config/broken-window.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

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

  it('emits a stderr WARN for a negative value', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: -5', ''].join('\n');
    _parseBrokenWindow(content);
    const warns = stderrCapture.filter((m) => m.includes('due-days'));
    expect(warns).toHaveLength(1);
  });

  it('falls back to 7 for an empty value', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: ', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
  });

  it('emits a stderr WARN for an empty value', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: ', ''].join('\n');
    _parseBrokenWindow(content);
    const warns = stderrCapture.filter((m) => m.includes('due-days'));
    expect(warns).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// due-days MAX-boundary — #794 GAP-4: a value with no upper bound reaches
// `computeDueDate` in spiral-carryover.mjs, where `Date#setUTCDate` overflows
// into an Invalid Date and `.toISOString()` throws a RangeError. The parser
// must reject values above MAX_DUE_DAYS (3650, ~10 years) before they ever
// leave this module.
// ---------------------------------------------------------------------------

describe('_parseBrokenWindow — due-days MAX-boundary (#794 GAP-4)', () => {
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

  it('falls back to 7 for a wildly out-of-range value (999999999)', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: 999999999', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
  });

  it('emits exactly one stderr WARN naming due-days for 999999999', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: 999999999', ''].join('\n');
    _parseBrokenWindow(content);
    const warns = stderrCapture.filter((m) => m.includes('due-days'));
    expect(warns).toHaveLength(1);
  });

  it('accepts the MAX boundary value (3650) with no WARN', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: 3650', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 3650 });
    expect(stderrCapture).toHaveLength(0);
  });

  it('falls back to 7 for one past the MAX boundary (3651)', () => {
    captureStderr();
    const content = ['broken-window-budget:', '  due-days: 3651', ''].join('\n');
    expect(_parseBrokenWindow(content)).toEqual({ enabled: false, 'due-days': 7 });
    const warns = stderrCapture.filter((m) => m.includes('due-days'));
    expect(warns).toHaveLength(1);
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

// ---------------------------------------------------------------------------
// parseSessionConfig integration (#730/H5 — the W2-C4 wiring gap)
//
// scripts/lib/config.mjs wires _parseBrokenWindow into parseSessionConfig →
// cfg['broken-window-budget']. These end-to-end cases guard the 3-line wiring
// that the C4 unit-suite predated. Falsification: delete the config.mjs wiring
// and cfg['broken-window-budget'] becomes undefined → every case below fails.
// ---------------------------------------------------------------------------

describe('parseSessionConfig integration (#730/H5)', () => {
  // Hermetic ctx (issue #783): the default hostPaths tier reads the REAL
  // owner.yaml on this host — injecting an empty ctx pins the COMMITTED default
  // values for these assertions (mirrors handover-gate.test.mjs § integration).
  const hermetic = { hostPaths: { env: {}, ownerConfig: undefined } };

  it('surfaces cfg["broken-window-budget"] with explicit enabled:true + due-days override', () => {
    const content = [
      '# Project',
      '',
      '## Session Config',
      '',
      'persistence: true',
      '',
      'broken-window-budget:',
      '  enabled: true',
      '  due-days: 14',
      '',
    ].join('\n');
    const config = parseSessionConfig(content, hermetic);
    expect(config['broken-window-budget']).toEqual({ enabled: true, 'due-days': 14 });
  });

  it('surfaces an explicit enabled:false with a non-default due-days', () => {
    const content = [
      '## Session Config',
      '',
      'persistence: true',
      '',
      'broken-window-budget:',
      '  enabled: false',
      '  due-days: 3',
      '',
    ].join('\n');
    const config = parseSessionConfig(content, hermetic);
    expect(config['broken-window-budget']).toEqual({ enabled: false, 'due-days': 3 });
  });

  it('defaults cfg["broken-window-budget"] to {enabled:false, due-days:7} when the block is absent', () => {
    const content = ['# Project', '', '## Session Config', '', 'persistence: true', ''].join('\n');
    const config = parseSessionConfig(content, hermetic);
    expect(config['broken-window-budget']).toEqual({ enabled: false, 'due-days': 7 });
  });

  it('the committed repo CLAUDE.md surfaces broken-window-budget as opt-in disabled (enabled:false)', () => {
    // readFileSync accepts a URL directly (Node) — three levels up from
    // tests/lib/config/ reaches the repo root.
    const claudeMd = readFileSync(new URL('../../../CLAUDE.md', import.meta.url), 'utf8');
    const config = parseSessionConfig(claudeMd, hermetic);
    expect(config['broken-window-budget'].enabled).toBe(false);
  });

  it('the committed repo CLAUDE.md pins due-days to the default 7-day horizon', () => {
    const claudeMd = readFileSync(new URL('../../../CLAUDE.md', import.meta.url), 'utf8');
    const config = parseSessionConfig(claudeMd, hermetic);
    expect(config['broken-window-budget']['due-days']).toBe(7);
  });
});
