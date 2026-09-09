/**
 * issue-budget.test.mjs — parser unit tests for the `issue-budget:` Session
 * Config block (scripts/lib/config/issue-budget.mjs).
 *
 * In-process only: every assertion calls the parser directly with literal
 * expected values — no CLI exit codes, no fixtures on disk.
 */

import { describe, it, expect } from 'vitest';
import { _parseIssueBudget } from '@lib/config/issue-budget.mjs';

const DEFAULTS = {
  'max-per-session': 12,
  'max-per-session-raw': 12,
  mode: 'strict',
  overflow: 'collect-issue',
};

describe('_parseIssueBudget — defaults', () => {
  it('returns defaults when the block is absent', () => {
    expect(_parseIssueBudget('## Session Config\n\nwaves: 5\n')).toEqual(DEFAULTS);
  });

  it('returns defaults for empty / non-string input', () => {
    expect(_parseIssueBudget('')).toEqual(DEFAULTS);
    expect(_parseIssueBudget(null)).toEqual(DEFAULTS);
  });

  it('returns defaults when the block header exists but has no recognised keys', () => {
    expect(_parseIssueBudget('issue-budget:\n  bogus: 1\n')).toEqual(DEFAULTS);
  });
});

describe('_parseIssueBudget — explicit values', () => {
  it('parses all three fields', () => {
    const content = [
      '## Session Config',
      '',
      'issue-budget:',
      '  max-per-session: 3',
      '  mode: warn',
      '  overflow: vault-note',
      '',
    ].join('\n');
    expect(_parseIssueBudget(content)).toEqual({
      'max-per-session': 3,
      'max-per-session-raw': 3,
      mode: 'warn',
      overflow: 'vault-note',
    });
  });

  it('accepts 0 as a valid max-per-session (blocks every non-exempt creation)', () => {
    expect(_parseIssueBudget('issue-budget:\n  max-per-session: 0\n')['max-per-session']).toBe(0);
  });

  it('strips inline comments and quotes', () => {
    const content = [
      'issue-budget:',
      '  max-per-session: 25   # raised for a backlog-import session',
      '  mode: "off"',
      "  overflow: 'vault-note'",
      '',
    ].join('\n');
    expect(_parseIssueBudget(content)).toEqual({
      'max-per-session': 25,
      'max-per-session-raw': 25,
      mode: 'off',
      overflow: 'vault-note',
    });
  });

  it('is bold-bullet tolerant (shared matchBlockHeader, #830)', () => {
    const content = ['- **issue-budget:**', '  max-per-session: 4', '  mode: off', ''].join('\n');
    expect(_parseIssueBudget(content)).toEqual({
      'max-per-session': 4,
      'max-per-session-raw': 4,
      mode: 'off',
      overflow: 'collect-issue',
    });
  });

  it('negative-lock: an inline comment on the HEADER line yields all-defaults', () => {
    const content = ['issue-budget:  # cap', '  max-per-session: 4', '  mode: off', ''].join('\n');
    expect(_parseIssueBudget(content)).toEqual(DEFAULTS);
  });
});

describe('_parseIssueBudget — malformed values fall back silently', () => {
  it('falls back on a non-numeric max-per-session', () => {
    expect(_parseIssueBudget('issue-budget:\n  max-per-session: many\n')['max-per-session']).toBe(12);
  });

  it('falls back on a negative max-per-session', () => {
    expect(_parseIssueBudget('issue-budget:\n  max-per-session: -5\n')['max-per-session']).toBe(12);
  });

  it('falls back on an unknown mode', () => {
    expect(_parseIssueBudget('issue-budget:\n  mode: hard\n').mode).toBe('strict');
  });

  it('falls back on an unknown overflow sink', () => {
    expect(_parseIssueBudget('issue-budget:\n  overflow: /dev/null\n').overflow).toBe('collect-issue');
  });
});

describe('_parseIssueBudget — block boundaries', () => {
  it('stops at the next column-0 key', () => {
    const content = [
      'issue-budget:',
      '  max-per-session: 2',
      'handover-gate:',
      '  max-open-questions: 9',
      '',
    ].join('\n');
    expect(_parseIssueBudget(content)).toEqual({
      'max-per-session': 2,
      'max-per-session-raw': 2,
      mode: 'strict',
      overflow: 'collect-issue',
    });
  });
});

// ---------------------------------------------------------------------------
// Per-session-type override syntax (`12 (feature: 6)`)
// ---------------------------------------------------------------------------
//
// TV-001 bug this catches: without the numeric/raw split, the parsed override
// OBJECT reaches `chargeIssueBudget`'s `state.count < max` comparison and the
// block message, where it surfaces as `[object Object]` — a cap that can never
// be reached, i.e. the gate silently off.
describe('_parseIssueBudget — per-session-type override', () => {
  it('parses `12 (feature: 6)` into default 12 + feature 6 with a NUMERIC max-per-session', () => {
    const parsed = _parseIssueBudget('issue-budget:\n  max-per-session: 12 (feature: 6)\n');
    expect(parsed['max-per-session']).toBe(12);
    expect(typeof parsed['max-per-session']).toBe('number');
    expect(parsed['max-per-session-raw']).toEqual({ default: 12, feature: 6 });
  });

  it('parses several overrides in one value', () => {
    const parsed = _parseIssueBudget(
      'issue-budget:\n  max-per-session: 12 (feature: 6, housekeeping: 3)\n',
    );
    expect(parsed['max-per-session-raw']).toEqual({ default: 12, feature: 6, housekeeping: 3 });
  });

  it('keeps a plain integer numeric on BOTH keys', () => {
    const parsed = _parseIssueBudget('issue-budget:\n  max-per-session: 12\n');
    expect(parsed['max-per-session']).toBe(12);
    expect(parsed['max-per-session-raw']).toBe(12);
  });

  // THE BUG (TV-001): `catch { break }` discarded the WHOLE value, so the
  // built-in 12 won — an operator who wrote a STRICTER cap got the stock cap
  // back from one typo in the override. The old fixture used `12 (feature: x)`,
  // where the fallback and the intended value are the same number, so the
  // assertion could not tell the two apart. 7 can.
  it('a malformed override does not silently restore the stock cap: 7 (feature: x) yields 7, never 12', () => {
    const parsed = _parseIssueBudget('issue-budget:\n  max-per-session: 7 (feature: x)\n');
    expect(parsed['max-per-session']).toBe(7);
    expect(parsed['max-per-session-raw']).toBe(7);
  });

  it('warns on stderr naming the key when it drops a malformed override', () => {
    const errs = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk) => { errs.push(String(chunk)); return true; };
    try {
      _parseIssueBudget('issue-budget:\n  max-per-session: 7 (feature: x)\n');
    } finally {
      process.stderr.write = orig;
    }
    expect(errs.join('')).toContain('max-per-session');
  });

  it('a malformed value with NO valid base still falls back to 12, silently', () => {
    const errs = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk) => { errs.push(String(chunk)); return true; };
    let parsed;
    try {
      parsed = _parseIssueBudget('issue-budget:\n  max-per-session: many\n');
    } finally {
      process.stderr.write = orig;
    }
    expect(parsed['max-per-session']).toBe(12);
    expect(errs.join('')).toBe('');
  });
});
