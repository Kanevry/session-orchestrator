/**
 * migrate-vault-paths-pure.test.mjs — direct unit tests for the pure helpers
 * exported from scripts/migrate-vault-paths.mjs (architect MED #607 D3).
 *
 * The script gained an entry-guard (`if (import.meta.url === pathToFileURL(
 * process.argv[1]).href) main()...`) so these helpers can be imported WITHOUT
 * firing the one-shot migration. Subprocess behaviour stays covered by
 * tests/scripts/migrate-vault-paths.test.mjs; this file exercises the helpers in
 * isolation, including edge cases that are awkward to reach through the CLI.
 *
 * Segment-dependent helpers (rewriteContent, findMissingSegmentHits,
 * isOwnedByUsernamePath, classifyHit) read module-level OLD/NEW segments that the
 * CLI sets inside main(). `_setSegmentsForTest` is the test seam for them; it is
 * reset in beforeEach so no segment state leaks between tests.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { load as loadYaml } from 'js-yaml';
import {
  rewriteMissingSegment,
  rewriteContent,
  lineHasMissingSegment,
  findMissingSegmentHits,
  isHistorical,
  classifyHit,
  isOwnedByUsernamePath,
  MISSING_SEGMENT_CLASS,
  _setSegmentsForTest,
} from '../../scripts/migrate-vault-paths.mjs';

const OLD = '/Users/oldname/';
const NEW = '/Users/newname/';

beforeEach(() => {
  // Every test that needs segments sets them explicitly; default to the
  // synthetic placeholders so a forgotten setter is obvious (not null).
  _setSegmentsForTest(OLD, NEW);
});

// ---------------------------------------------------------------------------
// MISSING_SEGMENT_CLASS — hoisted constant
// ---------------------------------------------------------------------------

describe('MISSING_SEGMENT_CLASS', () => {
  it('is the canonical missing-segment classification literal', () => {
    expect(MISSING_SEGMENT_CLASS).toBe('vault-dir-missing-segment');
  });
});

// ---------------------------------------------------------------------------
// isOwnedByUsernamePath — shared ownership predicate
// ---------------------------------------------------------------------------

describe('isOwnedByUsernamePath', () => {
  it.each([
    [`vault-dir: ${OLD}Projects/vault`, true],
    ['vault-dir: ~/Projects/vault', false],
    [undefined, false],
  ])('checks original username ownership for %s: %s', (line, expected) => {
    expect(isOwnedByUsernamePath(line)).toBe(expected);
  });

  it('matches only the exact OLD_SEGMENT literal, not a username substring', () => {
    // The predicate keys on the full `/Users/oldname/` segment (leading+trailing
    // slash), so a bare "oldname-other-string" mention is NOT owned by the
    // username path — mirrors the script's literal split+join discipline.
    expect(isOwnedByUsernamePath('see oldname-other-string for ref')).toBe(false);
    expect(isOwnedByUsernamePath(`plan-file: ${OLD}Projects/x`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// isHistorical — path-based historical classification (segment-independent)
// ---------------------------------------------------------------------------

describe('isHistorical', () => {
  it.each([
    ['/repo/01-projects/foo/decisions.md', true],
    ['/repo/history/notes.md', true],
    ['/repo/pricing-history/q1.md', true],
    ['/repo/90-archive/old.md', true],
    ['/repo/archive/old.md', true],
    ['/repo/ARCHIVE-INSTRUCTIONS.md', true],
    ['/repo/CLAUDE.md', false],
    ['/repo/History/Notes.md', true],
  ])('classifies historical path %s: %s', (filePath, expected) => {
    expect(isHistorical(filePath)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// classifyHit — vault-dir-drift vs path-drift vs historical
// ---------------------------------------------------------------------------

describe('classifyHit', () => {
  it.each([
    ['/repo/CLAUDE.md', `vault-dir: ${OLD}Projects/vault`, 'vault-dir-drift'],
    ['/repo/STATE.md', `plan-file: ${OLD}Projects/foo/bar.md`, 'path-drift'],
    ['/repo/decisions.md', `vault-dir: ${OLD}Projects/vault`, 'historical'],
    ['/repo/CLAUDE.md', `vault-dir: ${OLD}Projects/other`, 'path-drift'],
  ])('classifies %s with %s as %s', (filePath, line, expected) => {
    expect(classifyHit(filePath, line)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// rewriteContent — literal split+join username rewrite (segment-dependent)
// ---------------------------------------------------------------------------

describe('rewriteContent', () => {
  it('replaces the literal OLD_SEGMENT with NEW_SEGMENT, preserving the trailing path', () => {
    expect(rewriteContent(`plan-file: ${OLD}Projects/foo/bar.md\n`)).toBe(
      `plan-file: ${NEW}Projects/foo/bar.md\n`,
    );
  });

  it('replaces every occurrence (split+join is global)', () => {
    const input = `a: ${OLD}x\nb: ${OLD}y\n`;
    expect(rewriteContent(input)).toBe(`a: ${NEW}x\nb: ${NEW}y\n`);
  });

  it('leaves content without the literal untouched', () => {
    expect(rewriteContent('see oldname-other-string\n')).toBe('see oldname-other-string\n');
  });

  it('is idempotent — a second pass over already-migrated content is a no-op', () => {
    const once = rewriteContent(`p: ${OLD}q\n`);
    expect(rewriteContent(once)).toBe(`p: ${NEW}q\n`);
  });
});

// ---------------------------------------------------------------------------
// lineHasMissingSegment — single-line legacy vault-base probe
// ---------------------------------------------------------------------------

describe('lineHasMissingSegment', () => {
  it.each([
    ['vault-dir: ~/Projects/vault', true],
    ['vault-dir: /Users/bob/Projects/vault', true],
    ['vault-dir: /srv/fixture-vault', false],
    ['vault-dir: ~/Projects/vault-backups', false],
    ['cache: ~/Projects/vault-backups', false],
    ['vault-dir: ~/Projects/vault   # comment', true],
  ])('detects a legacy vault base in %s: %s', (line, expected) => {
    expect(lineHasMissingSegment(line)).toBe(expected);
  });

  it('is stateless across calls despite the /g regex lastIndex', () => {
    // The helper resets lastIndex; two probes of the same true line must agree.
    const line = 'vault-dir: ~/Projects/vault';
    expect(lineHasMissingSegment(line)).toBe(true);
    expect(lineHasMissingSegment(line)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findMissingSegmentHits — per-file missing-segment hit collection
// ---------------------------------------------------------------------------

describe('findMissingSegmentHits', () => {
  it('returns a 1-indexed hit for a drift line with the canonical classification', () => {
    const content = ['# header', 'vault-dir: ~/Projects/vault', ''].join('\n');
    const hits = findMissingSegmentHits('/repo/CLAUDE.md', content);
    expect(hits).toEqual([
      { line: 2, text: 'vault-dir: ~/Projects/vault', classification: MISSING_SEGMENT_CLASS },
    ]);
  });

  it('returns no hits when every vault-dir line is already canonical', () => {
    const content = 'vault-dir: /srv/fixture-vault\n';
    expect(findMissingSegmentHits('/repo/CLAUDE.md', content)).toEqual([]);
  });

  it('skips a line owned by the username-rewrite path (collision guard)', () => {
    // A vault-dir line carrying OLD_SEGMENT is a username drift, NOT a missing
    // segment — it must not appear in the missing-segment hits.
    const content = `vault-dir: ${OLD}Projects/vault\n`;
    expect(findMissingSegmentHits('/repo/CLAUDE.md', content)).toEqual([]);
  });

  it('marks hits in a historical file as historical, not the canonical class', () => {
    const content = 'vault-dir: ~/Projects/vault\n';
    const hits = findMissingSegmentHits('/repo/decisions.md', content);
    expect(hits).toEqual([
      { line: 1, text: 'vault-dir: ~/Projects/vault', classification: 'historical' },
    ]);
  });

  it('collects multiple drift lines in one file', () => {
    const content = [
      'vault-dir: ~/Projects/vault',
      'noise: ~/Projects/other',
      'vault-dir: /Users/x/Projects/vault',
    ].join('\n');
    const hits = findMissingSegmentHits('/repo/CLAUDE.md', content);
    expect(hits.map((h) => h.line)).toEqual([1, 3]);
  });
});

// ---------------------------------------------------------------------------
// rewriteMissingSegment — use the explicit configured canonical vault target
// (originalContent is REQUIRED — no default; #607 D3)
// ---------------------------------------------------------------------------

describe('rewriteMissingSegment', () => {
  it.each([
    ['vault-dir: ~/Projects/vault\n', 'vault-dir: /srv/fixture-vault\n'],
    ['vault-dir: /Users/bob/Projects/vault\n', 'vault-dir: /srv/fixture-vault\n'],
    ['vault-dir: /srv/fixture-vault\n', 'vault-dir: /srv/fixture-vault\n'],
    ['vault-dir: ~/Projects/vault/sub/dir\n', 'vault-dir: /srv/fixture-vault/sub/dir\n'],
    ['vault-dir: ~/Projects/vault   # canonical Meta-Vault location\n', 'vault-dir: /srv/fixture-vault   # canonical Meta-Vault location\n'],
    ['vault-dir: ~/Projects/vault/\n', 'vault-dir: /srv/fixture-vault/\n'],
    ['vault-dir: ~/Projects/vault-backups\n', 'vault-dir: ~/Projects/vault-backups\n'],
  ])('rewrites explicit canonical base while preserving %s', (input, expected) => {
    expect(rewriteMissingSegment(input, input, '/srv/fixture-vault')).toBe(expected);
  });

  it('skips a working line whose ORIGINAL carried OLD_SEGMENT (collision gate)', () => {
    // Simulate the chained-transform case: the username rewrite already ran, so
    // the working line is the NEW-username form, but the ORIGINAL line carried
    // OLD_SEGMENT. The canonical-target pass must leave that line untouched.
    const original = `vault-dir: ${OLD}Projects/vault\n`;
    const working = `vault-dir: ${NEW}Projects/vault\n`; // post username-rewrite
    expect(rewriteMissingSegment(working, original, '/srv/fixture-vault')).toBe(working);
  });

  it('rewrites a genuine missing-segment line even when another line is username-owned', () => {
    const original = [`vault-dir: ${OLD}Projects/vault`, 'vault-dir: ~/Projects/vault', ''].join(
      '\n',
    );
    const working = [`vault-dir: ${NEW}Projects/vault`, 'vault-dir: ~/Projects/vault', ''].join(
      '\n',
    );
    expect(rewriteMissingSegment(working, original, '/srv/fixture-vault')).toBe(
      [`vault-dir: ${NEW}Projects/vault`, 'vault-dir: /srv/fixture-vault', ''].join('\n'),
    );
  });

  it('throws when originalContent is omitted (required param, no silent default)', () => {
    // The `= content` default was dropped: calling without the original must fail
    // loudly (split of undefined) rather than fail open. This pins the contract.
    expect(() => rewriteMissingSegment('vault-dir: ~/Projects/vault\n')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Known limitation (QA LOW #607 item 5/7) — MISSING_SEGMENT_RE has no
// start-of-line anchor, so it over-matches commented-out / nested-key forms.
// These tests PIN the CURRENT (un-anchored) behaviour so a future anchor PR has
// a regression anchor to update. Documented as a deferred follow-up, NOT a
// blessing of the behaviour.
// ---------------------------------------------------------------------------

describe('rewriteMissingSegment — un-anchored over-match (known limitation)', () => {
  it('CURRENTLY rewrites a commented-out vault-dir line (no left anchor)', () => {
    const input = '# vault-dir: ~/Projects/vault\n';
    // Documents present behaviour; a start-of-line anchor would change this to a no-op.
    expect(rewriteMissingSegment(input, input, '/srv/fixture-vault')).toBe('# vault-dir: /srv/fixture-vault\n');
  });

  it('CURRENTLY rewrites a nested-key vault-dir line (no left anchor)', () => {
    const input = 'note: vault-dir: ~/Projects/vault\n';
    expect(rewriteMissingSegment(input, input, '/srv/fixture-vault')).toBe('note: vault-dir: /srv/fixture-vault\n');
  });
});


it('rewrites to an explicit whole canonical vault target without guessing an owner segment', () => {
  const input = 'vault-dir: ~/Projects/vault/subdir  # retain\n';
  expect(rewriteMissingSegment(input, input, '/srv/fixture-vault')).toBe('vault-dir: /srv/fixture-vault/subdir  # retain\n');
});

it('does not guess a canonical owner when the target is unconfigured or relative', () => {
  const input = 'vault-dir: ~/Projects/vault\n';
  expect(rewriteMissingSegment(input,input,null)).toBe(input);
  expect(rewriteMissingSegment(input,input,'relative/vault')).toBe(input);
});

it('preserves scalar quotes and safely quotes configured paths with spaces', () => {
  const input = 'vault-dir: "~/Projects/vault/sub" # keep\n';
  expect(rewriteMissingSegment(input,input,'/srv/Fixture Vault')).toBe('vault-dir: "/srv/Fixture Vault/sub" # keep\n');
  const bare = 'vault-dir: ~/Projects/vault/sub # keep\n';
  expect(rewriteMissingSegment(bare,bare,'/srv/Fixture Vault')).toBe('vault-dir: "/srv/Fixture Vault/sub" # keep\n');
});


it.each([
  ['"~/Projects/vault/a\\\\b"', '/a\\b'],
  ['"~/Projects/vault/a\\"b"', '/a"b'],
  ['"~/Projects/vault/a\\u0062"', '/ab'],
  ["'~/Projects/vault/O''Brien'", "/O'Brien"],
])('preserves decoded quoted suffix %s during vault migration', (scalar, suffix) => {
  const input = `vault-dir: ${scalar} # retain\n`;
  const target = '/srv/Fixture "Vault"\\Root';
  const output = rewriteMissingSegment(input, input, target);
  expect(loadYaml(output)['vault-dir']).toBe(target + suffix);
  expect(output).toContain(' # retain\n');
  expect(rewriteMissingSegment(output, output, target)).toBe(output);
});
