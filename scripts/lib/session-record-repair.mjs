/**
 * session-record-repair.mjs — in-place repair of schema-invalid session ledger
 * records (GitLab #1004).
 *
 * `.orchestrator/metrics/sessions.jsonl` accumulated records that fail the
 * repo's OWN `validateSession()` because they were appended by the coordinator
 * from a Markdown template instead of through `scripts/emit-session.mjs` (see
 * `scripts/lib/sessions-integrity-banner.mjs` for the visibility half of the
 * same defect). Measured at HEAD 1be450a on 2026-08-05: 33 of 216 records fail
 * `validateSession`, and 5 of those are additionally DROPPED by vault-mirror —
 * those sessions have no vault note at all.
 *
 * ── WHY REWRITE-IN-PLACE, NOT APPEND+TOMBSTONE ───────────────────────────────
 * Downstream readers count LINES, not session_ids: `memory-banner`'s
 * `sessionsEver = countJsonlLines(...)` and the integrity banner both iterate
 * lines. Appending a corrected copy of every broken record would inflate the
 * session count by 33 and make every historical metric wrong in a NEW way.
 * So each defective line is replaced positionally, line order is preserved,
 * and the file is swapped atomically (tmp + rename).
 *
 * ── WHAT THIS MODULE WILL NOT DO ─────────────────────────────────────────────
 *  - It never SYNTHESIZES history. A missing `waves` becomes `[]`, never a
 *    plausible-looking list of wave objects — `_validateWaves` passes an empty
 *    array vacuously, and inventing wave entries would fabricate a record of
 *    work that may never have happened.
 *  - It never INFERS `completed_at` from a neighbouring record. The ledger is
 *    NOT chronologically ordered (live lines 86-89 interleave two sessions), so
 *    "the next record's start" is not this record's end. A missing
 *    `completed_at` becomes `started_at` verbatim: duration 0, transparently
 *    unknown, and flagged in `_backfill_incomplete_fields`.
 *  - It never DEDUPES. `main-2026-05-11-deep-1` legitimately occupies three
 *    lines (two overlapping close attempts plus a differently-shaped third).
 *    Collapsing them would silently delete two sessions' worth of line count.
 *  - It never re-serializes a record that ALREADY passes validation — a passing
 *    line is emitted byte-for-byte, so the diff contains only real repairs and
 *    no key-order churn.
 *
 * ── PROVENANCE ───────────────────────────────────────────────────────────────
 * Every repaired record carries `_backfill_source` + `_backfill_incomplete_fields`
 * (both already schema-accepted by `_validateOptionalFields`, so no schema bump
 * is needed). The incomplete-fields list is the EXACT set of fields this record
 * had defaulted, which is what lets a downstream consumer tell a measured zero
 * apart from a repaired-to-zero.
 *
 * Plain Node ESM. Named exports. DI-friendly via `deps`.
 *
 * Cross-references:
 *  - `scripts/lib/session-schema/validator.mjs` — `validateSession` (the gate).
 *  - `scripts/lib/session-schema/serializer.mjs` — `serializeSessionLineChecked` (round-trip proof).
 *  - `scripts/lib/sessions-integrity-banner.mjs` — `checkSessionsIntegrity`.
 *  - `scripts/repair-invalid-sessions.mjs` — the CLI driver.
 */

import fs from 'node:fs';
import path from 'node:path';

import { validateSession as defaultValidateSession } from './session-schema/validator.mjs';
import { serializeSessionLineChecked as defaultSerialize } from './session-schema.mjs';
import { checkSessionsIntegrity as defaultCheckIntegrity } from './sessions-integrity-banner.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Value written to `_backfill_source` on every record this module repairs. */
export const REPAIR_SOURCE = 'repair-invalid-sessions/1004';

/** Ledger path (relative to repoRoot) that `checkSessionsIntegrity` inspects. */
export const CANONICAL_LEDGER_REL = path.join('.orchestrator', 'metrics', 'sessions.jsonl');

/** The four counters `_validateAgentSummary` requires on `agent_summary`. */
const AGENT_SUMMARY_FIELDS = Object.freeze(['complete', 'partial', 'failed', 'spiral']);

