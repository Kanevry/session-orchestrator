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
 *   probe is SILENT. Six independent signals are ANDed with a cooldown, not
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
 * ## The six signals
 *
 * | id                | due when                                                              | source |
 * |-------------------|-----------------------------------------------------------------------|--------|
 * | `evolve`          | no `orchestrator.evolve.completed` on record AND ≥20 active learnings  | `events.jsonl` + `computeReconcileNudge` |
 * | `sweep`           | the dry-run expiry sweep would archive ≥1 entry                       | `learnings/expiry-sweep.mjs` |
 * | `reconcile`       | `computeReconcileNudge().nudge === true`                              | `reconcile-nudge-banner.mjs` (reused whole) |
 * | `dialectic`       | `shouldDispatchAutoDialectic().trigger === true`                      | `auto-dialectic.mjs` |
 * | `memory-cleanup`  | `shouldDispatchAutoDream().trigger === true`                          | `auto-dream.mjs` |
 * | `pending-sidecar` | a pending dream/dialectic proposal younger than 14 days is unapplied   | `.orchestrator/*-pending*.md` |
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

import { closeSync, existsSync, fstatSync, openSync, readSync, statSync } from 'node:fs';
import path from 'node:path';

import { computeReconcileNudge } from './reconcile-nudge-banner.mjs';
import { sweepExpiredLearnings } from './learnings/expiry-sweep.mjs';
import { shouldDispatchAutoDialectic } from './auto-dialectic.mjs';
import { shouldDispatchAutoDream } from './auto-dream.mjs';
import { resolveMemoryDir } from './memory-paths.mjs';
import { readCanonicalSessions } from './sessions-canonical.mjs';
import { filterRealSessions } from './session-schema.mjs';

/**
 * How many signals this probe knows about. The banner denominator is this
 * number MINUS the signals a kill-switch skipped on this host — see the
 * `skipped` array in {@link computeMaintenanceDue}'s result.
 */
export const MAINTENANCE_TOTAL_SIGNALS = 6;

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
 * Backwards-scan chunk size (#1290 item 2).
 *
 * NAMED CEILING: 256 KiB is ~800 records in this repo's ledger, so the common
 * case — a repo that ran /evolve within its recent history — answers after a
 * handful of reads instead of loading the whole 7.9 MB file. The scan is
 * UNBOUNDED in the worst case ON PURPOSE: "never ran" is a claim about every
 * line and cannot be made from a tail, so a repo with no `evolve.completed`
 * record still walks the file to its start — just in chunks, never all at once
 * in one string.
 *
 * REVISIT TRIGGER: the maintenance probe's median passes 1000 ms (half
 * `PROBE_BUDGET_MS`), or one repo's `events.jsonl` passes 50 MB. Either means
 * the "never ran" walk has become the cost that matters and the answer needs an
 * index rather than a scan.
 */
export const TAIL_CHUNK_BYTES = 256 * 1024;

/**
 * Scan a buffer of COMPLETE lines backwards for the newest evolve record.
 *
 * @param {Buffer} buf
 * @returns {{lastAt: string|null}|null} null ⇒ no record in this buffer
 */
function scanEvolveLines(buf) {
  if (buf.length === 0) return null;
  const lines = buf.toString('utf8').split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || !line.includes(EVOLVE_EVENT)) continue; // cheap pre-filter before JSON.parse
    try {
      const rec = JSON.parse(line);
      if (rec?.event !== EVOLVE_EVENT) continue;
      return { lastAt: typeof rec.timestamp === 'string' ? rec.timestamp : null };
    } catch {
      continue; // a malformed line is not evidence either way — keep scanning
    }
  }
  return null;
}

/**
 * Find the most recent `orchestrator.evolve.completed` record.
 *
 * Reads the ledger BACKWARDS in {@link TAIL_CHUNK_BYTES} chunks and stops at
 * the first hit, because the interesting answer is the LAST occurrence. The
 * former implementation `readFileSync`-ed the whole file (7.9 MB here, 30–44 ms)
 * to answer a question the last few kilobytes usually settle.
 *
 * The one bug a naive chunked scan introduces is a record SPLIT across a chunk
 * boundary: the bytes before the first newline of a chunk are the tail of a line
 * whose head is in the chunk not read yet, so they are CARRIED, never parsed
 * here. Splitting on the 0x0A byte is safe on UTF-8 — no continuation byte can
 * equal a newline — so a multibyte character never splits a line either.
 *
 * @param {string} repoRoot
 * @returns {{ok: boolean, lastAt: string|null}} `ok: false` ⇒ the ledger exists
 *   but could not be read — the caller must record `undeterminable`, never clean.
 */
function readLastEvolveRun(repoRoot) {
  const file = path.join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
  if (!existsSync(file)) return { ok: true, lastAt: null }; // fresh repo: genuinely never
  let fd;
  try {
    fd = openSync(file, 'r');
    let pos = fstatSync(fd).size;
    /** Partial line at the FRONT of everything read so far. */
    let carry = Buffer.alloc(0);

    while (pos > 0) {
      const length = Math.min(TAIL_CHUNK_BYTES, pos);
      pos -= length;
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, pos);
      const block = carry.length > 0 ? Buffer.concat([buf, carry]) : buf;
      const firstNewline = block.indexOf(0x0a);
      if (firstNewline === -1) {
        carry = block; // no complete line yet — a line longer than one chunk
        continue;
      }
      const hit = scanEvolveLines(block.subarray(firstNewline + 1));
      if (hit) return { ok: true, lastAt: hit.lastAt };
      carry = block.subarray(0, firstNewline);
    }

    // pos === 0: the carry is the file's FIRST line, complete by construction.
    const hit = scanEvolveLines(carry);
    return { ok: true, lastAt: hit ? hit.lastAt : null };
  } catch {
    return { ok: false, lastAt: null };
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* best-effort */
      }
    }
  }
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
    if (!evolve.ok) {
      undeterminable.push('evolve');
    } else if (evolve.lastAt === null && nudge.activeLearnings >= MAINTENANCE_MIN_LEARNINGS) {
      markDue('evolve', `never, ${nudge.activeLearnings} active learnings`);
    }

    // --- reconcile (S3) ----------------------------------------------------
    if (nudge.nudge === true) {
      // HR-106: report what the rule JUDGED. `computeReconcileNudge` nudges on
      // a BACKLOG (eligible-unmaterialized learnings), never on a date — so
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
