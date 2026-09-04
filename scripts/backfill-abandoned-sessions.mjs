#!/usr/bin/env node
/**
 * backfill-abandoned-sessions.mjs — one-time historical migration CLI (#724 C1).
 *
 * Scans `.orchestrator/metrics/events.jsonl` for every distinct
 * `orchestrator.session.started` UUID that has no counterpart in
 * `.orchestrator/metrics/sessions.jsonl`, bridges each to its semantic id via
 * `orchestrator.session.lock.acquired` where available, and synthesizes a
 * `status: 'abandoned'` stub through the shared backfill core
 * (`scripts/lib/session-close-backfill.mjs`).
 *
 * SAFETY: `--dry-run` is the DEFAULT — nothing is written unless `--apply` is
 * passed. Dry-run is idempotent (creates no marker files, appends nothing) so
 * you can safely preview counts, then apply once against a copy or the live
 * store at the operator's discretion.
 *
 *   node scripts/backfill-abandoned-sessions.mjs [--dry-run|--apply] [--json]
 *                                                [--repo-root PATH]
 *                                                [--assume-dead-before ISO]
 *
 * DEAD-BY-AGE RELAXATION (#731): every CLI run happens FROM an active
 * session, so `.orchestrator/session.lock` is ALWAYS live at run-time — the
 * foreign-live-lock guard in the shared core (session-close-backfill.mjs)
 * would otherwise block every historical candidate unconditionally. This CLI
 * therefore ALWAYS passes `relaxDeadByAge: true`, so a candidate whose last
 * known event is older than the lock's own default TTL
 * (`session-lock.mjs` `DEFAULT_TTL_HOURS`) bypasses the current lock. The
 * optional `--assume-dead-before <ISO>` flag additionally bypasses the guard
 * for any candidate whose last known event predates the given cutoff,
 * regardless of the TTL window. This relaxation is scoped to THIS CLI only —
 * `hooks/on-session-end.mjs` never passes it (see the comment there).
 *
 * Exit codes (cli-design.md):
 *   0 — completed (dry-run or apply)
 *   1 — user/input error (bad args, invalid --assume-dead-before)
 *   2 — system error (unreadable events file, etc.)
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { backfillAbandonedSession, isUuid } from './lib/session-close-backfill.mjs';
import { emitEvent } from './lib/events.mjs';
import { getProjectDir } from './lib/platform.mjs';

const LOCK_ACQUIRED = 'orchestrator.session.lock.acquired';
const SESSION_STARTED = 'orchestrator.session.started';
const SESSION_ENDED = 'orchestrator.session.ended';

/**
 * Default cap on how many candidates may reach the (expensive) shared core in a
 * single run. Only the SessionStart path passes a limit; the CLI stays uncapped.
 * See `backfillOnSessionStart` for the latency rationale.
 */
export const SESSION_START_LIMIT = 25;

/**
 * Read a JSONL file into parsed objects; MISSING (ENOENT) → `[]` silently,
 * UNREADABLE (EACCES/EISDIR/…) → `[]` with a stderr WARN (#1188); malformed
 * lines skipped.
 */
function readJsonl(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    // #1188 — ENOENT and EACCES/EISDIR are different facts: a missing ledger is
    // the ordinary fresh-repo case; an UNREADABLE one previously read as "no
    // records" and made every downstream count silently wrong. Same split as
    // readLockDetailed (session-lock.mjs § absent vs unreadable).
    if (!err || err.code !== 'ENOENT') {
      process.stderr.write(
        `⚠ backfill-abandoned-sessions: cannot read ${filePath} ` +
          `(${err?.code ?? '?'}: ${err?.message ?? String(err)}) — ` +
          'treating as EMPTY, counts below are floors\n',
      );
    }
    // CEILING (BV-004): still [] rather than throw — this runs on the
    // SessionStart path (SESSION_START_LIMIT), where a permissions fault must
    // not crash the session start. REVISIT if the warn rate in events.jsonl
    // shows masked corruption.
    return [];
  }
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}

