/**
 * orphan-reaper/reaper-audit.mjs — the B5 kill audit: its record shape, its
 * writer, its bounded reader and pruner, and the HR-101 false-alarm rate the
 * reader exists for.
 */

import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { readTailWindow } from '../tail-window.mjs';
import { REAPER_DEFAULTS, underRepo } from './defaults.mjs';

/** Relative path of the JSONL kill audit (B5). Gitignored via `.gitignore:55`
 *  (`.orchestrator/metrics/*.jsonl`), verified with `git check-ignore --no-index -v`.
 *  Under the `ledger-delete-protected` policy rule: in-process fs only, never a
 *  shell `rm`/`mv`. */
export const REAPER_AUDIT_RELPATH = '.orchestrator/metrics/reaper-audit.jsonl';

/**
 * HR-101 ceiling: above this false-alarm rate the INSTRUMENT is suspect, and
 * the answer is to re-aim it — never to raise the threshold it fires on. Surfaced
 * as `instrumentSuspect` in the scan result; nothing in the reaper acts on it,
 * because acting on a broken instrument is the failure it names.
 */
export const FALSE_ALARM_SUSPECT_RATE = 0.1;

/** Characters of `args` copied into an audit record — and ONLY for a command
 *  that already matched the read-only allowlist, so a foreign process's command
 *  line (which may carry paths or tokens) never reaches the audit. */
const ARGS_HEAD_CHARS = 80;

/**
 * Size ceiling of the audit file and what a prune keeps. Named ceiling (BV-004):
 * a `kill` record with `args_head` and `result` serialises to 505 bytes, a
 * `report` record to 285 (measured on {@link buildAuditRecord} output 2026-10-01;
 * no real audit file existed on this host), so the kept 512 KiB hold ~1,000-1,800
 * decisions against the 50 the false-alarm window reads. Revisit if
 * `reaper.false-alarm-window` is ever configured above ~1,000.
 */
const REAPER_AUDIT_MAX_BYTES = 1024 * 1024;
const REAPER_AUDIT_KEEP_BYTES = 512 * 1024;

/** First tail window {@link readAuditRecords} tries; it grows ×4 only while the
 *  window holds fewer complete lines than requested. */
const AUDIT_TAIL_START_BYTES = 64 * 1024;

/** Absolute path of the kill audit for a repo. One constant per path.
 *  @param {string} repoRoot @returns {string} */
export function auditPath(repoRoot) {
  return underRepo(repoRoot, REAPER_AUDIT_RELPATH);
}

/**
 * Build one B5 audit record.
 *
 * Exactly ONE `trigger` per record, taken from the single verdict
 * `decideReapCandidates` assigned at its fixed priority — a kill carries
 * `orphan-ppid1`, a report carries the reason it was reported for. That is what
 * makes "why exactly was this killed" answerable afterwards; a record listing
 * two triggers would answer it with a shrug.
 *
 * `reason` is separate from `trigger` and present on every WITHDRAWAL: the
 * trigger says what made this a candidate, the reason says what took it back.
 * `args_head` is present ONLY for a command that cleared the read-only
 * allowlist — see {@link ARGS_HEAD_CHARS}.
 *
 * @param {object} entry     A candidate or a reported/rejected entry.
 * @param {'kill'|'report'|'reject'|'dry-run'} decision
 * @param {object} [extra]
 * @param {string} extra.timestamp
 * @param {string|null} [extra.sessionId]
 * @param {object} [extra.result]
 * @param {string} [extra.reason]
 * @returns {object}
 */
