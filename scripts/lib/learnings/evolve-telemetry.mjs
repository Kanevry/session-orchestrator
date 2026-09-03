/**
 * learnings/evolve-telemetry.mjs — mechanical `orchestrator.evolve.completed` /
 * `orchestrator.dialectic.completed` emitters for the two `/evolve` run
 * classes (issue #1206).
 *
 * Both events were prose-only until this module: five emit sites lived in
 * `skills/evolve/SKILL.md` as `node scripts/emit-event.mjs ...` bash blocks the
 * coordinator had to remember to run — a mechanism hiding inside prose, the
 * same shape #1017 already fixed once for the learnings-store write path
 * (`pruneLearnings()` in `./expiry-sweep.mjs`). This module gives both events
 * a CODE call site instead: `emitEvolveCompleted()` is invoked from
 * `scripts/sweep-expired-learnings.mjs`'s `--prune` exit path (the ONE store
 * write `/evolve analyze` already performs), and `recordDialecticRun()` is
 * invoked from `scripts/dialectic-deriver.mjs::runDialecticDeriver()` for the
 * three abort statuses it can determine on its own, plus dry-run success —
 * see that module's header for why APPLY-mode success and the two
 * throw-based abort classes (`unknown-model`, `subagent-crash`) still call
 * `recordDialecticRun()` from `skills/evolve/SKILL.md` prose (the merge and
 * the dispatch-agent try/catch both happen one layer up, outside this pure
 * pipeline).
 *
 * Both emitters are best-effort and try/catch-wrapped — same posture as
 * `emitReconcileCompleted` in `scripts/lib/reconcile/engine.mjs` and
 * `decideAndRecordAutoDialectic` in `scripts/lib/auto-dialectic.mjs` — because
 * `emitEvent()` THROWS `EventValidationError` on a malformed record, and a
 * telemetry failure must never break the `/evolve` pipeline itself.
 *
 * Both REFUSE to emit without an explicit `repoRoot` (#1119): most unit tests
 * call the underlying pipelines (`pruneLearnings`, `runDialecticDeriver`)
 * without one, and a `SO_PROJECT_DIR` fallback would silently append
 * synthetic records to the operator's REAL fleet ledger on every `npm test`.
 */

const REASON_MAX_CHARS = 300;

/**
 * Record one `/evolve analyze` run — success or abort.
 *
 * @param {object} [opts]
 * @param {string} opts.repoRoot - REQUIRED. No SO_PROJECT_DIR fallback (#1119).
 * @param {number} [opts.appended=0] - new learnings written (Step 3.5(4)).
 * @param {number} [opts.boosted=0] - existing learnings reinforced (Step 3.5(2)).
 * @param {number} [opts.pruned=0] - `$PRUNE.archived` total from the
 *   `--prune` call this function is invoked alongside.
 * @param {number} [opts.promoted=0] - always 0 from this call site; promotion
 *   to `public` scope is a separate CLI (`npm run share:hw-learnings -- --promote`).
 * @param {number} [opts.durationMs] - elapsed ms since the run's telemetry
 *   start marker; omitted (never fabricated) when not measured.
 * @param {string[]} [opts.skipped=[]] - HR-105: optional steps that RAN but
 *   were themselves skipped this run (e.g. `skill-evolution-off`,
 *   `vault-mirror-off`) — distinguishes "ran, a step inside it skipped" from
 *   "did not run at all" (the `aborted` form below). Included only when
 *   non-empty; success-form counters are ALWAYS present regardless.
 * @param {string} [opts.aborted] - when given (non-empty string), emit the
 *   ABORT form instead of the success form: `{aborted, reason, duration_ms}`.
 * @param {string} [opts.reason] - abort message shown to the user, clamped to
 *   {@link REASON_MAX_CHARS}.
 * @param {Function} [opts.emitFn] - DI hook for testing; defaults to the real
 *   `emitEvent` from `../events.mjs` (dynamically imported, so a caller that
 *   supplies `emitFn` never touches the real module at all).
 * @returns {Promise<void>}
 */
