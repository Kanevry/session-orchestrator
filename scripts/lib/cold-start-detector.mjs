/**
 * cold-start-detector.mjs — F1.3 Cold-Start Abandonment Fix
 *
 * Detects whether a repo is in a "bootstrapped but never used" state and
 * produces a banner-emit decision for the SessionStart hook. The headline
 * adoption finding (PRD 2026-05-21, §Background) is that 58% of audited
 * repos never get past bootstrap — the `SessionStart` hook stays silent and
 * the operator never returns. This detector adds one nudge.
 *
 * Behaviour (PRD §F1.3):
 *   1. Skip if `bootstrap.lock` is missing (repo not yet bootstrapped —
 *      the bootstrap-gate handles that path).
 *   2. Skip if `sessions.jsonl` line count ≥ `silence-after-sessions`
 *      (operator has already engaged at least once).
 *   3. Skip if bootstrap age < `nudge-after-hours` (give the operator a
 *      reasonable window after bootstrap before nudging).
 *   4. Emit otherwise, with a `markerPath` when the migration marker
 *      `.orchestrator/welcome-banner-pending` is present (the hook then
 *      calls `consumeMarker()` after emission).
 *
 * Hard contract:
 *   - Never throws. Any error → return {shouldEmit: false, reason: '...'}.
 *   - Pure async fs.promises — must not block the SessionStart hook's 5s
 *     budget. Internally uses stat + readFile only on small files.
 *   - No external deps. ESM only. Node 20+ `node:fs/promises`.
 *
 * Wired from `hooks/on-session-start.mjs` immediately after the host-banner
 * block (~line 240) and before the registry/peer block.
 *
 * @module cold-start-detector
 */

import { stat, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';

import { parseBootstrapLock } from './bootstrap-lock-freshness.mjs';

/** Milliseconds in one hour — exported for testability. */
export const MS_PER_HOUR = 60 * 60 * 1000;

/** Relative path of the migration-seed marker file. */
export const WELCOME_MARKER_REL = path.join('.orchestrator', 'welcome-banner-pending');

/** Relative path of the bootstrap lock. */
const BOOTSTRAP_LOCK_REL = path.join('.orchestrator', 'bootstrap.lock');

/** Relative path of the sessions roll-up (NDJSON). */
const SESSIONS_JSONL_REL = path.join('.orchestrator', 'metrics', 'sessions.jsonl');

/**
 * Cold-start banner copy. English first (Anthropic Claude Code surface).
 * Returned as `bannerLines` so the caller can join('\n') for stdout emission
 * or splice in additional context (e.g. bootstrap timestamp) without
 * re-parsing the message.
 *
 * Returned array, not a constant — keeps the function pure (no shared
 * mutable state).
 *
 * @param {{bootstrappedAt?: string|null}} [opts]
 * @returns {string[]}
 */
function buildBannerLines({ bootstrappedAt = null } = {}) {
  const tail = bootstrappedAt
    ? [`Bootstrap completed: ${bootstrappedAt}`]
    : [];
  return [
    '📚 First session not yet — your repo is set up but the orchestrator hasn\'t run anything yet.',
    '',
    'What this gives you:',
    '  • Auto-detects open issues, branch state, and CI status at session-start',
    '  • Distributes work across parallel subagents with file-lane isolation',
    '  • Captures learnings and decisions to vault automatically',
    '',
    'Try: `/session housekeeping`  ← 3-5 minutes, low-risk warm-up',
    ...tail,
  ];
}

/**
 * Best-effort line counter for NDJSON files. Returns 0 when the file is
 * missing OR empty OR unreadable — all three are equivalent for the
 * cold-start decision ("no sessions yet").
 *
 * Reads the full file because sessions.jsonl is small (1 line/session, ~2 KB
 * each — even 100 sessions = ~200 KB).
 *
 * @param {string} filePath
 * @returns {Promise<number>}
 */
async function countLines(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8');
    if (!raw) return 0;
    // Trailing newline must not inflate the count. split-then-filter handles
    // both Unix (\n) and Windows (\r\n) line endings.
    const lines = raw.split('\n').filter((l) => l.length > 0);
    return lines.length;
  } catch {
    return 0;
  }
}

/**
 * Existence check via fs.promises.stat. Returns true only when the path
 * resolves to a regular file or directory. Any error → false.
 *
 * @param {string} p
 * @returns {Promise<boolean>}
 */
