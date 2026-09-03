/**
 * sessions-staleness-banner.mjs — #724
 *
 * Deterministic session-start nudge for the "close-through" gap: sessions
 * that end (agents stop, work happens) without ever writing a
 * `.orchestrator/metrics/sessions.jsonl` ledger record. W1-D4 fleet finding:
 * 141 `orchestrator.session.started` events vs. 39 sessions.jsonl records in
 * this repo (~27% close-through rate) — the ledger silently under-counts
 * completed sessions with no signal to the operator.
 *
 * Mirrors the contract used by the sibling Phase 4 banners
 * (`scripts/lib/reconcile-nudge-banner.mjs`, `scripts/lib/vault-staleness-banner.mjs`,
 * `scripts/lib/loop-readiness-banner.mjs`): a single `checkXxx({repoRoot})`
 * entry point that is COMPLETELY try/catch-wrapped (never throws) and returns
 * either `null` (silent no-op) or `{severity:'warn'|'alert', message, ...extra}`.
 *
 * Design — self-exclusion over time, NOT lock-presence (load-bearing
 * correction; see issue #724 discussion): Phase 4 always runs INSIDE an
 * active session — Phase 1.2 has already acquired `.orchestrator/session.lock`
 * by the time this probe fires. Gating on "no live lock" would make the
 * banner structurally silent forever. Instead:
 *
 *   - `lastLedgerAt`      = the NEWEST instant any PARSEABLE `sessions.jsonl`
 *                           record proves the ledger was alive at — a genuine
 *                           record contributes its `completed_at` (or, absent
 *                           one, its `started_at`), a backfill stub
 *                           contributes ONLY its `started_at`. See
 *                           "Backfill-stub self-erasure fix" below for why the
 *                           stub's `completed_at` is excluded, and "#1125 —
 *                           newest-across-all, not genuine-first" for why the
 *                           two kinds are maxed rather than ranked.
 *   - `cutoff`            = the CURRENT session's `session.lock`
 *                           `started_at` (via `readLock()`); when no lock is
 *                           readable, `cutoff = now` (all events count).
 *   - `lastForeignEventAt`= the NEWEST `events.jsonl` line whose `timestamp`
 *                           is STRICTLY BEFORE `cutoff` — this structurally
 *                           excludes the current session's own events without
 *                           needing a `session_id` filter (most event lines
 *                           don't carry one; see the mission-log sample in
 *                           `.orchestrator/metrics/events.jsonl`).
 *   - `deltaHours`        = (lastForeignEventAt − lastLedgerAt) / 1h, only
 *                           meaningful when > 0 (foreign activity happened
 *                           AFTER the last ledger entry).
 *
 * Backfill-stub self-erasure fix — the anchor axis: a backfill-produced
 * `sessions.jsonl` record (`_backfill_source` / `status: 'abandoned'`, see
 * `session-close-backfill.mjs` `synthesizeRecord()`) sets `completed_at =
 * max(started_at, lastTerminalMs ?? nowMs)`. When the abandoned session
 * never emitted a STOPPED/ENDED event — the COMMON case, since that is
 * *why* it is "abandoned" — `completed_at` silently becomes the BACKFILL
 * RUN's own wall-clock instant, not a measurement of when the session
 * actually ended. Anchoring `lastLedgerEntry()` on that value means a
 * backfill run can retroactively erase a multi-day staleness gap just by
 * writing a stub today (observed: a 92.5h gap to the last GENUINE record
 * collapsed to 0.6h the moment a backfill stub landed).
 *
 * Two axes were available to fix this: (a) skip stub records when scanning
 * for the ledger anchor, keeping `completed_at` as the anchor field; or (b)
 * blanket-switch the anchor field to `started_at` for every record. (b) was
 * rejected — for a GENUINE multi-hour session, `started_at` sits hours
 * before `completed_at`, so switching the anchor field universally would
 * inflate `deltaHours` for perfectly healthy, promptly-closed sessions
 * (a session's own mid-session events would newly count as "after" the
 * anchor), reintroducing false positives on the opposite side. (a) is
 * chosen: a stub's `completed_at` is NEVER an anchor candidate. Stub
 * recognition uses EITHER marker (OR, not AND) deliberately — both are set by
 * the same producer today, but requiring both would silently stop matching the
 * day a future backfill variant drops one of them while keeping the other; OR
 * degrades gracefully (still catches it), AND does not.
 *
 * #1125 — newest-across-ALL records, not genuine-first: excluding the stub's
 * `completed_at` (above) is correct; excluding the whole STUB from the anchor
 * search was not. The original implementation scanned from EOF backward and
 * returned the first GENUINE record it met, reaching the stub `started_at`
 * fallback only when no genuine record existed ANYWHERE. That is a PRIORITY
 * ORDER, and it lets an OLD genuine record outrank a NEWER stub: whenever the
 * most recent ledger activity is a stub, the anchor fell back to a stale
 * genuine `completed_at` and the reported gap ballooned by the difference.
 * Measured in the vault repo 2026-08-22 (issue #1125): a 173h `alert` — the
 * probe's TOP severity — against a ledger whose newest records were from the
 * same day, contradicted by three independent counter-measurements (231 of 233
 * records carrying `completed_at`, newest `2026-08-22T16:23Z`;
 * `backfill-abandoned-sessions.mjs --dry-run` finding 0 to backfill; all 15
 * sessions since 2026-08-15 closed). A permanent top-severity false alarm
 * trains exactly the looking-away this probe exists to prevent, so it is a
 * defect of the same class as a missed gap, not a cosmetic one.
 *
 * The anchor is therefore the MAXIMUM over every record's own contribution:
 *   - GENUINE record → its `completed_at`; or, when that field is absent or
 *     unparseable, its `started_at` as a floor.
 *   - BACKFILL STUB  → its `started_at` ONLY (never the fabricated
 *     `completed_at` — that is the axis-(a) rule above).
 * A stub written for an abandoned session still PROVES the ledger was alive at
 * that instant: that session IS recorded (as abandoned), so activity around it
 * is not evidence of an unrecorded close-through. Taking a MAX can only move
 * the anchor FORWARD relative to the genuine-only anchor, so it never
 * re-introduces axis (b)'s inflation of `deltaHours`.
 *
 * Stub-anchored reporting (deliberately NOT null): when the winning anchor is a
 * stub's `started_at` — either because every record is a stub (no session has
 * EVER genuinely closed, a STRONGER close-through signal than an ordinary stale
 * ledger) or merely because the newest ledger activity happens to be a stub —
 * the result carries `stubFallback: true` so the message can say the anchor is
 * a stub `started_at` (grounded in the real `orchestrator.session.started`
 * event in the common case — see `synthesizeRecord()`) rather than imply a
 * measured close. The module's usual fail-quiet convention (null on
 * missing/empty/ambiguous input) does not extend to "we have data but all of it
 * is synthetic" — that state IS the failure this banner exists to catch.
 *
 * Severity: warn above `2 × DEFAULT_TTL_HOURS` (8h, imported from
 * `session-lock.mjs` rather than duplicated), alert above 24h.
 *
 * Plain-JS — no Zod dependency. Never throws. Never mutates input. No
 * `console.*` calls (repo ESLint `no-console` rule).
 *
 * Cross-references:
 *  - `.claude/rules/verification-before-completion.md` — evidence-before-claims.
 *  - `scripts/lib/session-lock.mjs` — `readLock()`, `DEFAULT_TTL_HOURS`.
 *  - `scripts/lib/reconcile-nudge-banner.mjs` / `vault-staleness-banner.mjs` /
 *    `loop-readiness-banner.mjs` — the banner-shape template.
 *  - `scripts/backfill-abandoned-sessions.mjs` — the CLI this banner's
 *    message recommends running (`--dry-run` is its default/safe mode).
 *  - `scripts/lib/session-close-backfill.mjs` — the backfill engine
 *    (`synthesizeRecord`) that produces the abandoned-session stubs seen in
 *    `sessions.jsonl` (e.g. `_backfill_source: "events-jsonl"`).
 *  - `skills/session-start/SKILL.md` Phase 4 — banner render site.
 *  - Issue #724.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readLock, DEFAULT_TTL_HOURS } from './session-lock.mjs';
import { isRealSession } from './session-schema/filters.mjs';
import { readCanonicalSessions } from './sessions-canonical.mjs';

/** Repo-relative path to the session ledger (one record per closed session). */
const SESSIONS_PATH = '.orchestrator/metrics/sessions.jsonl';

