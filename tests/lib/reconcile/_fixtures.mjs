/**
 * _fixtures.mjs — Committed, deterministic, CI-portable test fixture for the
 * #695 FA2 Reconciliation Engine.
 *
 * Replaces the prior golden tests' reads of the REAL learnings corpus
 * (`.orchestrator/metrics/` JSONL) — that corpus is gitignored and absent in a
 * fresh CI clone, so the file-read golden tests threw in CI. This inline fixture
 * preserves the SAME behavioral lock (type gate + file gate + invert) while
 * being deterministic and committed.
 *
 * Expected partition (asserted in eligibility.test.mjs + engine.test.mjs):
 *   eligible = 2  (fragile-pattern+files, recurring-issue+files)
 *   rejected = 4  (eligible type w/ no file_paths ×2, reject type w/ files,
 *                  default-reject type)
 *
 * @type {Array<Record<string, unknown>>}
 */
export const RECONCILE_FIXTURE = [
  // ELIGIBLE — eligible type with non-empty file_paths.
  {
    type: 'fragile-pattern',
    subject: 'eligible-frag',
    insight: 'a',
    confidence: 0.8,
    file_paths: ['scripts/lib/a/x.mjs'],
    created_at: '2026-06-21T00:00:00Z',
  },
  // ELIGIBLE — eligible type with non-empty file_paths.
  {
    type: 'recurring-issue',
    subject: 'eligible-rec',
    insight: 'b',
    confidence: 0.7,
    file_paths: ['scripts/lib/b/y.mjs'],
    created_at: '2026-06-21T00:00:00Z',
  },
  // REJECT — eligible type, no file_paths (cannot scope a conditional rule).
  { type: 'fragile-pattern', subject: 'no-files', insight: 'c', confidence: 0.6 },
  // REJECT — reject type even WITH files (type gate beats file gate).
  {
    type: 'effective-sizing',
    subject: 'sizing',
    insight: 'd',
    confidence: 0.9,
    file_paths: ['scripts/lib/c/z.mjs'],
  },
  // REJECT — default-reject type.
  { type: 'proven-pattern', subject: 'proven', insight: 'e', confidence: 0.95 },
  // REJECT — eligible type, no file_paths.
  { type: 'anti-pattern', subject: 'anti-no-files', insight: 'f', confidence: 0.5 },
];
