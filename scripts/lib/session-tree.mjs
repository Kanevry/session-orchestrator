/**
 * session-tree — the tree Session → Wave → Agent for one session (#2218).
 *
 * Read-only. Three ledgers under `.orchestrator/metrics/`, in this order of
 * authority:
 *
 *   1. `subagents.jsonl` — PRIMARY. One `start` and usually one `stop` row per
 *      agent, keyed by `parent_session_id` (the raw harness UUID). Optional
 *      `wave` (positive integer) / `wave_role` (string) when known.
 *   2. `events.jsonl` (+ rotated archives) — SECONDARY. `orchestrator.agent.stopped`
 *      maps raw ↔ semantic session ids and may carry `agent`, `wave`, `wave_role`.
 *   3. `sessions.jsonl` — one row per CLOSED session: semantic `session_id`,
 *      optional `raw_session_id`, recorded `waves[]` with roles and counts.
 *
 * Wave of an agent: the FIRST row that carries one wins, in ledger order
 * (subagents.jsonl before events; within it the start row precedes the stop
 * row), and `wave_role` is taken from that same row only. The stop row reads
 * the manifest at stop time, so an agent that outlives its wave can name a
 * later one there; such agents are counted in `coverage.wave_disagreements`,
 * never moved. Each agent carries `session_id` (its raw parent session), since
 * one semantic label can resolve to several raw ids.
 *
 * Id resolution runs to a fixpoint over every raw ↔ semantic pair in
 * `sessions.jsonl` and `orchestrator.agent.stopped`, so the set does not depend
 * on row order: a raw selector widens over its label(s) to every raw id that
 * shares them, and a label to every raw id it names. A recorded wave
 * (`sessions.jsonl`) follows the same first-row rule as an agent's wave; when
 * two resolved sessions record the same wave number, the first row in ledger
 * order is shown and the wave is counted in `coverage.recorded_conflicts`.
 *
 * An agent with no known wave lands in `unassigned`, never dropped. The
 * `coverage` / `sources` blocks let a consumer tell "measured zero" from "not
 * measurable": a ledger that is absent reports `present: false`, not 0 rows.
 *
 * @module scripts/lib/session-tree
 */

import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

import { readEventsWithRotations } from './events.mjs';
import { resolveLedgerPath } from './ledger-path.mjs';
import { resolveEventsLedgerRoot } from './platform.mjs';

/**
 * Events-ledger window for the #1401 census (`events-retention-banner.mjs`):
 * `null` — a session can be selected however old it is, so no day count bounds
 * the question. A cut history only removes the SECONDARY source: the raw ↔
 * semantic mapping and the events-side wave fallback for that session go
 * missing, which `sources.events.complete` / `rows_matched` make visible; the
 * agents themselves still come from `subagents.jsonl`.
 */
export const REQUIRED_EVENTS_WINDOW_DAYS = null;

const SUBAGENTS_REL = '.orchestrator/metrics/subagents.jsonl';
const SESSIONS_REL = path.join('.orchestrator', 'metrics', 'sessions.jsonl');
const AGENT_STOPPED = 'orchestrator.agent.stopped';
const WAVE_COMPLETED = 'orchestrator.wave.completed';

/** A ledger that must be readable for the tree to mean anything. */
export class LedgerUnreadableError extends Error {
  /**
   * @param {string} file
   * @param {string} reason
   */
  constructor(file, reason) {
    super(`ledger unreadable: ${file} (${reason})`);
    this.name = 'LedgerUnreadableError';
    this.file = file;
  }
}

const isWave = (v) => Number.isInteger(v) && v > 0;
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const pick = (a, b) => (a !== null && a !== undefined ? a : b ?? null);

/**
 * Stream a JSONL file line by line. Malformed lines are skipped and counted.
 *
 * @param {string} file
 * @param {(row: object) => void} onRow
 * @returns {Promise<{present: boolean, rows: number, malformed_lines: number}>}
 */
async function streamJsonl(file, onRow) {
  if (!existsSync(file)) return { present: false, rows: 0, malformed_lines: 0 };
  let rows = 0;
  let malformed = 0;
  const rl = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (line.trim() === '') continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      malformed += 1;
      continue;
    }
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      malformed += 1;
      continue;
    }
    rows += 1;
    onRow(row);
  }
  return { present: true, rows, malformed_lines: malformed };
}

