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
 *   - `lastLedgerAt`      = `completed_at` of the last PARSEABLE
 *                           `sessions.jsonl` record (scanned from EOF
 *                           backward, skipping malformed lines).
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
 * Scan `sessions.jsonl` lines from EOF backward and return the `completed_at`
 * of the last PARSEABLE record that carries a valid ISO timestamp. Malformed
 * or non-conforming lines (bad JSON, missing/invalid `completed_at`) are
 * skipped, not treated as fatal.
 *
 * @param {string[]} lines
 * @returns {{iso: string, ms: number}|null}
 */
function lastLedgerEntry(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let record;
    try {
      record = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object' || typeof record.completed_at !== 'string') continue;
    const ms = Date.parse(record.completed_at);
    if (!Number.isFinite(ms)) continue;
    return { iso: record.completed_at, ms };
  }
  return null;
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
 * unparseable, `events.jsonl` is missing/empty, no foreign (pre-cutoff)
 * event exists, the foreign event is not after the last ledger entry, or the
 * resulting gap is under the warn threshold. Never throws.
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
 * }}
 */
export function checkSessionsStaleness({ repoRoot, now = Date.now() } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const nowMs = typeof now === 'number' && Number.isFinite(now) ? now : Date.now();

    const sessionLines = readJsonlLines(path.join(repoRoot, SESSIONS_PATH));
    if (sessionLines === null || sessionLines.length === 0) return null;

    const ledger = lastLedgerEntry(sessionLines);
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

    const base =
      `sessions-staleness: last sessions.jsonl entry ${ledger.iso} is ${deltaHours}h behind ` +
      `pre-session events.jsonl activity ${foreign.iso} — possible close-through gap ` +
      `(sessions ended without a ledger record; run node scripts/backfill-abandoned-sessions.mjs --dry-run)`;

    const message = severity === 'alert' ? `🚨 ${base} — gap exceeds 24h.` : `⚠ ${base}.`;

    return {
      severity,
      message,
      lastLedgerAt: ledger.iso,
      lastForeignEventAt: foreign.iso,
      deltaHours,
    };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}
