/**
 * rank.mjs — autopilot dispatcher ranking scorer (Epic #673 P2, issue #677).
 *
 * Ranks FREE candidate repos so the cross-repo dispatcher can recommend the
 * single most worthwhile one to work on next. Combines three signals into a
 * multiplicative score:
 *
 *   priority  × staleness × readiness
 *
 *  - PRIORITY  — open-backlog severity (critical/high counts) from
 *    `scanBacklog` (scripts/lib/backlog-scan.mjs). null (glab/gh missing or
 *    timeout) ⇒ neutral fallback (1) + a warning. NEVER blocks.
 *  - STALENESS — days since the candidate's last completed session. Older =
 *    more worthwhile (you have not touched it in a while). No prior sessions ⇒
 *    maximally stale.
 *  - READINESS — CI status (red repos are worth less right now) × host
 *    resource verdict (a degraded/critical host de-prioritises everything
 *    equally; it is a host-level signal, fetched once and shared).
 *
 * Design contract (PRD §2 P2.3, §3 FA-2, §4):
 *  - `scoreCandidate` is a PURE, deterministic, documented formula — no I/O.
 *  - `rankCandidates` does all I/O through injectable `deps` so Wave-4 tests
 *    are deterministic. Default `deps` wires the real signal sources.
 *  - GLAB/GH FALLBACK is mandatory: a null priority is ranked on
 *    staleness × readiness only, with a human-readable warning. Never throws,
 *    never blocks.
 *  - All returns are plain serialisable objects (CLI wrapper lands in #678).
 *
 * @typedef {{ repoRoot: string, repoName: string, free: boolean, status: 'frei'|'in-progress'|'force-closed', heartbeat: string|null, sessionId: string|null }} Candidate
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { scanBacklog } from '../backlog-scan.mjs';
import { checkCiStatus as realCheckCiStatus } from '../ci-status-banner.mjs';
import { probe as realProbe, evaluate as realEvaluate } from '../resource-probe.mjs';

/** Staleness cap (days). Beyond this, additional age does not raise the score. */
export const STALENESS_CAP_DAYS = 90;

/** Day length in ms — shared age-in-days idiom (mirrors backlog-scan ageDays). */
const MS_PER_DAY = 86_400_000;

/**
 * Canonical resource-threshold defaults (mirrors
 * scripts/lib/config/vault-integration.mjs `_parseResourceThresholds`).
 * Used by the default `resourceVerdict` dep so ranking works standalone
 * without a parsed Session Config in hand.
 */
const DEFAULT_RESOURCE_THRESHOLDS = {
  'ram-free-min-gb': 4,
  'ram-free-critical-gb': 2,
  'cpu-load-max-pct': 80,
  'concurrent-sessions-warn': 5,
};

// ---------------------------------------------------------------------------
// PURE core
// ---------------------------------------------------------------------------

/**
 * Score a single candidate from its gathered signals. Pure + deterministic.
 *
 * FORMULA (multiplicative — higher = more worth working on):
 *
 *   priorityScore   = priority
 *                       ? 1 + 2·criticalCount + 1·highCount
 *                       : 1                         // null ⇒ neutral fallback
 *   stalenessScore  = 1 + min(staleDays, 90) / 30  // older = higher, capped
 *   readinessScore  = ciFactor · resourceFactor
 *       ciFactor       = ciStatus === 'red' ? 0.25 : 1
 *                        // null / 'unknown' / 'green' are all non-blocking (1)
 *       resourceFactor = critical ? 0.25 : degraded ? 0.6 : 1
 *                        // 'green' / 'warn' ⇒ 1
 *
 *   score = priorityScore · stalenessScore · readinessScore
 *
 * Rationale:
 *  - A candidate with no backlog signal is neither rewarded nor punished — it
 *    competes on staleness × readiness alone (the glab/gh fallback).
 *  - Staleness is bounded so an ancient repo cannot dominate purely on age.
 *  - Readiness only ever DAMPENS (factors ≤ 1): a red CI or a strained host
 *    makes a repo less attractive right now, but never negative.
 *
 * @param {{
 *   priority: { criticalCount: number, highCount: number } | null,
 *   staleDays: number,
 *   readiness: {
 *     ciStatus: 'green'|'red'|'unknown'|null,
 *     resourceVerdict: 'green'|'warn'|'degraded'|'critical',
 *   },
 * }} signals
 * @returns {number} score (≥ 0; higher = more worthwhile)
 */
