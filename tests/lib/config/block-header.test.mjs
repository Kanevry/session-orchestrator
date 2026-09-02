/**
 * block-header.test.mjs — Unit tests for scripts/lib/config/block-header.mjs (#830)
 *
 * Contract of the shared bold-tolerant block-header matcher:
 *   matchBlockHeader(line, key) — single-line boolean:
 *     MATCH  : `key:`, `- key:`, `**key:**`, `- **key:**` (each ± trailing ws);
 *              the two `**` markers are independently optional.
 *     NO MATCH: `key: value`, `key:  # comment`, `  key:` (indented), other keys.
 *     Regex-metacharacters in `key` are escaped defensively.
 *   hasBlockHeader(content, key) — multiline presence variant for whole-file
 *     PRESENCE guards; true when ANY line opens the block for `key`.
 *   matchBlockHeaderDetailed(line, key) — indent + inline-value variant (#1185):
 *     matches everything matchBlockHeader does PLUS an indented header and/or
 *     a header carrying an inline value; returns `{indent, value}` or `null`.
 *
 * Expected values are hardcoded literals — no regex is re-derived in the test
 * (testing.md anti-pattern #3 / #4 avoided). Behaviour, not implementation.
 */

import { describe, it, expect } from 'vitest';
import { matchBlockHeader, hasBlockHeader, matchBlockHeaderDetailed } from '@lib/config/block-header.mjs';

// ---------------------------------------------------------------------------
// matchBlockHeader — positives (the four accepted forms × trailing whitespace)
// ---------------------------------------------------------------------------

