/**
 * tests/lib/claude-md-budget-lint.test.mjs
 *
 * Unit tests for `checkClaudeMdBudgetLint()` — the session-start Phase 4
 * banner wrapper added in #878 (FA2b). NOTE on test-file placement: the
 * PRE-EXISTING `lintClaudeMd()` + CLI coverage for this module already
 * lives at tests/scripts/claude-md-budget-lint.test.mjs (issue #722 Epic A
 * Wave 3) — this file deliberately does NOT duplicate that coverage. It
 * covers ONLY the new banner-wrapper surface added by #878, per this wave's
 * scoped test-file path (tests/lib/claude-md-budget-lint.test.mjs).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkClaudeMdBudgetLint } from '@lib/claude-md-budget-lint.mjs';

const tmpDirs = [];

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'claude-md-budget-lint-banner-'));
  tmpDirs.push(d);
  return d;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('checkClaudeMdBudgetLint — clean file', () => {
  it('returns null when the resolved CLAUDE.md has zero violations', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'CLAUDE.md'), '# Title\n\nShort clean body.\n', 'utf8');

    const result = checkClaudeMdBudgetLint({ repoRoot: dir });

    expect(result).toBeNull();
  });
});

describe('checkClaudeMdBudgetLint — no instruction file', () => {
  it('returns null when neither CLAUDE.md nor AGENTS.md exists under repoRoot', () => {
    const dir = tmp(); // empty dir, no instruction file written

    const result = checkClaudeMdBudgetLint({ repoRoot: dir });

    expect(result).toBeNull();
  });
});

describe('checkClaudeMdBudgetLint — violations present', () => {
  it('returns a warn-severity banner naming the violation count and rule names', () => {
    const dir = tmp();
    // 4 lines total (index 0..3, split('\n') yields 4 entries) — exceeds maxLines: 2.
    // Line 2 is deliberately over maxLineChars: 10.
    const longLine = 'a'.repeat(20);
    writeFileSync(join(dir, 'CLAUDE.md'), `short\n${longLine}\nshort\n`, 'utf8');

    const result = checkClaudeMdBudgetLint({ repoRoot: dir, maxLines: 2, maxLineChars: 10 });

    expect(result).toEqual({
      severity: 'warn',
      message: expect.stringContaining('CLAUDE.md budget lint:'),
    });
    expect(result.message).toContain('max-lines');
    expect(result.message).toContain('max-line-chars');
    expect(result.message).toContain('2 violation(s)');
  });

  it('resolves AGENTS.md when CLAUDE.md is absent, and names it in the banner', () => {
    const dir = tmp();
    const longLine = 'a'.repeat(20);
    writeFileSync(join(dir, 'AGENTS.md'), `${longLine}\n`, 'utf8');

    const result = checkClaudeMdBudgetLint({ repoRoot: dir, maxLineChars: 10 });

    expect(result.severity).toBe('warn');
    expect(result.message).toContain('AGENTS.md');
  });
});

describe('checkClaudeMdBudgetLint — never throws (banner-wrapper contract)', () => {
  it('returns null instead of throwing when repoRoot does not exist on disk', () => {
    const missing = join(tmpdir(), 'definitely-does-not-exist-budget-lint-banner-repo-xyz');

    expect(() => checkClaudeMdBudgetLint({ repoRoot: missing })).not.toThrow();
    expect(checkClaudeMdBudgetLint({ repoRoot: missing })).toBeNull();
  });
});