export function scoreCandidate(signals) {
  const { priority, staleDays, readiness } = signals;

  const priorityScore = priority
    ? 1 + 2 * (priority.criticalCount || 0) + 1 * (priority.highCount || 0)
    : 1;

  // Guard against NaN/negative staleDays — clamp to [0, cap].
  const safeStaleDays =
    typeof staleDays === 'number' && Number.isFinite(staleDays) && staleDays > 0
      ? staleDays
      : 0;
  const stalenessScore = 1 + Math.min(safeStaleDays, STALENESS_CAP_DAYS) / 30;

  const ciStatus = readiness?.ciStatus ?? null;
  const resourceVerdict = readiness?.resourceVerdict ?? 'green';

  const ciFactor = ciStatus === 'red' ? 0.25 : 1;
  const resourceFactor =
    resourceVerdict === 'critical'
      ? 0.25
      : resourceVerdict === 'degraded'
        ? 0.6
        : 1;
  const readinessScore = ciFactor * resourceFactor;

  return priorityScore * stalenessScore * readinessScore;
}

// ---------------------------------------------------------------------------
// Default signal-source implementations (the real wiring)
// ---------------------------------------------------------------------------

/**
 * Default PRIORITY source: run `scanBacklog` against the candidate repo.
 *
 * `scanBacklog` keys off the CURRENT process git remote, so to score a
 * DIFFERENT repo we run it with that repo as the working directory and restore
 * cwd afterwards. Returns the scanBacklog summary or null (CLI missing /
 * timeout / parse-fail). Never throws.
 *
 * @param {string} repoRoot
 * @param {number} nowMs
 * @returns {Promise<null | {criticalCount: number, highCount: number}>}
 */
async function defaultFetchPriority(repoRoot, nowMs) {
  const prevCwd = process.cwd();
  try {
    process.chdir(repoRoot);
    return await scanBacklog({ nowMs });
  } catch {
    return null;
  } finally {
    try {
      process.chdir(prevCwd);
    } catch {
      /* best-effort cwd restore */
    }
  }
}

/**
 * Default STALENESS source: read `<repoRoot>/.orchestrator/metrics/sessions.jsonl`,
 * take the LAST record, and compute days since `completed_at` (fallback
 * `started_at`). No file / no parsable record / no timestamp ⇒
 * `STALENESS_CAP_DAYS` (treat as maximally stale = most worthwhile).
 *
 * @param {string} repoRoot
 * @param {number} nowMs
 * @returns {Promise<number>} days since last session (≥ 0)
 */
async function defaultStaleDaysFor(repoRoot, nowMs) {
  try {
    const file = path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
    const raw = readFileSync(file, 'utf8');
    const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return STALENESS_CAP_DAYS;

    // Last non-empty line = most recent session record.
    let last = null;
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        last = JSON.parse(lines[i]);
        break;
      } catch {
        // Skip a corrupt trailing line and try the previous one.
      }
    }
    if (!last || typeof last !== 'object') return STALENESS_CAP_DAYS;

    const iso = last.completed_at || last.started_at || null;
    if (!iso || typeof iso !== 'string') return STALENESS_CAP_DAYS;
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return STALENESS_CAP_DAYS;

    const days = (nowMs - t) / MS_PER_DAY;
    return days > 0 ? days : 0;
  } catch {
    // No sessions file (or unreadable) ⇒ never worked on ⇒ maximally stale.
    return STALENESS_CAP_DAYS;
  }
}

/**
 * Default READINESS (CI) source: thin wrapper over `checkCiStatus`.
 * Returns the 'green'|'red'|'unknown' status string, or null (no-op).
 * null / 'unknown' are treated as non-blocking by `scoreCandidate`.
 *
 * @param {{ repoRoot: string }} args
 * @returns {Promise<'green'|'red'|'unknown'|null>}
 */
async function defaultCheckCiStatus({ repoRoot }) {
  try {
    const result = await realCheckCiStatus({ repoRoot });
    return result && typeof result.status === 'string' ? result.status : null;
  } catch {
    return null;
  }
}

/**
 * Default READINESS (resource) source: probe the host ONCE and evaluate against
 * the canonical default thresholds. This is a HOST-level signal (identical for
 * every candidate), so `rankCandidates` calls it exactly once per ranking run.
 * Falls back to 'green' (non-dampening) on any failure.
 *
 * @returns {Promise<'green'|'warn'|'degraded'|'critical'>}
 */
async function defaultResourceVerdict() {
  try {
    const snapshot = await realProbe();
    const { verdict } = realEvaluate(snapshot, DEFAULT_RESOURCE_THRESHOLDS);
    return verdict || 'green';
  } catch {
    return 'green';
  }
}