/** Repo-relative path to the generic telemetry stream (one line per event). */
const EVENTS_PATH = '.orchestrator/metrics/events.jsonl';

/** warn threshold: 2x the session-lock default TTL (8h) — imported, not duplicated. */
export const WARN_THRESHOLD_HOURS = DEFAULT_TTL_HOURS * 2;

/** alert threshold: a full day behind is a strong close-through signal. */
export const ALERT_THRESHOLD_HOURS = 24;

/**
 * Read a JSONL file's non-empty lines. Returns `null` when the file is
 * absent or unreadable, `[]` when it exists but has no non-empty lines.
 * Never throws.
 *
 * @param {string} filePath
 * @returns {string[]|null}
 */
function readJsonlLines(filePath) {
  if (!existsSync(filePath)) return null;
  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  return raw.split('\n').filter((line) => line.length > 0);
}

/**
 * True when a `sessions.jsonl` record's `completed_at` was SYNTHESIZED by
 * the backfill engine (`scripts/lib/session-close-backfill.mjs`
 * `synthesizeRecord()`) rather than measured at real session-close time —
 * see the module-header "Backfill-stub self-erasure fix" section above for
 * the full reasoning behind the OR (not AND) combination of the two markers.
 *
 * Reuses `isRealSession()` from `./session-schema/filters.mjs` — its own doc
 * names `status: 'abandoned'` "the canonical marker" for exactly this phantom
 * class, so this is the SAME predicate every other real/phantom-aware
 * consumer in this repo already relies on, not a hand-rolled duplicate of it.
 * `_backfill_source` is layered on top as the second, independent signal.
 * Caller guarantees `record` is already a non-null object (see
 * `lastLedgerEntry()`'s guard above the call site).
 *
 * @param {object} record
 * @returns {boolean}
 */
