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
 * We continue to read `file_paths` — it is now the canonical scope key. The
 * engine's default JSONL loader also runs records through migrateLegacyLearning
 * + normalizeLearning, so direct `runReconcile({ repoRoot })` calls see the same
 * legacy alias + `files`→`file_paths` mapping as the backfill/read funnels.
 *
 * ── Type-name mapping (issue → real) ─────────────────────────────────────────
 *   issue 'fragile-file'    -> real 'fragile-file'    (verbatim; 1 instance)
 *   issue 'recurring-issue' -> real 'recurring-issue' (verbatim; 1 instance)
 *   issue 'anti-pattern'    -> real 'anti-pattern'    (verbatim; 22 instances)
 * Forward-compat spec names with 0 instances today are also included so a future
 * renamed corpus still converts (they convert nothing now — harmless). See the
 * CONVERT_TYPES doc for the full 2026-07-02 instance census.
 *
 * Pure functions — depends only on the pure `learnings/schema` type registry
 * (a frozen constant; no I/O). Deterministic, no file I/O.
 */

import { LEARNING_TYPE_REGISTRY, LEARNING_TTL_DAYS, deriveExpiresAt } from '../learnings/schema.mjs';

/**
 * Recovery-stub / legacy-backfill placeholder insight signature (issue #741.2).
 * Legacy-recovery records occasionally carry a stub insight instead of a real
 * one (e.g. `"(legacy record — insight backfilled during 2026-07-02 recovery)"`).
 * A placeholder insight would produce an EMPTY rule body downstream (the
 * renderer has nothing meaningful to render) — reject it honestly at the
 * eligibility gate instead of letting a hollow rule reach the proposal stage.
 * @type {RegExp}
 */
const PLACEHOLDER_RE = /insight backfilled during .* recovery|^\(?legacy record\b/i;

/**
 * The learning `type` values that may become a conditional rule. DERIVED
 * (Epic #723 I1, issue #733 Teil b) from `scripts/lib/learnings/schema.mjs`'s
 * `LEARNING_TYPE_REGISTRY`: every type whose `ruleConvertible` flag is `true`.
 *
 * Instance census (corrected 2026-07-02, Epic #723 B2 — the earlier comment
 * was a stale mis-count that inverted `fragile-file` and `fragile-pattern`),
 * kept here as a historical record (the registry itself carries no counts):
 *   - 'anti-pattern'         — 22 instances
 *   - 'architecture-pattern' —  2 instances
 *   - 'convention'           —  1 instance
 *   - 'design-pattern'       —  1 instance
 *   - 'fragile-file'         —  1 instance
 *   - 'recurring-issue'      —  1 instance
 *   - 'fragile-pattern'      —  0 instances (kept for forward-compat)
 *   - 'stagnation-class-frequency' — 0 instances (kept for forward-compat)
 *
 * The membership is UNCHANGED from the prior hand-maintained literal — every
 * listed type stays in the allow-list, so a future renamed/backfilled corpus
 * still converts and 0-instance types convert nothing today.
 *
 * @type {Set<string>}
 */
export const CONVERT_TYPES = new Set(
  Object.entries(LEARNING_TYPE_REGISTRY)
    .filter(([, meta]) => meta.ruleConvertible)
    .map(([type]) => type)
);

/**
 * Classify a single learning record for rule-conversion eligibility.
 *
 * INVERTED allow-list: eligible only when the type is in CONVERT_TYPES AND a
 * non-empty `file_paths[]` is present. The type gate is evaluated before the
 * file gate, so an out-of-allow-list type is rejected as such even when it
 * carries file paths.
 *
 * Two further gates run AFTER the type + file gates succeed (issue #741):
 *   - placeholder-insight (#741.2, always-on): an empty or recovery-stub
 *     insight would produce an empty rule body — rejected honestly rather
 *     than proposed with hollow content. `minInsightChars` additionally
 *     rejects an insight that is non-empty but too short to be useful; it is
 *     opt-in (inert when omitted).
 *   - already-expired-at-proposal (#741.1c, opt-in via `now`): a learning
 *     whose natural TTL (`created_at` + per-type TTL) already elapsed before
 *     proposal time is rejected honestly instead of silently floored back to
 *     life. Inert when `now` is omitted, so existing single-arg callers are
 *     unaffected.
 *
 * Defensive: a null / non-object record, or one missing `type`, is rejected
 * (never throws).
 *
 * @param {unknown} learning - an in-memory learning object.
 * @param {{ now?: number, minInsightChars?: number }} [opts] - now: injectable
 *        clock (ms epoch) gating the expiry check; minInsightChars: opt-in
 *        minimum insight length gating the placeholder check.
 * @returns {{ eligible: boolean, reason: string }}
 */
export function classifyLearning(learning, { now, minInsightChars } = {}) {
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

  // Placeholder-insight gate (#741.2, always-on) — empty or recovery-stub
  // insight would produce an empty rule body downstream.
  const insight = typeof learning.insight === 'string' ? learning.insight.trim() : '';
  if (insight === '' || PLACEHOLDER_RE.test(insight)) {
    return {
      eligible: false,
      reason: `placeholder-insight — insight is empty or a recovery placeholder ("${insight.slice(0, 40)}")`,
    };
  }
  if (typeof minInsightChars === 'number' && minInsightChars > 0 && insight.length < minInsightChars) {
    return {
      eligible: false,
      reason: `placeholder-insight — insight ${insight.length} chars < min-insight-chars ${minInsightChars}`,
    };
  }

  // Already-expired-at-proposal gate (#741.1c, opt-in via `now`) — a learning
  // whose natural TTL already elapsed before proposal time is rejected
  // honestly rather than silently floored back to life at emit time.
  if (typeof now === 'number' && Number.isFinite(now)) {
    const naturalExpiryIso = deriveExpiresAt(learning.created_at, type);
    const naturalExpiryMs = Date.parse(naturalExpiryIso);
    if (Number.isFinite(naturalExpiryMs) && naturalExpiryMs < now) {
      const ttlDays = LEARNING_TTL_DAYS[type] ?? LEARNING_TTL_DAYS.default;
      return {
        eligible: false,
        reason: `already-expired-at-proposal — natural TTL (created_at + ${ttlDays}d) elapsed at ${naturalExpiryIso.slice(0, 10)} before proposal`,
      };
    }
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
 * @param {{ now?: number, minInsightChars?: number }} [opts] - forwarded verbatim
 *        to {@link classifyLearning} for every record.
 * @returns {{ eligible: object[], rejected: Array<{ learning: object, reason: string }> }}
 */
export function filterEligible(learnings, opts = {}) {
  const eligible = [];
  const rejected = [];

  const list = Array.isArray(learnings) ? learnings : [];
  for (const learning of list) {
    const { eligible: isEligible, reason } = classifyLearning(learning, opts);
    if (isEligible) {
      eligible.push(learning);
    } else {
      rejected.push({ learning, reason });
    }
  }

  return { eligible, rejected };
}