describe('matchBlockHeader — accepted header forms', () => {
  const key = 'eval';
  const positives = [
    'eval:', // plain
    '- eval:', // list-dash
    '**eval:**', // fully bold
    '- **eval:**', // bold-bullet (the #823/#830 rendering)
    'eval:   ', // plain + trailing spaces
    '- eval:  ', // dash + trailing spaces
    '**eval:**  ', // bold + trailing spaces
    '- **eval:**\t', // bold-bullet + trailing tab
    '**eval:', // bold-open only (independent markers)
    'eval:**', // bold-close only (independent markers)
  ];
  for (const line of positives) {
    it(`matches ${JSON.stringify(line)}`, () => {
      expect(matchBlockHeader(line, key)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// matchBlockHeader — negatives (LOAD-BEARING rejects)
// ---------------------------------------------------------------------------

describe('matchBlockHeader — rejected forms', () => {
  const key = 'eval';
  const negatives = [
    ['eval: value', 'header carrying a value is not a block-opener'],
    ['eval: true', 'a scalar value on the header line'],
    ['eval:  # opt-in harness', 'inline comment on the header line stays broken-by-design'],
    ['eval: {}', 'inline-object value'],
    ['  eval:', 'indented line is a sub-key, not a top-level header'],
    ['\teval:', 'tab-indented line'],
    ['evaluation:', 'a longer key that starts with the target'],
    ['xeval:', 'a key with a leading char'],
    ['eval', 'no colon'],
    ['', 'empty line'],
    ['# eval:', 'a markdown heading, not a block header'],
  ];
  for (const [line, why] of negatives) {
    it(`rejects ${JSON.stringify(line)} — ${why}`, () => {
      expect(matchBlockHeader(line, key)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// matchBlockHeader — multi-hyphen key + regex-metacharacter escaping
// ---------------------------------------------------------------------------

describe('matchBlockHeader — key handling', () => {
  it('matches a multi-hyphen key exactly', () => {
    expect(matchBlockHeader('broken-window-budget:', 'broken-window-budget')).toBe(true);
    expect(matchBlockHeader('- **broken-window-budget:**', 'broken-window-budget')).toBe(true);
  });

  it('does not match a different key', () => {
    expect(matchBlockHeader('vault-sync:', 'vault-integration')).toBe(false);
  });

  it('escapes a `.` in the key so it is a literal, not any-char', () => {
    // key 'a.b': the literal 'a.b:' matches; 'axb:' must NOT (the dot is escaped)
    expect(matchBlockHeader('a.b:', 'a.b')).toBe(true);
    expect(matchBlockHeader('axb:', 'a.b')).toBe(false);
  });

  it('escapes a `+` in the key so it is a literal, not a quantifier', () => {
    expect(matchBlockHeader('a+b:', 'a+b')).toBe(true);
    expect(matchBlockHeader('aaab:', 'a+b')).toBe(false);
  });

  it('returns false for a non-string line', () => {
    expect(matchBlockHeader(null, 'eval')).toBe(false);
    expect(matchBlockHeader(undefined, 'eval')).toBe(false);
    expect(matchBlockHeader(42, 'eval')).toBe(false);
  });

  it('returns false for an empty or non-string key', () => {
    expect(matchBlockHeader('eval:', '')).toBe(false);
    expect(matchBlockHeader('eval:', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hasBlockHeader — multiline presence
// ---------------------------------------------------------------------------

describe('hasBlockHeader — present', () => {
  it('finds a plain header among many lines', () => {
    const content = ['## Session Config', '', 'persistence: true', 'eval:', '  enabled: true', ''].join('\n');
    expect(hasBlockHeader(content, 'eval')).toBe(true);
  });

  it('finds the bold-bullet header form (#830)', () => {
    const content = ['intro', '- **dispatcher-autonomy:**', '  autonomy: off', ''].join('\n');
    expect(hasBlockHeader(content, 'dispatcher-autonomy')).toBe(true);
  });

  it('finds a header terminated by CRLF', () => {
    const content = 'foo\r\ndispatcher-autonomy:\r\n  autonomy: off\r\n';
    expect(hasBlockHeader(content, 'dispatcher-autonomy')).toBe(true);
  });

  it('finds a header carrying trailing whitespace', () => {
    const content = 'foo\ndispatcher-autonomy:   \n  autonomy: off\n';
    expect(hasBlockHeader(content, 'dispatcher-autonomy')).toBe(true);
  });
});

describe('hasBlockHeader — absent', () => {
  it('is false when only an indented sub-key of that name exists', () => {
    const content = ['other:', '  dispatcher-autonomy: nope', ''].join('\n');
    expect(hasBlockHeader(content, 'dispatcher-autonomy')).toBe(false);
  });

  it('is false when the header carries a value', () => {
    const content = ['dispatcher-autonomy: off', ''].join('\n');
    expect(hasBlockHeader(content, 'dispatcher-autonomy')).toBe(false);
  });

  it('is false when the header carries an inline comment', () => {
    const content = ['dispatcher-autonomy:  # migrated', '  autonomy: off', ''].join('\n');
    expect(hasBlockHeader(content, 'dispatcher-autonomy')).toBe(false);
  });

  it('is false on empty string', () => {
    expect(hasBlockHeader('', 'dispatcher-autonomy')).toBe(false);
  });

  it('is false on non-string content', () => {
    expect(hasBlockHeader(null, 'dispatcher-autonomy')).toBe(false);
    expect(hasBlockHeader(undefined, 'dispatcher-autonomy')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// matchBlockHeaderDetailed — indent + inline-value capture (#1185)
// ---------------------------------------------------------------------------

describe('matchBlockHeaderDetailed — inline value capture (matchBlockHeader cannot express this)', () => {
  it('captures an inline value on a header line — matchBlockHeader rejects this line entirely', () => {
    const line = 'health-endpoints: [{name: "API", url: "https://a/health"}]';
    expect(matchBlockHeaderDetailed(line, 'health-endpoints')).toEqual({
      indent: 0,
      value: '[{name: "API", url: "https://a/health"}]',
    });
    // The exact line matchBlockHeaderDetailed captures a value from is a
    // documented NO-MATCH for the plain matcher (module docblock).
    expect(matchBlockHeader(line, 'health-endpoints')).toBe(false);
  });

  it('reports value: null for a bare header — no value on the line', () => {
    expect(matchBlockHeaderDetailed('health-endpoints:', 'health-endpoints')).toEqual({
      indent: 0,
      value: null,
    });
  });

  it('reports value: null for a bare header with only trailing whitespace', () => {
    expect(matchBlockHeaderDetailed('health-endpoints:   ', 'health-endpoints')).toEqual({
      indent: 0,
      value: null,
    });
  });
});

describe('matchBlockHeaderDetailed — indentation distinguishes a nested header from a top-level one', () => {
  // indent: 0 is already pinned by "reports value: null for a bare header"
  // above (identical input, identical assertion) — not repeated here
  // (test-value.md TV-004). The exact indent width is reported distinctly,
  // never clamped to a boolean: the shape `ecosystem-health: / health-endpoints:`
  // nests at 2 spaces; 4 proves the width itself is carried, not just "nested".
  it.each([
    ['  health-endpoints:', 2],
    ['    health-endpoints:', 4],
  ])('the line %j reports indent: %i', (line, indent) => {
    expect(matchBlockHeaderDetailed(line, 'health-endpoints')).toEqual({ indent, value: null });
  });
});

describe('matchBlockHeaderDetailed — trailing inline comment behaves as before (#1174 HEADER_RE parity)', () => {
  // health-endpoints.mjs's pre-#1185 private HEADER_RE captured everything
  // after the colon RAW, with no comment-stripping — the shared matcher
  // reproduces that byte-for-byte so the migration is behaviour-preserving.
  it('captures a trailing comment as raw value text — no stripping', () => {
    expect(matchBlockHeaderDetailed('health-endpoints:  # note', 'health-endpoints')).toEqual({
      indent: 0,
      value: '# note',
    });
  });

  // Negative-lock precedent: tests/lib/config/bold-block-header-adoption.test.mjs
  // "negative-lock: inline comment on the header line yields all-defaults".
  // Introducing matchBlockHeaderDetailed must not loosen matchBlockHeader's own
  // contract for its 40 existing block-scanning callers.
  it('matchBlockHeader itself is untouched — still rejects a header with an inline comment', () => {
    expect(matchBlockHeader('eval:  # opt-in harness', 'eval')).toBe(false);
  });
});
