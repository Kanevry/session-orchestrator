/**
 * evolve.test.mjs — Unit tests for scripts/lib/config/evolve.mjs
 *
 * Covers:
 *   _parseEvolve — PURE parser: absent block, empty extra-sources, full parse,
 *                  multiple sources, schema-gate drops (bad kind, bad learning-type,
 *                  bad/missing path), inline comments, CRLF, non-indented break.
 *   parseSessionConfig integration — the 'evolve.extra-sources' dotted key:
 *                  default [], full parse via the top-level reader.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { _parseEvolve, EVOLVE_EXTRA_SOURCE_DEFAULTS } from '@lib/config/evolve.mjs';
import { parseSessionConfig } from '@lib/config.mjs';

// A reusable well-formed entry block.
const FULL = [
  'evolve:',
  '  extra-sources:',
  '    - path: eval/learn/reports/latest.json',
  '      kind: regression-flags',
  '      learning-type: domain-regression',
  '',
].join('\n');

// ---------------------------------------------------------------------------
// _parseEvolve — absent / empty
// ---------------------------------------------------------------------------

describe('_parseEvolve — absent block', () => {
  it('returns [] when evolve: block is completely absent', () => {
    expect(_parseEvolve('')).toEqual([]);
  });

  it('returns [] when only other top-level blocks are present', () => {
    expect(_parseEvolve('persistence: true\nvcs: gitlab\n')).toEqual([]);
  });

  it('returns [] when evolve: block exists but has no extra-sources: key', () => {
    const content = ['evolve:', '  some-other-key: value', ''].join('\n');
    expect(_parseEvolve(content)).toEqual([]);
  });

  it('returns [] when extra-sources: is present but has no list items', () => {
    const content = ['evolve:', '  extra-sources:', ''].join('\n');
    expect(_parseEvolve(content)).toEqual([]);
  });

  it('returns [] when extra-sources: is an empty inline list', () => {
    const content = ['evolve:', '  extra-sources: []', ''].join('\n');
    expect(_parseEvolve(content)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// _parseEvolve — full parse + multiple sources
// ---------------------------------------------------------------------------

describe('_parseEvolve — full parse', () => {
  it('parses a single fully-specified extra-source', () => {
    expect(_parseEvolve(FULL)).toEqual([
      {
        path: 'eval/learn/reports/latest.json',
        kind: 'regression-flags',
        'learning-type': 'domain-regression',
      },
    ]);
  });

  it('parses multiple extra-sources into an array preserving order', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - path: a/first.json',
      '      kind: regression-flags',
      '      learning-type: domain-regression',
      '    - path: b/second.json',
      '      kind: regression-flags',
      '      learning-type: domain-regression',
      '',
    ].join('\n');
    expect(_parseEvolve(content)).toEqual([
      { path: 'a/first.json', kind: 'regression-flags', 'learning-type': 'domain-regression' },
      { path: 'b/second.json', kind: 'regression-flags', 'learning-type': 'domain-regression' },
    ]);
  });

  it('defaults kind and learning-type when only path is given', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - path: only-path.json',
      '',
    ].join('\n');
    expect(_parseEvolve(content)).toEqual([
      {
        path: 'only-path.json',
        kind: EVOLVE_EXTRA_SOURCE_DEFAULTS.kind,
        'learning-type': EVOLVE_EXTRA_SOURCE_DEFAULTS['learning-type'],
      },
    ]);
  });

  it('strips inline YAML comments from values', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - path: with/comment.json   # the sidecar',
      '      kind: regression-flags     # only value',
      '      learning-type: domain-regression',
      '',
    ].join('\n');
    expect(_parseEvolve(content)).toEqual([
      { path: 'with/comment.json', kind: 'regression-flags', 'learning-type': 'domain-regression' },
    ]);
  });

  it('handles CRLF line endings', () => {
    const content =
      'evolve:\r\n  extra-sources:\r\n    - path: crlf.json\r\n      kind: regression-flags\r\n      learning-type: domain-regression\r\n';
    expect(_parseEvolve(content)).toEqual([
      { path: 'crlf.json', kind: 'regression-flags', 'learning-type': 'domain-regression' },
    ]);
  });

  it('stops scanning at the next non-indented top-level key', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - path: inside.json',
      '      kind: regression-flags',
      '      learning-type: domain-regression',
      'persistence: true',
      '',
    ].join('\n');
    expect(_parseEvolve(content)).toEqual([
      { path: 'inside.json', kind: 'regression-flags', 'learning-type': 'domain-regression' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// _parseEvolve — schema-gate drops (with stderr WARN)
// ---------------------------------------------------------------------------

describe('_parseEvolve — schema-gate drops', () => {
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

  it('drops an entry missing required path, keeps a valid sibling', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - kind: regression-flags',
      '      learning-type: domain-regression',
      '    - path: good.json',
      '      kind: regression-flags',
      '      learning-type: domain-regression',
      '',
    ].join('\n');
    const result = _parseEvolve(content);
    expect(result).toEqual([
      { path: 'good.json', kind: 'regression-flags', 'learning-type': 'domain-regression' },
    ]);
    const warns = stderrCapture.filter((m) => m.includes('missing required field: path'));
    expect(warns).toHaveLength(1);
  });

  it('drops an entry whose path carries a shell metacharacter', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - path: bad$(whoami).json',
      '      kind: regression-flags',
      '      learning-type: domain-regression',
      '',
    ].join('\n');
    const result = _parseEvolve(content);
    expect(result).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes('shell metacharacter in path'));
    expect(warns).toHaveLength(1);
  });

  it('drops an entry with an unknown kind value', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - path: report.json',
      '      kind: bogus-kind',
      '      learning-type: domain-regression',
      '',
    ].join('\n');
    const result = _parseEvolve(content);
    expect(result).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes('unknown kind'));
    expect(warns).toHaveLength(1);
  });

  it('drops an entry with an unknown learning-type value', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - path: report.json',
      '      kind: regression-flags',
      '      learning-type: anti-pattern',
      '',
    ].join('\n');
    const result = _parseEvolve(content);
    expect(result).toEqual([]);
    const warns = stderrCapture.filter((m) => m.includes('unknown learning-type'));
    expect(warns).toHaveLength(1);
  });

  it('keeps only the valid entries from a mixed list', () => {
    const content = [
      'evolve:',
      '  extra-sources:',
      '    - path: ok.json',
      '      kind: regression-flags',
      '      learning-type: domain-regression',
      '    - path: badkind.json',
      '      kind: nope',
      '      learning-type: domain-regression',
      '    - kind: regression-flags',
      '      learning-type: domain-regression',
      '',
    ].join('\n');
    const result = _parseEvolve(content);
    expect(result).toEqual([
      { path: 'ok.json', kind: 'regression-flags', 'learning-type': 'domain-regression' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// parseSessionConfig integration — the dotted 'evolve.extra-sources' key
// ---------------------------------------------------------------------------

describe("parseSessionConfig — 'evolve.extra-sources' key (#638)", () => {
  it('defaults to [] when the evolve: block is absent', () => {
    const config = parseSessionConfig('## Session Config\n\npersistence: true\n');
    expect(config['evolve.extra-sources']).toEqual([]);
  });

  it('exposes evolve.extra-sources as a top-level key', () => {
    const config = parseSessionConfig('## Session Config\n\npersistence: true\n');
    expect(config).toHaveProperty('evolve.extra-sources');
  });

  it('parses a full evolve.extra-sources entry through parseSessionConfig', () => {
    const content = [
      '## Session Config',
      '',
      'evolve:',
      '  extra-sources:',
      '    - path: eval/learn/reports/latest.json',
      '      kind: regression-flags',
      '      learning-type: domain-regression',
      '',
    ].join('\n');
    const config = parseSessionConfig(content);
    expect(config['evolve.extra-sources']).toEqual([
      {
        path: 'eval/learn/reports/latest.json',
        kind: 'regression-flags',
        'learning-type': 'domain-regression',
      },
    ]);
  });
});
