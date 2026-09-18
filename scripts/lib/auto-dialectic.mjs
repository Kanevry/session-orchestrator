/**
 * auto-dialectic.mjs — Cadence helper for the dialectic derivation (#506, F2.5).
 *
 * Mirrors the auto-dream.mjs API shape exactly. Decides whether a dialectic
 * derivation is DUE, writes the proposed peer-card diff to
 * `.orchestrator/dialectic-pending.md` atomically, and tracks the last-run
 * timestamp at `.orchestrator/dialectic-last-run`.
 *
 * Who calls what (the session-end Phase 3.6.7 auto-trigger is GONE — #1288):
 *   - `shouldDispatchAutoDialectic` — read by the session-start `maintenance-due`
 *     probe (`scripts/lib/maintenance-due-banner.mjs`) to report the `dialectic`
 *     signal. Side-effect-free by contract: a variant advancing the last-run stamp
 *     would consume the signal it reports.
 *   - `writeDialecticPending` / `consumeDialecticPending` / `writeDialecticLastRun` —
 *     called by `/evolve dialectic` (Step 6.4 in
 *     `skills/evolve/references/evolve-dialectic-mode.md`), the only trigger today.
 *   - Both sidecars are READ by the same `maintenance-due` probe.
 *
 * Decision inputs (PRD F2.5 acceptance criteria):
 *   - dialectic.cadence (default 5) — sessions since last dialectic run
 *   - kill-switch: cadence === 0 → never trigger
 *   - AC4 precondition: skip when no new sessions AND no new learnings since
 *     last run (no-op input → no-op output)
 *
 * Pure-function decision; side effects (sidecar write, timestamp update) are
 * separate helpers. No external deps — Node 20+ stdlib only.
 */