function updateNewestSession(newest, row) {
  if (!isStr(row.parent_session_id)) return;
  const ms = Date.parse(row.timestamp);
  if (ms >= newest.ms) {
    newest.id = row.parent_session_id;
    newest.ms = ms;
  }
}

/**
 * Raw id of the newest session in `subagents.jsonl` rows (max timestamp).
 *
 * @param {object[]} subagentRows
 * @returns {string|null}
 */
export function newestSessionId(subagentRows) {
  const newest = { id: null, ms: -Infinity };
  for (const row of subagentRows) updateNewestSession(newest, row);
  return newest.id;
}

function addSessionPair(pairs, rawId, label) {
  if (!isStr(rawId) || !isStr(label)) return;
  if (!pairs.has(rawId)) pairs.set(rawId, new Set());
  pairs.get(rawId).add(label);
}

// Resolve the whole connected component even when a linking row arrived last.
function widenSessionIds(raw, semantic, pairs) {
  for (let grew = true; grew;) {
    grew = false;
    for (const [id, labels] of pairs) {
      for (const label of labels) {
        if (raw.has(id) === semantic.has(label)) continue;
        raw.add(id);
        semantic.add(label);
        grew = true;
      }
    }
  }
}

/**
 * Build the tree for one session. Pure: rows in, tree out.
 *
 * @param {object} args
 * @param {string} args.selector — raw harness UUID or semantic session label
 * @param {object[]} args.subagentRows — parsed `subagents.jsonl` rows
 * @param {object[]|null} args.eventRows — parsed events, `null` = not readable
 * @param {object[]|null} args.sessionRows — parsed `sessions.jsonl` rows, `null` = absent
 * @returns {{found: boolean, session: object, waves: object[], unassigned: object, coverage: object}}
 */
