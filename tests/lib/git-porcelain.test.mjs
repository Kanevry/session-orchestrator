/**
 * tests/lib/git-porcelain.test.mjs
 *
 * Unit tests for the shared `git status --porcelain -z` parser extracted from
 * quality-gate.mjs (GitLab #1355). Only the cases that are NOT already covered
 * by a consumer suite live here: the malformed-entry drop, the R/C
 * double-field consumption, and empty input. The behaviour of the three
 * consumers themselves stays pinned by their own suites.
 */

import { describe, it, expect } from 'vitest';

import { parsePorcelainEntries, parsePorcelainZ } from '@lib/git-porcelain.mjs';

describe('parsePorcelainZ', () => {
  it('returns [] for empty input and for nullish input', () => {
    expect(parsePorcelainZ('')).toEqual([]);
    expect(parsePorcelainZ(undefined)).toEqual([]);
    expect(parsePorcelainZ(null)).toEqual([]);
  });

  it('drops malformed entries — too short, or no space in column 3', () => {
    // `XY ` is the shortest well-formed prefix. `?x` (2 chars) and `?? ` with
    // no path are not entries; `??x.mjs` has no space at index 2.
    const raw = ['?x', '?? ', '??x.mjs', ' M real.mjs', ''].join('\0');
    expect(parsePorcelainZ(raw)).toEqual(['real.mjs']);
  });

  it('consumes the second NUL field of a rename and keeps both paths', () => {
    const raw = ['R  new.mjs', 'old.mjs', '?? after.mjs', ''].join('\0');
    expect(parsePorcelainZ(raw)).toEqual(['new.mjs', 'old.mjs', 'after.mjs']);
  });

  it('treats a work-tree-column copy (` C`) as a double-field entry too', () => {
    const raw = [' C copy.mjs', 'source.mjs', ' M plain.mjs', ''].join('\0');
    expect(parsePorcelainZ(raw)).toEqual(['copy.mjs', 'source.mjs', 'plain.mjs']);
  });

  it('emits paths with spaces, quotes and non-ASCII bytes verbatim', () => {
    const raw = [' M old name.mjs', '?? quo"te.mjs', ' M ümläut.mjs', ''].join('\0');
    expect(parsePorcelainZ(raw)).toEqual(['old name.mjs', 'quo"te.mjs', 'ümläut.mjs']);
  });
});

describe('parsePorcelainEntries', () => {
  it('exposes both status columns and the rename source per entry', () => {
    const raw = ['R  new.mjs', 'old.mjs', '!! build/', '?? untracked.mjs', ''].join('\0');
    expect(parsePorcelainEntries(raw)).toEqual([
      { x: 'R', y: ' ', status: 'R ', path: 'new.mjs', original: 'old.mjs' },
      { x: '!', y: '!', status: '!!', path: 'build/', original: null },
      { x: '?', y: '?', status: '??', path: 'untracked.mjs', original: null },
    ]);
  });

  it('yields null original when a rename entry has no source field', () => {
    expect(parsePorcelainEntries('R  new.mjs\0')).toEqual([
      { x: 'R', y: ' ', status: 'R ', path: 'new.mjs', original: null },
    ]);
  });
});
