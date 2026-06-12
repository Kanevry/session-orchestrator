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
  it('returns true for a line containing the OLD_SEGMENT literal', () => {
    expect(isOwnedByUsernamePath(`vault-dir: ${OLD}Projects/vault`)).toBe(true);
  });

  it('returns false for a line without the OLD_SEGMENT literal', () => {
    expect(isOwnedByUsernamePath('vault-dir: ~/Projects/vault')).toBe(false);
  });

  it('returns false for undefined (shorter original-content array)', () => {
    // The collision-gate in rewriteMissingSegment can index past the end of the
    // original-content lines; an undefined line is not owned by the username path.
    expect(isOwnedByUsernamePath(undefined)).toBe(false);
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
  it('flags decisions.md basename as historical', () => {
    expect(isHistorical('/repo/01-projects/foo/decisions.md')).toBe(true);
  });

  it('flags any file under a /history/ directory', () => {
    expect(isHistorical('/repo/history/notes.md')).toBe(true);
  });

  it('flags a -history/ suffixed directory (pricing-history/)', () => {
    expect(isHistorical('/repo/pricing-history/q1.md')).toBe(true);
  });

  it('flags a numbered vault archive directory (90-archive/)', () => {
    expect(isHistorical('/repo/90-archive/old.md')).toBe(true);
  });

  it('flags a bare /archive/ directory', () => {
    expect(isHistorical('/repo/archive/old.md')).toBe(true);
  });

  it('flags a basename containing "archive"', () => {
    expect(isHistorical('/repo/ARCHIVE-INSTRUCTIONS.md')).toBe(true);
  });

  it('returns false for an ordinary source file', () => {
    expect(isHistorical('/repo/CLAUDE.md')).toBe(false);
  });

  it('is case-insensitive on the path', () => {
    expect(isHistorical('/repo/History/Notes.md')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// classifyHit — vault-dir-drift vs path-drift vs historical
// ---------------------------------------------------------------------------

describe('classifyHit', () => {
  it('classifies a vault-dir: line carrying the old username as vault-dir-drift', () => {
    expect(classifyHit('/repo/CLAUDE.md', `vault-dir: ${OLD}Projects/vault`)).toBe(
      'vault-dir-drift',
    );
  });

  it('classifies a non-vault-dir old-username reference as path-drift', () => {
    expect(classifyHit('/repo/STATE.md', `plan-file: ${OLD}Projects/foo/bar.md`)).toBe(
      'path-drift',
    );
  });

  it('classifies any hit in a historical file as historical (overrides shape)', () => {
    // Even a vault-dir: line is "historical" when the file is a decisions log.
    expect(classifyHit('/repo/decisions.md', `vault-dir: ${OLD}Projects/vault`)).toBe(
      'historical',
    );
  });

  it('requires the literal Projects/vault tail for vault-dir-drift (not just vault-dir:)', () => {
    // A vault-dir: line whose value is NOT the vault-path literal is path-drift.
    expect(classifyHit('/repo/CLAUDE.md', `vault-dir: ${OLD}Projects/other`)).toBe(
      'path-drift',
    );
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
// lineHasMissingSegment — single-line missing-/Bernhard/-segment probe
// ---------------------------------------------------------------------------

describe('lineHasMissingSegment', () => {
  it('matches a tilde vault-dir pointing at ~/Projects/vault', () => {
    expect(lineHasMissingSegment('vault-dir: ~/Projects/vault')).toBe(true);
  });

  it('matches the expanded /Users/<user>/Projects/vault form', () => {
    expect(lineHasMissingSegment('vault-dir: /Users/bob/Projects/vault')).toBe(true);
  });

  it('does NOT match an already-canonical ~/Projects/Bernhard/vault (idempotency)', () => {
    expect(lineHasMissingSegment('vault-dir: ~/Projects/Bernhard/vault')).toBe(false);
  });

  it('does NOT match a vault-backups path (trailing path-boundary guard)', () => {
    expect(lineHasMissingSegment('vault-dir: ~/Projects/vault-backups')).toBe(false);
  });

  it('does NOT match a non-vault-dir ~/Projects/vault line (context guard)', () => {
    expect(lineHasMissingSegment('cache: ~/Projects/vault-backups')).toBe(false);
  });

  it('matches even when a trailing comment follows the value', () => {
    expect(lineHasMissingSegment('vault-dir: ~/Projects/vault   # comment')).toBe(true);
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
    const content = 'vault-dir: ~/Projects/Bernhard/vault\n';
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
// rewriteMissingSegment — insert the /Bernhard/ owner segment
// (originalContent is REQUIRED — no default; #607 D3)
// ---------------------------------------------------------------------------

describe('rewriteMissingSegment', () => {
  it('inserts the canonical owner segment for a tilde vault-dir', () => {
    const input = 'vault-dir: ~/Projects/vault\n';
    expect(rewriteMissingSegment(input, input)).toBe('vault-dir: ~/Projects/Bernhard/vault\n');
  });

  it('inserts the owner segment for the expanded /Users/<user> form', () => {
    const input = 'vault-dir: /Users/bob/Projects/vault\n';
    expect(rewriteMissingSegment(input, input)).toBe(
      'vault-dir: /Users/bob/Projects/Bernhard/vault\n',
    );
  });

  it('is idempotent — an already-canonical line is left unchanged', () => {
    const input = 'vault-dir: ~/Projects/Bernhard/vault\n';
    expect(rewriteMissingSegment(input, input)).toBe('vault-dir: ~/Projects/Bernhard/vault\n');
  });

  it('preserves a trailing path after vault, inserting the owner at the root only', () => {
    const input = 'vault-dir: ~/Projects/vault/sub/dir\n';
    expect(rewriteMissingSegment(input, input)).toBe(
      'vault-dir: ~/Projects/Bernhard/vault/sub/dir\n',
    );
  });

  it('preserves a trailing inline comment on the rewritten line', () => {
    const input = 'vault-dir: ~/Projects/vault   # canonical Meta-Vault location\n';
    expect(rewriteMissingSegment(input, input)).toBe(
      'vault-dir: ~/Projects/Bernhard/vault   # canonical Meta-Vault location\n',
    );
  });

  it('preserves a trailing slash on the rewritten vault-dir value', () => {
    const input = 'vault-dir: ~/Projects/vault/\n';
    expect(rewriteMissingSegment(input, input)).toBe('vault-dir: ~/Projects/Bernhard/vault/\n');
  });

  it('leaves a vault-backups line untouched (path-boundary guard)', () => {
    const input = 'vault-dir: ~/Projects/vault-backups\n';
    expect(rewriteMissingSegment(input, input)).toBe('vault-dir: ~/Projects/vault-backups\n');
  });

  it('skips a working line whose ORIGINAL carried OLD_SEGMENT (collision gate)', () => {
    // Simulate the chained-transform case: the username rewrite already ran, so
    // the working line is the NEW-username form, but the ORIGINAL line carried
    // OLD_SEGMENT. The missing-segment pass must NOT inject /Bernhard/ here.
    const original = `vault-dir: ${OLD}Projects/vault\n`;
    const working = `vault-dir: ${NEW}Projects/vault\n`; // post username-rewrite
    expect(rewriteMissingSegment(working, original)).toBe(working);
    expect(rewriteMissingSegment(working, original)).not.toContain('Bernhard');
  });

  it('rewrites a genuine missing-segment line even when another line is username-owned', () => {
    const original = [`vault-dir: ${OLD}Projects/vault`, 'vault-dir: ~/Projects/vault', ''].join(
      '\n',
    );
    const working = [`vault-dir: ${NEW}Projects/vault`, 'vault-dir: ~/Projects/vault', ''].join(
      '\n',
    );
    expect(rewriteMissingSegment(working, original)).toBe(
      [`vault-dir: ${NEW}Projects/vault`, 'vault-dir: ~/Projects/Bernhard/vault', ''].join('\n'),
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
    expect(rewriteMissingSegment(input, input)).toBe('# vault-dir: ~/Projects/Bernhard/vault\n');
  });

  it('CURRENTLY rewrites a nested-key vault-dir line (no left anchor)', () => {
    const input = 'note: vault-dir: ~/Projects/vault\n';
    expect(rewriteMissingSegment(input, input)).toBe('note: vault-dir: ~/Projects/Bernhard/vault\n');
  });
});
