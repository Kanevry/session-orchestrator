/**
 * release-session-lock.mjs — CLI: release THIS session's `session.lock`, emit the
 * terminal `orchestrator.session.lock.released` breadcrumb, and PROVE the lock is
 * gone before exiting 0.
 *
 * ## Why a CLI and not one more `release()` call site (#1395)
 *
 * Measured 2026-09-19: three of the four `release()` call sites already emit
 * `orchestrator.session.lock.released` — `hooks/on-session-end.mjs`,
 * `scripts/lib/autopilot/worktree-pipeline.mjs` and
 * `scripts/lib/session-transition.mjs`. The silent one was never code at all: it
 * is the PROSE step `skills/session-end/SKILL.md` § Phase 3.8, executed by hand
 * by the coordinator LLM. It deletes the lock, so the SessionEnd hook later reads
 * `status: 'absent'` and emits nothing — this repo recorded 5 `lock.acquired`
 * against 0 `lock.released`. A prose "call X, then check Y" step is the shape
 * that gets skipped (`.claude/rules/process-contracts.md`: 339 of 351 issues
 * closed without the prose-mandated pre-step); the repair is ONE command that
 * verifies its own effect and exits non-zero when it cannot.
 *
 * ## Why the emit is not inside `release()`
 *
 * Three structural reasons, none of them fixable here:
 *   1. Import cycle — `scripts/lib/events.mjs` imports `session-lock.mjs`
 *      (`sessionAttribution()` reads the lock), so `session-lock.mjs` cannot
 *      import `events.mjs`.
 *   2. `release()` is synchronous; `emitEvent()` is async.
 *   3. After the unlink the event envelope can no longer read the lock for
 *      correlation — which is exactly why this CLI captures `session_id` and
 *      `semantic_session_id` from the lock BEFORE releasing and passes both
 *      EXPLICITLY in the payload.
 *
 * ## Reuse note (BV-001.2)
 *
 * `leaveSourceRoot()` in `scripts/lib/session-transition.mjs` is the closest
 * existing helper and is deliberately NOT reused: it also deregisters the
 * host-wide registry entry, which a session closing in place must NOT do at
 * Phase 3.8 (the SessionEnd hook owns deregistration, at the real end). Its
 * `LOCK_RELEASED_EVENT` constant IS reused, so the event name has one writer.
 *
 * Exit codes: 0 verified · 1 user/input or ownership error · 2 system error.
 *
 * Exports (for tests): main.
 */

import { parseArgs } from 'node:util';

import { readLockDetailed, loadOwnerProof, release } from './lib/session-lock.mjs';
import { LOCK_RELEASED_EVENT } from './lib/session-transition.mjs';
import { emitEvent } from './lib/events.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

/**
 * `caller` value stamped into the breadcrumb, so this fourth release site stays
 * distinguishable from `on-session-end`, `session-transition` and the autopilot
 * worktree pipeline in the single `orchestrator.session.lock.*` stream.
 */
export const PHASE_CALLER = 'session-end-phase-3-8';

const HELP = `release-session-lock.mjs — release this session's lock and prove it is gone

USAGE
  node scripts/release-session-lock.mjs --session-id <raw-id> [--repo-root <path>] [--json]

WHAT IT DOES
  1. Reads <repo-root>/.orchestrator/session.lock.
  2. Releases it IFF its raw session_id equals --session-id (owner-proof gated,
     exactly as hooks/on-session-end.mjs gates it).
  3. Emits orchestrator.session.lock.released with the ids read BEFORE the
     delete, plus caller="${PHASE_CALLER}".
  4. RE-READS the lock path and exits 0 only when our lock is provably gone.

FLAGS
  --session-id <id>   REQUIRED. The RAW (physical) session id that owns the lock
                      — .orchestrator/session.lock "session_id", never STATE.md
                      "session" and never the semantic id. A lock owned by a
                      different id is NEVER released.
  --repo-root <path>  Repo whose lock is released (default: cwd).
  --json              Machine-readable result on stdout.
  -h, --help          Show this help and exit 0.

OUTCOMES
  absent        no lock file — nothing released, NO event, exit 0.
  deleted       our lock was removed and re-read as gone.
  already-gone  ownership matched but the lock had already vanished; the event
                is still written, because a lock removed by a third party while
                we held it is the forensically interesting case.

EXIT CODES
  0 — the lock is provably absent (released now, or nothing to release)
  1 — user/input or ownership error: missing/empty --session-id, unknown flag,
      or a lock owned by a different session (nothing is touched)
  2 — system error: unreadable/corrupt lock, filesystem error, owner-proof
      mismatch, the lock still present after release, or the breadcrumb could
      not be written
`;

