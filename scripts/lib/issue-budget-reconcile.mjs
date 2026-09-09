/**
 * issue-budget-reconcile.mjs — close-time cross-check between what a session
 * RECORDED as created and what the issue-budget ledger CHARGED (#1163).
 *
 * ## Why a cross-check exists at all
 *
 * The cap is enforced by a PreToolUse hook, and a hook only sees the routes it
 * matches. Every unmatched route is a silent zero: nothing errors, no ledger
 * line is written, and the absence is indistinguishable from a session that
 * created nothing. Measured 2026-09-09 on a session record with **26** issues
 * in `issues_created` and NO counter file under either candidate key — the
 * hook had not run for a single one of those creations, and nothing said so.
 *
 * So this module compares two independently-produced numbers and names the
 * disagreement:
 *
 *   recorded  — `record.issues_created.length` from the session record
 *   charged   — `count` summed over the ledgers
 *   exempt    — `exempt` summed over the ledgers
 *   escaped   — `max(0, recorded - charged - exempt)`
 *
 * ## Why BOTH ledger keys are read
 *
 * The accounting key is SEMANTIC when `current-session.json` verified the raw
 * id, and RAW otherwise (`resolveIssueBudgetSessionId`). Which of the two a
 * given session's file is named after therefore depends on a condition that can
 * change mid-session — measured in one consumer repo: 25 of 36 counter files
 * keyed semantic, 11 keyed raw. Reading only one key reports a phantom
 * "escaped" for every session that used the other.
 *
 * ## Why `found` is tracked explicitly
 *
 * `readBudgetState` returns a ZEROED state for a missing file — by design, so
 * the cap never inherits a foreign session's spend. That makes "no ledger" and
 * "a real zero" byte-identical in the return value, and reading the zero as
 * "all good" is exactly the #1163 failure this module exists to surface. So the
 * file's existence is measured separately, per key, before the read.
 *
 * FAIL-OPEN BY CONTRACT: nothing here throws. A close-time cross-check that
 * aborts the close is strictly worse than one that reports `no-ledger`.
 */

import { existsSync, readFileSync } from 'node:fs';

import {
  readBudgetState,
  budgetStatePath,
  budgetStateRel,
  loadIssueBudgetConfig,
} from './issue-budget.mjs';

/** Event name for the reconciliation record. Plain literal, greppable. */
export const ISSUE_BUDGET_RECONCILED_EVENT = 'orchestrator.issue_budget.reconciled';

/**
 * Read one candidate ledger, recording whether its file was actually there.
 *
 * ## Why the path is carried TWICE
 *
 * `abs_path` is the operator-facing answer to "which file did you look at?" and
 * belongs in the local WARN text. `path` is repo-RELATIVE and is the only half
 * that may travel: this record is copied verbatim into the
 * `orchestrator.issue_budget.reconciled` event, which the optional Clank webhook
 * ships off-host. An absolute ledger path names the operator's home directory
 * and the repo's private slug, neither of which the receiving side needs to
 * interpret the verdict. The split is in the FIELD NAMES so a future consumer
 * cannot pick the leaking one by accident.
 *
 * ## Why `corrupt` is separate from `found`
 *
 * `readBudgetState` normalises a present-but-unreadable file to a ZEROED state
 * (fail-open by contract). So `{"count":"3"}` — an existing ledger whose shape
 * is wrong — reads as `found: true, charged: 0`, which the verdict logic would
 * otherwise call `escaped` and answer with the escape-route list. That is the
 * wrong diagnosis for a merely corrupt file, so the raw shape is inspected here
 * and reported on its own flag.
 *
 * @param {string} repoRoot
 * @param {string|null|undefined} sessionId
 * @param {'semantic'|'raw'} key
 * @returns {{ key: string, sessionId: string|null, path: string|null, abs_path: string|null,
 *             found: boolean, corrupt: boolean, charged: number, exempt: number,
 *             overflow: number }}
 */
function _readLedger(repoRoot, sessionId, key) {
  const id = typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null;
  if (id === null) {
    return {
      key,
      sessionId: null,
      path: null,
      abs_path: null,
      found: false,
      corrupt: false,
      charged: 0,
      exempt: 0,
      overflow: 0,
    };
  }
  let file = null;
  let rel = null;
  let found;
  let corrupt = false;
  let state = { count: 0, exempt: 0, overflow: [] };
  try {
    file = budgetStatePath(repoRoot, id);
    rel = budgetStateRel(id);
    found = existsSync(file);
    state = readBudgetState(repoRoot, id);
    if (found) corrupt = !_ledgerShapeIsReadable(file);
  } catch {
    // Unreadable ledger — reported as not found rather than thrown (fail-open).
    found = false;
  }
  return {
    key,
    sessionId: id,
    path: rel,
    abs_path: file,
    found,
    corrupt,
    charged: Number.isInteger(state?.count) ? state.count : 0,
    exempt: Number.isInteger(state?.exempt) ? state.exempt : 0,
    overflow: Array.isArray(state?.overflow) ? state.overflow.length : 0,
  };
}

