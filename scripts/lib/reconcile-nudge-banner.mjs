/**
 * reconcile-nudge-banner.mjs — #723 (Epic #723 B1, Flaggschiff-Konvergenz 11).
 *
 * Deterministic session-start nudge for the Learning→Rule reconciliation
 * pipeline. Fleet finding: `reconcile.enabled` defaults to `false` (silent
 * no-op) and `/reconcile` is on-demand-only — repos with 131/123/101
 * learnings on disk had ZERO reconcile runs, because nothing ever told the
 * operator the corpus had accumulated enough evidence to be worth converting.
 * This probe closes that gap the same way `loop-readiness-banner.mjs` (#633)
 * closes the "no .claude/loop.md" gap: a single `checkXxx({repoRoot})` entry
 * point that returns `null` (silent no-op) or `{severity:'warn', message}`.
 *
 * Deliberately introduces NO new Session Config key — per the #723 scope note,
 * an advisory-only banner needs no on/off switch of its own (mirrors
 * `ci-status-banner.mjs` / `qg-command-drift-banner.mjs` / `loop-readiness-banner.mjs`,
 * none of which carry a dedicated enable flag). The EXISTING `reconcile.enabled`
 * key is read only to decide whether to append an informational parenthetical —
 * never to gate the probe itself.
 *
 * "Last reconcile run" provenance (researched, not guessed): the reconciliation
 * engine (`scripts/lib/reconcile/engine.mjs` `runReconcile`) writes exactly ONE
 * disk artifact per run — the idempotency sidecar at
 * `.orchestrator/runtime/reconcile-candidates.jsonl` (owned by
 * `scripts/lib/reconcile/idempotency.mjs`). Every learning present at a given
 * run (eligible OR rejected) gets a candidate row, so:
 *   - the MAX `created_at` across `loadCandidates({repoRoot})` is the most
 *     recent reconcile run's timestamp (or `null` when the store is empty —
 *     i.e. no run on record, matching the fleet finding above).
 *   - the candidate COUNT is a reasonable proxy for "how many learnings had
 *     been seen as of the last run" (dedup is by `learning_key`, so it is a
 *     high-water mark across all runs to date), used for the "new learnings
 *     since last run" delta heuristic.
 * There is no separate `reconcile`-scoped event in `.orchestrator/metrics/events.jsonl`
 * — the idempotency sidecar IS the durable run record, so this module reads
 * that directly rather than re-deriving a signal from the generic event log.
 *
 * Reuses the existing learnings-corpus helpers rather than re-implementing
 * filter logic:
 *   - `readLearnings` (`./learnings/io.mjs`) — normalized entries (files→file_paths
 *     dialect rename applied), used for the eligibility count.
 *   - `surfaceTopN` (`./learnings/surface.mjs`) — the canonical active-learning
 *     filter (confidence > floor, not expired); called with a large cap to get
 *     the full active set rather than a top-N slice.
 *   - `filterEligible` (`./reconcile/eligibility.mjs`) — the SAME type/file_paths
 *     allow-list gate the reconcile engine itself uses (deliberately NOT
 *     confidence-gated — mirrors `runReconcile`'s own posture, see
 *     `skills/reconcile/SKILL.md` Phase 2.2).
 *
 * Plain-JS — no Zod dependency. Never throws. `computeReconcileNudge` always
 * returns the full shape (never null); `checkReconcileNudge` returns the
 * session-start banner object or null.
 *
 * Cross-references:
 *  - `.claude/rules/verification-before-completion.md` — evidence-before-claims.
 *  - `scripts/lib/loop-readiness-banner.mjs` — the banner-shape template.
 *  - `scripts/lib/reconcile/engine.mjs` / `idempotency.mjs` / `eligibility.mjs`.
 *  - `scripts/lib/learnings/io.mjs` / `surface.mjs`.
 *  - `scripts/lib/config/reconcile.mjs` (`_parseReconcile`) — existing config key.
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site.
 *  - Issue #723.
 */

import { join } from 'node:path';