export async function emitEvolveCompleted({
  repoRoot,
  appended = 0,
  boosted = 0,
  pruned = 0,
  promoted = 0,
  durationMs,
  skipped = [],
  aborted,
  reason,
  emitFn,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    process.stderr.write(
      'evolve: skipped orchestrator.evolve.completed — no repoRoot given; ' +
        'refusing the ambient SO_PROJECT_DIR destination (#1119).\n',
    );
    return;
  }

  const payload =
    typeof aborted === 'string' && aborted.length > 0
      ? {
          aborted,
          reason: typeof reason === 'string' ? reason.slice(0, REASON_MAX_CHARS) : reason,
          duration_ms: durationMs,
        }
      : {
          appended,
          boosted,
          pruned,
          promoted,
          duration_ms: durationMs,
          ...(Array.isArray(skipped) && skipped.length > 0 ? { skipped } : {}),
        };

  try {
    const emit = emitFn ?? (await import('../events.mjs')).emitEvent;
    await emit('orchestrator.evolve.completed', payload, { repoRoot });
  } catch (err) {
    // best-effort — a telemetry failure must never break the caller's pipeline,
    // but a silently swallowed failure is exactly the 0-records unfalsifiability
    // #1206 was filed against — so it is surfaced on stderr instead.
    process.stderr.write(
      '⚠ evolve-telemetry: emit failed (orchestrator.evolve.completed): ' +
        (err?.message ?? String(err)) +
        '\n',
    );
  }
}

/**
 * Record one `/evolve --dialectic` run — success or abort.
 *
 * @param {object} [opts]
 * @param {string} opts.repoRoot - REQUIRED, same #1119 refusal as {@link emitEvolveCompleted}.
 * @param {string} opts.status - `ok` for the success form, or one of the abort
 *   slugs `unknown-model` | `budget-exceeded` | `would-empty-card` |
 *   `empty-input` | `subagent-crash` (mirrors `skills/evolve/SKILL.md` Step 6.5
 *   verbatim) — any other non-`ok` string is emitted as the abort form as-is.
 * @param {'dry-run'|'apply'} [opts.mode] - success form only.
 * @param {number} [opts.userDeltas=0] - success form only.
 * @param {number} [opts.agentDeltas=0] - success form only.
 * @param {number} [opts.tokensIn] - success form only; omitted when not measured.
 * @param {number} [opts.tokensOut] - success form only; omitted when not measured.
 * @param {number} [opts.durationMs] - omitted (never fabricated) when not measured.
 * @param {Function} [opts.emitFn] - DI hook for testing; defaults to the real
 *   `emitEvent` from `../events.mjs` (dynamically imported, so a caller that
 *   supplies `emitFn` never touches the real module at all).
 * @returns {Promise<void>}
 */
export async function recordDialecticRun({
  repoRoot,
  status,
  mode,
  userDeltas = 0,
  agentDeltas = 0,
  tokensIn,
  tokensOut,
  durationMs,
  emitFn,
} = {}) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    process.stderr.write(
      'dialectic: skipped orchestrator.dialectic.completed — no repoRoot given; ' +
        'refusing the ambient SO_PROJECT_DIR destination (#1119).\n',
    );
    return;
  }

  const payload =
    status === 'ok'
      ? {
          mode,
          user_deltas: userDeltas,
          agent_deltas: agentDeltas,
          tokens_in: tokensIn,
          tokens_out: tokensOut,
          duration_ms: durationMs,
        }
      : { aborted: status, duration_ms: durationMs };

  try {
    const emit = emitFn ?? (await import('../events.mjs')).emitEvent;
    await emit('orchestrator.dialectic.completed', payload, { repoRoot });
  } catch (err) {
    // best-effort — a telemetry failure must never break the caller's pipeline,
    // but a silently swallowed failure is exactly the 0-records unfalsifiability
    // #1206 was filed against — so it is surfaced on stderr instead.
    process.stderr.write(
      '⚠ evolve-telemetry: emit failed (orchestrator.dialectic.completed): ' +
        (err?.message ?? String(err)) +
        '\n',
    );
  }
}
