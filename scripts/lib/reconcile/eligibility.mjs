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
 * The scope key is `file_paths` (an array of repo-relative paths), NOT `files`.
 * Issue #695 wrote `files[]`, but that key does not exist on disk — the real
 * corpus carries `file_paths` (verified census). We read `file_paths`.
 *
 * ── Type-name mapping (issue → real) ─────────────────────────────────────────
 *   issue 'fragile-file'    -> real 'fragile-pattern'
 *   issue 'recurring-issue' -> real 'recurring-issue' (verbatim)
 *   issue 'anti-pattern'    -> real 'anti-pattern'    (verbatim)
 * Forward-compat spec names with 0 instances today are also included so a future
 * renamed corpus still converts (they convert nothing now — harmless).
 *
 * Pure functions, no external dependencies — Node 20+ stdlib only. No file I/O.
 */

/**
 * The REAL learning `type` values that may become a conditional rule.
 *
 * Real types (present in the corpus today):
 *   - 'fragile-pattern'  (issue spec called this 'fragile-file')
 *   - 'recurring-issue'  (verbatim)
 *   - 'anti-pattern'     (verbatim)
 *
 * Forward-compat issue-spec names (0 instances today — harmless inclusion so a
 * future renamed corpus still converts):
 *   - 'fragile-file', 'stagnation-class-frequency', 'architecture-pattern',
 *     'convention', 'design-pattern'
 *
 * @type {Set<string>}
 */
export const CONVERT_TYPES = new Set([
  // Real types present on disk
  'fragile-pattern',
  'recurring-issue',
  'anti-pattern',
  // Forward-compat issue-spec names (0 instances today)
  'fragile-file',
  'stagnation-class-frequency',
  'architecture-pattern',
  'convention',
  'design-pattern',
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