import { readLearnings } from './learnings/io.mjs';
import { surfaceTopN } from './learnings/surface.mjs';
import { filterEligible } from './reconcile/eligibility.mjs';
import { loadCandidates } from './reconcile/idempotency.mjs';
import { readConfigFile } from './config/io.mjs';
import { _parseReconcile } from './config/reconcile.mjs';

/** Repo-relative location of the learnings corpus (mirrors engine.mjs's own constant — not exported there). */
const LEARNINGS_PATH = '.orchestrator/metrics/learnings.jsonl';

/** Nudge threshold (a): active-learning count with no reconcile run on record. */
export const NUDGE_MIN_LEARNINGS = 20;

/** Nudge threshold (b): new learnings accrued since the last determinable reconcile run. */
export const NUDGE_MIN_DELTA = 15;

/** Nudge threshold (c): rule-eligible learnings (type + file_paths allow-list), regardless of confidence. */
export const NUDGE_MIN_ELIGIBLE = 3;

/**
 * Resolve the max `created_at` across reconcile-candidate sidecar records —
 * the most recent reconcile run's timestamp, or `null` when no run is on
 * record (empty store, missing file, or no parseable timestamp).
 *
 * @param {Array<{created_at?: unknown}>} candidates
 * @returns {string|null} ISO 8601 timestamp, or null
 */
function _lastRunAt(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  let maxMs = -Infinity;
  for (const c of candidates) {
    const t = c && typeof c.created_at === 'string' ? Date.parse(c.created_at) : NaN;
    if (Number.isFinite(t) && t > maxMs) maxMs = t;
  }
  return Number.isFinite(maxMs) && maxMs > -Infinity ? new Date(maxMs).toISOString() : null;
}

/**
 * Pure computation — always returns the full shape (never null, never throws).
 * Touches disk only via the injected/default learnings + candidates readers,
 * all of which are themselves never-throwing.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — project root (defaults to process.cwd()).
 * @param {Date|number} [opts.now] — injectable clock, forwarded to the active-learning filter.
 * @returns {Promise<{
 *   totalLearnings: number,
 *   activeLearnings: number,
 *   eligibleCount: number,
 *   lastRunAt: string|null,
 *   lastRunCandidateCount: number,
 *   delta: number,
 *   nudge: boolean,
 *   reasons: string[],
 * }>}
 */
export async function computeReconcileNudge(opts = {}) {
  const empty = {
    totalLearnings: 0,
    activeLearnings: 0,
    eligibleCount: 0,
    lastRunAt: null,
    lastRunCandidateCount: 0,
    delta: 0,
    nudge: false,
    reasons: [],
  };

  const repoRoot = typeof opts.repoRoot === 'string' && opts.repoRoot.length > 0 ? opts.repoRoot : process.cwd();
  const learningsPath = join(repoRoot, LEARNINGS_PATH);

  /** @type {object[]} */
  let entries;
  try {
    const result = await readLearnings(learningsPath);
    entries = Array.isArray(result?.entries) ? result.entries : [];
  } catch {
    return empty; // fail-open — never throw out of the probe
  }

  // Silent no-op: missing file, empty file, or all-malformed lines all
  // collapse to entries.length === 0 here.
  if (entries.length === 0) return empty;

  /** @type {object[]} */
  let active;
  try {
    // Reuse surfaceTopN's active-filter (confidence > floor, not expired)
    // uncapped — pass a large `n` to get the FULL active set, not a top slice.
    active = await surfaceTopN(learningsPath, Number.MAX_SAFE_INTEGER, { now: opts.now });
  } catch {
    active = [];
  }

  if (active.length === 0) return empty;

  let eligibleCount;
  try {
    eligibleCount = filterEligible(entries).eligible.length;
  } catch {
    eligibleCount = 0;
  }

  /** @type {Array<Record<string, unknown>>} */
  let candidates;
  try {
    candidates = loadCandidates({ repoRoot });
  } catch {
    candidates = [];
  }

  const lastRunAt = _lastRunAt(candidates);
  const lastRunCandidateCount = Array.isArray(candidates) ? candidates.length : 0;
  const delta = entries.length - lastRunCandidateCount;

  const reasons = [];
  // (a) — plenty of active learnings, but no reconcile run has ever recorded them.
  if (active.length >= NUDGE_MIN_LEARNINGS && lastRunAt === null) {
    reasons.push(`${active.length} active learnings with no reconcile run on record`);
  }
  // (b) — a determinable prior run exists, and the corpus has grown meaningfully since.
  if (lastRunAt !== null && delta > NUDGE_MIN_DELTA) {
    reasons.push(`${delta} new learnings since the last reconcile run`);
  }
  // (c) — enough rule-eligible learnings to be worth a batch, independent of confidence.
  if (eligibleCount >= NUDGE_MIN_ELIGIBLE) {
    reasons.push(`${eligibleCount} rule-eligible learnings`);
  }

  return {
    totalLearnings: entries.length,
    activeLearnings: active.length,
    eligibleCount,
    lastRunAt,
    lastRunCandidateCount,
    delta,
    nudge: reasons.length > 0,
    reasons,
  };
}