/**
 * Is the ledger file on disk a readable counter shape?
 *
 * Read directly rather than through `readBudgetState`, whose normalisation is
 * exactly what hides this. Fail-open: an unreadable file is reported as corrupt,
 * never thrown.
 *
 * @param {string} file
 * @returns {boolean}
 */
function _ledgerShapeIsReadable(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    return Number.isInteger(raw?.count);
  } catch {
    return false;
  }
}

/**
 * Cross-check a closing session's recorded issue creations against the
 * issue-budget ledger(s).
 *
 * The two ledgers are SUMMED rather than preferred one over the other: a
 * session whose key flipped mid-session legitimately has spend under both, and
 * preferring one would under-report exactly that case. When both keys resolve
 * to the same string, only one is read (no double count).
 *
 * Verdicts:
 *   `no-ledger`    — `recorded > 0` and NO file existed under either key. The
 *                    hook never ran for a single create; the count is not
 *                    merely low, it is absent.
 *   `corrupt-ledger` — a ledger file EXISTS but its shape is unreadable (bad
 *                    JSON, or a `count` that is not an integer). Its `charged`
 *                    is therefore unknown, not zero — so no escape claim may be
 *                    made from it, and the fix is the file, not the matcher.
 *   `escaped`      — a ledger exists but `recorded > charged + exempt`. Some
 *                    creations took a route the matcher does not see.
 *   `stale-record` — a ledger exists with spend, and the record claims none.
 *                    The record, not the ledger, is the suspect half.
 *   `match`        — everything the record claims is accounted for.
 *
 * @param {{ repoRoot: string,
 *           record?: { issues_created?: unknown } | null,
 *           sessionId?: string|null,
 *           rawSessionId?: string|null,
 *           config?: { "max-per-session": number, mode: string, overflow: string },
 *           now?: string }} opts
 * @returns {{ recorded: number, charged: number, exempt: number, overflow: number,
 *             escaped: number, sources: object[], verdict: string,
 *             max: number|null, mode: string|null }}
 */
export function reconcileIssueBudget({
  repoRoot,
  record = null,
  sessionId = null,
  rawSessionId = null,
  config = null,
  now = new Date().toISOString(),
} = {}) {
  const empty = {
    recorded: 0,
    charged: 0,
    exempt: 0,
    overflow: 0,
    escaped: 0,
    sources: [],
    verdict: 'match',
    max: null,
    mode: null,
    at: now,
  };
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') return empty;

  try {
    const created = record?.issues_created;
    const recorded = Array.isArray(created) ? created.length : 0;

    const sources = [_readLedger(repoRoot, sessionId, 'semantic')];
    if (
      typeof rawSessionId === 'string' &&
      rawSessionId.length > 0 &&
      rawSessionId !== sessionId
    ) {
      sources.push(_readLedger(repoRoot, rawSessionId, 'raw'));
    }

    const charged = sources.reduce((n, s) => n + s.charged, 0);
    const exempt = sources.reduce((n, s) => n + s.exempt, 0);
    const overflow = sources.reduce((n, s) => n + s.overflow, 0);
    const anyFound = sources.some((s) => s.found);
    const escaped = Math.max(0, recorded - charged - exempt);

    const anyCorrupt = sources.some((s) => s.corrupt);

    let verdict = 'match';
    if (recorded > 0 && !anyFound) verdict = 'no-ledger';
    // Precedence over `escaped`: a corrupt ledger's `charged` is UNKNOWN, so the
    // escape arithmetic that would otherwise fire is built on a zero nobody
    // measured. Naming the corruption first sends the operator at the file.
    else if (anyCorrupt) verdict = 'corrupt-ledger';
    else if (escaped > 0) verdict = 'escaped';
    else if (anyFound && recorded === 0 && charged > 0) verdict = 'stale-record';

    let cfg = config;
    if (!cfg) {
      try {
        cfg = loadIssueBudgetConfig(repoRoot);
      } catch {
        cfg = null;
      }
    }

    return {
      recorded,
      charged,
      exempt,
      overflow,
      escaped,
      sources,
      verdict,
      max: typeof cfg?.['max-per-session'] === 'number' ? cfg['max-per-session'] : null,
      mode: typeof cfg?.mode === 'string' ? cfg.mode : null,
      at: now,
    };
  } catch {
    // Never throws — a close-time cross-check that aborts the close is worse
    // than one that reports nothing.
    return empty;
  }
}

/**
 * Emit the reconciliation record to the repo's event ledger.
 *
 * Follows `_emitEvaluated` in `scripts/lib/express-path.mjs`: `events.mjs` is
 * imported LAZILY (a static import would pull `platform.mjs`, which walks the
 * filesystem at module load, into every consumer of this module), `repoRoot` is
 * passed EXPLICITLY and a missing one SKIPS the emit rather than falling
 * through to the ambient `SO_PROJECT_DIR` — writing a synthetic record into the
 * operator's real fleet ledger is unrecoverable, a skipped record is not — and
 * the whole thing is best-effort: the verdict above is authoritative whether or
 * not the ledger accepted the line.
 *
 * @param {string} repoRoot
 * @param {ReturnType<typeof reconcileIssueBudget>} result
 * @returns {Promise<void>}
 */
