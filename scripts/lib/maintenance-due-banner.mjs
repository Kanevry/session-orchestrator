/**
 * maintenance-due-banner.mjs — ONE session-start probe for the whole
 * maintenance loop.
 *
 * ## Why this module exists
 *
 * Measured 2026-09-09 across consumer repos: `orchestrator.evolve.completed`
 * fired ZERO times, all 628 learnings were still active, the session-end
 * auto-dialectic nudge recorded `decided: true` while nobody ever ran it, and
 * memory-cleanup had run in 1 of 3 repos. The maintenance loop was not
 * missing — it was ADVERTISED IN THREE PLACES nobody reads at a moment nobody
 * acts: two session-end nudges (3.6.5 auto-dream, 3.6.7 auto-dialectic) fire
 * while the operator is closing down, and the session-start `reconcile-nudge`
 * probe spoke for one signal out of several.
 *
 * This probe replaces all three with a single reading at the ONE moment the
 * operator can act on it — session start — recommending the one verb that
 * runs the whole loop: `/session housekeeping`.
 *
 * ## Design constraints it is written against
 *
 * - **HR-101 (a signal may only warn if it is rare).** Nothing is due ⇒ the
 *   probe is SILENT. Seven independent signals are ANDed with a cooldown, not
 *   ORed into a permanent warning: a repo that ran `/session housekeeping`
 *   within the last {@link HOUSEKEEPING_COOLDOWN_DAYS} days says nothing at
 *   all, because the operator already did the thing the banner would ask for.
 * - **HR-106 (the banner reports what the rule judged).** Every DUE signal
 *   carries the number or the date that made it due — never a bare count.
 * - **Three-state, never two.** A signal whose inputs cannot be read goes to
 *   `undeterminable`; it is never folded into "clean". Copied wholesale from
 *   `reconcile-nudge-banner.mjs`'s `never` vs `undeterminable` discipline.
 * - **NO new Session Config key.** Every threshold below is an EXISTING key or
 *   an existing module constant. Same posture as `reconcile-nudge-banner.mjs`
 *   and `loop-readiness-banner.mjs`: an advisory banner needs no switch.
 *
 * ## The seven signals
 *
 * | id                | due when                                                              | source |
 * |-------------------|-----------------------------------------------------------------------|--------|
 * | `evolve`          | no `orchestrator.evolve.completed` on record AND ≥20 active learnings  | `events.jsonl` + `computeReconcileNudge` |
 * | `sweep`           | the dry-run expiry sweep would archive ≥1 entry                       | `learnings/expiry-sweep.mjs` |
 * | `reconcile`       | `computeReconcileNudge().nudge === true`                              | `reconcile-nudge-banner.mjs` (reused whole) |
 * | `dialectic`       | `shouldDispatchAutoDialectic().trigger === true`                      | `auto-dialectic.mjs` |
 * | `memory-cleanup`  | `shouldDispatchAutoDream().trigger === true`                          | `auto-dream.mjs` |
 * | `pending-sidecar` | a pending dream/dialectic proposal younger than 14 days is unapplied   | `.orchestrator/*-pending*.md` |
 * | `generated-rules-expiring` | a machine-generated rule is expired or expires within {@link GENERATED_RULE_EXPIRY_HORIZON_DAYS} days | `instruction-budget-guard.mjs` |
 *
 * ### Why the expiry alarm is HERE and not in the test suite (#1372 follow-up)
 *
 * The invariant "no generated rule file sits expired in `.claude/rules/`" was
 * first written as a vitest case comparing `expires-at` against TODAY. That is
 * a calendar time-bomb in a BLOCKING gate: with nothing committed and nothing
 * broken, `npm test` — pre-push hook and CI alike — turns red on the morning
 * after the earliest date and blocks every unrelated hotfix, while the repair
 * (consolidate the file, move its provenance pairs, delete it) is a human
 * decision no test run can take. HR-101/HR-105: a signal must fire when
 * something CHANGED, at a moment the operator can act, and be repairable by the
 * thing that fires it. Session start, recommending `/session housekeeping`, is
 * that moment; the predicate itself is still tested, against an INJECTED clock.
 *
 * Only SIDE-EFFECT-FREE signal functions are called — never a variant that
 * advances `.orchestrator/dialectic-last-run`, because a probe that writes the
 * stamp would consume the very signal it reports. (The former recording wrapper
 * around this signal was removed in #1288; only the pure decision function
 * remains.)
 *
 * Never throws. `computeMaintenanceDue` always returns the full shape;
 * `checkMaintenanceDue` returns the banner object or `null`.
 *
 * @module scripts/lib/maintenance-due-banner
 */

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

