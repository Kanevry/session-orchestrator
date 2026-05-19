/**
 * tests/unit/category8-boundary.test.mjs
 *
 * Issue #479 HIGH — c8.6 Predicate B boundary tests.
 *
 * Covers:
 *   - exactly 60 lines in a section → PASS (2 points with delegation link)
 *   - exactly 61 lines in a section → PASS but with reduced points (1 point)
 *   - no "## " headings in CLAUDE.md → maxSectionLines equals total file length
 *     (degenerate: behaviour pinned so a regression is observable)
 *
 * Section line-counting algorithm (from category8.mjs):
 *   text.split(/^## /m) → per-section array
 *   section.split('\n').length gives the line count for each section
 *
 * Fixture derivation:
 *   A section with heading "## Section\n" followed by N content lines then
 *   a trailing newline. After splitting on /^## /m the segment starts with
 *   "Section\n" (heading text stripped by split), then N content lines, then
 *   "". So split('\n').length = N + 2 (heading-text row + N content + trailing empty).
 *   To get exactly 60: N = 58. To get exactly 61: N = 59.
 *
 * Falsification check (per rules/test-quality.md):
 *   If the predicateB threshold were changed from 60 to 50, the "exactly 60" test
 *   would flip from pass(2) to pass(1) → assertion on c.points === 2 fails. ✓
 *   If maxSectionLines were computed wrongly (e.g. off-by-one), the "exactly 61"
 *   test's evidence assertion would expose it. ✓
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir as ostmpdir } from 'node:os';
import { realpathSync } from 'node:fs';

import { runCategory8 } from '@lib/harness-audit/categories/category8.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot() {
  // realpathSync resolves macOS /var → /private/var symlink (learning conf 0.85)
  return realpathSync(mkdtempSync(join(ostmpdir(), 'cat8-bnd-')));
}

function _ensureDir(p) {
  mkdirSync(p, { recursive: true });
}

/**
 * Build a CLAUDE.md fixture that includes a delegation link (Predicate A = true)
 * and a single section whose split('\n').length equals exactly targetLineCount.
 *
 * targetLineCount = contentLines + 2
 *   where contentLines = targetLineCount - 2
 *
 * The "## Section\n" heading text plus N content lines plus trailing empty = N+2.
 */
function makeSectionFixture(targetLineCount) {
  const contentLines = targetLineCount - 2;
  const body = Array.from({ length: contentLines }, (_, i) => `- item ${i + 1}`).join('\n');
  // No blank line after the ## heading — the segment after split(/^## /m) is:
  // "Section\n" + body + "\n" → heading-text + N content lines + trailing-empty = N+2 tokens.
  return `# Root\n\n> See [README.md](./README.md) for layout.\n\n## Section\n${body}\n`;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('c8.6 lean-root — Predicate B boundary conditions', () => {
  let root;

  beforeEach(() => {
    root = makeRoot();
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // -------------------------------------------------------------------------
  // Boundary 1: exactly 60 lines → Predicate B passes → 2 points (A + B)
  // -------------------------------------------------------------------------

  it('c8.6 pass(2): section with exactly 60 split-lines earns full 2 points', () => {
    // targetLineCount 60: contentLines = 58
    writeFileSync(join(root, 'CLAUDE.md'), makeSectionFixture(60));

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(2);
    expect(c.evidence.delegationLink).toBe(true);
    expect(c.evidence.maxSectionLines).toBe(60);
  });

  // -------------------------------------------------------------------------
  // Boundary 2: exactly 61 lines → Predicate B fails → 1 point (A only)
  // -------------------------------------------------------------------------

  it('c8.6 pass(1): section with exactly 61 split-lines earns only 1 point', () => {
    // targetLineCount 61: contentLines = 59
    writeFileSync(join(root, 'CLAUDE.md'), makeSectionFixture(61));

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.delegationLink).toBe(true);
    expect(c.evidence.maxSectionLines).toBe(61);
    expect(c.message).toContain('exceeds 60 lines');
  });

  // -------------------------------------------------------------------------
  // Boundary 3: no "## " headings → maxSectionLines = total file length
  //
  // Degenerate case: the entire file is one section because split(/^## /m)
  // with no match returns a single-element array containing the whole text.
  // This pins the behaviour: maxSectionLines must equal the total line count,
  // NOT silently return 0 or some other sentinel.
  // -------------------------------------------------------------------------

  it('c8.6 no-## headings: maxSectionLines equals total file line count (behaviour pinned)', () => {
    // 5 physical lines — no "## " heading at all
    // Delegation link is present to isolate c8.6 Predicate B from Predicate A.
    const fixture =
      '# Root\n' +
      '> See [README.md](./README.md) for layout.\n' +
      'Line 3\n' +
      'Line 4\n' +
      'Line 5\n';
    writeFileSync(join(root, 'CLAUDE.md'), fixture);

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    // The whole file is one section (no ## split). It has 6 tokens from split('\n')
    // (lines 1-5 plus trailing empty after final \n).
    expect(c.evidence.maxSectionLines).toBe(6);
    // Delegation link fires → status is pass or fail based only on predicateA
    // (delegation link exists → predicateA true → status pass; predicateB ≤60 also true for 6)
    expect(c.evidence.delegationLink).toBe(true);
    expect(c.status).toBe('pass');
    expect(c.points).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Boundary 4: multi-section file where only ONE section exceeds 60 lines
  // Ensures the MAX logic is tested: maxSectionLines tracks the worst section.
  // -------------------------------------------------------------------------

  it('c8.6 pass(1): multi-section where one section has 62 split-lines earns 1 point', () => {
    // Short section: 10 content lines (12 split-lines: heading + 10 + trailing empty + blank) → well under 60
    // Long section: 60 content lines (62 split-lines: heading + 60 + trailing empty) → over 60
    // No blank line after ## headings so formula is: heading-text + N content lines + trailing empty = N+2.
    const shortSection = Array.from({ length: 10 }, (_, i) => `- s1 item ${i + 1}`).join('\n');
    const longSection = Array.from({ length: 60 }, (_, i) => `- s2 item ${i + 1}`).join('\n');
    const fixture =
      '# Root\n\n> See [README.md](./README.md) for layout.\n\n' +
      `## Short Section\n${shortSection}\n\n` +
      `## Long Section\n${longSection}\n`;
    writeFileSync(join(root, 'CLAUDE.md'), fixture);

    const checks = runCategory8(root);
    const c = checks.find((ch) => ch.check_id === 'lean-root');

    expect(c.status).toBe('pass');
    expect(c.points).toBe(1);
    expect(c.evidence.maxSectionLines).toBe(62);
    expect(c.evidence.delegationLink).toBe(true);
  });
});