function isBackfillStub(record) {
  if (!isRealSession(record)) return true;
  return typeof record._backfill_source === 'string' && record._backfill_source.length > 0;
}

/**
 * Parse one record field into an anchor candidate. Returns `null` when the
 * field is absent, not a string, or not a parseable timestamp.
 *
 * @param {unknown} value
 * @returns {{iso: string, ms: number}|null}
 */
function tsCandidate(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? { iso: value, ms } : null;
}

/**
 * Keep whichever of the two candidates is newer. A `null` candidate never
 * displaces a real one. On an exact tie the LATER-seen candidate wins, which
 * (with the forward scan in `lastLedgerEntry()`) preserves the previous
 * "nearest-EOF record wins" tie-break.
 *
 * @param {{iso: string, ms: number}|null} current
 * @param {{iso: string, ms: number}|null} candidate
 * @returns {{iso: string, ms: number}|null}
 */
function keepNewer(current, candidate) {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return candidate.ms >= current.ms ? candidate : current;
}

/**
 * Scan all `sessions.jsonl` lines and return the anchor instant to measure
 * ledger staleness against: the NEWEST instant any record proves the ledger
 * was alive at. Malformed or non-conforming lines (bad JSON, non-object) are
 * skipped, not treated as fatal.
 *
 * Which timestamp each record kind contributes, and why (full reasoning in the
 * module header, "#1125 — newest-across-ALL records"):
 *   - GENUINE (`!isBackfillStub()`) → `completed_at`, written by the real
 *     session-end path; falling back to `started_at` when `completed_at` is
 *     absent or unparseable, so a truncated/in-flight record still contributes
 *     the coverage it does prove. Taking the newer of the two can only move the
 *     anchor forward, never backward, so it does not inflate `deltaHours`.
 *   - BACKFILL STUB → `started_at` ONLY. Its `completed_at` may be the backfill
 *     RUN's own wall-clock rather than a measurement of when the session ended
 *     (see `synthesizeRecord()`), and anchoring on that would let a backfill run
 *     retroactively erase a real multi-day gap.
 *
 * The two kinds are MAXED, not ranked: an older genuine record must not outrank
 * a newer stub (that priority order was the #1125 false-alert defect). When the
 * winning candidate is a stub's `started_at`, `stubFallback: true` is set on the
 * result so the caller can say the anchor is a stub start, not a measured close;
 * the key is omitted (`undefined`) on the genuine path.
 *
 * `records` is the CANONICAL (#1209b) record set — `readCanonicalSessions()`
 * has already collapsed a duplicated `session_id` to its newest occurrence, so
 * a since-corrected raw LINE for the same identity (e.g. one later marked
 * `status: 'abandoned'`, or a stale `completed_at` a later record for the same
 * id superseded) can no longer independently skew this max-reduce the way a
 * raw-line scan over every append could.
 *
 * @param {object[]} records
 * @returns {{iso: string, ms: number, stubFallback?: true}|null}
 */
