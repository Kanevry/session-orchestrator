/**
 * session-end/tail-runner.mjs — the APPLY half of the Phase 3.6.x tail.
 *
 * `phase-skip.mjs` decides WHICH tail phases should run and is side-effect-free
 * by contract. Until now nothing was the other half for 3.6.4: the
 * Expired-Learnings Sweep was coordinator PROSE, so the dry-run decision was
 * computed on every close and the apply path was never mechanically reached.
 * Census (2026-09-09, `rg -n sweepExpiredLearnings scripts/ hooks/ skills/
 * tests/`): the only call sites were the definition itself, the `dryRun: true`
 * probe in `phase-skip.mjs`, the standalone CLI, and tests — no session-end
 * caller applied anything. Measured consequence across three consumer repos:
 * 0 sweeps ever applied, 628 learnings resident in the active stores.
 *
 * This module closes that gap and nothing else. It is deliberately NOT a
 * general tail executor:
 *
 *   - **3.6.3 Memory-Proposals** — AUQ-gated (the operator approves each
 *     proposal before it is written); `.claude/rules/ask-via-tool.md` AUQ-004
 *     puts the tool out of reach of anything but the coordinator thread.
 *   - **3.6.5 Auto-Dream** and **3.6.7 Auto-Dialectic** — both NUDGES that end
 *     in a subagent dispatch (memory-cleanup, `dialectic-deriver`); a library
 *     function cannot dispatch an agent.
 *   - **3.6.6 Skill-Judge** — needs a live LLM dispatch for the judgement.
 *   - **3.6.8 Reconcile** — the write is operator-approved per proposal (AUQ),
 *     which is the whole never-always-on firewall of Epic #693.
 *
 * So {@link runTailPhases} exists as the SEAM (one dispatch table, one result
 * shape) rather than as an abstraction over six phases that will never all be
 * mechanical. A future phase that becomes mechanical is added here; the five
 * above stay coordinator-executed by design, not by omission.
 *
 * Never-throws contract, and its DIRECTION is the opposite of `phase-skip.mjs`.
 * The planner fails OPEN (probe error → run the phase, because losing a phase
 * silently is worse than running it needlessly). A runner that writes to disk
 * must fail CLOSED: any error yields `{ran: false, reason: 'error'}` and the
 * close proceeds. Session close is the one thing that must never be blocked by
 * a best-effort maintenance sweep — a store that stays unswept for one more
 * session costs nothing; a close that aborts loses the session record.
 *
 * Plain Node ESM, no external deps.
 *
 * @typedef {Object} SweepResult
 * @property {boolean} ran            - true only when the store was actually rewritten.
 * @property {string}  [reason]       - why it did not run ('plan-skip' | 'no-plan' | 'error').
 * @property {string}  [error]        - error message, `reason === 'error'` only.
 * @property {number}  [scanned]      - entries read from the active store (ran only).
 * @property {number}  [archived]     - entries moved to the archive sidecar (ran only).
 * @property {string}  [archivePath]  - the archive sidecar written to (ran only).
 */

import { sweepExpiredLearnings } from '../learnings/expiry-sweep.mjs';
import { resolveLearningsPaths } from './phase-skip.mjs';

/** Event name — a plain string literal so the events-schema census can see it. */
const SWEEP_EVENT = 'orchestrator.learnings.sweep_applied';

/** Payload marker for the producer, so the ledger separates it from the CLI. */
const SWEEP_SOURCE = 'session-end-3.6.4';

/**
 * Pull the decision for one phase id out of a `planTailPhases()` result.
 *
 * Accepts three shapes so callers need no adapter: the full
 * `{plan, skippedReport}` envelope, a bare `PhaseDecision[]`, or a single
 * `PhaseDecision` object. Anything else → `null` (treated as "no plan").
 *
 * @param {object|Array|undefined} plan
 * @param {string} phase
 * @returns {object|null}
 */
function findPhaseDecision(plan, phase) {
  if (!plan) return null;
  const list = Array.isArray(plan) ? plan : Array.isArray(plan.plan) ? plan.plan : null;
  if (list) return list.find((d) => d && d.phase === phase) ?? null;
  return plan.phase === phase ? plan : null;
}