export function buildSessionTree({ selector, subagentRows, eventRows, sessionRows }) {
  const raw = new Set();
  const semantic = new Set();
  const pairs = new Map();
  if (subagentRows.some((r) => r.parent_session_id === selector)) raw.add(selector);
  for (const s of sessionRows ?? []) {
    if (s.raw_session_id === selector) raw.add(selector);
    if (s.session_id === selector) semantic.add(selector);
    addSessionPair(pairs, s.raw_session_id, s.session_id);
  }
  for (const e of eventRows ?? []) {
    if (e?.event !== AGENT_STOPPED) continue;
    if (e.session_id === selector) raw.add(selector);
    if (e.semantic_session_id === selector) semantic.add(selector);
    addSessionPair(pairs, e.session_id, e.semantic_session_id);
  }
  widenSessionIds(raw, semantic, pairs);

  /** @type {Map<string, object>} */
  const agents = new Map();
  const touch = (id) => {
    if (!agents.has(id)) {
      agents.set(id, {
        agent_id: id, session_id: null, agent_type: null, started_at: null, stopped_at: null,
        wave: null, wave_role: null, wave_source: null,
      });
    }
    return agents.get(id);
  };

  let subRowsMatched = 0;
  let stopsWithoutTranscript = 0;
  // Agents whose rows name more than one wave (see module header: first row wins).
  const disagreeing = new Set();
  for (const r of subagentRows) {
    if (!raw.has(r.parent_session_id) || !isStr(r.agent_id)) continue;
    subRowsMatched += 1;
    const a = touch(r.agent_id);
    a.session_id = pick(a.session_id, r.parent_session_id);
    a.agent_type = pick(a.agent_type, isStr(r.agent_type) ? r.agent_type : null);
    if (r.event === 'start') a.started_at = minTs(a.started_at, r.timestamp);
    if (r.event === 'stop') {
      a.stopped_at = maxTs(a.stopped_at, r.timestamp);
      if (r.subagent_transcript_found === false) stopsWithoutTranscript += 1;
    }
    if (isWave(r.wave)) {
      if (a.wave === null) {
        a.wave = r.wave;
        a.wave_role = isStr(r.wave_role) ? r.wave_role : null;
        a.wave_source = 'subagents';
      } else if (a.wave !== r.wave) {
        disagreeing.add(r.agent_id);
      }
    }
  }

  // Events: only enrich agents subagents.jsonl already knows for this session,
  // and add events-only agents (subagent row lost) as such.
  let evRowsMatched = 0;
  const waveCompleted = new Map();
  for (const e of eventRows ?? []) {
    if (e?.event === AGENT_STOPPED && raw.has(e.session_id) && isStr(e.agent_id)) {
      evRowsMatched += 1;
      const a = touch(e.agent_id);
      a.session_id = pick(a.session_id, e.session_id);
      a.agent_type = pick(a.agent_type, isStr(e.agent) ? e.agent : null);
      a.stopped_at = pick(a.stopped_at, isStr(e.timestamp) ? e.timestamp : null);
      if (isWave(e.wave)) {
        if (a.wave === null) {
          a.wave = e.wave;
          a.wave_role = isStr(e.wave_role) ? e.wave_role : null;
          a.wave_source = 'events';
        } else if (a.wave !== e.wave) {
          disagreeing.add(e.agent_id);
        }
      }
    } else if (e?.event === WAVE_COMPLETED && raw.has(e.session_id) && isWave(e.wave_number)) {
      // A wave.completed row without session_id is never attributed.
      evRowsMatched += 1;
      waveCompleted.set(e.wave_number, e);
    }
  }

  // Recorded waves from sessions.jsonl (closed sessions only).
  const recorded = new Map();
  const recordedBy = new Map();
  const recordedConflicts = new Set();
  let sessRowsMatched = 0;
  for (const s of sessionRows ?? []) {
    if (!semantic.has(s.session_id)) continue;
    sessRowsMatched += 1;
    for (const w of Array.isArray(s.waves) ? s.waves : []) {
      if (!isWave(w?.wave)) continue;
      if (!recorded.has(w.wave)) {
        recorded.set(w.wave, w);
        recordedBy.set(w.wave, s.session_id);
      } else if (recordedBy.get(w.wave) !== s.session_id) {
        recordedConflicts.add(w.wave);
      }
    }
  }

  const waveNums = new Set([...recorded.keys(), ...waveCompleted.keys()]);
  for (const a of agents.values()) if (a.wave !== null) waveNums.add(a.wave);
  const all = [...agents.values()].sort(byStart);
  const strip = ({ wave: _w, ...rest }) => rest;
  const waves = [...waveNums].sort((x, y) => x - y).map((n) => {
    const members = all.filter((a) => a.wave === n);
    const rec = recorded.get(n) ?? null;
    const done = waveCompleted.get(n) ?? null;
    return {
      wave: n,
      role: pick(isStr(rec?.role) ? rec.role : null, members.find((a) => a.wave_role)?.wave_role ?? null),
      agents: members.map(strip),
      recorded: rec || done
        ? {
            agent_count: Number.isInteger(rec?.agent_count) ? rec.agent_count : null,
            files_changed: pick(Number.isInteger(rec?.files_changed) ? rec.files_changed : null,
              Number.isInteger(done?.files_changed) ? done.files_changed : null),
          }
        : null,
    };
  });
  const unassigned = all.filter((a) => a.wave === null).map(strip);

  const withWave = all.length - unassigned.length;
  return {
    found: raw.size > 0 || semantic.size > 0,
    session: {
      selector,
      raw_session_ids: [...raw].sort(),
      semantic_session_ids: [...semantic].sort(),
    },
    waves,
    unassigned: { count: unassigned.length, agents: unassigned },
    coverage: {
      // false = no raw id resolvable, so agents are NOT measurable (not zero).
      agents_measurable: raw.size > 0,
      agents_total: all.length,
      agents_with_wave: withWave,
      wave_from_subagents: all.filter((a) => a.wave_source === 'subagents').length,
      wave_from_events: all.filter((a) => a.wave_source === 'events').length,
      wave_disagreements: disagreeing.size,
      unassigned: unassigned.length,
      recorded_waves: recorded.size,
      recorded_conflicts: recordedConflicts.size,
      rows_matched: { subagents: subRowsMatched, events: evRowsMatched, sessions: sessRowsMatched },
      stop_rows_without_transcript: stopsWithoutTranscript,
    },
  };
}

function minTs(a, b) {
  if (!isStr(b)) return a;
  return a === null || Date.parse(b) < Date.parse(a) ? b : a;
}
function maxTs(a, b) {
  if (!isStr(b)) return a;
  return a === null || Date.parse(b) > Date.parse(a) ? b : a;
}
function byStart(x, y) {
  const a = x.started_at ?? x.stopped_at ?? '';
  const b = y.started_at ?? y.stopped_at ?? '';
  return a < b ? -1 : a > b ? 1 : x.agent_id < y.agent_id ? -1 : 1;
}