import { SCAN_CHUNK_BYTES, scanEventsBackwards } from './events.mjs';
import { computeReconcileNudge } from './reconcile-nudge-banner.mjs';
import { sweepExpiredLearnings } from './learnings/expiry-sweep.mjs';
import { shouldDispatchAutoDialectic } from './auto-dialectic.mjs';
import { shouldDispatchAutoDream } from './auto-dream.mjs';
import { resolveMemoryDir } from './memory-paths.mjs';
import { readCanonicalSessions } from './sessions-canonical.mjs';
import { filterRealSessions } from './session-schema.mjs';
import {
  daysUntilGeneratedRuleExpiry,
  listMachineGeneratedRules,
} from './instruction-budget-guard.mjs';

/**
 * How many signals this probe knows about. The banner denominator is this
 * number MINUS the signals a kill-switch skipped on this host — see the
 * `skipped` array in {@link computeMaintenanceDue}'s result.
 */
export const MAINTENANCE_TOTAL_SIGNALS = 7;

/**
 * How far ahead the `generated-rules-expiring` signal looks.
 *
 * NAMED CEILING (BV-004): 7 days is one week of sessions — long enough that the
 * operator meets the warning before the loader silently starts dropping the
 * rule, short enough that it is not standing noise (HR-104: a signal that is
 * essentially always present is no signal). On this repo's corpus at
 * 2026-09-16 the earliest `expires-at` was 14 days out, so the row is silent.
 *
 * REVISIT TRIGGER: if the row is due on more than ~1 session start in 10, the
 * horizon is measuring the reconcile engine's 30-day default TTL rather than an
 * overdue consolidation — re-aim it (HR-101), never widen it.
 */
export const GENERATED_RULE_EXPIRY_HORIZON_DAYS = 7;

/**
 * Active-learning floor for the `evolve` signal. Deliberately the SAME number
 * as `NUDGE_MIN_LEARNINGS` in `reconcile-nudge-banner.mjs` (20) — both answer
 * "is the corpus large enough that never having processed it is a finding?".
 * Defined locally rather than imported so the two can diverge if the reconcile
 * threshold is ever retuned for reconcile-specific reasons.
 */
export const MAINTENANCE_MIN_LEARNINGS = 20;

/** Suppress the banner when a housekeeping session completed this recently. */
export const HOUSEKEEPING_COOLDOWN_DAYS = 7;

/**
 * A pending sidecar older than this is not a nudge, it is archaeology — the
 * operator has demonstrably moved on, and re-raising it every session start is
 * the HR-101 failure mode.
 */
export const SIDECAR_MAX_AGE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/** The event name whose ABSENCE is the `evolve` signal. */
const EVOLVE_EVENT = 'orchestrator.evolve.completed';

/** Pending-proposal sidecars, repo-relative (owned by auto-dream / auto-dialectic). */
const PENDING_SIDECARS = ['.orchestrator/pending-dream.md', '.orchestrator/dialectic-pending.md'];

// ---------------------------------------------------------------------------
// Small readers — every one of them is never-throw and three-state
// ---------------------------------------------------------------------------