async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect cold-start state and produce a banner-emit decision.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - resolved repo root (caller passes
 *   `resolveProjectDir()` from platform.mjs)
 * @param {number} [opts.nudgeAfterHours=1] - PRD default 1 — emit only if
 *   bootstrap age >= this. Override via Session Config
 *   `cold-start.nudge-after-hours`.
 * @param {number} [opts.silenceAfterSessions=1] - PRD default 1 — silence
 *   after >= this many sessions exist. Override via Session Config
 *   `cold-start.silence-after-sessions`.
 * @param {boolean} [opts.enabled=true] - master switch (Session Config
 *   `cold-start.enabled`). When false, returns shouldEmit=false with
 *   reason='disabled'.
 * @param {number} [opts.now] - injected clock for tests (defaults to
 *   Date.now()).
 * @returns {Promise<{shouldEmit: boolean, reason: string, markerPath?: string, bannerLines?: string[]}>}
 */
export async function detectColdStart(opts = {}) {
  const {
    repoRoot,
    nudgeAfterHours = 1,
    silenceAfterSessions = 1,
    enabled = true,
    now = Date.now(),
  } = opts;

  // Defensive: missing repoRoot is a programming error, but the hook
  // contract is "never break" — fall through cleanly.
  if (!repoRoot || typeof repoRoot !== 'string') {
    return { shouldEmit: false, reason: 'no-repo-root' };
  }

  if (enabled === false) {
    return { shouldEmit: false, reason: 'disabled' };
  }

  const lockPath = path.join(repoRoot, BOOTSTRAP_LOCK_REL);
  const sessionsPath = path.join(repoRoot, SESSIONS_JSONL_REL);
  const markerPath = path.join(repoRoot, WELCOME_MARKER_REL);

  // PRD §F1.3 Unwanted behaviour: if bootstrap.lock missing, do NOT emit.
  // Bootstrap-gate handles that path — emitting here would race the gate.
  if (!(await exists(lockPath))) {
    return { shouldEmit: false, reason: 'no-bootstrap-lock' };
  }

  // PRD §F1.3 Ubiquitous: silence once the repo has ≥ N sessions. This is
  // the auto-silence path — banner is one-shot per repo (default N=1).
  const sessionCount = await countLines(sessionsPath);
  if (sessionCount >= silenceAfterSessions) {
    return {
      shouldEmit: false,
      reason: `sessions-floor-met (${sessionCount} >= ${silenceAfterSessions})`,
    };
  }

  // PRD §F1.3 Event-driven: bootstrap age >= nudge-after-hours.
  let bootstrappedAt;
  try {
    const lockRaw = await readFile(lockPath, 'utf8');
    const parsed = parseBootstrapLock(lockRaw);
    // Prefer modern `bootstrapped-at` (post-#186); fall back to legacy
    // `timestamp` for older locks.
    bootstrappedAt = parsed['bootstrapped-at'] || parsed['timestamp'] || null;
  } catch {
    return { shouldEmit: false, reason: 'lock-read-failed' };
  }

  if (!bootstrappedAt) {
    return { shouldEmit: false, reason: 'lock-no-timestamp' };
  }

  const ts = Date.parse(bootstrappedAt);
  if (Number.isNaN(ts)) {
    return { shouldEmit: false, reason: 'lock-unparseable-timestamp' };
  }

  const ageMs = now - ts;
  const thresholdMs = nudgeAfterHours * MS_PER_HOUR;
  if (ageMs < thresholdMs) {
    const ageHours = Math.floor(ageMs / MS_PER_HOUR);
    return {
      shouldEmit: false,
      reason: `bootstrap-too-fresh (${ageHours}h < ${nudgeAfterHours}h)`,
    };
  }

  // All conditions met — emit. Marker presence is informational: the hook
  // calls `consumeMarker(markerPath)` only when this field is non-null.
  const markerPresent = await exists(markerPath);

  return {
    shouldEmit: true,
    reason: markerPresent
      ? 'migration-marker-present'
      : `bootstrap-age-met (${Math.floor(ageMs / MS_PER_HOUR)}h >= ${nudgeAfterHours}h, sessions=${sessionCount})`,
    markerPath: markerPresent ? markerPath : undefined,
    bannerLines: buildBannerLines({ bootstrappedAt }),
  };
}

/**
 * Delete the migration-seed marker after the banner has been emitted.
 *
 * Best-effort: any failure (already deleted by another session, permission
 * issue, missing parent dir) is swallowed. The next session-start will
 * re-evaluate via the standard sessions-jsonl path.
 *
 * @param {string} markerPath - absolute path returned by `detectColdStart()`
 * @returns {Promise<boolean>} true on successful delete, false otherwise
 */
export async function consumeMarker(markerPath) {
  if (!markerPath || typeof markerPath !== 'string') return false;
  try {
    await unlink(markerPath);
    return true;
  } catch {
    return false;
  }
}