export function buildAuditRecord(entry, decision, {
  timestamp, sessionId = null, result, reason,
} = {}) {
  /** @type {Record<string, unknown>} */
  const record = {
    timestamp,
    session_id: sessionId,
    pid: entry.pid,
    pgid: entry.pgid ?? null,
    trigger: entry.trigger ?? entry.reason ?? null,
    threshold: entry.threshold ?? null,
    actual: entry.actual ?? (typeof entry.ageSeconds === 'number' ? { ageSeconds: entry.ageSeconds } : null),
    unit: 'seconds',
    command_signature: entry.commandSignature ?? null,
    decision,
  };
  if (typeof entry.args === 'string' && entry.args.length > 0) {
    record.args_head = entry.args.slice(0, ARGS_HEAD_CHARS);
  }
  if (result !== undefined) record.result = result;
  const effectiveReason = reason ?? (decision === 'report' ? entry.reason : undefined);
  if (effectiveReason !== undefined && effectiveReason !== null) record.reason = effectiveReason;
  return record;
}

/**
 * Default audit sink: append one JSONL line to {@link REAPER_AUDIT_RELPATH}.
 * In-process fs only (the path sits under the `ledger-delete-protected` policy
 * rule). Best-effort — an audit write must never fail a scan — but a failure
 * prints one WARN line rather than vanishing.
 *
 * @param {string} repoRoot
 * @param {object} record
 * @returns {void}
 */
export function appendAuditRecord(repoRoot, record) {
  const target = auditPath(repoRoot);
  try {
    mkdirSync(path.dirname(target), { recursive: true });
    appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
  } catch (err) {
    process.stderr.write(
      `orphan-reaper: could not append to ${REAPER_AUDIT_RELPATH}: ${err?.message ?? String(err)}\n`,
    );
  }
}

/**
 * Default audit READER — the other half of {@link appendAuditRecord}, and the
 * data source {@link falseAlarmRate} needs (B5: "Dieselbe Datei ist die
 * Datenquelle für `reaper.false-alarm-window`").
 *
 * Returns the parsed records among the LAST `limit` non-empty lines, oldest
 * first — the same population a whole-file read sliced to `limit` lines yields,
 * read from a tail window instead. The window grows only while it holds fewer
 * complete lines than `limit`, so records larger than expected cannot shrink the
 * population; {@link pruneReaperAudit} bounds the worst case at the whole file.
 * The first line of a window that does not start at byte 0 is a fragment and is
 * dropped before anything is parsed.
 *
 * A malformed line is dropped from the rate's population rather than counted,
 * because an unreadable record carries no decision to classify — and the rate
 * reports its own `n`, so a shrinking population is visible in the number's
 * denominator.
 *
 * @param {string} repoRoot
 * @param {number} [limit]
 * @returns {object[]} parsed records in chronological order; `[]` on any failure
 */
export function readAuditRecords(repoRoot, limit = REAPER_DEFAULTS.falseAlarmWindow) {
  const target = auditPath(repoRoot);
  const want = Math.max(1, limit);
  let lines;
  try {
    let windowBytes = AUDIT_TAIL_START_BYTES;
    for (;;) {
      const { text, cut } = readTailWindow(target, windowBytes);
      const all = text.split('\n');
      if (cut) all.shift();
      lines = all.filter((l) => l.trim().length > 0);
      if (!cut || lines.length >= want) break;
      windowBytes *= 4;
    }
  } catch {
    return [];
  }
  const records = [];
  for (const line of lines.slice(-want)) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') records.push(parsed);
    } catch {
      /* an unreadable line carries no decision to classify */
    }
  }
  return records;
}

/**
 * Replace the audit atomically: write `<target>.tmp-<pid>` beside it, then
 * rename over it. Throws instead of writing when the target is a symlink or not
 * a regular file. `writeFileSync(target)` would truncate first — a scan child
 * killed between truncate and write left the "why was this killed" record empty
 * — and would write THROUGH a symlink, cutting e.g. a linked `events.jsonl` to
 * 512 KiB (CWE-59, reproduced 2026-10-01). `rename` replaces the link itself,
 * and `wx` refuses a pre-planted file or link at the tmp name. The same few
 * lines as `process-group.mjs`'s `replaceRegularFile`, kept local because that
 * module is not this one's to depend on for a file write.
 *
 * @param {string} target
 * @param {string} body
 */