/** @param {unknown} now @returns {number} */
function nowMs(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = typeof now === 'string' ? Date.parse(now) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

/** ISO timestamp → `YYYY-MM-DD`, or null. */
function isoDay(ts) {
  return typeof ts === 'string' && ts.length >= 10 ? ts.slice(0, 10) : null;
}

/**
 * Backwards-scan chunk size (#1290 item 2) — the shared reader's constant, kept
 * under this module's own name because it is the number this probe's cost is
 * reasoned about in. NAMED CEILING + revisit trigger live at
 * {@link SCAN_CHUNK_BYTES}.
 */
export const TAIL_CHUNK_BYTES = SCAN_CHUNK_BYTES;

/**
 * Wall-clock budget for the "did /evolve ever run?" walk (#1414).
 *
 * NAMED CEILING (BV-004): 1000 ms is half of `PROBE_BUDGET_MS` (2000 ms in
 * `session-start-probes.mjs`), which this probe shares with six other signals.
 * The walk is UNBOUNDED in principle — "never ran" is a claim about every line
 * of every source — so it needs an own limit now that it spans the archives
 * too, and running out must report `truncated`, never a clean "never".
 *
 * REVISIT TRIGGER: a repo where this reports `truncated` more than rarely. That
 * means the answer needs an index rather than a scan, not a bigger budget
 * (HR-101).
 */
export const EVOLVE_SCAN_BUDGET_MS = 1000;

/**
 * Find the most recent `orchestrator.evolve.completed` record — across ROTATION
 * boundaries (#1414).
 *
 * Walks the ledger backwards through every source, newest first, and stops at
 * the first hit, because the interesting answer is the LAST occurrence. Reading
 * the active file alone was the bug: "never ran" is a claim about EVERY line
 * ever written, and after a rotation the only `evolve.completed` record on the
 * host can sit in `_archive/` — the probe then nags a repo that has run
 * /evolve, which is the HR-101 failure mode this module exists to avoid.
 *
 * @param {string} repoRoot
 * @returns {{ok: boolean, lastAt: string|null, truncated: boolean}} `ok: false`
 *   ⇒ a source exists but could not be read; `truncated: true` ⇒ the budget ran
 *   out before the walk finished. In BOTH cases the caller must record
 *   `undeterminable`, never clean — a walk that did not finish has not proven
 *   "never".
 */
function readLastEvolveRun(repoRoot) {
  const file = path.join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
  let lastAt = null;
  const scan = scanEventsBackwards({
    filePath: file,
    chunkBytes: TAIL_CHUNK_BYTES,
    budgetMs: EVOLVE_SCAN_BUDGET_MS,
    // Cheap substring pre-filter before JSON.parse — the property the previous
    // hand-rolled scan was written for, kept here rather than re-derived.
    filter: EVOLVE_EVENT,
    onRecord: (rec) => {
      if (rec?.event !== EVOLVE_EVENT) return false;
      lastAt = typeof rec.timestamp === 'string' ? rec.timestamp : null;
      return true;
    },
  });
  if (scan.unreadable.length > 0) return { ok: false, lastAt: null, truncated: false };
  return { ok: true, lastAt, truncated: scan.truncated };
}

/**
 * Most recent COMPLETED housekeeping session, or null.
 *
 * @param {string} repoRoot
 * @returns {string|null} ISO timestamp
 */
function readLastHousekeeping(repoRoot) {
  try {
    const entries = filterRealSessions(readCanonicalSessions({ repoRoot }));
    let max = null;
    for (const e of entries) {
      if (e?.session_type !== 'housekeeping') continue;
      const ts = e.completed_at;
      if (typeof ts !== 'string' || ts.length === 0) continue;
      if (max === null || ts > max) max = ts;
    }
    return max;
  } catch {
    return null;
  }
}

/** Claude-Code-only memory dir gate — mirrors `session-end/phase-skip.mjs`. */
function isClaudePlatform(platform) {
  if (platform === undefined || platform === null || platform === '') return true;
  const p = String(platform).toLowerCase();
  return p === 'claude' || p === 'claude-code' || p === 'claudecode';
}

// ---------------------------------------------------------------------------
// Computation
// ---------------------------------------------------------------------------

/**
 * Compute the maintenance-due reading. Pure with respect to the repo: reads
 * only, writes nothing, advances no last-run stamp. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — defaults to `process.cwd()`.
 * @param {object} [opts.config] — parsed Session Config (thresholds only).
 * @param {Date|number} [opts.now] — injectable clock.
 * @param {string} [opts.platform] — harness platform; non-Claude skips `memory-cleanup`.
 * @returns {Promise<{
 *   due: Array<{id: string, detail: string}>,
 *   total: number,
 *   skipped: string[],
 *   undeterminable: string[],
 *   lastHousekeeping: string|null,
 * }>}
 */
export async function computeMaintenanceDue(opts = {}) {
  const repoRoot =
    typeof opts.repoRoot === 'string' && opts.repoRoot.length > 0 ? opts.repoRoot : process.cwd();
  const config = opts.config ?? {};
  const now = nowMs(opts.now);

  /** @type {Array<{id: string, detail: string}>} */
  const due = [];
  /** @type {string[]} */
  const undeterminable = [];
  /**
   * Signals a kill-switch turned OFF for this host. They are neither due nor
   * undeterminable — they were never judged, so they must not appear in the
   * denominator either (HR-106: the banner reports what the rule judged).
   * @type {string[]}
   */
  const skipped = [];
  const markDue = (id, detail) => due.push({ id, detail });

  // --- reconcile (S3) + the active-learning count S1 needs ------------------
  // ONE call serves both signals: re-deriving the active-learning filter here
  // would be a second, drifting copy of the reconcile thresholds (BV-001.2).
  let nudge;
  try {
    nudge = await computeReconcileNudge({ repoRoot, now: opts.now });
  } catch {
    /* left undefined — the two signals below become `undeterminable`, not clean */
  }
  if (!nudge) {
    undeterminable.push('evolve', 'reconcile');
  } else {
    // --- evolve (S1) -------------------------------------------------------
    const evolve = readLastEvolveRun(repoRoot);
    // `truncated` is NOT "not found": a walk that ran out of budget proves
    // nothing about the lines it never reached (#1414).
    if (!evolve.ok || evolve.truncated) {
      undeterminable.push('evolve');
    } else if (evolve.lastAt === null && nudge.activeLearnings >= MAINTENANCE_MIN_LEARNINGS) {
      markDue('evolve', `never, ${nudge.activeLearnings} active learnings`);
    }

    // --- reconcile (S3) ----------------------------------------------------
    if (nudge.nudge === true) {
      // HR-106: report what the rule JUDGED. `computeReconcileNudge` nudges on
      // a BACKLOG — rule-eligible learnings minus those already materialized
      // in the sidecar or `.claude/rules/` (`countReconcileBacklog`, #1380;
      // before #1380 it counted all eligible ones) — never on a date — so
      // printing `lastRunAt` here put today's date next to the word "due" and
      // read as "last run today and already due again". Measured 2026-09-09
      // (learning 013a45ba): with 108 learnings capped under
      // `max-proposals-per-run: 10`, the row stayed due after every run while
      // showing that run's own date. `reasons` is the judgment itself.
      const why = Array.isArray(nudge.reasons) && nudge.reasons.length > 0
        ? nudge.reasons.join(', ')
        : `last run ${isoDay(nudge.lastRunAt) ?? 'never'}`;
      markDue('reconcile', why);
    }
  }

  // --- sweep (S2) ----------------------------------------------------------
  try {
    const metrics = path.join(repoRoot, '.orchestrator', 'metrics');
    const res = await sweepExpiredLearnings({
      filePath: path.join(metrics, 'learnings.jsonl'),
      archivePath: path.join(metrics, 'learnings-archive.jsonl'),
      now: opts.now,
      dryRun: true,
    });
    if (Number(res?.archived) > 0) markDue('sweep', `${res.archived} expired`);
  } catch {
    undeterminable.push('sweep');
  }

  // --- dialectic (S4) ------------------------------------------------------
  const cadence = config?.dialectic?.cadence ?? 5;
  if (cadence === 0) {
    skipped.push('dialectic');
  } else {
    try {
      const dec = await shouldDispatchAutoDialectic({ repoRoot, cadence });
      if (dec?.trigger === true) {
        markDue('dialectic', isoDay(dec.signals?.lastRunAt) ?? 'never');
      }
    } catch {
      undeterminable.push('dialectic');
    }
  }

  // --- memory-cleanup (S5) -------------------------------------------------
  const threshold = config?.['memory-cleanup-threshold'] ?? 5;
  if (threshold === 0 || !isClaudePlatform(opts.platform)) {
    skipped.push('memory-cleanup');
  } else {
    try {
      const dec = await shouldDispatchAutoDream({
        repoRoot,
        memoryDir: resolveMemoryDir(repoRoot),
        threshold,
        softLimit: config?.['memory-cleanup-soft-limit'] ?? 180,
      });
      if (dec?.trigger === true) {
        const s = dec.signals ?? {};
        markDue(
          'memory-cleanup',
          isoDay(s.lastCleanupAt) ?? `never, ${s.sessionsSinceCleanup ?? 0} sessions`,
        );
      }
    } catch {
      undeterminable.push('memory-cleanup');
    }
  }

  // --- pending sidecar (S6) ------------------------------------------------
  try {
    const pending = [];
    for (const rel of PENDING_SIDECARS) {
      const file = path.join(repoRoot, rel);
      if (!existsSync(file)) continue;
      const ageDays = (now - statSync(file).mtimeMs) / MS_PER_DAY;
      if (ageDays <= SIDECAR_MAX_AGE_DAYS) pending.push(path.basename(rel));
    }
    if (pending.length > 0) markDue('pending-sidecar', pending.join(', '));
  } catch {
    undeterminable.push('pending-sidecar');
  }

  // --- generated-rules-expiring (S7) ---------------------------------------
  // The predicate and the population both come from `instruction-budget-guard`,
  // which is where the generated corpus is DEFINED (its byte ceiling judges the
  // same set). A local re-implementation would be a second definition of
  // "machine-generated" that agrees only until one of the two is edited.
  try {
    const listed = listMachineGeneratedRules({ repoRoot });
    if (!listed.ok) {
      // The directory is there but unreadable — not knowing is not clean.
      undeterminable.push('generated-rules-expiring');
    } else {
      const expiring = listed.rules
        .map((r) => ({ ...r, days: daysUntilGeneratedRuleExpiry({ meta: r.meta, now }) }))
        .filter((r) => r.days !== null && r.days <= GENERATED_RULE_EXPIRY_HORIZON_DAYS)
        .sort((a, b) => a.days - b.days);
      if (expiring.length > 0) {
        // HR-106: name the files and the dates the verdict was computed from —
        // the operator has to open exactly those files to repair this.
        // HR-106 again, one step further: name the REPAIR, not only the
        // finding. The sweep (#1377) is the mechanical half — prose out, the
        // provenance pair kept as `markers only` — and an operator who is told
        // only which files expired has to rediscover that the command exists.
        markDue(
          'generated-rules-expiring',
          `${expiring.map((r) => `${r.file} ${r.expiresAt}`).join(', ')} → ` +
            'node scripts/sweep-expired-rules.mjs (dry-run first)',
        );
      }
    }
  } catch {
    undeterminable.push('generated-rules-expiring');
  }

  return {
    due,
    // HR-106: the denominator counts the signals this host actually EVALUATED.
    // A signal a kill-switch turned off was never judged, so reporting it in
    // "3 of 6" would quote a denominator the rule never used.
    total: MAINTENANCE_TOTAL_SIGNALS - skipped.length,
    skipped,
    undeterminable,
    lastHousekeeping: readLastHousekeeping(repoRoot),
  };
}

/**
 * Session-start probe entry point.
 *
 * Silent (`null`) when nothing is due and everything was readable, and ALSO
 * when a housekeeping session completed within {@link HOUSEKEEPING_COOLDOWN_DAYS}
 * days — the cooldown is what keeps this instrument rare (HR-101). The
 * computation still runs and is still available via {@link computeMaintenanceDue};
 * only the banner is suppressed.
 *
 * @param {{repoRoot?: string, config?: object, now?: Date|number, platform?: string}} [opts]
 * @returns {Promise<null | {severity: 'warn', message: string}>}
 */
export async function checkMaintenanceDue(opts = {}) {
  try {
    const computed = await computeMaintenanceDue(opts);
    if (computed.due.length === 0 && computed.undeterminable.length === 0) return null;

    // Cooldown — no new config key: the housekeeping session's own record IS
    // the "last maintenance run" stamp.
    if (computed.lastHousekeeping !== null) {
      const ageMs = nowMs(opts.now) - Date.parse(computed.lastHousekeeping);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < HOUSEKEEPING_COOLDOWN_DAYS * MS_PER_DAY) {
        return null;
      }
    }

    // HR-106: every number in the banner is a number the verdict was computed
    // from — no aggregate stands alone without the signal that produced it.
    const detail = computed.due.map((d) => `${d.id}: ${d.detail}`).join(' · ');
    const unknown =
      computed.undeterminable.length > 0
        ? ` · undeterminable: ${computed.undeterminable.join(', ')}`
        : '';
    const message =
      `⚠ maintenance due: ${computed.due.length} of ${computed.total}` +
      (detail ? ` (${detail})` : '') +
      unknown +
      ' — run /session housekeeping.';

    return { severity: 'warn', message };
  } catch {
    // Defensive catch-all — a session-start banner must never throw.
    return null;
  }
}
