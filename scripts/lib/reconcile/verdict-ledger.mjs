/**
 * verdict-ledger.mjs — append-only record of reconcile verdicts and runs (#1710).
 *
 * The idempotency sidecar (`.orchestrator/runtime/reconcile-candidates.jsonl`,
 * `./idempotency.mjs`) is gitignored and resolved per checkout, so a fresh git
 * worktree or another host starts without it: an operator's explicit
 * `rejected` verdict was lost there and `/reconcile` re-proposed the declined
 * rule, while the session-start nudge reported "no reconcile run on record".
 *
 * This ledger lives at `.orchestrator/metrics/reconcile-verdicts.jsonl` under
 * `resolveEventsLedgerRoot(repoRoot)` — a linked worktree maps to its MAIN
 * checkout — beside `learnings.jsonl`, so it shares learnings' tracking status
 * in every repo (tracked + `merge=union` in the vault, host-local here). It is
 * NEVER rewritten, only appended. Two record shapes, one JSON object per line:
 *   { kind: 'verdict', learning_key, outcome, processed_at, recorded_at }
 *   { kind: 'run', at, learnings }   (`learnings`: count the run loaded; optional on older lines)
 *
 * Verdict lines carry DECISIONS only (see {@link BRANCH_SCOPED_OUTCOMES}): an
 * outcome that describes one branch's tree (`written`, `already-on-disk`, or no
 * outcome at all) already has a cross-tree witness in the tracked rule file's
 * provenance marker, and mirroring it from a worktree whose branch is later
 * abandoned would make the learning permanently non-re-proposable in main.
 * Run recency (`lastRunAt`) comes from `run` lines only — a verdict is not a run.
 *
 * Writes happen ONLY for an explicit non-empty `repoRoot` — never a
 * `process.cwd()` fallback, so a test without a root can never append to this
 * repo's real ledger. Readers without a root return the empty result.
 *
 * Ceiling (BV-004): no lock. Concurrent worktree sessions append through
 * O_APPEND with small lines (one `appendFileSync` per call), which keeps lines
 * whole in practice; the sidecar stays the checkout-local work queue and this
 * file only carries terminality and run recency. Revisit trigger: an
 * interleaved or garbled ledger line observed (`skipped > 0` on a ledger no
 * human edited).
 */

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveEventsLedgerRoot } from '../platform.mjs';

/** Repo-relative location of the verdict ledger (resolved against the MAIN checkout). */
export const VERDICT_LEDGER_PATH = '.orchestrator/metrics/reconcile-verdicts.jsonl';

/**
 * Terminal outcomes that describe ONE branch's tree, not a decision, and are
 * therefore never mirrored into the ledger: `written` (writer.mjs persisted the
 * rule file), `already-on-disk` (engine.mjs found its provenance marker) and the
 * empty string (a record without `outcome` — pre-#1042, read as `written`). Every
 * other outcome is a decision (today `rejected`, `expired-swept`).
 */
export const BRANCH_SCOPED_OUTCOMES = Object.freeze(new Set(['', 'written', 'already-on-disk']));

/**
 * @param {unknown} outcome - a sidecar record's `outcome` (absent/null ⇒ branch-scoped).
 * @returns {boolean} true iff the outcome is a decision the ledger carries.
 */
export function isDecisionOutcome(outcome) {
  return typeof outcome === 'string' && !BRANCH_SCOPED_OUTCOMES.has(outcome);
}

/**
 * @param {unknown} repoRoot
 * @returns {string|null} absolute ledger path, or null without an explicit root
 */
function ledgerPathFor(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
  return join(resolveEventsLedgerRoot(repoRoot), VERDICT_LEDGER_PATH);
}

/**
 * @typedef {Object} VerdictLedger
 * @property {Map<string, string>} terminalKeys - learning_key → outcome of its first recorded verdict.
 * @property {string|null} lastRunAt - max over run records' `at`, ISO (a verdict is not a run).
 * @property {number|null} lastRunLearnings - `learnings` of the run record with the latest `at`;
 *   null when that record (or every run record) predates the field or carries no valid integer.
 * @property {number} skipped - lines that were not a valid verdict/run record (counted, never silent).
 * @property {boolean} present - the file was read.
 * @property {boolean} readError - the file exists (or may) but could not be read (non-ENOENT).
 */

/** @returns {VerdictLedger} */
function emptyLedger() {
  return {
    terminalKeys: new Map(),
    lastRunAt: null,
    lastRunLearnings: null,
    skipped: 0,
    present: false,
    readError: false,
  };
}

/** `<path>\0<skipped>` pairs already warned about in this process. */
const warnedSkipped = new Set();

