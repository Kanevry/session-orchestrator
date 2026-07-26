/**
 * issue-900-regression.test.mjs — #900 regression fixture: the reconcile
 * engine could structurally NOT convert real-corpus learning types (0/49
 * eligible reported by the issue). This fixture reconstructs the 10 real
 * rejection groups from the issue (49 records total) and locks in the
 * POST-FIX partition:
 *
 *   - `pattern` (alias -> proven-pattern) and `gotcha` (alias -> anti-pattern)
 *     records carrying file_paths are now PROPOSED (type-alias + registry flip).
 *   - `workflow-pattern` records carrying file_paths are now PROPOSED
 *     (registry ruleConvertible flip).
 *   - `effective-sizing` / `process` / `scope-guidance` / `infra` /
 *     `deviation-pattern` records remain REJECTED on the TYPE gate — even
 *     when they carry file_paths — proving the fix is narrowly scoped and
 *     does not accidentally convert genuinely unknown/non-convertible types.
 *   - `recurring-issue` / `fragile-file` records WITHOUT file_paths remain
 *     REJECTED on the FILE gate — already-convertible types still need scope.
 *
 * `normalizeDialects` is applied to every record before `filterEligible`,
 * mirroring exactly what the engine's default learnings loader does
 * (`migrateLegacyLearning` + `normalizeLearning`, both of which route through
 * `normalizeDialects` — see `scripts/lib/reconcile/engine.mjs`
 * `defaultLoadLearnings`).
 */

import { describe, it, expect } from 'vitest';

import { filterEligible } from '../../../scripts/lib/reconcile/eligibility.mjs';
import { normalizeDialects } from '../../../scripts/lib/learnings/schema.mjs';

/**
 * Build `count` synthetic learning records of a given (possibly free-form,
 * non-registry) `type`. Each record carries a real, non-placeholder insight
 * and a fixed `created_at` well inside every registry TTL, so only the
 * type/file gates under test can produce a rejection.
 *
 * @param {string} type
 * @param {number} count
 * @param {{ filePaths?: boolean }} [opts] - filePaths defaults to true.
 * @returns {object[]}
 */
function buildGroup(type, count, { filePaths = true } = {}) {
  return Array.from({ length: count }, (_, i) => {
    const record = {
      type,
      subject: `${type}-${i}`,
      insight: `Real insight text describing a ${type} record #${i}.`,
      confidence: 0.7,
      created_at: '2026-06-21T00:00:00Z',
    };
    if (filePaths) {
      record.file_paths = [`scripts/lib/${type}/${i}.mjs`];
    }
    return record;
  });
}

// The 10 real-corpus rejection groups reported by issue #900 (0/49 eligible
// pre-fix). Counts: 14 + 12 + 6 + 3 + 2 + 2 + 2 + 1 + 6 + 1 = 49.
const ISSUE_900_FIXTURE = [
  ...buildGroup('pattern', 14), // alias -> proven-pattern; has file_paths
  ...buildGroup('gotcha', 12), // alias -> anti-pattern; has file_paths
  ...buildGroup('effective-sizing', 6), // never rule-convertible (a metric, not a scope-able pattern)
  ...buildGroup('process', 3), // free-form, not in LEARNING_TYPE_REGISTRY
  ...buildGroup('scope-guidance', 2), // free-form, not in LEARNING_TYPE_REGISTRY
  ...buildGroup('workflow-pattern', 2), // now ruleConvertible:true; has file_paths
  ...buildGroup('infra', 2), // free-form, not in LEARNING_TYPE_REGISTRY
  ...buildGroup('deviation-pattern', 1), // free-form, not in LEARNING_TYPE_REGISTRY
  ...buildGroup('recurring-issue', 6, { filePaths: false }), // eligible type, no scope
  ...buildGroup('fragile-file', 1, { filePaths: false }), // eligible type, no scope
];

describe('#900 regression — 49-record real-corpus fixture (0/49 eligible pre-fix)', () => {
  it('fixture totals exactly 49 records across the 10 documented groups', () => {
    expect(ISSUE_900_FIXTURE).toHaveLength(49);
  });

  it('proposes every pattern/gotcha/workflow-pattern record carrying file_paths (28 total)', () => {
    // normalizeDialects applies the #900 type-alias resolution (pattern/gotcha)
    // exactly as the engine's default loader does before eligibility ever runs.
    const normalized = ISSUE_900_FIXTURE.map((r) => normalizeDialects(r));
    const { eligible } = filterEligible(normalized);

    const eligibleTypes = eligible.map((l) => l.type);
    const proposedCount = eligibleTypes.filter(
      (t) => t === 'proven-pattern' || t === 'anti-pattern' || t === 'workflow-pattern',
    ).length;

    expect(proposedCount).toBe(28); // 14 pattern + 12 gotcha + 2 workflow-pattern
    expect(eligible).toHaveLength(28);
  });

  it('rejects every effective-sizing/process/scope-guidance/infra/deviation-pattern record on the type gate, despite file_paths (14 total)', () => {
    const normalized = ISSUE_900_FIXTURE.map((r) => normalizeDialects(r));
    const { rejected } = filterEligible(normalized);

    const stillUnknown = rejected.filter((r) =>
      ['effective-sizing', 'process', 'scope-guidance', 'infra', 'deviation-pattern'].includes(
        r.learning.type,
      ),
    );
    expect(stillUnknown).toHaveLength(14); // 6 + 3 + 2 + 2 + 1

    for (const r of stillUnknown) {
      expect(r.reason).toMatch(/not in convert allow-list/);
    }
  });

  it('rejects every scope-lacking recurring-issue/fragile-file record on the file gate (7 total)', () => {
    const normalized = ISSUE_900_FIXTURE.map((r) => normalizeDialects(r));
    const { rejected } = filterEligible(normalized);

    const scopeLacking = rejected.filter(
      (r) => r.learning.type === 'recurring-issue' || r.learning.type === 'fragile-file',
    );
    expect(scopeLacking).toHaveLength(7); // 6 recurring-issue + 1 fragile-file

    for (const r of scopeLacking) {
      expect(r.reason).toMatch(/empty file_paths/);
    }
  });

  it('totals 49 = 28 eligible + 21 rejected (14 unknown-type + 7 scope-lacking)', () => {
    const normalized = ISSUE_900_FIXTURE.map((r) => normalizeDialects(r));
    const { eligible, rejected } = filterEligible(normalized);
    expect(eligible).toHaveLength(28);
    expect(rejected).toHaveLength(21);
    expect(eligible.length + rejected.length).toBe(49);
  });
});