function lastLedgerEntry(records) {
  let newestGenuine = null; // newest genuine completed_at (or started_at floor)
  let newestStub = null; // newest stub started_at

  for (const record of records) {
    if (!record || typeof record !== 'object') continue;

    if (isBackfillStub(record)) {
      newestStub = keepNewer(newestStub, tsCandidate(record.started_at));
      continue;
    }

    let own = tsCandidate(record.completed_at);
    const started = tsCandidate(record.started_at);
    // `completed_at` is the normal anchor and wins ties; `started_at` only
    // takes over when it is genuinely newer or `completed_at` is unusable.
    if (started !== null && (own === null || started.ms > own.ms)) own = started;
    newestGenuine = keepNewer(newestGenuine, own);
  }

  if (newestGenuine === null && newestStub === null) return null;

  const stubWins = newestGenuine === null || (newestStub !== null && newestStub.ms > newestGenuine.ms);
  if (stubWins) return { iso: newestStub.iso, ms: newestStub.ms, stubFallback: true };
  return { iso: newestGenuine.iso, ms: newestGenuine.ms };
}

/**
 * Scan ALL `events.jsonl` lines and return the newest one whose `timestamp`
 * is strictly before `cutoffMs`. This is the self-exclusion mechanism: the
 * current session's own events (all >= cutoff, since cutoff is this
 * session's lock `started_at`) are structurally excluded without needing a
 * `session_id` filter. Malformed lines and lines with a missing/invalid
 * `timestamp` are skipped.
 *
 * @param {string[]} lines
 * @param {number} cutoffMs
 * @returns {{iso: string, ms: number}|null}
 */
function newestForeignEvent(lines, cutoffMs) {
  let best = null;
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object' || typeof record.timestamp !== 'string') continue;
    const ms = Date.parse(record.timestamp);
    if (!Number.isFinite(ms)) continue;
    if (ms >= cutoffMs) continue; // not "foreign" — belongs to (or postdates) the current session
    if (best === null || ms > best.ms) best = { iso: record.timestamp, ms };
  }
  return best;
}

/**
 * Resolve the cutoff instant (in epoch ms) that separates "the current
 * session's own events" from "foreign/pre-session events". Prefers the
 * current session's `session.lock` `started_at`; falls back to `now` when no
 * lock is readable (or its `started_at` is unparseable) — in that fallback
 * case every events.jsonl line counts as a candidate "foreign" event.
 *
 * Known limitation: the cutoff uses `lock.started_at` as recorded at lock
 * acquisition time — a `forceAcquire()` takeover (stale-lock override) or
 * cross-machine clock skew can shift this value away from the wall-clock
 * instant the CURRENT process actually started, which can widen or narrow
 * the "foreign" window by the skew amount. This banner is advisory-only
 * tolerance (a nudge, never a gate), so an imprecise cutoff only affects when
 * the warn/alert nudge fires, never blocks anything.
 *
 * @param {string} repoRoot
 * @param {number} nowMs
 * @returns {number}
 */
