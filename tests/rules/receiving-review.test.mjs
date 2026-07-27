/**
 * tests/rules/receiving-review.test.mjs
 *
 * ## Why this file only holds instruction-budget tests
 *
 * It used to carry 55 tests, 52 of which were prose-pins on
 * `.claude/rules/receiving-review.md`: heading-present regexes, See-Also
 * link-name `toContain`s, and verbatim sentence fragments from RCR-007/008.
 * Those pins could only ever go red when someone deliberately edited the rule
 * text — i.e. they re-asserted the diff the author had just written, and the
 * fix for a red was always "update the test to the new wording". They caught
 * no bug class; they taxed every rule edit.
 *
 * What remains are the three tests that exercise a LIVE contract:
 * `computeInstructionBudget()` from `scripts/lib/instruction-budget-guard.mjs`
 * measured against the REAL repo state. These CAN go red without anyone
 * touching this file — any always-on rule anywhere in `.claude/rules/` that
 * pushes the repo over the directive ceiling or blows this rule's byte budget
 * trips them. That is a genuine regression signal, and it is the reason
 * receiving-review.md's growth was capped in #899 in the first place.
 *
 * Structural properties of the rule file itself (frontmatter, dangling
 * citations, glob scoping) are covered mechanically by
 * `claude-md-drift-check`'s rule-scoping check — not by prose greps here.
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..', '..');

describe('receiving-review.md — instruction budget (#899)', () => {
  it('byte size stays within the +2000B growth ceiling (8225 B) over the pre-change 6225 B baseline', async () => {
    const { computeInstructionBudget } = await import('../../scripts/lib/instruction-budget-guard.mjs');
    const budget = computeInstructionBudget({ repoRoot });
    const entry = budget.perFile.find((f) => f.file === 'receiving-review.md');
    expect(entry).toBeDefined();
    expect(entry.bytes).toBeLessThanOrEqual(8225);
  });

  it('repo-wide always-on directive total stays at or under the configured ceiling', async () => {
    const { computeInstructionBudget, DEFAULT_CEILING } = await import('../../scripts/lib/instruction-budget-guard.mjs');
    const budget = computeInstructionBudget({ repoRoot });
    // The ceiling is Session-Config-driven (instruction-budget.ceiling, currently
    // 480). Assert the resolved ceiling equals the module default AND that the
    // live total respects it — pinning the literal 480 here would duplicate the
    // config and go red on a legitimate operator ceiling change.
    expect(budget.ceiling).toBe(DEFAULT_CEILING);
    expect(budget.totalDirectives).toBeLessThanOrEqual(budget.ceiling);
  });

  it('repo-wide instruction budget is not flagged overBudget', async () => {
    const { computeInstructionBudget } = await import('../../scripts/lib/instruction-budget-guard.mjs');
    const budget = computeInstructionBudget({ repoRoot });
    expect(budget.overBudget).toBe(false);
  });
});