/**
 * Load the verdict ledger for `repoRoot`. A missing file (ENOENT) is the empty
 * result, silently; any other read failure is the empty result plus ONE stderr
 * WARN with `readError: true` (same split as `defaultLoadLearnings`). Blank lines
 * are ignored; every other line that is not a valid verdict/run record is
 * counted in `skipped`, and a non-zero count emits ONE stderr WARN naming the
 * path and the count — once per path and count per process (no production
 * caller reads `skipped`). Never throws.
 *
 * @param {string|undefined} repoRoot - explicit root; absent → empty result.
 * @returns {VerdictLedger}
 */
export function loadVerdictLedger(repoRoot) {
  const result = emptyLedger();
  const absPath = ledgerPathFor(repoRoot);
  if (absPath === null) return result;

  let raw;
  try {
    raw = readFileSync(absPath, 'utf8');
  } catch (err) {
    if (!err || err.code !== 'ENOENT') {
      result.readError = true;
      process.stderr.write(
        `⚠ loadVerdictLedger: cannot read ${absPath} ` +
          `(${err?.code ?? '?'}: ${err?.message ?? String(err)}) — treating as EMPTY\n`,
      );
    }
    return result;
  }
  result.present = true;

  let maxMs = -Infinity;
  let latestRunMs = -Infinity;
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let rec;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      result.skipped += 1;
      continue;
    }
    if (rec && rec.kind === 'verdict' && typeof rec.learning_key === 'string' && rec.learning_key.length > 0) {
      if (!result.terminalKeys.has(rec.learning_key)) {
        result.terminalKeys.set(rec.learning_key, typeof rec.outcome === 'string' ? rec.outcome : '');
      }
    } else if (rec && rec.kind === 'run' && typeof rec.at === 'string' && Number.isFinite(Date.parse(rec.at))) {
      const t = Date.parse(rec.at);
      if (t > maxMs) maxMs = t;
      if (t >= latestRunMs) {
        latestRunMs = t;
        result.lastRunLearnings =
          Number.isSafeInteger(rec.learnings) && rec.learnings >= 0 ? rec.learnings : null;
      }
    } else {
      result.skipped += 1;
    }
  }
  if (maxMs > -Infinity) result.lastRunAt = new Date(maxMs).toISOString();
  // Once per path and count per process: one /reconcile reads the ledger once per
  // stamp, and the same bad line must not print N+2 identical warnings.
  const warnKey = `${absPath}\0${result.skipped}`;
  if (result.skipped > 0 && !warnedSkipped.has(warnKey)) {
    warnedSkipped.add(warnKey);
    process.stderr.write(
      `⚠ loadVerdictLedger: ${result.skipped} line(s) in ${absPath} are not a valid verdict/run record — ignored\n`,
    );
  }
  return result;
}

/**
 * Append all `records` as JSONL in ONE write (mkdir -p first). Never throws.
 * @param {string|undefined} repoRoot
 * @param {Array<Record<string, unknown>>} records
 * @returns {{ ok: boolean, appended: number, error?: string }}
 */
function appendRecords(repoRoot, records) {
  const absPath = ledgerPathFor(repoRoot);
  if (absPath === null) return { ok: false, appended: 0, error: 'no repoRoot' };
  if (records.length === 0) return { ok: true, appended: 0 };
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    appendFileSync(absPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return { ok: true, appended: records.length };
  } catch (err) {
    return { ok: false, appended: 0, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Append one verdict line per terminal candidate (`processed_at` set). The
 * caller decides which records are new; this function does not dedupe.
 *
 * @param {string|undefined} repoRoot - explicit root; absent → nothing written.
 * @param {Array<{ learning_key?: unknown, outcome?: unknown, processed_at?: unknown }>} candidates
 * @param {string} [recordedAt] - ISO; defaults to now.
 * @returns {{ ok: boolean, appended: number, error?: string }}
 */
export function appendVerdicts(repoRoot, candidates, recordedAt) {
  const at = typeof recordedAt === 'string' && recordedAt.length > 0 ? recordedAt : new Date().toISOString();
  const records = (Array.isArray(candidates) ? candidates : [])
    .filter((c) => c && typeof c.learning_key === 'string' && c.learning_key.length > 0 && typeof c.processed_at === 'string')
    .map((c) => ({
      kind: 'verdict',
      learning_key: c.learning_key,
      outcome: typeof c.outcome === 'string' ? c.outcome : '',
      processed_at: c.processed_at,
      recorded_at: at,
    }));
  return appendRecords(repoRoot, records);
}

/**
 * Append one run record.
 * @param {string|undefined} repoRoot - explicit root; absent → nothing written.
 * @param {string} at - ISO timestamp of the run.
 * @param {number} [learnings] - how many learnings the run loaded; omitted from the
 *   record unless a non-negative integer (the nudge's "new since last run" baseline).
 * @returns {{ ok: boolean, appended: number, error?: string }}
 */
export function appendRun(repoRoot, at, learnings) {
  const rec = { kind: 'run', at };
  if (Number.isSafeInteger(learnings) && learnings >= 0) rec.learnings = learnings;
  return appendRecords(repoRoot, [rec]);
}