/**
 * Emit the one sweep record. Best-effort by construction: a telemetry failure
 * never changes the caller's return value.
 *
 * The shape (lazy `events.mjs` import, explicit `repoRoot`, silent catch) is
 * copied from `_emitEvaluated` in `scripts/lib/express-path.mjs`. Both halves
 * are load-bearing: the lazy import keeps `platform.mjs`'s load-time filesystem
 * walk-up out of the static graph of a module the planner imports, and the
 * refusal to emit WITHOUT an explicit `repoRoot` prevents the `SO_PROJECT_DIR`
 * fallback from writing a synthetic record into whatever tree the ambient env
 * happens to resolve to (#941 — that mistake once landed a test record in the
 * operator's real fleet ledger).
 *
 * @param {{repoRoot: string, scanned: number, archived: number}} ctx
 * @returns {Promise<void>}
 */
async function emitSweepApplied({ repoRoot, scanned, archived }) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
    process.stderr.write(
      `tail-runner: skipped ${SWEEP_EVENT} — no repoRoot given; ` +
        'refusing the ambient SO_PROJECT_DIR destination (#941).\n',
    );
    return;
  }
  try {
    const { emitEvent, sessionAttribution } = await import('../events.mjs');
    await emitEvent(
      SWEEP_EVENT,
      { scanned, archived, source: SWEEP_SOURCE, ...sessionAttribution(repoRoot) },
      { repoRoot },
    );
  } catch {
    // Best-effort telemetry — the sweep already happened and its result is
    // authoritative whether or not the ledger accepted the record.
  }
}

/**
 * Phase 3.6.4 — apply the Expired-Learnings Sweep the planner decided on.
 *
 * Runs ONLY when the plan's 3.6.4 decision says `run === true`. Any other
 * shape (skip decision, phase absent, no plan at all) returns without touching
 * disk — the planner owns the decision, this function owns the write, and a
 * runner that re-derives the decision would be free to disagree with it.
 *
 * @param {object} args
 * @param {string} args.repoRoot            Absolute repo root.
 * @param {object|Array} [args.plan]        `planTailPhases()` result, its `plan`
 *                                          array, or the bare 3.6.4 decision.
 * @param {Date|number} [args.now]          Injectable clock (grace-window maths).
 * @param {number} [args.graceDays]         Override the 14-day grace window.
 * @param {boolean} [args.emit=true]        Set false to suppress the ledger record.
 * @returns {Promise<SweepResult>}          Never throws.
 */
export async function runExpiredSweep({ repoRoot, plan, now, graceDays, emit = true } = {}) {
  try {
    const decision = findPhaseDecision(plan, '3.6.4');
    if (!decision) return { ran: false, reason: 'no-plan' };
    if (decision.run !== true) {
      return { ran: false, reason: 'plan-skip', planReason: decision.reason };
    }
    if (typeof repoRoot !== 'string' || repoRoot.trim() === '') {
      return { ran: false, reason: 'error', error: 'runExpiredSweep: repoRoot is required' };
    }

    const { filePath, archivePath } = resolveLearningsPaths(repoRoot);
    const res = await sweepExpiredLearnings({
      filePath,
      archivePath,
      now,
      dryRun: false,
      ...(graceDays === undefined ? {} : { graceDays }),
    });

    const scanned = res?.scanned ?? 0;
    const archived = res?.archived ?? 0;
    if (emit) await emitSweepApplied({ repoRoot, scanned, archived });

    return { ran: true, scanned, archived, archivePath: res?.archivePath ?? archivePath };
  } catch (err) {
    // Fail CLOSED (see the module header): a maintenance sweep must never be
    // able to block a session close.
    return { ran: false, reason: 'error', error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Run every MECHANICAL phase of the session-end tail.
 *
 * Today that is exactly one — 3.6.4. See the module header for why 3.6.3 and
 * 3.6.5–3.6.8 stay coordinator-executed (AUQ-gated per
 * `.claude/rules/ask-via-tool.md` AUQ-004, or requiring a subagent dispatch a
 * library function cannot make). The keyed return shape is the seam: a caller
 * reads `result['3.6.4']` today and keeps compiling when a second phase lands.
 *
 * @param {object} args — forwarded verbatim to {@link runExpiredSweep}.
 * @returns {Promise<Record<string, SweepResult>>} Never throws.
 */
export async function runTailPhases({ repoRoot, plan, now, graceDays, emit } = {}) {
  return { '3.6.4': await runExpiredSweep({ repoRoot, plan, now, graceDays, emit }) };
}
