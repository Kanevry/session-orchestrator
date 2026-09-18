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
 *   - the MAX `created_at` across `loadCandidates({repoRoot}).records` is the
 *     most recent reconcile run's timestamp (or `null` when the store is
 *     empty — i.e. no run on record, matching the fleet finding above).
 *     `.skipped` is read alongside it because `records.length === 0` alone is
 *     AMBIGUOUS: a missing store and a store whose every line failed the
 *     candidate shape guard both yield `[]`. Reporting "never" for the latter
 *     denies a run whose record was merely quarantined (GitLab #955 finding 2).
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
 *   - `countReconcileBacklog` (`./reconcile/backlog.mjs`) — the SAME eligibility +
 *     materialization partition `/reconcile` applies, imported from the LEAF module
 *     rather than from `./reconcile/engine.mjs`. The engine is WRITE-capable (it
 *     merges the candidate store) and drags the emitter, renderer and unicode
 *     validator behind it: importing the count from there took this probe's static
 *     closure from 11 modules / 151,946 B to 19 / 322,897 B (+112 %, measured
 *     2026-09-18), inherited unasked by `maintenance-due-banner.mjs`. A banner must
 *     not be able to reach a writer.
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
import { countReconcileBacklog } from './reconcile/backlog.mjs';
import { loadCandidates } from './reconcile/idempotency.mjs';
import { readConfigFile } from './config/io.mjs';
import { _parseReconcile } from './config/reconcile.mjs';

/** Repo-relative location of the learnings corpus (mirrors engine.mjs's own constant — not exported there). */
const LEARNINGS_PATH = '.orchestrator/metrics/learnings.jsonl';

/** Nudge threshold (a): active-learning count with no reconcile run on record. */
export const NUDGE_MIN_LEARNINGS = 20;

/** Nudge threshold (b): new learnings accrued since the last determinable reconcile run. */
export const NUDGE_MIN_DELTA = 15;

/**
 * Nudge threshold (c): reconcile BACKLOG — rule-eligible learnings (type + file_paths
 * allow-list, not expired, regardless of confidence) MINUS those already materialized
 * in the idempotency sidecar or a `.claude/rules/` provenance marker. Counting the
 * materialized ones too made the probe un-greenable (#1380: 98 eligible, 35 already
 * materialized, and no `/reconcile` run could ever clear it).
 */
export const NUDGE_MIN_ELIGIBLE = 3;

/**
 * Resolve the `reconcile` Session Config settings this module needs, in ONE read.
 *
 * Both consumers go through here, so the nudge can never judge on a different
 * population than `/reconcile` does: the skill reads `reconcile.min-insight-chars`
 * (default 24) and forwards it to the engine, and so must this probe. Before #1380
 * follow-up the value was only read AFTER the backlog had already been counted, which
 * left the placeholder-insight gate practically OFF for the banner.
 *
 * Precedence: an injected already-parsed Session Config wins per KEY (DI seam, avoids a
 * second CLAUDE.md read); any key it does not carry falls back to parsing
 * CLAUDE.md/AGENTS.md; an unreadable config falls back to `_parseReconcile('')`, i.e.
 * the parser's OWN documented defaults — never a literal repeated here.
 *
 * Never throws.
 *
 * @param {string} repoRoot
 * @param {unknown} [config] already-parsed Session Config
 * @returns {Promise<{enabled: boolean, minInsightChars: number}>}
 */
async function _resolveReconcileSettings(repoRoot, config) {
  const injected =
    config && typeof config === 'object' && /** @type {any} */ (config).reconcile &&
    typeof (/** @type {any} */ (config).reconcile) === 'object'
      ? /** @type {Record<string, unknown>} */ (/** @type {any} */ (config).reconcile)
      : null;

  const hasEnabled = injected !== null && typeof injected.enabled === 'boolean';
  const hasChars = injected !== null && Number.isFinite(injected['min-insight-chars']);
  if (hasEnabled && hasChars) {
    return {
      enabled: /** @type {boolean} */ (injected.enabled),
      minInsightChars: Number(injected['min-insight-chars']),
    };
  }

  let parsed;
  try {
    parsed = _parseReconcile(await readConfigFile(repoRoot));
  } catch {
    // Config unreadable — take the parser's own defaults (single source of truth).
    parsed = _parseReconcile('');
  }

  return {
    enabled: hasEnabled ? /** @type {boolean} */ (injected.enabled) : parsed.enabled,
    minInsightChars: hasChars
      ? Number(injected['min-insight-chars'])
      : parsed['min-insight-chars'],
  };
}

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
 * @param {Date|number} [opts.now] — injectable clock, forwarded to the active-learning
 *   filter AND the eligibility expiry gate.
 * @param {number} [opts.minInsightChars] — forwarded to the eligibility filter. When
 *   OMITTED the value is read from Session Config (`reconcile.min-insight-chars`,
 *   default 24) rather than left inert, so the nudge and `/reconcile` count the SAME
 *   population — see `_resolveReconcileSettings`.
 * @param {object} [opts.config] — optional already-parsed Session Config (DI seam).
 * @returns {Promise<{
 *   totalLearnings: number,
 *   activeLearnings: number,
 *   eligibleCount: number,
 *   alreadyMaterialized: number,
 *   backlogCount: number,
 *   lastRunAt: string|null,
 *   lastRunCandidateCount: number,
 *   delta: number,
 *   nudge: boolean,
 *   reasons: string[],
 *   skippedCandidates?: number,
 * }>}
 *   `skippedCandidates` is ABSENT when the candidate store was never inspected
 *   (early empty-corpus return, or an unreadable store); `0` means inspected and
 *   clean, `> 0` means that many persisted lines failed the candidate shape guard.
 */
export async function computeReconcileNudge(opts = {}) {
  const empty = {
    totalLearnings: 0,
    activeLearnings: 0,
    eligibleCount: 0,
    alreadyMaterialized: 0,
    backlogCount: 0,
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

  // Same partition a real /reconcile run applies (engine.mjs step 3/3a) — one
  // truth, so the nudge can only fire on work /reconcile is able to clear.
  // That includes the placeholder-insight gate: when the caller did not supply
  // `minInsightChars`, read it from Session Config BEFORE counting, or the
  // banner counts learnings `/reconcile` would reject.
  const minInsightChars = Number.isFinite(opts.minInsightChars)
    ? Number(opts.minInsightChars)
    : (await _resolveReconcileSettings(repoRoot, opts.config)).minInsightChars;

  // The candidate store is read ONCE, BEFORE the backlog count — the count needs
  // the same records for its sidecar-dedupe half, and reading them here lets it
  // be handed down instead of read a second time (`candidatesRead` says whether
  // the hand-down is trustworthy; on a failed read we hand nothing down and let
  // `countReconcileBacklog` decide for itself rather than pass a fake empty set).
  /** @type {Array<Record<string, unknown>>} */
  let candidates;
  /** @type {number|undefined} */
  let skippedCandidates;
  let candidatesRead = false;
  try {
    const diag = loadCandidates({ repoRoot });
    candidates = Array.isArray(diag?.records) ? diag.records : [];
    candidatesRead = Array.isArray(diag?.records);
    // Absence-preserving, mirroring `engine.mjs` `summary.skipped`: only a
    // finite count means "the store was inspected". Absent ⇒ never checked,
    // 0 ⇒ checked and clean.
    if (Number.isFinite(diag?.skipped)) skippedCandidates = Number(diag.skipped);
  } catch {
    candidates = [];
    // Store never inspected → leave `skippedCandidates` absent rather than
    // fabricating a clean 0.
  }

  // ONE corpus, ONE population. `entries` (read above via `readLearnings`) is
  // handed down instead of letting the count re-read and re-normalize the same
  // file: the banner line names `activeLearnings` and `backlogCount` side by
  // side, and two independent reads of one file are two populations wearing one
  // sentence (HR-106). `repoRoot` stays required — the sidecar and the
  // `.claude/rules/` provenance scan are resolved from it.
  // Never throws (all-zero on failure).
  const {
    eligible: eligibleCount,
    alreadyMaterialized,
    backlog: backlogCount,
  } = countReconcileBacklog({
    repoRoot,
    learnings: entries,
    ...(candidatesRead ? { existingCandidates: candidates } : {}),
    now: opts.now,
    minInsightChars,
  });

  const lastRunAt = _lastRunAt(candidates);
  const lastRunCandidateCount = Array.isArray(candidates) ? candidates.length : 0;
  const delta = entries.length - lastRunCandidateCount;
  const quarantined = typeof skippedCandidates === 'number' ? skippedCandidates : 0;

  const reasons = [];
  // (a) — plenty of active learnings and no DATEABLE run on record. When the
  // store holds quarantined lines the honest claim is "undeterminable", not
  // "never": the evidence exists, it is merely unreadable. /reconcile is still
  // the right action either way — mergeCandidates rewrites the store in full and
  // purges the bad lines — so the nudge fires in both cases, only the wording
  // differs.
  if (active.length >= NUDGE_MIN_LEARNINGS && lastRunAt === null) {
    reasons.push(
      quarantined > 0
        ? `${active.length} active learnings; last reconcile run undeterminable — ${quarantined} unreadable record(s) in the candidate store`
        : `${active.length} active learnings with no reconcile run on record`,
    );
  }
  // (b) — a determinable prior run exists, and the corpus has grown meaningfully since.
  if (lastRunAt !== null && delta > NUDGE_MIN_DELTA) {
    reasons.push(`${delta} new learnings since the last reconcile run`);
  }
  // (c) — enough NOT-YET-MATERIALIZED rule-eligible learnings to be worth a
  // batch, independent of confidence. HR-106: the reason names the number judged.
  if (backlogCount >= NUDGE_MIN_ELIGIBLE) {
    reasons.push(`${backlogCount} rule-eligible learnings awaiting a rule`);
  }

  const computed = {
    totalLearnings: entries.length,
    activeLearnings: active.length,
    eligibleCount,
    alreadyMaterialized,
    backlogCount,
    lastRunAt,
    lastRunCandidateCount,
    delta,
    nudge: reasons.length > 0,
    reasons,
  };
  // Additive + absence-preserving: the key exists ONLY when the candidate store
  // was actually inspected, so no consumer can read a false `skippedCandidates: 0`.
  if (typeof skippedCandidates === 'number') {
    /** @type {any} */ (computed).skippedCandidates = skippedCandidates;
  }
  return computed;
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

    // ONE config read for both settings, BEFORE the backlog is counted — the
    // `min-insight-chars` gate must reach `countReconcileBacklog`, and reading the
    // config afterwards (as this did before) left it inert.
    let reconcileEnabled = false;
    let minInsightChars;
    try {
      ({ enabled: reconcileEnabled, minInsightChars } = await _resolveReconcileSettings(
        repoRoot,
        config,
      ));
    } catch {
      // Unreachable in practice (_resolveReconcileSettings never throws) — keep the
      // conservative default and let computeReconcileNudge resolve the gate itself.
      reconcileEnabled = false;
    }

    let computed;
    try {
      computed = await computeReconcileNudge({ repoRoot, now, minInsightChars });
    } catch {
      return null;
    }
    if (!computed || computed.nudge !== true) return null;

    // Three-state last-run label. `never` is a claim about history and must only
    // be made when the store was inspected and held nothing: a store whose lines
    // were quarantined by the shape guard is EVIDENCE OF A RUN that can no longer
    // be dated, so it reads `undeterminable` — saying "never" there would assert
    // an absence the file on disk contradicts (GitLab #955 finding 2).
    const quarantined =
      Number.isFinite(computed.skippedCandidates) && computed.skippedCandidates > 0
        ? Number(computed.skippedCandidates)
        : 0;
    const dated =
      typeof computed.lastRunAt === 'string' && computed.lastRunAt.length >= 10
        ? computed.lastRunAt.slice(0, 10)
        : null;
    let lastRunLabel;
    if (dated !== null) {
      // Partially contaminated: the date is real but derived only from the
      // surviving records, so flag that it may under-report.
      lastRunLabel =
        quarantined > 0
          ? `${dated} (+${quarantined} unreadable record(s) — date may be stale)`
          : dated;
    } else {
      lastRunLabel =
        quarantined > 0
          ? `undeterminable (${quarantined} unreadable record(s) in the candidate store)`
          : 'never';
    }

    const lines = [
      `⚠ reconcile-nudge: ${computed.activeLearnings} active learnings, ${computed.backlogCount} rule-eligible awaiting a rule ` +
        `(${computed.alreadyMaterialized} already materialized), ` +
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
