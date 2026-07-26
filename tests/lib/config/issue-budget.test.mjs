/**
 * issue-budget.test.mjs — parser unit tests for the `issue-budget:` Session
 * Config block (scripts/lib/config/issue-budget.mjs).
 *
 * In-process only: every assertion calls the parser directly with literal
 * expected values — no CLI exit codes, no fixtures on disk.
 */

import { describe, it, expect } from 'vitest';
import { _parseIssueBudget } from '@lib/config/issue-budget.mjs';

const DEFAULTS = { 'max-per-session': 12, mode: 'strict', overflow: 'collect-issue' };

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
      mode: 'off',
      overflow: 'vault-note',
    });
  });

  it('is bold-bullet tolerant (shared matchBlockHeader, #830)', () => {
    const content = ['- **issue-budget:**', '  max-per-session: 4', '  mode: off', ''].join('\n');
    expect(_parseIssueBudget(content)).toEqual({
      'max-per-session': 4,
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
      mode: 'strict',
      overflow: 'collect-issue',
    });
  });
});