/**
 * Print the one-line human summary (stdout = data, stderr = diagnostics).
 *
 * @param {{outcome: string, verified: boolean, session_id: string, event_emitted: boolean}} result
 */
function printHuman(result) {
  if (result.outcome === 'absent') {
    process.stdout.write('session-lock: nothing to release — no lock file (no event written).\n');
    return;
  }
  const verified = result.verified ? 'verified gone' : 'NOT verified — lock still present';
  const event = result.event_emitted ? 'breadcrumb written' : 'breadcrumb FAILED';
  process.stdout.write(
    `session-lock ${result.outcome} for session ${result.session_id} — ${verified}, ${event}.\n`,
  );
}

/**
 * Did OUR lock really vanish?
 *
 * Computed from a FRESH read after `release()` returned, deliberately not from
 * `release()`'s own `verified` field: that field is absent on the benign
 * `no-lock` branch (so a caller copying it reports `verified: false` for a lock
 * that IS gone), and it was computed before this process did anything else. The
 * CLI's whole contract is "exit 0 proves absence", so it re-reads.
 *
 * A FOREIGN lock present at the re-read counts as verified — ours is gone and a
 * sibling legitimately acquired the path in the race window (same rule as
 * `release()`'s post-delete verify; PSA-005: never touch a lock we do not own).
 *
 * @param {string} repoRoot
 * @param {string} sessionId
 * @returns {boolean}
 */
function ourLockIsGone(repoRoot, sessionId) {
  const after = readLockDetailed({ repoRoot });
  if (after.status === 'absent') return true;
  if (after.status === 'ok') return after.lock.session_id !== sessionId;
  // unreadable / corrupt — absence cannot be confirmed, so it is not claimed.
  return false;
}

/**
 * CLI entry point.
 *
 * @param {{argv?: string[]}} [opts]
 * @returns {Promise<number>} process exit code
 */