export async function emitIssueBudgetReconciled(repoRoot, result) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    process.stderr.write(
      `issue-budget-reconcile: skipped ${ISSUE_BUDGET_RECONCILED_EVENT} — no repoRoot given; ` +
        'refusing the ambient SO_PROJECT_DIR destination (#941).\n',
    );
    return;
  }
  try {
    const { emitEvent, sessionAttribution } = await import('./events.mjs');
    await emitEvent(
      ISSUE_BUDGET_RECONCILED_EVENT,
      {
        verdict: result.verdict,
        recorded: result.recorded,
        charged: result.charged,
        exempt: result.exempt,
        overflow: result.overflow,
        escaped: result.escaped,
        // REPO-RELATIVE `path` only (`s.path`, from `budgetStateRel`). The
        // absolute path stays in `result.sources[].abs_path` for the local WARN
        // text: this payload travels verbatim over the optional Clank webhook,
        // where `/Users/<operator>/Projects/<private-slug>/…` is owner data the
        // receiver has no use for.
        ledgers: (result.sources ?? []).map((s) => ({
          key: s.key,
          path: s.path,
          found: s.found,
          corrupt: s.corrupt === true,
          charged: s.charged,
          exempt: s.exempt,
        })),
        ...sessionAttribution(repoRoot),
      },
      { repoRoot },
    );
  } catch {
    // Best-effort telemetry.
  }
}

/**
 * Human-readable line(s) for session-end's Final Report.
 *
 * `match` gets ONE info line — a cross-check that prints a paragraph when it
 * found nothing trains the operator to skip it. Every other verdict has to say
 * what is missing AND where it looked, because the first question on reading
 * "no ledger" is always "which path did you check?".
 *
 * @param {ReturnType<typeof reconcileIssueBudget>} result
 * @returns {string}
 */
export function formatIssueBudgetReconcileWarn(result) {
  const r = result ?? {};
  // ABSOLUTE paths here on purpose: this text is local (session-end's Final
  // Report), and the first question on reading it is always "which file?" —
  // which a repo-relative path answers only after the reader guesses the root.
  // The travelling copy (the event payload) carries the relative form instead.
  const paths = (r.sources ?? [])
    .map(
      (s) =>
        `  ${s.key}: ${s.abs_path ?? '(no session key resolved)'}` +
        `${s.found ? '' : ' — MISSING'}${s.corrupt ? ' — CORRUPT' : ''}`,
    )
    .join('\n');

  if (r.verdict === 'match') {
    return (
      `ℹ issue-budget: ${r.recorded} recorded / ${r.charged} charged / ${r.exempt} exempt — reconciled.`
    );
  }

  if (r.verdict === 'no-ledger') {
    return [
      `⚠ issue-budget: ${r.recorded} issue(s) recorded for this session and NO counter file exists.`,
      'A missing ledger does not mean the cap was under-used — it means the hook never ran for a',
      'single one of those creations, so the cap was silently OFF for this session.',
      'Looked up (both accounting keys — semantic and raw):',
      paths,
      'Known routes that reach issue creation WITHOUT the hook charging it:',
      '  - `glab api` / `gh api` POST to an `/issues` path — MATCHED since #1163, so a fresh',
      '    no-ledger verdict is no longer explained by this one.',
      '  - `bash -c "…"` and other interpreter payloads (the matcher does not recurse into them).',
      '  - a create inside a command substitution `$( … )` (never becomes its own statement).',
      '  - `xargs`-driven creation (the operand list is expanded after the hook runs).',
      '  - foreign-channel agents (a `cursor:`/remote-dispatch role spawns a binary no hook sees).',
      'Verify with: ls -l the paths above, and re-check `issue-budget.mode` in the Session Config.',
    ].join('\n');
  }

  if (r.verdict === 'corrupt-ledger') {
    // ONE line by design: a corrupt file is a file problem, and printing the
    // escape-route list here would send the operator hunting a matcher gap that
    // this verdict has no evidence for.
    return (
      `⚠ issue-budget: a counter file exists but its shape is unreadable — the charged count is ` +
      `UNKNOWN, not 0 (${r.recorded} recorded):\n${paths}`
    );
  }

  if (r.verdict === 'escaped') {
    return [
      `⚠ issue-budget: ${r.escaped} issue(s) escaped the cap — ${r.recorded} recorded but only`,
      `${r.charged} charged + ${r.exempt} exempt across the ledgers:`,
      paths,
      'The counter is therefore an UNDERCOUNT for this session; the cap allowed more creations',
      'than it believes it did. Same escape routes as above (`bash -c`, `$( )`, `xargs`,',
      'foreign-channel agents).',
    ].join('\n');
  }

  return [
    `⚠ issue-budget: the ledger charged ${r.charged} (+${r.exempt} exempt) but the session record`,
    'lists no created issues — the RECORD is the suspect half here, not the counter:',
    paths,
  ].join('\n');
}