/**
 * Enumerate distinct sessions worth evaluating: every unique
 * session.started UUID, each bridged to its semantic id via lock.acquired
 * where one exists. Preserves first-seen order.
 *
 * @param {{ repoRoot: string }} args
 * @returns {Array<{ sessionId: string, semanticSessionId: string|null }>}
 */
export function planSessions({ repoRoot }) {
  const events = readJsonl(path.join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl'));

  // Two independent UUID -> semantic bridges (#1167). `lock.acquired` is the
  // original one, but a session that LOST the lock-acquire race never emits it;
  // its `session.ended` event carries `semantic_session_id` all the same (since
  // #1068 AC1) and was never read here. Without that second bridge the
  // candidate resolved semantic=null and the shared core minted a SYNTHETIC id,
  // writing a duplicate stub beside the record the SessionEnd hook had already
  // written under the real semantic id (measured 2026-09-02 @ c3ab480: 8 pairs).
  // lock.acquired keeps precedence — it is the older, mode-carrying attestation.
  const semanticFromLock = new Map();
  const semanticFromEnded = new Map();
  for (const ev of events) {
    if (typeof ev.session_id !== 'string' || typeof ev.semantic_session_id !== 'string') continue;
    if (ev.event === LOCK_ACQUIRED) semanticFromLock.set(ev.session_id, ev.semantic_session_id);
    else if (ev.event === SESSION_ENDED) semanticFromEnded.set(ev.session_id, ev.semantic_session_id);
  }
  const semanticByUuid = new Map([...semanticFromEnded, ...semanticFromLock]);

  const seen = new Set();
  const plan = [];
  for (const ev of events) {
    if (ev.event !== SESSION_STARTED || typeof ev.session_id !== 'string') continue;
    if (seen.has(ev.session_id)) continue;
    seen.add(ev.session_id);
    plan.push({ sessionId: ev.session_id, semanticSessionId: semanticByUuid.get(ev.session_id) ?? null });
  }
  return plan;
}

/**
 * Cheap pre-filter (#926): the set of session ids ALREADY present in
 * sessions.jsonl.
 *
 * WHY THIS EXISTS — latency. `backfillAbandonedSession` re-reads the whole
 * events.jsonl on every call whose id cannot be resolved without it. On a
 * mature store that is O(candidates x events-file): measured 1.26 s for 187
 * candidates over a 1.77 MB events.jsonl, of which 183 were already recorded
 * and therefore pure waste. Reading the (much smaller) sessions.jsonl ONCE up
 * front lets us skip those without entering the core at all.
 *
 * This is a pure latency optimisation with NO behavioural change: it reproduces
 * exactly the core's own early-dedupe branch (same `recordId` derivation, same
 * defensive UUID check) and reports the same `skipped-already-recorded` key.
 * Candidates whose id CANNOT be resolved cheaply (a bare UUID with no
 * lock.acquired bridge — the synthetic-id mint needs events) are never
 * pre-filtered; they still go through the core untouched.
 *
 * @param {string} repoRoot
 * @returns {Set<string>}
 */
function readRecordedIds(repoRoot) {
  const records = readJsonl(path.join(repoRoot, '.orchestrator', 'metrics', 'sessions.jsonl'));
  const ids = new Set();
  for (const r of records) {
    if (!r) continue;
    if (typeof r.session_id === 'string') ids.add(r.session_id);
    // #1167 — a backfilled record now stamps the harness UUID it was
    // reconstructed from. Indexing it lets a bare-UUID candidate be recognised
    // as already-recorded even though the record itself is keyed semantically —
    // the join that was structurally impossible while the field was absent
    // (0 of 286 records carried it, measured 2026-09-02 @ c3ab480).
    if (typeof r.raw_session_id === 'string') ids.add(r.raw_session_id);
  }
  return ids;
}

/**
 * Resolve the sessions.jsonl record id for a planned candidate WITHOUT reading
 * events.jsonl. Mirrors the core's own two-phase resolution: a known semantic
 * id, or a `sessionId` that is already semantic. Returns null when the id can
 * only be resolved from events (bare UUID → lock bridge or synthetic mint).
 */
function cheapRecordId({ sessionId, semanticSessionId }) {
  if (semanticSessionId) return semanticSessionId;
  if (sessionId && !isUuid(sessionId)) return sessionId;
  return null;
}

/**
 * Run the migration over every planned session.
 *
 * `relaxDeadByAge: true` is ALWAYS passed to the shared core (#731) — see the
 * module docblock for why. `assumeDeadBeforeMs` is forwarded as-is (null when
 * `--assume-dead-before` was not given).
 *
 * @param {object} args
 * @param {string}  args.repoRoot
 * @param {boolean} args.apply
 * @param {number|null} [args.assumeDeadBeforeMs]
 * @param {number|null} [args.limit=null]
 *   #926 — cap on how many candidates may reach the shared core. Pre-filtered
 *   (already-recorded) candidates do NOT count against it, since they cost
 *   nothing. On hitting the cap the run stops early and sets
 *   `summary.truncated = true`; the remainder is picked up by the next run.
 *   `null` (CLI default) means uncapped.
 * @param {boolean} [args.newestFirst=false]
 *   #926 — walk the plan most-recent-first. Load-bearing whenever `limit` is
 *   set: a bare-UUID candidate with no lock.acquired bridge cannot be
 *   pre-filtered (its synthetic id is only derivable from events), so it always
 *   spends a core call just to be told "already recorded". In first-seen order
 *   those ancient candidates exhaust the whole budget before the run ever
 *   reaches the genuinely-abandoned recent ones. Measured on a copy of this
 *   repo's live store: first-seen order → backfilled 0, truncated true.
 * @returns {Promise<object>} aggregate summary
 */
export async function runMigration({
  repoRoot,
  apply,
  assumeDeadBeforeMs = null,
  limit = null,
  newestFirst = false,
}) {
  const planned = planSessions({ repoRoot });
  const plan = newestFirst ? [...planned].reverse() : planned;
  const summary = {
    repoRoot,
    mode: apply ? 'apply' : 'dry-run',
    total: plan.length,
    backfilled: 0,
    would_backfill: 0,
    dead_by_age: 0,
    errors: 0,
    skipped: {},
  };

  // Pre-filter pass — costs ONE sessions.jsonl read for the whole run.
  const recordedIds = readRecordedIds(repoRoot);
  let considered = 0;

  // Dry-run has no incremental sessions.jsonl write, so two started-UUIDs that
  // bridge to the SAME semantic id (a session that cleared/compacted mid-run)
  // would both report 'would-backfill' and over-count. Track projected ids
  // here so the dry-run total matches what --apply actually writes.
  const projected = new Set();

  for (const item of plan) {
    // -- Cheap pre-filter: already recorded → skip WITHOUT entering the core --
    const known = cheapRecordId(item);
    if (
      (known !== null && recordedIds.has(known)) ||
      (isUuid(item.sessionId) && recordedIds.has(item.sessionId))
    ) {
      summary.skipped['skipped-already-recorded'] =
        (summary.skipped['skipped-already-recorded'] ?? 0) + 1;
      continue;
    }

    // -- Latency cap (#926, SessionStart path only) --------------------------
    if (typeof limit === 'number' && considered >= limit) {
      summary.truncated = true;
      break;
    }
    considered += 1;

    const res = await backfillAbandonedSession({
      repoRoot,
      sessionId: item.sessionId,
      semanticSessionId: item.semanticSessionId,
      dryRun: !apply,
      relaxDeadByAge: true,
      assumeDeadBeforeMs,
    });
    switch (res.action) {
      case 'backfilled':
        summary.backfilled += 1;
        if (res.deadByAge) summary.dead_by_age += 1;
        await emitBackfillCompleted(repoRoot, item, res);
        // Keep the pre-filter snapshot in step with what we just wrote, so a
        // second candidate bridging to the SAME semantic id is skipped cheaply
        // instead of re-entering the core (which would reach the same verdict).
        if (typeof res.sessionId === 'string') recordedIds.add(res.sessionId);
        break;
      case 'would-backfill':
        if (projected.has(res.sessionId)) {
          summary.skipped['skipped-already-recorded'] =
            (summary.skipped['skipped-already-recorded'] ?? 0) + 1;
        } else {
          projected.add(res.sessionId);
          summary.would_backfill += 1;
          if (res.deadByAge) summary.dead_by_age += 1;
        }
        break;
      case 'error':
        summary.errors += 1;
        break;
      default:
        summary.skipped[res.action] = (summary.skipped[res.action] ?? 0) + 1;
    }
  }
  return summary;
}

/**
 * Emit `orchestrator.session.backfill_completed` for a record THIS path wrote
 * (#1167). Mirrors the payload of `hooks/on-session-end.mjs::emitBackfillOutcome`
 * so both writers are queryable with one filter.
 *
 * Until now the startup/CLI path wrote records SILENTLY: only the SessionEnd
 * hook emitted the event, so nothing in the event stream distinguished "the
 * backfill never ran" from "the backfill ran here". Best-effort by contract —
 * observability must never fail a migration run.
 *
 * @param {string} repoRoot
 * @param {{sessionId: string, semanticSessionId: string|null}} item
 * @param {{action: string, sessionId?: string, supersedes?: string, error?: string}} res
 */
async function emitBackfillCompleted(repoRoot, item, res) {
  try {
    await emitEvent(
      'orchestrator.session.backfill_completed',
      {
        kind: 'abandoned',
        action: typeof res?.action === 'string' ? res.action : 'unknown',
        ...(typeof item?.sessionId === 'string' ? { session_id: item.sessionId } : {}),
        ...(typeof item?.semanticSessionId === 'string'
          ? { semantic_session_id: item.semanticSessionId }
          : {}),
        ...(typeof res?.sessionId === 'string' ? { record_id: res.sessionId } : {}),
        ...(typeof res?.supersedes === 'string' ? { supersedes: res.supersedes } : {}),
        ...(typeof res?.error === 'string' ? { reason: res.error } : {}),
      },
      { repoRoot },
    );
  } catch { /* observability is best-effort */ }
}

/**
 * SessionStart entry point (#926) — decouple the backfill from the /close path.
 *
 * THE BUG THIS FIXES: `hooks/on-session-end.mjs` calls the backfill correctly,
 * but SessionEnd only fires on a REGULAR close. A session killed by Ctrl-C, a
 * timeout, or a crash leaves no ledger entry at all, and the backfill then waits
 * for the NEXT clean close — which may never come. Observed on this repo:
 * sessions.jsonl 18.9 h behind events.jsonl with 8 commits and 0 records.
 * Running at SessionStart closes the loop: the PREVIOUS abandoned session is
 * reconstructed by the NEXT session's start, whatever killed it.
 *
 * ── SAFETY (the two ways this could do damage) ───────────────────────────────
 *  (1) NEVER record the CURRENTLY-STARTING session as abandoned. Two
 *      independent defences:
 *        a. STRUCTURAL — the caller invokes this BEFORE emitting
 *           `orchestrator.session.started`, so this session is not yet in
 *           events.jsonl and therefore not a candidate at all (`planSessions`
 *           enumerates started-events only).
 *        b. GUARD — on a clear/compact/resume re-fire, an EARLIER
 *           `session.started` for the same logical session IS present. It
 *           resolves to our own semantic id, whose lock is live, so the core's
 *           `skipped-own-live-lock` branch (#863) rejects it.
 *  (2) NEVER record a RUNNING FOREIGN session as abandoned. The core evaluates
 *      lock ownership against the CANDIDATE (not the running process): a
 *      candidate that holds a live lock returns `skipped-own-live-lock` BEFORE
 *      the dead-by-age relaxation is ever consulted. Verified against a fixture
 *      where the live lock holder is >4 h stale and thus relaxation-eligible.
 *
 * Residual risk, stated explicitly: a session that is live but does NOT hold
 * the lock (it lost the acquire race — `bootstrapLock` leaves the foreign lock
 * in place and bails) AND has emitted no event for longer than the lock TTL
 * (`DEFAULT_TTL_HOURS` = 4 h) could still be relaxed past. That candidate is
 * one the system's OWN liveness model already considers dead, since its lock
 * would have expired; we deliberately reuse that same TTL rather than inventing
 * a second notion of liveness.
 *
 * Never throws — a backfill failure must NEVER block a session start.
 *
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {number|null} [args.limit=SESSION_START_LIMIT]
 * @returns {Promise<object|null>} the summary, or null when disabled/failed
 */
export async function backfillOnSessionStart({ repoRoot, limit = SESSION_START_LIMIT } = {}) {
  try {
    // Escape hatch for operators who never want ledger writes at session start.
    if (process.env.SO_DISABLE_STARTUP_BACKFILL === '1') return null;
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
    // newestFirst is mandatory here — see runMigration's param docs for the
    // measured failure (budget burned on ancient already-recorded candidates).
    return await runMigration({ repoRoot, apply: true, limit, newestFirst: true });
  } catch {
    // Swallowed by contract — see the docblock. The hook is informational-only.
    return null;
  }
}

function renderHuman(summary) {
  const lines = [];
  lines.push(`Backfill abandoned sessions — ${summary.mode}`);
  lines.push(`  repo:            ${summary.repoRoot}`);
  lines.push(`  sessions seen:   ${summary.total}`);
  if (summary.mode === 'apply') {
    lines.push(`  backfilled:      ${summary.backfilled}`);
  } else {
    lines.push(`  would backfill:  ${summary.would_backfill}`);
  }
  if (summary.dead_by_age > 0) {
    lines.push(`  dead-by-age:     ${summary.dead_by_age} (relaxed past a live foreign session.lock)`);
  }
  lines.push(`  errors:          ${summary.errors}`);
  const skips = Object.entries(summary.skipped);
  if (skips.length > 0) {
    lines.push('  skipped:');
    for (const [reason, n] of skips) lines.push(`    ${reason}: ${n}`);
  }
  return lines.join('\n') + '\n';
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        apply: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'repo-root': { type: 'string' },
        'assume-dead-before': { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`backfill-abandoned-sessions: ${err.message}\n`);
    process.exit(1);
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(
      'Usage: node scripts/backfill-abandoned-sessions.mjs [--dry-run|--apply] [--json]\n' +
        '                                                     [--repo-root PATH]\n' +
        '                                                     [--assume-dead-before ISO]\n' +
        '  --dry-run             preview only (DEFAULT — nothing is written)\n' +
        '  --apply               synthesize + append abandoned-session stubs\n' +
        '  --json                emit the summary as JSON to stdout\n' +
        '  --repo-root           override the project root (default: resolved project dir)\n' +
        '  --assume-dead-before  ISO-8601 cutoff; a candidate whose last known event\n' +
        '                        predates it bypasses a live foreign session.lock\n' +
        'Exit codes: 0 ok, 1 arg error, 2 system error\n'
    );
    process.exit(0);
  }

  // --apply is an explicit opt-in; absent it (or with --dry-run) we never write.
  const apply = values.apply === true && values['dry-run'] !== true;
  const repoRoot = values['repo-root'] || getProjectDir();

  let assumeDeadBeforeMs = null;
  if (typeof values['assume-dead-before'] === 'string' && values['assume-dead-before'].length > 0) {
    const ms = Date.parse(values['assume-dead-before']);
    if (Number.isNaN(ms)) {
      process.stderr.write(
        `backfill-abandoned-sessions: --assume-dead-before is not a valid ISO-8601 timestamp: "${values['assume-dead-before']}"\n`
      );
      process.exit(1);
    }
    assumeDeadBeforeMs = ms;
  }

  let summary;
  try {
    summary = await runMigration({ repoRoot, apply, assumeDeadBeforeMs });
  } catch (err) {
    process.stderr.write(`backfill-abandoned-sessions: ${err?.message ?? String(err)}\n`);
    process.exit(2);
  }

  if (values.json) {
    process.stdout.write(JSON.stringify(summary) + '\n');
  } else {
    process.stdout.write(renderHuman(summary));
  }
  process.exit(0);
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main().catch((err) => {
    process.stderr.write(`backfill-abandoned-sessions: unexpected error: ${err?.stack ?? err}\n`);
    process.exit(2);
  });
}
