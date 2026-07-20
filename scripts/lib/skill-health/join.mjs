/**
 * join.mjs — Layer 2 (L2) skill-health: join skill-selection events to session outcomes.
 *
 * COARSE-GRANULARITY LIMITATION (read before using):
 * The existing data model only records outcome signals at SESSION granularity via
 * `agent_summary: { complete, partial, failed, spiral }` in sessions.jsonl. There is NO
 * per-skill, per-wave, or per-invocation outcome signal in the current schema. Therefore
 * this join is inherently coarse: for each skill we can tell WHICH sessions selected it
 * and what those sessions' AGGREGATE outcomes were — but NOT whether the skill itself
 * succeeded or failed within a session. Callers must not interpret the outcome buckets
 * as per-skill success/failure rates; they are session-level aggregate outcomes for sessions
 * that happened to select the skill.
 *
 * Where a session_id from skill-invocations.jsonl is not found in sessions.jsonl (e.g.
 * the session is still in progress, or the record was never written), the session
 * contributes `unknown` to the outcome tally — it is never silently dropped.
 *
 * ABANDONED-SESSION HANDLING (#834): a session_id CAN be found in sessions.jsonl
 * yet be a phantom stub (`status: 'abandoned'`, written by session-close-backfill
 * for a session that ended without a real close — 0 waves, all-zero agent_summary).
 * Counting such a join as `sessionsJoined` would inflate the skill's join
 * denominator with zero real contribution — the join "succeeds" but carries no
 * signal. Per this module's own "never silently dropped" contract, an abandoned
 * join is routed to a DISTINCT `abandoned` outcome bucket rather than either (a)
 * silently folding into `sessionsJoined`/the numeric outcome fields with zero
 * contribution (inflates the denominator invisibly), or (b) folding into
 * `unknown` (which means "not found in the ledger at all" — a different failure
 * mode a caller may want to distinguish from "found but phantom").
 *
 * Part of Epic #645 — Skill Self-Evolution Foundation, Layer 2.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isRealSession } from '../session-schema/filters.mjs';

const DEFAULT_INVOCATIONS_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../.orchestrator/metrics/skill-invocations.jsonl',
);

const DEFAULT_SESSIONS_PATH = path.resolve(
  fileURLToPath(import.meta.url),
  '../../../../.orchestrator/metrics/sessions.jsonl',
);

/**
 * Reads a JSONL file and returns an array of successfully parsed records.
 * Silently skips malformed lines. Returns [] when the file is absent.
 *
 * @param {string} filePath
 * @returns {Promise<object[]>}
 */
async function readJsonl(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const records = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // skip malformed lines per spec
    }
  }
  return records;
}

/**
 * Builds a Map<session_id, { agentSummary, real }> from sessions.jsonl records.
 * Records without a session_id or with a non-object agent_summary are skipped.
 * `real` is false for phantom `status: 'abandoned'` stubs (#834) — callers use
 * it to route the join to the `abandoned` outcome bucket instead of counting
 * a zero-signal join as `sessionsJoined`.
 *
 * @param {object[]} sessionRecords
 * @returns {Map<string, { agentSummary: { complete: number, partial: number, failed: number, spiral: number }, real: boolean }>}
 */
function buildSessionMap(sessionRecords) {
  const map = new Map();
  for (const rec of sessionRecords) {
    if (typeof rec.session_id !== 'string' || !rec.session_id) continue;
    if (rec.agent_summary && typeof rec.agent_summary === 'object') {
      map.set(rec.session_id, { agentSummary: rec.agent_summary, real: isRealSession(rec) });
    }
  }
  return map;
}

/**
 * Joins skill-selection events to existing session outcomes.
 *
 * @param {object} [opts]
 * @param {string} [opts.invocationsPath] - Path to skill-invocations.jsonl (L1 writer output).
 * @param {string} [opts.sessionsPath]    - Path to sessions.jsonl.
 *
 * @returns {Promise<{
 *   bySkill: {
 *     [skill: string]: {
 *       skill: string,
 *       selections: number,
 *       sessions: string[],
 *       outcomes: { complete: number, partial: number, failed: number, spiral: number, unknown: number, abandoned: number }
 *     }
 *   },
 *   totalSelections: number,
 *   sessionsJoined: number,
 *   sessionsUnknown: number,
 *   sessionsAbandoned: number
 * }>}
 */
export async function joinSkillOutcomes({
  invocationsPath = DEFAULT_INVOCATIONS_PATH,
  sessionsPath = DEFAULT_SESSIONS_PATH,
} = {}) {
  const [invocations, sessionRecords] = await Promise.all([
    readJsonl(invocationsPath),
    readJsonl(sessionsPath),
  ]);

  const sessionMap = buildSessionMap(sessionRecords);

  /** @type {Map<string, { skill: string, selectionCount: number, sessions: Set<string>, outcomes: object }>} */
  const bySkill = new Map();

  let totalSelections = 0;
  let sessionsJoined = 0;
  let sessionsUnknown = 0;
  let sessionsAbandoned = 0;

  for (const inv of invocations) {
    // Only process skill-selection events with a valid skill field
    if (typeof inv.skill !== 'string' || !inv.skill) continue;
    if (inv.event !== 'selected') continue;

    const skill = inv.skill;
    const sessionId = typeof inv.session_id === 'string' ? inv.session_id : null;

    totalSelections += 1;

    if (!bySkill.has(skill)) {
      bySkill.set(skill, {
        skill,
        selectionCount: 0,
        sessions: new Set(),
        outcomes: { complete: 0, partial: 0, failed: 0, spiral: 0, unknown: 0, abandoned: 0 },
      });
    }

    const record = bySkill.get(skill);
    record.selectionCount += 1;

    if (sessionId) {
      const isNew = !record.sessions.has(sessionId);
      record.sessions.add(sessionId);

      if (isNew) {
        const entry = sessionMap.get(sessionId);
        if (entry && entry.real) {
          const summary = entry.agentSummary;
          // Sum session-level aggregate outcomes into this skill's buckets
          record.outcomes.complete += typeof summary.complete === 'number' ? summary.complete : 0;
          record.outcomes.partial += typeof summary.partial === 'number' ? summary.partial : 0;
          record.outcomes.failed += typeof summary.failed === 'number' ? summary.failed : 0;
          record.outcomes.spiral += typeof summary.spiral === 'number' ? summary.spiral : 0;
          sessionsJoined += 1;
        } else if (entry && !entry.real) {
          // Found in sessions.jsonl but a phantom abandoned stub (#834) — a
          // zero-signal join. Route to a distinct bucket instead of inflating
          // sessionsJoined or conflating with "not found at all" (unknown).
          record.outcomes.abandoned += 1;
          sessionsAbandoned += 1;
        } else {
          // Session id not found in sessions.jsonl — count as unknown, never drop
          record.outcomes.unknown += 1;
          sessionsUnknown += 1;
        }
      }
    } else {
      // No session_id on the invocation record — count as unknown
      record.outcomes.unknown += 1;
      sessionsUnknown += 1;
    }
  }

  // Serialize: convert Set<string> → sorted string[] for stable output
  /** @type {Record<string, object>} */
  const bySkillObj = {};
  for (const [skill, rec] of bySkill.entries()) {
    bySkillObj[skill] = {
      skill: rec.skill,
      selections: rec.selectionCount,
      sessions: [...rec.sessions].sort(),
      outcomes: rec.outcomes,
    };
  }

  return { bySkill: bySkillObj, totalSelections, sessionsJoined, sessionsUnknown, sessionsAbandoned };
}