/**
 * Stable ordering for `_backfill_incomplete_fields`. Deterministic output is
 * load-bearing for the idempotency guarantee: run 2 must produce a
 * byte-identical file, which a Set's insertion order would not guarantee across
 * differently-shaped inputs.
 */
const INCOMPLETE_FIELD_ORDER = Object.freeze([
  'completed_at',
  'total_waves',
  'waves',
  'waves[].wave',
  'agent_summary',
  'agent_summary.complete',
  'agent_summary.partial',
  'agent_summary.failed',
  'agent_summary.spiral',
  'total_agents',
  'total_files_changed',
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Non-negative finite number — the shape every count field must satisfy. */
function isCount(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function orderIncompleteFields(fields) {
  const rank = (f) => {
    const i = INCOMPLETE_FIELD_ORDER.indexOf(f);
    return i === -1 ? INCOMPLETE_FIELD_ORDER.length : i;
  };
  return [...fields].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/** Compact ISO stamp for backup filenames: `20260805T091500Z`. */
export function backupStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------
// Record repair
// ---------------------------------------------------------------------------

/**
 * Repair every defect class present on ONE session record.
 *
 * Applies ALL rules, not just the first — `validateSession` throws on its first
 * violation, so a first-error-only repair would need N passes for an N-defect
 * record (live line 85 carries six). The input is never mutated.
 *
 * Defaults chosen so that the repaired value is either derivable from the
 * record itself or transparently zero/empty; nothing is invented. See the
 * module docblock for the three things this deliberately refuses to do.
 *
 * @param {object} record — a parsed sessions.jsonl record
 * @returns {{record: object, defects: string[], incompleteFields: string[], changed: boolean}}
 */
export function repairRecord(record) {
  if (!isPlainObject(record)) {
    return { record, defects: [], incompleteFields: [], changed: false };
  }

  const out = { ...record };
  const defects = [];
  const incomplete = new Set();

  // -- waves ----------------------------------------------------------------
  // A NUMBER here is not garbage: it IS the wave count, written by an older
  // template that put the count where the array belongs. Capture it before
  // discarding, or the `total_waves` repair below loses real data.
  let wavesNumber = null;
  if (!Array.isArray(out.waves)) {
    if (isCount(out.waves)) {
      wavesNumber = out.waves;
      defects.push('waves_number');
    } else if (out.waves === undefined || out.waves === null) {
      defects.push('waves_absent');
    } else {
      defects.push('waves_not_array');
    }
    out.waves = [];
    incomplete.add('waves');
  }

  // -- waves[i].wave --------------------------------------------------------
  // `_validateWaves` requires `wave >= 1` on every entry. Older shapes either
  // omit it (the number lived in `wave_number`) or start at 0 (a coordinator-
  // direct "wave 0"). Renumber the WHOLE array sequentially — patching only the
  // offending entries would produce duplicate wave numbers on the 0-based shape.
  // Bail out when any entry is not an object: that is a shape this module has
  // no defensible default for, so the record falls through to the error bucket
  // rather than being silently mangled.
  if (out.waves.length > 0 && out.waves.every(isPlainObject)) {
    const needsRenumber = out.waves.some((w) => !isCount(w.wave) || w.wave < 1);
    if (needsRenumber) {
      out.waves = out.waves.map((w, i) => ({ ...w, wave: i + 1 }));
      defects.push('wave_index_invalid');
      incomplete.add('waves[].wave');
    }
  }

  // -- total_waves ----------------------------------------------------------
  if (!isCount(out.total_waves)) {
    out.total_waves = wavesNumber !== null ? wavesNumber : out.waves.length;
    defects.push('total_waves_missing');
    incomplete.add('total_waves');
  }

  // -- agent_summary --------------------------------------------------------
  if (!isPlainObject(out.agent_summary)) {
    out.agent_summary = { complete: 0, partial: 0, failed: 0, spiral: 0 };
    defects.push('agent_summary_absent');
    incomplete.add('agent_summary');
  } else {
    const missing = AGENT_SUMMARY_FIELDS.filter((f) => !isCount(out.agent_summary[f]));
    if (missing.length > 0) {
      out.agent_summary = { ...out.agent_summary };
      for (const f of missing) {
        out.agent_summary[f] = 0;
        incomplete.add(`agent_summary.${f}`);
      }
      defects.push(
        missing.length === 1 && missing[0] === 'spiral'
          ? 'agent_summary_spiral_missing'
          : 'agent_summary_field_missing'
      );
    }
  }

  // -- total_agents ---------------------------------------------------------
  if (!isCount(out.total_agents)) {
    // Prefer the record's own evidence: an agent_summary PRESENT in the
    // original sums to the real agent count (live line 71 sums to 30 where
    // waves.length is 5 — W2/A4 review finding). Fall back to waves.length
    // only when the summary was absent or sums to 0 (no signal).
    const summarySum = isPlainObject(record.agent_summary)
      ? AGENT_SUMMARY_FIELDS.reduce(
          (n, f) => n + (isCount(record.agent_summary[f]) ? record.agent_summary[f] : 0),
          0
        )
      : 0;
    out.total_agents = summarySum > 0 ? summarySum : out.waves.length;
    defects.push('total_agents_missing');
    incomplete.add('total_agents');
  }

  // -- total_files_changed --------------------------------------------------
  if (!isCount(out.total_files_changed)) {
    out.total_files_changed = 0;
    defects.push('total_files_changed_missing');
    incomplete.add('total_files_changed');
  }

  // -- completed_at ---------------------------------------------------------
  // Legacy `ended_at` is the same fact under its old name (emit-session.mjs
  // aliasLegacyEndedAt precedent) — prefer it when parseable and monotonic,
  // so the repaired record cannot disagree with its own ended_at (live line
  // 85 — W2/A4 review finding). Else `started_at` verbatim → duration 0,
  // i.e. "unknown", and flagged as such. NEVER the next record's timestamp:
  // the ledger is not chronologically ordered (see the module docblock).
  if (typeof out.completed_at !== 'string' && typeof out.started_at === 'string') {
    const endedMs = typeof out.ended_at === 'string' ? Date.parse(out.ended_at) : NaN;
    const startedMs = Date.parse(out.started_at);
    out.completed_at =
      Number.isFinite(endedMs) && Number.isFinite(startedMs) && endedMs >= startedMs
        ? out.ended_at
        : out.started_at;
    defects.push('completed_at_missing');
    incomplete.add('completed_at');
  }

  if (defects.length === 0) {
    return { record, defects: [], incompleteFields: [], changed: false };
  }

  // -- provenance (additive, already schema-accepted) ------------------------
  const prior = Array.isArray(record._backfill_incomplete_fields)
    ? record._backfill_incomplete_fields.filter((f) => typeof f === 'string')
    : [];
  const merged = orderIncompleteFields(incomplete);
  out._backfill_source = REPAIR_SOURCE;
  out._backfill_incomplete_fields = [...new Set([...prior, ...merged])];

  return { record: out, defects, incompleteFields: merged, changed: true };
}

// ---------------------------------------------------------------------------
// Ledger repair
// ---------------------------------------------------------------------------

/**
 * Repair one ledger line. Pure — decides the OUTPUT line for one INPUT line.
 *
 * Outcomes:
 *  - `blank`        — whitespace-only/empty segment, emitted unchanged.
 *  - `unparseable`  — `JSON.parse` threw; emitted unchanged. File corruption is
 *                     a different problem and the integrity banner skips these
 *                     too; silently "fixing" bytes we cannot read is worse.
 *  - `valid`        — passed `validateSession`; emitted BYTE-FOR-BYTE.
 *  - `repaired`     — defects fixed, gated, re-serialized.
 *  - `error`        — still invalid after repair; ORIGINAL emitted unchanged.
 *
 * @param {string} line
 * @param {{validateSession?: Function, serialize?: Function}} [deps]
 * @returns {{line: string, status: string, sessionId: string|null, defects: string[], incompleteFields: string[], error: string|null, record: object|null}}
 */
export function repairLine(line, deps = {}) {
  const { validateSession = defaultValidateSession, serialize = defaultSerialize } = deps;
  const base = { line, status: 'valid', sessionId: null, defects: [], incompleteFields: [], error: null, record: null };

  if (line.trim().length === 0) return { ...base, status: 'blank' };

  let record;
  try {
    record = JSON.parse(line);
  } catch (err) {
    return { ...base, status: 'unparseable', error: err?.message ?? String(err) };
  }
  if (!isPlainObject(record)) {
    return { ...base, status: 'unparseable', error: 'line is not a JSON object' };
  }

  const sessionId = typeof record.session_id === 'string' ? record.session_id : null;

  try {
    validateSession(record);
    // Already valid — emit the ORIGINAL bytes. Re-serializing a passing record
    // would rewrite key order for no benefit and bury the real repairs in noise.
    return { ...base, status: 'valid', sessionId, record };
  } catch {
    /* fall through to repair */
  }

  const { record: repaired, defects, incompleteFields } = repairRecord(record);
  try {
    // GATE ONLY — the return value is deliberately discarded. `validateSession`
    // stamps `schema_version: 2` on its output, and live line 152 has no
    // `schema_version` key at all; serializing its return would invent a version
    // claim for a record that never made one. Serialize the repaired INPUT.
    validateSession(repaired);
    const serialized = serialize(repaired);
    return {
      line: serialized.endsWith('\n') ? serialized.slice(0, -1) : serialized,
      status: 'repaired',
      sessionId,
      defects,
      incompleteFields,
      error: null,
      record: repaired,
    };
  } catch (err) {
    return {
      ...base,
      status: 'error',
      sessionId,
      defects,
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Compute the repaired ledger text plus a summary, WITHOUT touching disk.
 *
 * Splitting on `\n` and rejoining preserves the trailing-newline shape and any
 * blank segments exactly, so a file with no repairs round-trips byte-identically.
 *
 * @param {string} raw — full ledger contents
 * @param {object} [deps]
 * @returns {{text: string, summary: object, lines: object[]}}
 */
export function repairText(raw, deps = {}) {
  const parts = raw.split('\n');
  const results = parts.map((p) => repairLine(p, deps));
  const text = results.map((r) => r.line).join('\n');

  const defectsByClass = {};
  const errors = [];
  const idCounts = new Map();
  let total = 0;
  let unparseable = 0;
  let invalidBefore = 0;
  let repaired = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'blank') continue;
    total += 1;
    if (r.sessionId) idCounts.set(r.sessionId, (idCounts.get(r.sessionId) ?? 0) + 1);
    if (r.status === 'unparseable') {
      unparseable += 1;
      continue;
    }
    if (r.status === 'valid') continue;
    invalidBefore += 1;
    for (const d of r.defects) defectsByClass[d] = (defectsByClass[d] ?? 0) + 1;
    if (r.status === 'repaired') {
      repaired += 1;
    } else {
      errors.push({ line: i + 1, session_id: r.sessionId, error: r.error });
    }
  }

  const duplicates = [...idCounts.entries()]
    .filter(([, n]) => n > 1)
    .map(([session_id, count]) => ({ session_id, count }))
    .sort((a, b) => (a.session_id < b.session_id ? -1 : 1));

  return {
    text,
    lines: results,
    summary: {
      total,
      unparseable,
      invalid_before: invalidBefore,
      repaired,
      // Projected: every line that was invalid and did NOT get repaired.
      invalid_after: invalidBefore - repaired,
      duplicate_ids_observed: duplicates,
      defects_by_class: defectsByClass,
      errors,
    },
  };
}

/**
 * Re-read a written ledger and prove it is actually clean.
 *
 * Two independent probes, because they measure different populations (see the
 * integrity banner's docblock): `validateSession` is the write-path schema,
 * `checkSessionsIntegrity` additionally exercises the REAL vault-mirror render
 * path — a record can pass the first and still be dropped by the second.
 *
 * The integrity probe reads `<repoRoot>/.orchestrator/metrics/sessions.jsonl`
 * by construction, so it is only meaningful when `file` IS that path; against
 * any other target it is reported as skipped rather than quietly measuring the
 * wrong file.
 *
 * @returns {{ok: boolean, invalid_after: number, invalid_lines: object[], integrity: string|object}}
 */
export function verifyWritten({ file, repoRoot, deps = {} }) {
  const {
    readFileSync = fs.readFileSync,
    validateSession = defaultValidateSession,
    checkIntegrity = defaultCheckIntegrity,
  } = deps;

  const raw = readFileSync(file, 'utf8');
  const invalidLines = [];
  const parts = raw.split('\n');
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].trim().length === 0) continue;
    let record;
    try {
      record = JSON.parse(parts[i]);
    } catch {
      continue; // unparseable lines are passed through by design
    }
    if (!isPlainObject(record)) continue;
    try {
      validateSession(record);
    } catch (err) {
      invalidLines.push({
        line: i + 1,
        session_id: typeof record.session_id === 'string' ? record.session_id : null,
        error: err?.message ?? String(err),
      });
    }
  }

  let integrity = 'skipped-not-canonical-path';
  if (typeof repoRoot === 'string' && repoRoot.length > 0) {
    const canonical = path.join(repoRoot, CANONICAL_LEDGER_REL);
    if (path.resolve(file) === path.resolve(canonical)) {
      const banner = checkIntegrity({ repoRoot });
      integrity = banner === null ? 'clean' : banner;
    }
  }

  const ok = invalidLines.length === 0 && (integrity === 'clean' || integrity === 'skipped-not-canonical-path');
  return { ok, invalid_after: invalidLines.length, invalid_lines: invalidLines, integrity };
}

/**
 * Repair a sessions ledger end-to-end.
 *
 * Dry-run (the default) reads and computes only — no backup, no tmp file, no
 * write. Apply copies the original to `<file>.bak-<stamp>` FIRST, writes
 * `<file>.tmp-<pid>` in the same directory and renames it over the target
 * (atomic within a filesystem), then re-verifies the written file. A failed
 * verification restores the backup byte-identically and reports `ok: false` —
 * the caller maps that to exit 3.
 *
 * Never throws for a defective RECORD (those land in `summary.errors`); a
 * genuine I/O failure DOES throw and is the caller's exit-2 case.
 *
 * @param {object} args
 * @param {string}  args.file                 ledger path
 * @param {string}  [args.repoRoot]           enables the integrity post-probe
 * @param {boolean} [args.apply=false]        write (default: dry-run)
 * @param {boolean} [args.backup=true]        take a `.bak-<stamp>` under --apply
 * @param {Date}    [args.now]                backup-stamp seam
 * @param {object}  [args.deps]               DI: fs fns, validateSession, serialize, checkIntegrity
 * @returns {object} summary
 */
export function repairLedger({ file, repoRoot = null, apply = false, backup = true, now = new Date(), deps = {} }) {
  const {
    readFileSync = fs.readFileSync,
    writeFileSync = fs.writeFileSync,
    renameSync = fs.renameSync,
    copyFileSync = fs.copyFileSync,
    unlinkSync = fs.unlinkSync,
    existsSync = fs.existsSync,
  } = deps;

  const raw = readFileSync(file, 'utf8');
  const { text, summary: base } = repairText(raw, deps);

  const summary = {
    mode: apply ? 'apply' : 'dry-run',
    file,
    ...base,
    backup_path: null,
    post_verify: null,
    ok: true,
  };

  if (!apply) return summary;

  // -- backup FIRST (unconditional unless explicitly opted out) --------------
  let backupPath = null;
  if (backup) {
    backupPath = `${file}.bak-${backupStamp(now)}`;
    copyFileSync(file, backupPath);
    summary.backup_path = backupPath;
  }

  // -- atomic swap ----------------------------------------------------------
  const tmpPath = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, text, 'utf8');
    renameSync(tmpPath, file);
  } catch (err) {
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }

  // -- post-verification ----------------------------------------------------
  const verdict = verifyWritten({ file, repoRoot, deps });
  summary.post_verify = verdict;
  summary.invalid_after = verdict.invalid_after;

  if (!verdict.ok) {
    // Restore byte-identically. The backup is preferred (it is the on-disk
    // artefact an operator can inspect); `raw` is the in-memory fallback for
    // `--no-backup`, and both are the same bytes.
    if (backupPath) {
      copyFileSync(backupPath, file);
    } else {
      writeFileSync(file, raw, 'utf8');
    }
    summary.ok = false;
    summary.restored = true;
  }

  return summary;
}
