/**
 * eligibility.mjs — Reconciliation-engine eligibility filter (Epic #693 FA2, issue #695).
 *
 * Decides which `learnings.jsonl` entries are eligible to be converted into a
 * conditional `.claude/rules/*.md` rule. A learning is a plain in-memory JSON
 * object; this module classifies and partitions such objects without any I/O.
 *
 * ── Safe posture (INVERTED allow-list) ───────────────────────────────────────
 * The engine default-rejects. Only a learning whose `type` is in
 * {@link CONVERT_TYPES} AND that carries a non-empty `file_paths[]` (the scope a
 * conditional rule needs) is eligible. Everything else is rejected with a
 * specific audit reason. This is the safe default the issue demands: a corpus
 * of unknown types never silently produces a rule.
 *
 * ── The file-carrier key ─────────────────────────────────────────────────────
 * The scope key we read is `file_paths` (an array of repo-relative paths).
 * Provenance (corrected 2026-07-02, Epic #723 B2): the live corpus historically
 * carried the scope under `files`, NOT `file_paths` — so this reader matched
 * nothing (0/108 records had `file_paths`). Two fixes now converge on
 * `file_paths` and keep this reader correct:
 *   1. `scripts/backfill-learnings.mjs` normalized the on-disk corpus
 *      `files` → `file_paths` (one-shot, 2026-07-02).
 *   2. The schema SSOT (`learnings/schema.mjs` normalizeDialects) renames
 *      `files` → `file_paths` on every read + migration going forward.
 * We continue to read `file_paths` — it is now the canonical scope key.
 * NOTE: this module reads its learnings via the engine's raw JSONL loader
 * (`defaultLoadLearnings`), which does NOT pass records through
 * normalizeLearning — so post-backfill correctness relies on the on-disk
 * `file_paths` written by fix (1); wiring the raw loader through the SSOT is a
 * separate follow-up.
 *
 * ── Type-name mapping (issue → real) ─────────────────────────────────────────
 *   issue 'fragile-file'    -> real 'fragile-file'    (verbatim; 1 instance)
 *   issue 'recurring-issue' -> real 'recurring-issue' (verbatim; 1 instance)
 *   issue 'anti-pattern'    -> real 'anti-pattern'    (verbatim; 22 instances)
 * Forward-compat spec names with 0 instances today are also included so a future
 * renamed corpus still converts (they convert nothing now — harmless). See the
 * CONVERT_TYPES doc for the full 2026-07-02 instance census.
 *
 * Pure functions, no external dependencies — Node 20+ stdlib only. No file I/O.
 */

/**
 * The learning `type` values that may become a conditional rule.
 *
 * Instance census (corrected 2026-07-02, Epic #723 B2 — the earlier comment
 * was a stale mis-count that inverted `fragile-file` and `fragile-pattern`):
 *   - 'anti-pattern'         — 22 instances
 *   - 'architecture-pattern' —  2 instances
 *   - 'convention'           —  1 instance
 *   - 'design-pattern'       —  1 instance
 *   - 'fragile-file'         —  1 instance
 *   - 'recurring-issue'      —  1 instance
 *   - 'fragile-pattern'      —  0 instances (kept for forward-compat)
 *   - 'stagnation-class-frequency' — 0 instances (kept for forward-compat)
 *
 * The SET below is UNCHANGED — every listed type stays in the allow-list, so a
 * future renamed/backfilled corpus still converts and 0-instance types convert
 * nothing today. Only the census annotations were corrected.
 *
 * @type {Set<string>}
 */
export const CONVERT_TYPES = new Set([
  // Types with live instances as of 2026-07-02 (count in parens)
  'anti-pattern', //          22
  'architecture-pattern', //   2
  'convention', //             1
  'design-pattern', //         1
  'fragile-file', //           1
  'recurring-issue', //        1
  // Forward-compat: 0 instances today, kept so a future corpus still converts
  'fragile-pattern', //        0
  'stagnation-class-frequency', // 0
]);

/**
 * Classify a single learning record for rule-conversion eligibility.
 *
 * INVERTED allow-list: eligible only when the type is in CONVERT_TYPES AND a
 * non-empty `file_paths[]` is present. The type gate is evaluated before the
 * file gate, so an out-of-allow-list type is rejected as such even when it
 * carries file paths.
 *
 * Defensive: a null / non-object record, or one missing `type`, is rejected
 * (never throws).
 *
 * @param {unknown} learning - an in-memory learning object.
 * @returns {{ eligible: boolean, reason: string }}
 */
export function classifyLearning(learning) {
  if (
    learning === null ||
    typeof learning !== 'object' ||
    Array.isArray(learning) ||
    typeof learning.type !== 'string' ||
    learning.type.length === 0
  ) {
    return { eligible: false, reason: 'invalid learning record (missing type)' };
  }

  const { type } = learning;

  // Type gate beats file gate (safe posture: default-reject unknown types).
  if (!CONVERT_TYPES.has(type)) {
    return {
      eligible: false,
      reason: `type '${type}' not in convert allow-list — default-reject`,
    };
  }

  const filePaths = learning.file_paths;
  if (!Array.isArray(filePaths) || filePaths.length === 0) {
    return {
      eligible: false,
      reason: `eligible type '${type}' but empty file_paths[] — cannot scope a conditional rule`,
    };
  }

  return {
    eligible: true,
    reason: `eligible: ${type} with ${filePaths.length} file path(s)`,
  };
}

/**
 * Partition a list of learnings into eligible records and rejected records
 * (each rejection carrying the specific audit reason).
 *
 * @param {unknown[]} learnings - list of in-memory learning objects.
 * @returns {{ eligible: object[], rejected: Array<{ learning: object, reason: string }> }}
 */
export function filterEligible(learnings) {
  const eligible = [];
  const rejected = [];

  const list = Array.isArray(learnings) ? learnings : [];
  for (const learning of list) {
    const { eligible: isEligible, reason } = classifyLearning(learning);
    if (isEligible) {
      eligible.push(learning);
    } else {
      rejected.push({ learning, reason });
    }
  }

  return { eligible, rejected };
}