/**
 * Build the default `deps` object. Exposed for tests that want to override a
 * single dep while keeping the real ones for the rest.
 *
 * @returns {{
 *   fetchPriority: (repoRoot: string, nowMs: number) => Promise<null | {criticalCount: number, highCount: number}>,
 *   staleDaysFor: (repoRoot: string, nowMs: number) => Promise<number>,
 *   checkCiStatus: (args: { repoRoot: string }) => Promise<'green'|'red'|'unknown'|null>,
 *   resourceVerdict: () => Promise<'green'|'warn'|'degraded'|'critical'>,
 * }}
 */
export function defaultDeps() {
  return {
    fetchPriority: defaultFetchPriority,
    staleDaysFor: defaultStaleDaysFor,
    checkCiStatus: defaultCheckCiStatus,
    resourceVerdict: defaultResourceVerdict,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Rank a list of FREE candidate repos (the dispatcher pre-filters
 * `free === true`). Gathers signals via injectable `deps`, scores each
 * candidate with the pure `scoreCandidate` formula, and sorts DESC by score.
 *
 * Sort is deterministic: score DESC, then staleDays DESC, then repoName ASC.
 * `ranked[0]` is the top recommendation.
 *
 * GLAB/GH FALLBACK: when `deps.fetchPriority` returns null (CLI missing /
 * timeout), the candidate is scored with `priority: null` (neutral 1) AND a
 * warning is pushed. Never throws, never blocks.
 *
 * The host resource verdict is fetched ONCE (host-level signal) and shared
 * across all candidates.
 *
 * @param {Candidate[]} freeCandidates
 * @param {{
 *   now?: number,
 *   deps?: Partial<ReturnType<typeof defaultDeps>>,
 * }} [opts]
 * @returns {Promise<{
 *   ranked: Array<{ candidate: Candidate, score: number, signals: {
 *     priority: { criticalCount: number, highCount: number } | null,
 *     staleDays: number,
 *     readiness: { ciStatus: 'green'|'red'|'unknown'|null, resourceVerdict: 'green'|'warn'|'degraded'|'critical' },
 *   } }>,
 *   warnings: string[],
 * }>}
 */
export async function rankCandidates(freeCandidates, opts = {}) {
  const candidates = Array.isArray(freeCandidates) ? freeCandidates : [];
  const nowMs = typeof opts.now === 'number' ? opts.now : Date.now();
  const deps = { ...defaultDeps(), ...(opts.deps || {}) };
  const warnings = [];

  // Host-level resource verdict — fetched ONCE, shared across candidates.
  let resourceVerdict;
  try {
    resourceVerdict = (await deps.resourceVerdict()) || 'green';
  } catch {
    // Non-blocking: a failed host probe defaults to non-dampening 'green'.
    resourceVerdict = 'green';
    warnings.push('resource verdict unavailable (host probe failed) — readiness scored without resource dampening');
  }

  const rows = [];
  for (const candidate of candidates) {
    const repoRoot = candidate?.repoRoot;
    const repoName = candidate?.repoName ?? repoRoot ?? '<unknown>';

    // PRIORITY (with glab/gh fallback).
    let priority;
    try {
      const raw = await deps.fetchPriority(repoRoot, nowMs);
      priority =
        raw && typeof raw === 'object'
          ? { criticalCount: raw.criticalCount || 0, highCount: raw.highCount || 0 }
          : null;
    } catch {
      priority = null;
    }
    if (priority === null) {
      warnings.push(
        `priority unavailable for ${repoName} (glab/gh missing or timeout) — ranked on staleness×readiness only`,
      );
    }

    // STALENESS.
    let staleDays;
    try {
      const d = await deps.staleDaysFor(repoRoot, nowMs);
      staleDays = typeof d === 'number' && Number.isFinite(d) && d >= 0 ? d : STALENESS_CAP_DAYS;
    } catch {
      staleDays = STALENESS_CAP_DAYS;
    }

    // READINESS — CI status.
    let ciStatus;
    try {
      ciStatus = await deps.checkCiStatus({ repoRoot });
    } catch {
      ciStatus = null;
    }

    const signals = {
      priority,
      staleDays,
      readiness: { ciStatus, resourceVerdict },
    };
    const score = scoreCandidate(signals);

    rows.push({ candidate, score, signals });
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.signals.staleDays !== a.signals.staleDays) {
      return b.signals.staleDays - a.signals.staleDays;
    }
    const an = a.candidate?.repoName ?? '';
    const bn = b.candidate?.repoName ?? '';
    return an < bn ? -1 : an > bn ? 1 : 0;
  });

  return { ranked: rows, warnings };
}