import { readFile, writeFile, rename, unlink, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { filterRealSessions } from './session-schema.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default cadence: dispatch every N sessions when nothing else interferes. */
export const DEFAULT_CADENCE = 5;

/** Repo-relative path to the last-run timestamp file. */
export const DIALECTIC_LAST_RUN_PATH = '.orchestrator/dialectic-last-run';

/** Repo-relative path to the pending dialectic proposal sidecar. */
export const DIALECTIC_PENDING_PATH = '.orchestrator/dialectic-pending.md';

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function lastRunPath(repoRoot) {
  return path.join(repoRoot, DIALECTIC_LAST_RUN_PATH);
}

function pendingPath(repoRoot) {
  return path.join(repoRoot, DIALECTIC_PENDING_PATH);
}

function sessionsJsonlPath(repoRoot) {
  return path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl');
}

function learningsJsonlPath(repoRoot) {
  return path.join(repoRoot, '.orchestrator', 'metrics', 'learnings.jsonl');
}

// ---------------------------------------------------------------------------
// Last-run timestamp reader (defensive — never throws)
// ---------------------------------------------------------------------------

/**
 * Read `.orchestrator/dialectic-last-run`. Returns the trimmed ISO timestamp
 * string, or `null` when the file is absent / unreadable / empty / malformed.
 *
 * Defensive: any filesystem or parse error degrades to `null` (signal-reader
 * convention — same as auto-dream.mjs which never throws on missing inputs).
 *
 * @param {object} args
 * @param {string} args.repoRoot Absolute path to the repo root.
 * @returns {Promise<string|null>}
 */
export async function readDialecticLastRun({ repoRoot } = {}) {
  if (!repoRoot) return null;
  const target = lastRunPath(repoRoot);
  if (!existsSync(target)) return null;
  try {
    const raw = await readFile(target, 'utf8');
    const trimmed = raw.trim();
    if (trimmed.length === 0) return null;
    // Validate as a parseable ISO timestamp (best-effort).
    const ms = Date.parse(trimmed);
    if (Number.isNaN(ms)) return null;
    return trimmed;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Signal reader — sessions + learnings since lastRun
// ---------------------------------------------------------------------------

/**
 * Count sessions.jsonl + learnings.jsonl entries newer than the last-run
 * timestamp. When no last-run timestamp exists, returns the total entry count
 * for each stream (mirrors auto-dream's "no prior cleanup" branch).
 *
 * Schema-defensive: malformed JSONL lines are silently skipped (best-effort
 * signal reader). Entries lacking the relevant timestamp field are not counted
 * against the cadence — only entries we can date inclusively.
 *
 * Timestamp fields used:
 *   - sessions.jsonl: `started_at` (string ISO)
 *   - learnings.jsonl: `created_at` (string ISO) — falls back to `updated_at`
 *     when `created_at` is absent.
 *
 * @param {object} args
 * @param {string} args.repoRoot Absolute path to the repo root.
 * @returns {Promise<{lastRunAt:string|null, sessionsSinceLast:number, learningsSinceLast:number}>}
 */
export async function readDialecticSignals({ repoRoot } = {}) {
  const lastRunAt = await readDialecticLastRun({ repoRoot });

  let sessionsSinceLast = 0;
  let learningsSinceLast = 0;

  // Sessions
  const sessionsPath = sessionsJsonlPath(repoRoot);
  if (existsSync(sessionsPath)) {
    try {
      const raw = await readFile(sessionsPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      const entries = [];
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch {
          continue; // malformed line — skip silently
        }
      }
      // Abandoned-session filter (#834): mirrors auto-dream.mjs
      // readDreamSignals() — phantom `status: 'abandoned'` stubs are
      // legitimate DATA but not legitimate SIGNAL, and must not fire the
      // /evolve --dialectic cadence off zero real work.
      const realEntries = filterRealSessions(entries);
      for (const entry of realEntries) {
        const startedAt = entry.started_at;
        if (typeof startedAt !== 'string' || startedAt.length === 0) continue;
        if (lastRunAt === null || startedAt > lastRunAt) {
          sessionsSinceLast += 1;
        }
      }
    } catch {
      // Filesystem error reading sessions.jsonl — leave count at 0
    }
  }

  // Learnings
  const learningsPath = learningsJsonlPath(repoRoot);
  if (existsSync(learningsPath)) {
    try {
      const raw = await readFile(learningsPath, 'utf8');
      const lines = raw.split('\n').filter((l) => l.length > 0);
      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const ts = entry.created_at ?? entry.updated_at;
        if (typeof ts !== 'string' || ts.length === 0) continue;
        if (lastRunAt === null || ts > lastRunAt) {
          learningsSinceLast += 1;
        }
      }
    } catch {
      // Filesystem error reading learnings.jsonl — leave count at 0
    }
  }

  return { lastRunAt, sessionsSinceLast, learningsSinceLast };
}

// ---------------------------------------------------------------------------
// Decision function
// ---------------------------------------------------------------------------

/**
 * Decide whether a dialectic derivation is DUE — i.e. whether the operator should
 * run `/evolve dialectic` (dry-run first). Read by the session-start
 * `maintenance-due` probe; no auto-trigger consumes this any more (#1288).
 *
 * Rules (PRD F2.5):
 *   - cadence === 0 → never trigger (kill-switch).
 *   - AC4 precondition: sessionsSinceLast === 0 AND learningsSinceLast === 0 →
 *     no new input since last run → skip with reason
 *     `no-new-input-since-last-run` (the reason string is part of the contract —
 *     the `maintenance-due` probe reports it verbatim).
 *   - sessionsSinceLast >= cadence → trigger (cadence threshold met).
 *   - Otherwise → skip with reason `under-threshold (sessions=N/M)`.
 *
 * Read-only: never writes any file. Callers may pass an explicit `signals`
 * object for testing; when omitted, `readDialecticSignals()` is invoked.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {number} [args.cadence=5]    `dialectic.cadence` from config.
 * @param {object} [args.signals]      Pre-computed signals (skips disk reads).
 * @returns {Promise<{trigger:boolean, reason:string, signals:object}>}
 */
export async function shouldDispatchAutoDialectic({
  repoRoot,
  cadence = DEFAULT_CADENCE,
  signals,
} = {}) {
  // Kill-switch first — bail before any I/O.
  if (cadence === 0) {
    return {
      trigger: false,
      reason: 'kill-switch (dialectic.cadence=0)',
      signals: signals ?? { lastRunAt: null, sessionsSinceLast: 0, learningsSinceLast: 0 },
    };
  }

  const resolved = signals ?? (await readDialecticSignals({ repoRoot }));

  // AC4 precondition: no new input since the last run → no-op output.
  // This guard runs BEFORE the cadence check so a never-decremented
  // sessionsSinceLast (e.g. stuck above cadence due to a missed write) does
  // not re-dispatch on empty inputs.
  if (resolved.sessionsSinceLast === 0 && resolved.learningsSinceLast === 0) {
    return {
      trigger: false,
      reason: 'no-new-input-since-last-run',
      signals: resolved,
    };
  }

  // Cadence-based trigger.
  if (resolved.sessionsSinceLast >= cadence) {
    return {
      trigger: true,
      reason: `cadence-threshold-met (sessions=${resolved.sessionsSinceLast} >= cadence=${cadence})`,
      signals: resolved,
    };
  }

  return {
    trigger: false,
    reason: `under-threshold (sessions=${resolved.sessionsSinceLast}/${cadence})`,
    signals: resolved,
  };
}

// ---------------------------------------------------------------------------
// last-run — atomic write
// ---------------------------------------------------------------------------

/**
 * Write `.orchestrator/dialectic-last-run` with the given ISO timestamp.
 *
 * Atomicity: write to `<path>.<rand>.tmp`, then rename(). Same-fs rename is
 * atomic on POSIX — observers see either the previous file or the new one,
 * never a half-written intermediate (mirrors auto-dream.mjs:248-251).
 *
 * Defensive: returns `{ok: false, error}` on filesystem failure rather than
 * throwing — the caller logs the error and continues.
 *
 * Caller: `/evolve dialectic` Step 6.4 (`skills/evolve/references/evolve-dialectic-mode.md`),
 * after a successful `--apply` AND after the operator explicitly discards a
 * proposal. Without this write the maintenance-due `dialectic` signal never
 * resets (#1380). The session-end auto-trigger that used to call it is gone.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string} args.isoTimestamp ISO 8601 timestamp string.
 * @returns {Promise<{ok:boolean, error?:string, path?:string}>}
 */
export async function writeDialecticLastRun({ repoRoot, isoTimestamp } = {}) {
  if (!repoRoot) {
    return { ok: false, error: 'writeDialecticLastRun: repoRoot is required' };
  }
  if (typeof isoTimestamp !== 'string' || isoTimestamp.length === 0) {
    return { ok: false, error: 'writeDialecticLastRun: isoTimestamp must be a non-empty string' };
  }

  const target = lastRunPath(repoRoot);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, `${isoTimestamp}\n`, 'utf8');
    await rename(tmp, target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// pending dialectic sidecar — atomic write / read
// ---------------------------------------------------------------------------

/**
 * Write the proposed dialectic diff to `.orchestrator/dialectic-pending.md`
 * atomically.
 *
 * Caller: `/evolve dialectic` Step 6.4's dry-run branch
 * (`skills/evolve/references/evolve-dialectic-mode.md`) — `runDialecticDeriver()`
 * returns the diff and the caller persists it here. There is no session-end
 * auto-trigger any more (#1288).
 *
 * Caller supplies the body (a Markdown document containing the peer-card
 * diff and any narrative). This helper prepends a minimal hand-rolled YAML
 * frontmatter block carrying the metadata the operator's review and the later
 * `--apply` step rely on; the session-start `maintenance-due` probe reads the
 * resulting file's presence + age for its `pending-sidecar` signal. The
 * frontmatter is hand rolled (no js-yaml dep) — auto-dream pattern.
 *
 * Atomicity: tmp+rename (mirrors auto-dream.mjs:248-251).
 *
 * @param {object} args
 * @param {string}   args.repoRoot
 * @param {string}   args.diff             Markdown body (typically a unified-diff block).
 * @param {object}   [args.usage]          {input_tokens, output_tokens} from the subagent.
 * @param {string}   [args.sourceSession]  Session id that produced the proposal.
 * @param {string}   [args.model]          Model identifier (e.g., `claude-haiku-4-5`).
 * @param {number}   [args.learningsIn]    Count of learnings consumed.
 * @param {number}   [args.sessionsIn]     Count of sessions consumed.
 * @param {string[]} [args.cardsTargeted]  Peer-card slugs the diff would touch.
 * @returns {Promise<{path:string, bytes:number}>}
 */
export async function writeDialecticPending({
  repoRoot,
  diff,
  usage = null,
  sourceSession = null,
  model = null,
  learningsIn = null,
  sessionsIn = null,
  cardsTargeted = null,
} = {}) {
  if (typeof diff !== 'string' || diff.trim().length === 0) {
    throw new TypeError('writeDialecticPending: diff must be a non-empty string');
  }
  if (!repoRoot) {
    throw new TypeError('writeDialecticPending: repoRoot is required');
  }

  const target = pendingPath(repoRoot);
  await mkdir(path.dirname(target), { recursive: true });

  const generatedAt = new Date().toISOString();
  const inputTokens = usage && typeof usage.input_tokens === 'number' ? usage.input_tokens : null;
  const outputTokens =
    usage && typeof usage.output_tokens === 'number' ? usage.output_tokens : null;

  // Render cards_targeted as a JSON-style inline list (no js-yaml dep). Empty
  // array `[]` when callers pass an empty list; `null` when omitted.
  let cardsRendered = 'null';
  if (Array.isArray(cardsTargeted)) {
    cardsRendered = `[${cardsTargeted.map((c) => JSON.stringify(c)).join(', ')}]`;
  }

  const frontmatter = [
    '---',
    `generated_at: ${generatedAt}`,
    `source_session: ${JSON.stringify(sourceSession ?? 'unknown')}`,
    `model: ${JSON.stringify(model ?? 'unknown')}`,
    `input_tokens: ${JSON.stringify(inputTokens)}`,
    `output_tokens: ${JSON.stringify(outputTokens)}`,
    `learnings_in: ${JSON.stringify(learningsIn ?? null)}`,
    `sessions_in: ${JSON.stringify(sessionsIn ?? null)}`,
    `cards_targeted: ${cardsRendered}`,
    '---',
    '',
  ].join('\n');

  const content = `${frontmatter}${diff}${diff.endsWith('\n') ? '' : '\n'}`;
  const tmp = `${target}.${randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, target);

  return { path: target, bytes: Buffer.byteLength(content, 'utf8') };
}

/**
 * Consume (delete) `.orchestrator/dialectic-pending.md` once its proposal has
 * been applied or explicitly discarded. Mirrors auto-dream's `--apply-pending`,
 * which unlinks its sidecar on success: without this, the maintenance-due
 * `pending-sidecar` signal stays due for the sidecar's full 14-day window
 * after the proposal was already dealt with (#1380).
 *
 * ENOENT is tolerated (`consumed: false`) — "already gone" is the desired end
 * state. Any other filesystem error returns `{ok: false, error}` rather than
 * throwing, matching `writeDialecticLastRun`.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @returns {Promise<{ok:boolean, consumed?:boolean, error?:string, path?:string}>}
 */
export async function consumeDialecticPending({ repoRoot } = {}) {
  if (!repoRoot) {
    return { ok: false, error: 'consumeDialecticPending: repoRoot is required' };
  }
  const target = pendingPath(repoRoot);
  try {
    await unlink(target);
    return { ok: true, consumed: true, path: target };
  } catch (err) {
    if (err?.code === 'ENOENT') return { ok: true, consumed: false, path: target };
    return { ok: false, error: err.message };
  }
}

/**
 * Read `.orchestrator/dialectic-pending.md` if present. Returns the raw file
 * body (including frontmatter) so callers can decide how to parse it.
 * Returns `null` when the file is absent or unreadable.
 *
 * Defensive: any filesystem error degrades to `null` — the file is a
 * cross-session sidecar, and a missing read is indistinguishable from
 * "no pending proposal" semantically.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @returns {Promise<string|null>}
 */
export async function readDialecticPending({ repoRoot } = {}) {
  if (!repoRoot) return null;
  const target = pendingPath(repoRoot);
  if (!existsSync(target)) return null;
  try {
    return await readFile(target, 'utf8');
  } catch {
    return null;
  }
}
