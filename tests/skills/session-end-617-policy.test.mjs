/**
 * tests/skills/session-end-617-policy.test.mjs
 *
 * Policy-consistency regression test for the #617 session-end change.
 *
 * #617 reframed the session-end issue-creation policy: MED/LOW review findings
 * are now folded in-session or recorded in the Final Report (under "Unresolved
 * Review Findings"), NOT auto-filed as issues. Only HIGH+/blocking review
 * findings, SPIRAL/FAILED agent carryover, and planned-carryover items still
 * get a ticket.
 *
 * This is a PROSE policy change in skills/session-end/SKILL.md with no runtime
 * code, so the correct guard is a string-presence regression test (analogous to
 * tests/husky/pre-commit-owner-leakage.test.mjs). Each assertion below would
 * FAIL if the #617 policy were reverted (e.g. if the old unconditional "ALWAYS
 * create issues for unfinished work" rule were restored, or the MED/LOW-recorded
 * bucket were removed).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const SKILL_PATH = join(REPO_ROOT, 'skills', 'session-end', 'SKILL.md');

const content = readFileSync(SKILL_PATH, 'utf8');

describe('session-end #617 — MED/LOW findings are recorded, not auto-filed', () => {
  it('contains the new Critical Rule "DO NOT auto-file MED/LOW review findings"', () => {
    // Line 843: "**DO NOT auto-file MED/LOW review findings as issues**"
    expect(content).toContain('DO NOT auto-file MED/LOW review findings');
  });

  it('contains the "### Unresolved Review Findings" Final-Report bucket header', () => {
    // Line 774: "### Unresolved Review Findings (MED/LOW — recorded, not ticketed) [#617]"
    expect(content).toContain('### Unresolved Review Findings');
  });

  it('severity-disposition table contains both a "MED / LOW" row and a "Planned-carryover" row', () => {
    // Line 135: "| MED / LOW review finding | Fold in-session ... DO NOT create an issue (#617) |"
    expect(content).toContain('MED / LOW');
    // Line 136: "| Planned-carryover (item was in the plan, not finished) | ALWAYS create ... |"
    expect(content).toContain('Planned-carryover');
  });

  it('preserves the SPIRAL/FAILED carryover path — createSpiralCarryoverIssue referenced at least twice', () => {
    const occurrences = (content.match(/createSpiralCarryoverIssue/g) || []).length;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('replaces the old unconditional rule with the PLANNED-qualified form', () => {
    // The old bare rule "ALWAYS create issues for unfinished work" must NOT remain
    // as an unqualified standalone rule; #617 qualifies it with PLANNED.
    // Line 842: "**ALWAYS create issues for unfinished PLANNED work**"
    expect(content).toContain('ALWAYS create issues for unfinished PLANNED work');
  });
});