/**
 * Best-effort extraction of `reconcile.enabled` from an already-parsed Session
 * Config object (DI/test seam — avoids re-reading CLAUDE.md when the caller
 * already has it). Returns `null` when unresolvable from `config` alone, in
 * which case `checkReconcileNudge` falls back to reading CLAUDE.md/AGENTS.md.
 *
 * @param {unknown} config
 * @returns {boolean|null}
 */
function _reconcileEnabledFromConfig(config) {
  if (config && typeof config === 'object') {
    const rc = /** @type {Record<string, unknown>} */ (config).reconcile;
    if (rc && typeof rc === 'object' && typeof (/** @type {any} */ (rc).enabled) === 'boolean') {
      return /** @type {any} */ (rc).enabled;
    }
  }
  return null;
}

/**
 * Check reconcile-nudge readiness and produce a session-start banner.
 *
 * Silent (`null`) when: no learnings corpus (missing/empty/all-malformed),
 * zero active learnings, or none of the three nudge thresholds are met.
 * Never throws.
 *
 * @param {{repoRoot: string, config?: object, now?: Date|number}} opts
 *   - `repoRoot`: REQUIRED absolute path to the repo root.
 *   - `config`: optional already-parsed Session Config (DI seam; avoids a
 *     second CLAUDE.md read when the caller already parsed it).
 *   - `now`: optional injectable clock, forwarded to the active-learning filter.
 * @returns {Promise<null | {severity:'warn', message:string}>}
 */
export async function checkReconcileNudge(opts = {}) {
  try {
    const { repoRoot, config, now } = opts;
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    let computed;
    try {
      computed = await computeReconcileNudge({ repoRoot, now });
    } catch {
      return null;
    }
    if (!computed || computed.nudge !== true) return null;

    let reconcileEnabled = _reconcileEnabledFromConfig(config);
    if (reconcileEnabled === null) {
      try {
        const content = await readConfigFile(repoRoot);
        reconcileEnabled = _parseReconcile(content).enabled;
      } catch {
        // Config unreadable — fall back to the documented config default (false)
        // so the informational parenthetical still renders conservatively.
        reconcileEnabled = false;
      }
    }

    const lastRunLabel =
      typeof computed.lastRunAt === 'string' && computed.lastRunAt.length >= 10
        ? computed.lastRunAt.slice(0, 10)
        : 'never';

    const lines = [
      `⚠ reconcile-nudge: ${computed.activeLearnings} active learnings, ${computed.eligibleCount} rule-eligible, ` +
        `last reconcile run: ${lastRunLabel} — run /reconcile to convert learnings into rules.`,
    ];
    if (reconcileEnabled === false) {
      lines.push(
        '  (reconcile.enabled: false — banner is advisory only; /reconcile still runs on-demand.)'
      );
    }

    return { severity: 'warn', message: lines.join('\n') };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
