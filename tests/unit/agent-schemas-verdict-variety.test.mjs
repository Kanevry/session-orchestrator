/**
 * tests/unit/agent-schemas-verdict-variety.test.mjs
 *
 * Issue #479 HIGH — verdict enum-variety in agent body examples.
 *
 * Problem (from qa-strategist audit):
 *   Only "PROCEED" appears as a concrete verdict value in reviewer-agent body
 *   JSON examples. The other three enum values (PROCEED_WITH_FOLLOWUPS,
 *   FIX_REQUIRED, BLOCKED) appear only in the pipe-delimited schema description
 *   string "PROCEED|PROCEED_WITH_FOLLOWUPS|FIX_REQUIRED|BLOCKED", which is a
 *   type annotation, not a demonstrated usage example.
 *
 * What this test checks:
 *   Each reviewer-style agent body must contain at least one concrete JSON
 *   example showing a non-PROCEED verdict — i.e., a line of the form:
 *     "verdict": "PROCEED_WITH_FOLLOWUPS"
 *   (or FIX_REQUIRED or BLOCKED) WITHOUT a pipe character in the value.
 *
 * Distinction from the existing schema validation tests:
 *   Existing tests in agent-output-schema.test.mjs and
 *   agent-schemas-implementer-verdict.test.mjs verify that the schemas
 *   ACCEPT all four values. This test verifies that the agent body
 *   DOCUMENTS the non-trivial cases via a concrete example, so operators
 *   reading the agent file understand what those outputs look like in practice.
 *
 * Expected outcome:
 *   All 5 tests currently FAIL — this surfaces the documentation gap.
 *   When the gap is fixed (one concrete non-PROCEED example added per agent),
 *   tests become green. The test is the regression guard.
 *
 * Falsification check:
 *   If an agent body had "verdict": "PROCEED_WITH_FOLLOWUPS" and it was
 *   removed, this test would fail. If the test only checked for the pipe-
 *   delimited schema string, removing the concrete example would not fail
 *   it — hence the tighter regex that excludes matches containing "|". ✓
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const AGENTS_DIR = join(REPO_ROOT, 'agents');

// Reviewer-style agents — the ones that produce verdict output.
// Implementer agents (code-implementer, db-specialist, etc.) are out of scope;
// they use verdict differently (as coordinator-consumption output).
const REVIEWER_AGENTS = [
  'architect-reviewer',
  'security-reviewer',
  'qa-strategist',
  'session-reviewer',
  'analyst',
];

// Non-PROCEED variants that must appear as concrete examples.
// A concrete example is: "verdict": "PROCEED_WITH_FOLLOWUPS" (no pipe in value).
const _VARIANT_VERDICTS = ['PROCEED_WITH_FOLLOWUPS', 'FIX_REQUIRED', 'BLOCKED'];

// Regex that matches a concrete verdict value (no pipe character in the value).
// Matches:  "verdict": "PROCEED_WITH_FOLLOWUPS"
// Does NOT match:  "verdict": "PROCEED|PROCEED_WITH_FOLLOWUPS|FIX_REQUIRED|BLOCKED"
const CONCRETE_VARIANT_RE = /"verdict":\s*"(PROCEED_WITH_FOLLOWUPS|FIX_REQUIRED|BLOCKED)"/;

describe('reviewer agent bodies — concrete non-PROCEED verdict examples', () => {
  for (const agentName of REVIEWER_AGENTS) {
    it(`${agentName}.md body contains at least one concrete non-PROCEED verdict example`, () => {
      const filePath = join(AGENTS_DIR, `${agentName}.md`);
      const content = readFileSync(filePath, 'utf8');

      // The assertion: the agent body must have at least one concrete JSON line
      // showing a non-PROCEED verdict value. The pipe-delimited enum description
      // "PROCEED|PROCEED_WITH_FOLLOWUPS|..." does NOT satisfy this check because
      // CONCRETE_VARIANT_RE requires the value to contain ONLY the variant name.
      const hasConcreteVariant = CONCRETE_VARIANT_RE.test(content);

      expect(hasConcreteVariant).toBe(true);
    });
  }
});