async function readRelatedRows(repoRoot, sessPath, raw, semantic, pairs) {
  function matchesSession(id, label) {
    if (pairs) addSessionPair(pairs, id, label);
    return raw.has(id) || semantic.has(label);
  }

  const sessionRows = [];
  let sess = { present: false, rows: 0, malformed_lines: 0, error: null };
  try {
    const stats = await streamJsonl(sessPath, (r) => {
      if (matchesSession(r.raw_session_id, r.session_id)) sessionRows.push(r);
    });
    sess = { ...stats, error: null };
  } catch (err) {
    sess.error = err?.code ?? 'read-failed';
  }

  let ev;
  let eventRows = null;
  try {
    const read = readEventsWithRotations(repoRoot, { filter: (e) => {
      if (e?.event === AGENT_STOPPED) return matchesSession(e.session_id, e.semantic_session_id);
      return e?.event === WAVE_COMPLETED && raw.has(e.session_id);
    } });
    eventRows = read.events;
    // `present` = at least one source was actually READ. `complete !== null`
    // only says a source EXISTS: an unreadable active file with no archive
    // gives `complete: false` and zero events, which must not print as 0.
    const unreadable = read.sources.filter((s) => s.readable === false).length;
    ev = {
      path: read.active_path, present: read.sources.some((s) => s.readable !== false),
      complete: read.complete, gaps: read.gaps.length, unreadable_sources: unreadable,
      malformed_lines: read.malformed_lines, error: null,
    };
  } catch (err) {
    ev = {
      path: null, present: null, complete: null, gaps: null, unreadable_sources: null,
      malformed_lines: null, error: err?.code ?? 'read-failed',
    };
  }

  return { sessionRows, sess, eventRows, ev };
}

async function readSubagents(file, onRow) {
  let stats;
  try {
    stats = await streamJsonl(file, onRow);
  } catch (err) {
    throw new LedgerUnreadableError(file, err?.code ?? String(err?.message ?? err));
  }
  if (!stats.present) throw new LedgerUnreadableError(file, 'absent');
  return stats;
}

/**
 * Load the three ledgers for `repoRoot` and build the tree.
 *
 * `subagents.jsonl` resolves through {@link resolveLedgerPath} (a linked
 * worktree reads the main checkout's copy when it ignores the ledger);
 * events and sessions map through `resolveEventsLedgerRoot`, as their writers do.
 *
 * @param {object} args
 * @param {string} args.repoRoot — absolute repo root
 * @param {string|null} [args.session] — raw UUID or semantic label; default newest
 * @returns {Promise<object>} the tree plus a `sources` block
 * @throws {LedgerUnreadableError} when `subagents.jsonl` is absent or unreadable
 */
export async function loadSessionTree({ repoRoot, session = null }) {
  const subPath = resolveLedgerPath(SUBAGENTS_REL, repoRoot);
  const newest = { id: null, ms: -Infinity };
  if (!isStr(session)) await readSubagents(subPath, (row) => updateNewestSession(newest, row));
  const selector = isStr(session) ? session.trim() : newest.id ?? '';

  // The selector can be either kind of id. Keep candidate rows here; the
  // builder verifies which ids were actually observed (including subagents).
  const raw = new Set([selector]);
  const semantic = new Set([selector]);
  const pairs = new Map();
  const sessPath = path.join(resolveEventsLedgerRoot(repoRoot), SESSIONS_REL);
  let related = await readRelatedRows(repoRoot, sessPath, raw, semantic, pairs);
  widenSessionIds(raw, semantic, pairs);
  if (raw.size > 1 || semantic.size > 1) {
    // An alias may have appeared after its rows, including across rotations.
    related = await readRelatedRows(repoRoot, sessPath, raw, semantic);
  }
  const { sessionRows, sess, eventRows, ev } = related;
  const subagentRows = [];
  const sub = await readSubagents(subPath, (r) => {
    if (raw.has(r.parent_session_id)) subagentRows.push(r);
  });
  const tree = buildSessionTree({
    selector,
    subagentRows,
    eventRows,
    sessionRows: sess.present ? sessionRows : null,
  });
  return {
    ...tree,
    session: { ...tree.session, defaulted: !isStr(session) },
    sources: {
      subagents: { path: subPath, present: true, rows: sub.rows, malformed_lines: sub.malformed_lines },
      events: ev,
      sessions: { path: sessPath, present: sess.present, rows: sess.rows, malformed_lines: sess.malformed_lines, error: sess.error },
    },
  };
}