export async function main({ argv = process.argv.slice(2) } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'repo-root': { type: 'string' },
        'session-id': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    process.stderr.write(`release-session-lock: ${err?.message ?? 'bad arguments'}\n`);
    process.stderr.write('Run with --help for usage.\n');
    return 1;
  }

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const sessionId = values['session-id'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    process.stderr.write('release-session-lock: --session-id <raw-id> is required.\n');
    process.stderr.write('Run with --help for usage.\n');
    return 1;
  }

  const repoRoot = values['repo-root'] ?? process.cwd();

  const emitResult = async (result) => {
    if (values.json) process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    else printHuman(result);
  };

  // -- Step 1: read the lock, and capture the ids BEFORE anything is deleted --
  const lockDetail = readLockDetailed({ repoRoot });

  if (lockDetail.status === 'absent') {
    // Nothing was released, so nothing terminal happened: NO event. Writing one
    // here would put a fictional lifecycle end into the stream — the idempotent
    // re-run case is not a release.
    const result = { ok: true, outcome: 'absent', verified: true, session_id: sessionId, event_emitted: false };
    await emitResult(result);
    return 0;
  }

  if (lockDetail.status !== 'ok') {
    process.stderr.write(`release-session-lock: lock is ${lockDetail.status} — ownership cannot be established; nothing touched.\n`);
    await emitResult({
      ok: false, outcome: `lock-${lockDetail.status}`, verified: false, session_id: sessionId, event_emitted: false,
    });
    return 2;
  }

  const lock = lockDetail.lock;
  if (lock.session_id !== sessionId) {
    // A raw-id mismatch never grants release ownership (same gate as
    // hooks/on-session-end.mjs). Reconciliation of a foreign lease is the
    // reaper's job, not this command's.
    process.stderr.write(`release-session-lock: lock is owned by a different session — not released.\n`);
    await emitResult({
      ok: false, outcome: 'session-mismatch', verified: false, session_id: sessionId, event_emitted: false,
    });
    return 1;
  }

  const semanticSessionId = typeof lock.semantic_session_id === 'string' && lock.semantic_session_id.length > 0
    ? lock.semantic_session_id
    : null;

  // -- Step 2: release, owner-proof gated (#987/#989) ------------------------
  // `proof` is null whenever ownership cannot be proven; release() treats null
  // as absent and degrades to the session_id-only path, so it is passed
  // through unguarded.
  const proof = loadOwnerProof({ repoRoot });
  const releaseResult = release({ sessionId, repoRoot, proof });

  if (releaseResult.ok !== true) {
    process.stderr.write(`release-session-lock: release failed — ${releaseResult.reason ?? 'fs-error'}\n`);
    await emitResult({
      ok: false, outcome: `release-${releaseResult.reason ?? 'fs-error'}`, verified: false, session_id: sessionId, event_emitted: false,
    });
    return 2;
  }

  const alreadyGone = releaseResult.deleted !== true && releaseResult.reason === 'no-lock';
  if (releaseResult.deleted !== true && !alreadyGone) {
    // 'proof-mismatch' (and any future non-delete reason): ownership matched on
    // the raw id but the second factor contradicted it. Contradictory on-disk
    // state, not a bad argument — exit 2.
    process.stderr.write(`release-session-lock: lock not released — ${releaseResult.reason ?? 'not-deleted'}\n`);
    await emitResult({
      ok: false, outcome: `release-${releaseResult.reason ?? 'not-deleted'}`, verified: false, session_id: sessionId, event_emitted: false,
    });
    return 2;
  }

  // -- Step 3: prove it ------------------------------------------------------
  const verified = ourLockIsGone(repoRoot, sessionId);
  const outcome = alreadyGone ? 'already-gone' : 'deleted';

  // -- Step 4: the terminal breadcrumb --------------------------------------
  // The ids are passed EXPLICITLY: the lock is gone by now, so emitEvent's
  // lock-derived correlation would find nothing to attribute this record to.
  let eventEmitted = true;
  let emitError = null;
  try {
    await emitEvent(LOCK_RELEASED_EVENT, {
      session_id: sessionId,
      ...(semanticSessionId !== null ? { semantic_session_id: semanticSessionId } : {}),
      caller: PHASE_CALLER,
      outcome,
      verified,
    }, { repoRoot });
  } catch (err) {
    eventEmitted = false;
    emitError = err?.message ?? String(err);
  }

  const result = {
    ok: verified && eventEmitted,
    outcome,
    verified,
    session_id: sessionId,
    ...(semanticSessionId !== null ? { semantic_session_id: semanticSessionId } : {}),
    event_emitted: eventEmitted,
    ...(emitError !== null ? { event_error: emitError } : {}),
  };
  await emitResult(result);

  if (!verified) {
    process.stderr.write('release-session-lock: the lock is STILL present after release — not verified.\n');
    return 2;
  }
  if (!eventEmitted) {
    // The release itself succeeded; what failed is the one thing this command
    // exists to guarantee, so it is reported as a system error rather than
    // swallowed. Phase 3.8 treats a non-zero exit as a WARN and continues.
    process.stderr.write(`release-session-lock: breadcrumb could not be written — ${emitError}\n`);
    return 2;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// CLI guard — prevents execution during test-time imports.
// ---------------------------------------------------------------------------

if (isMainModule(import.meta.url)) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`release-session-lock: unexpected error: ${err?.stack ?? err}\n`);
      process.exit(2);
    });
}
