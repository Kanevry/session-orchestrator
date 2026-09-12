/**
 * tests/lib/ux-grill/rubric-parity.test.mjs — the severity table in
 * `skills/ux-grill/rubric-v2.md` against its declared SSOT in
 * `scripts/lib/ux-grill/schema.mjs`.
 *
 * WHY this file exists: `rubric-v2.md` states in prose that `SEVERITY_BY_CHECK`
 * / `severityForAxeImpact` are the source of truth and the table "is a rendering
 * of it". Nothing checked that. Worse, the rubric file's full text IS the
 * `rubric_hash` comparability key, so a drifted table is not merely stale
 * documentation — it is the artefact an operator reads when deciding whether a
 * severity changed between two runs.
 *
 * The census is PARSED out of the markdown, never hand-typed here: a parity test
 * whose subject is a literal list only checks itself (`.claude/rules/
 * measurement-discipline.md` § "A parity test with a hand-typed list under a
 * census title is a green tick with no cover"). Hence the VACUUM GUARD below —
 * if the table is reshaped so the parser stops matching, this file must go RED,
 * not silently green over an empty set.
 */

import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';

import { CHECK_IDS, SEVERITY_BY_CHECK, severityForAxeImpact } from '../../../scripts/lib/ux-grill/schema.mjs';

const repoRoot = path.resolve(import.meta.dirname, '../../..');
const rubricPath = path.join(repoRoot, 'skills/ux-grill/rubric-v2.md');

/** Header of the ONE table this test owns; anchors the parse to it. */
const TABLE_HEADER = '| check (`checkId`) | measurement | severity |';

/**
 * Parse the severity table out of the rubric.
 *
 * @returns {{rows: number, byCheck: Record<string,string>, byAxeImpact: Record<string,string>}}
 *   `byCheck` are the non-axe rows (`checkId` → severity); `byAxeImpact` are the
 *   `axe-violations` rows, keyed by each impact token the measurement cell names.
 */
function parseRubricSeverityTable() {
  const lines = fs.readFileSync(rubricPath, 'utf8').split('\n');
  const start = lines.indexOf(TABLE_HEADER);
  if (start < 0) throw new Error(`rubric-v2.md no longer contains the severity table header: ${TABLE_HEADER}`);

  /** @type {Record<string,string>} */ const byCheck = {};
  /** @type {Record<string,string>} */ const byAxeImpact = {};
  let rows = 0;
  // Skip the header and its `|---|---|---|` separator; stop at the first
  // non-table line (blank line or prose).
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith('|')) break;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 3) break;
    const [check, measurement, severity] = cells;
    rows += 1;
    const ticked = (/** @type {string} */ cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (check.startsWith(`\`${CHECK_IDS.AXE_VIOLATIONS}\``)) {
      const impacts = ticked(measurement);
      // "impact `minor` / unknown" — the unticked word is the catch-all branch.
      if (/\bunknown\b/.test(measurement)) impacts.push('unknown');
      for (const impact of impacts) byAxeImpact[impact] = severity;
      continue;
    }
    const [checkId] = ticked(check);
    if (checkId === undefined) break;
    byCheck[checkId] = severity;
  }
  return { rows, byCheck, byAxeImpact };
}

describe('ux-grill rubric-v2 severity table — parity with schema.mjs', () => {
  const parsed = parseRubricSeverityTable();

  // VACUUM GUARD. Bug: a table reshape (renamed header, a fourth column, the
  // rows converted to a list) silently empties the census, and every parity
  // assertion below then passes over nothing. An empty parse is a FAILURE of
  // this test, never a pass.
  it('parses a non-empty census out of the rubric markdown', () => {
    expect(parsed.rows).toBeGreaterThan(0);
    expect(Object.keys(parsed.byCheck).length).toBeGreaterThan(0);
    expect(Object.keys(parsed.byAxeImpact).length).toBeGreaterThan(0);
    // The SSOT side must be non-empty too, else set-equality is vacuous both ways.
    expect(Object.keys(SEVERITY_BY_CHECK).length).toBeGreaterThan(0);
  });

  // Bug: `rubric-v2.md` claims to be a rendering of `SEVERITY_BY_CHECK`, but
  // nothing compared them — a severity changed on one side (or a check added to
  // CHECK_IDS and rendered with a made-up severity) stayed green forever, while
  // the rubric text drives `rubric_hash` and is what the operator reads.
  it('renders exactly the checks in SEVERITY_BY_CHECK, with the same severities', () => {
    expect(parsed.byCheck).toEqual({ ...SEVERITY_BY_CHECK });
  });

  // Bug: the axe rows render `severityForAxeImpact`'s BRANCHES, which no import
  // can compare structurally. Driving the real function with the impact tokens
  // the table names is the only way a changed branch goes red.
  it('renders every severityForAxeImpact branch as the function computes it', () => {
    for (const [impact, severity] of Object.entries(parsed.byAxeImpact)) {
      expect(severityForAxeImpact(impact), `axe impact "${impact}"`).toBe(severity);
    }
    // All three severities must be reachable from the rendered impacts — a table
    // that dropped, say, the `moderate` row would otherwise still pass above.
    expect(new Set(Object.values(parsed.byAxeImpact))).toEqual(new Set(['high', 'medium', 'low']));
    // The catch-all: an impact the table never names still falls to `low`.
    expect(severityForAxeImpact('not-an-axe-impact')).toBe('low');
  });
});