function replaceRegularFile(target, body) {
  if (!lstatSync(target).isFile()) {
    throw new Error('not a regular file (a symlink is never written through) — left untouched');
  }
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, body, { encoding: 'utf8', flag: 'wx' });
    renameSync(tmp, target);
  } catch (err) {
    // EEXIST: the tmp name belongs to someone else — never remove it.
    if (err?.code !== 'EEXIST') {
      try { unlinkSync(tmp); } catch { /* nothing was created */ }
    }
    throw err;
  }
}

/**
 * Size-bounded prune of the audit: once the file passes `maxBytes`, rewrite it
 * atomically with its newest `keepBytes`, cut at a line boundary. The same
 * rewrite shape as `pruneGateProcessLedger` (`process-group.mjs`), the other
 * ledger the scan's housekeeping prunes; the audit is pruned by SIZE rather than
 * age because its population is a rolling window of decisions, not of days.
 *
 * Never throws; a failure — including a symlinked or non-regular audit, which
 * is refused rather than written through — prints one WARN line and leaves the
 * file as it was.
 * Named ceiling (BV-004): an append that lands between the read and the write
 * is lost — a window of one read + one write, once per ~0.5 MB of audit.
 *
 * @param {string} repoRoot
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.keepBytes]
 * @returns {number} bytes removed; 0 when nothing was pruned
 */
export function pruneReaperAudit(repoRoot, {
  maxBytes = REAPER_AUDIT_MAX_BYTES,
  keepBytes = REAPER_AUDIT_KEEP_BYTES,
} = {}) {
  const target = auditPath(repoRoot);
  let size;
  try {
    size = statSync(target).size;
  } catch {
    return 0;
  }
  if (size <= maxBytes) return 0;
  try {
    const { text, cut } = readTailWindow(target, Math.min(keepBytes, maxBytes));
    // A cut window starts mid-record; with no newline at all it is ONE record
    // larger than the window, and keeping any part of it would keep a fragment.
    const newline = text.indexOf('\n');
    const kept = !cut ? text : (newline === -1 ? '' : text.slice(newline + 1));
    replaceRegularFile(target, kept);
    return size - Buffer.byteLength(kept, 'utf8');
  } catch (err) {
    process.stderr.write(
      `orphan-reaper: could not prune ${REAPER_AUDIT_RELPATH}: ${err?.message ?? String(err)}\n`,
    );
    return 0;
  }
}

/**
 * False-alarm rate over the last `windowSize` audit decisions — the HR-101
 * instrument-health check ("a signal may only warn if it is rare"; above ~10%
 * the instrument is broken and gets re-aimed, never re-thresholded).
 *
 * POPULATION (the number's denominator, stated because a rate without one is a
 * claim): audit records where the reaper judged a process a reapable orphan —
 * `decision` in `kill` | `dry-run` | `reject`. `report` records are excluded:
 * reporting a foreign or non-read-only process is the correct outcome, not a
 * firing of the kill signal.
 *
 * FALSE ALARM: a record where that judgement was refuted afterwards —
 * `decision: 'reject'` (the identity re-check withdrew the candidate) or a kill
 * whose `result.ok` is false (the signal did not take effect).
 *
 * Returns `{rate: null}` below 10 records: a rate over a handful of decisions
 * says nothing, and `null` is distinguishable from a measured 0 (a missing
 * measurement must never look like a zero).
 *
 * @param {object[]} auditRecords  In chronological order; the LAST `windowSize` are used.
 * @param {number} [windowSize]
 * @returns {{rate: number|null, n: number}}
 */
export function falseAlarmRate(auditRecords, windowSize = REAPER_DEFAULTS.falseAlarmWindow) {
  const all = Array.isArray(auditRecords) ? auditRecords : [];
  const firings = all.filter((r) => r && (r.decision === 'kill' || r.decision === 'dry-run' || r.decision === 'reject'));
  const window = windowSize > 0 ? firings.slice(-windowSize) : firings;
  const n = window.length;
  if (n < 10) return { rate: null, n };
  const falseAlarms = window.filter((r) => r.decision === 'reject' || r?.result?.ok === false).length;
  return { rate: falseAlarms / n, n };
}
