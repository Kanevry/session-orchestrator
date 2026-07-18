/**
 * eval/session-resolve.mjs — deterministic session selection + time-window
 * attribution helpers for the aiat-llm-eval engine (Epic #803, S3).
 *
 * The engine scores ONE completed orchestrator session. Two questions must be
 * answered deterministically and honestly before any dimension is graded:
 *
 *   1. WHICH session? — resolveSession() implements the operator-approved
 *      cascade (Decision #2, revised #822): explicit id > newest record (source
 *      order) that is either status:'completed' or non-abandoned with completed
 *      work. Abandoned records are ALWAYS skipped.
 *
 *   2. WHOSE events? — quality_gate events in events.jsonl carry NO session_id,
 *      so they are attributed to a session by its wall-clock window
 *      [started_at, completed_at] (Decision #1: attribution = time-window).
 *      findPeerOverlap() detects when that window overlaps ANY other session's
 *      window — a contaminated window means gate-attribution is unsafe and the
 *      affected dimensions downgrade to `cannot-determine` (never guess).
 *
 * Pure module: no clock reads, no I/O — it operates on already-parsed record
 * arrays. Determinism is load-bearing for the CLI `--verify` re-evaluation path.
 */

/** Thrown by resolveSession when no eligible session can be selected. */
export class SessionResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SessionResolutionError';
  }
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Resolve the session to evaluate.
 *
 * @param {object[]} records — parsed sessions.jsonl records, in source order.
 * @param {string} [sessionId] — explicit session_id; when absent the cascade runs.
 * @returns {{ record: object, resolvedVia: 'explicit'|'cascade-completed'|'cascade-fallback' }}
 * @throws {SessionResolutionError} when nothing eligible is found.
 */
export function resolveSession(records, sessionId) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new SessionResolutionError('no session records found in sessions.jsonl');
  }

  // Explicit selection: the LAST record carrying this session_id (records may be
  // rewritten/backfilled across a session's life; the latest is authoritative).
  if (sessionId) {
    let match = null;
    for (const r of records) {
      if (isPlainObject(r) && r.session_id === sessionId) match = r;
    }
    if (!match) {
      throw new SessionResolutionError(`session not found: ${sessionId}`);
    }
    return { record: match, resolvedVia: 'explicit' };
  }

  // Cascade (#822 — single backward scan, newest-wins): walk records from
  // newest to oldest and return the FIRST one that qualifies via either tier,
  // rather than exhausting tier (a) — status:'completed' — over the WHOLE
  // array before ever considering tier (b). status:'completed' is a sparse
  // legacy field (absent from every record written after 2026-07-04 by the
  // current Phase-3.7 writer), so exhausting it first could select an
  // arbitrarily old record and skip many newer valid ones. Both resolvedVia
  // labels are preserved for downstream callers/tests.
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (!isPlainObject(r)) continue;
    if (r.status === 'abandoned') continue;
    if (r.status === 'completed') {
      return { record: r, resolvedVia: 'cascade-completed' };
    }
    // status may be absent (absent !== 'abandoned') — qualifies when it
    // otherwise shows evidence of completed work.
    if (!r.completed_at) continue;
    const complete = isPlainObject(r.agent_summary) ? r.agent_summary.complete ?? 0 : 0;
    const rate = isPlainObject(r.effectiveness) ? r.effectiveness.completion_rate : undefined;
    if (complete > 0 || (rate !== undefined && rate !== null)) {
      return { record: r, resolvedVia: 'cascade-fallback' };
    }
  }

  throw new SessionResolutionError(
    'no completed session found (all records abandoned or without evidence of completed work)',
  );
}

/**
 * Compute the wall-clock window [start, end] (epoch ms) for a session record.
 * Returns null when either boundary is missing / unparseable — the caller then
 * treats window-attributed dimensions as unmeasurable rather than guessing.
 *
 * @param {object} record
 * @returns {{ start: number, end: number } | null}
 */
export function computeWindow(record) {
  if (!isPlainObject(record)) return null;
  const start = Date.parse(record.started_at);
  const end = Date.parse(record.completed_at);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return { start, end };
}

/**
 * Detect peer sessions whose window overlaps the resolved session's window.
 *
 * Overlap uses STRICT inequality (a.start < b.end && b.start < a.end) so two
 * back-to-back sessions that merely touch at a shared boundary are NOT counted
 * as overlapping. Records sharing the resolved session_id (duplicate/backfill
 * rewrites of the SAME session) are excluded, as are records without a valid
 * window.
 *
 * @param {object[]} records — all sessions.jsonl records.
 * @param {object} resolved — the resolved session record.
 * @returns {{ count: number, peers: string[] }} unique overlapping session_ids.
 */
export function findPeerOverlap(records, resolved) {
  const win = computeWindow(resolved);
  if (!win || !Array.isArray(records)) return { count: 0, peers: [] };

  const peers = new Set();
  for (const r of records) {
    if (!isPlainObject(r)) continue;
    if (r.session_id === resolved.session_id) continue;
    const w = computeWindow(r);
    if (!w) continue;
    if (win.start < w.end && w.start < win.end) {
      peers.add(typeof r.session_id === 'string' ? r.session_id : '(unknown)');
    }
  }
  const list = [...peers];
  return { count: list.length, peers: list };
}