function resolveCutoffMs(repoRoot, nowMs) {
  let lock;
  try {
    lock = readLock({ repoRoot });
  } catch {
    return nowMs;
  }
  if (!lock || typeof lock.started_at !== 'string') return nowMs;
  const parsed = Date.parse(lock.started_at);
  return Number.isFinite(parsed) ? parsed : nowMs;
}

/**
 * Check sessions-ledger staleness and produce a session-start banner.
 *
 * Silent (`null`) when: `sessions.jsonl` is missing/empty/entirely
 * unparseable-or-anchor-less (see `lastLedgerEntry()` — this now also
 * covers "every record is a backfill stub with no parseable `started_at`
 * anywhere"), `events.jsonl` is missing/empty, no foreign (pre-cutoff)
 * event exists, the foreign event is not after the last ledger entry, or the
 * resulting gap is under the warn threshold. Never throws.
 *
 * When the newest anchor is a backfill stub (`ledger.stubFallback`),
 * `lastLedgerAt` is a STUB's `started_at`, not a genuine `completed_at` — the
 * message says so explicitly rather than implying a real close was measured.
 *
 * @param {{repoRoot: string, now?: number}} opts
 *   - `repoRoot`: REQUIRED absolute path to the repo root.
 *   - `now`: optional injectable clock (epoch ms); defaults to `Date.now()`.
 *     Used only as the cutoff fallback when no session.lock is readable.
 * @returns {null | {
 *   severity: 'warn'|'alert',
 *   message: string,
 *   lastLedgerAt: string,
 *   lastForeignEventAt: string,
 *   deltaHours: number,
 *   stubFallback?: true,
 * }}
 */
export function checkSessionsStaleness({ repoRoot, now = Date.now() } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

    const sessionsPath = path.join(repoRoot, SESSIONS_PATH);
    const sessionLines = readJsonlLines(sessionsPath);
    if (sessionLines === null || sessionLines.length === 0) return null;

    // CANONICAL (#1209b) record set — readJsonlLines() above only decides
    // missing-vs-empty (readCanonicalSessions() cannot tell those apart, see
    // its own doc); the anchor scan itself now runs over the collapsed set.
    const sessionRecords = readCanonicalSessions({ filePath: sessionsPath });
    const ledger = lastLedgerEntry(sessionRecords);
    if (ledger === null) return null;

    const eventLines = readJsonlLines(path.join(repoRoot, EVENTS_PATH));
    if (eventLines === null || eventLines.length === 0) return null;

    const cutoffMs = resolveCutoffMs(repoRoot, nowMs);

    const foreign = newestForeignEvent(eventLines, cutoffMs);
    if (foreign === null) return null;

    const deltaMs = foreign.ms - ledger.ms;
    if (deltaMs <= 0) return null; // foreign activity is not AFTER the last ledger entry

    const deltaHours = Math.round((deltaMs / 3600000) * 10) / 10;
    if (deltaHours <= WARN_THRESHOLD_HOURS) return null;

    const severity = deltaHours > ALERT_THRESHOLD_HOURS ? 'alert' : 'warn';

    // stubFallback (see lastLedgerEntry()): the newest anchor in sessions.jsonl
    // is a backfill stub — ledger.iso is that STUB's started_at, not a measured
    // completed_at. Say so explicitly rather than implying a real close. (The
    // wording deliberately does NOT claim "stub-only": since #1125 a stub can
    // win the anchor while older genuine records exist.)
    const ledgerDescription = ledger.stubFallback
      ? `newest sessions.jsonl entry is a backfill stub — its started_at ${ledger.iso}`
      : `last sessions.jsonl entry ${ledger.iso}`;

    const base =
      `sessions-staleness: ${ledgerDescription} is ${deltaHours}h behind ` +
      `pre-session events.jsonl activity ${foreign.iso} — possible close-through gap ` +
      `(sessions ended without a ledger record; run node scripts/backfill-abandoned-sessions.mjs --dry-run)`;

    const message = severity === 'alert' ? `🚨 ${base} — gap exceeds 24h.` : `⚠ ${base}.`;

    return {
      severity,
      message,
      lastLedgerAt: ledger.iso,
      lastForeignEventAt: foreign.iso,
      deltaHours,
      ...(ledger.stubFallback ? { stubFallback: true } : {}),
    };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
