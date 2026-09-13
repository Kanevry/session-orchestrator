#!/usr/bin/env node
/**
 * post-bash-issue-budget-refund.mjs — PostToolUseFailure hook: gives a budget
 * slot back when the `gh|glab issue create` it was booked for did NOT run (#1347).
 *
 * Compensating half of `hooks/pre-bash-issue-budget.mjs`. That hook charges in
 * PreToolUse — BEFORE the command runs — which is the only place a QUANTITY gate
 * can block. The cost is that a create which fails (network, rejected label,
 * expired auth) has already spent its slot, so the retry spends a second one:
 * the same issue consumed two of `issue-budget.max-per-session`, and under
 * `mode: strict` that pushes a legitimate issue into overflow parking.
 *
 * Decision flow (mirrors the pre-hook's gate numbering where it applies):
 *   G1 tool filter — only Bash.
 *   G2 command is a non-empty string.
 *   G2b FAILURE filter — a failure FIELD is required: a non-zero `exit_code`, a
 *      non-empty `error`, or `is_error === true` (top level or inside
 *      `tool_response`). The EVENT NAME is deliberately NOT a signal — see
 *      {@link isFailure}.
 *   G3 matcher — the SAME `findIssueCreateStatements` the pre-hook charges with,
 *      so the two can never drift on what counts as an issue-create call. One
 *      refund per issue-create STATEMENT, which is exactly the unit G6 charged.
 *   G3b ATTRIBUTION — one exit code covers the whole Bash call, so it is evidence
 *      about the create only when the create statements ARE the whole command
 *      (`statementsCoverWholeCommand`). Measured 2026-09-13: `glab issue create
 *      --title X && false` files the issue, exits 1, and the first cut of this
 *      hook refunded a slot for it. Anything else → no-op,
 *      `chain-not-attributable`. EVALUATED AFTER G4 in the code: G4 is the
 *      cheaper and more absolute gate, and a repo with the budget off must not
 *      report a chain verdict it has no stake in.
 *  G4 config — `mode: off` → nothing (there was no charge to give back), and
 *      that includes the telemetry: EVERY branch that can emit reads the config
 *      first and returns on `off` (see {@link loadBudgetContext}).
 *   G5 refund — `refundBooking` per statement, honoured ONLY against a statement
 *      present in the session's `charged[]` ledger. A pre-execution failure
 *      (parked at the cap and denied, `exit_code: null`) therefore refunds
 *      nothing WITHOUT a heuristic here: those statements were never charged.
 *      Exemption unit and the never-below-zero / never-touch-`overflow[]`
 *      invariants live in the shared core (`scripts/lib/issue-budget.mjs`).
 *
 * Fail-safe posture: every path exits 0 and emits NOTHING on stdout. This hook
 * runs after the tool has already run; it has no decision to make and must not
 * alter the tool result. Internal errors are swallowed in main().catch.
 *
 * TELEMETRY (#1353). Every decision branch that concerns an issue-create command
 * also emits ONE `orchestrator.issue_budget.refunded` record — see
 * {@link emitRefundDecision}. Before that, a refund left only a stderr line,
 * which under exit 0 reaches the debug log alone: refunds were uncountable, so
 * "how often does this fire, and for which reason" was unfalsifiable
 * (`.claude/rules/host-resources.md` HR-105). The no-op reasons are emitted too —
 * without them the census has a numerator and no denominator. A repo with
 * `issue-budget.mode: off` contributes NO record on any branch: it never charged,
 * so its decisions are not part of the population the census describes, and
 * counting them would invert exactly the numerator/denominator argument above.
 */

import { readStdin } from '../scripts/lib/io.mjs';
import { resolveProjectDir } from '../scripts/lib/platform.mjs';
import { readJson } from '../scripts/lib/common.mjs';
import {
  findIssueCreateStatements,
  statementsCoverWholeCommand,
} from './_lib/vcs-create-matcher.mjs';
import {
  loadIssueBudgetConfig,
  resolveIssueBudgetSessionId,
  refundBooking,
} from '../scripts/lib/issue-budget.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Opt-out per session via SO_DISABLED_HOOKS=post-bash-issue-budget-refund; the
// "minimal"/"off" profiles disable it like every other non-core hook.
if (!shouldRunHook('post-bash-issue-budget-refund')) process.exit(0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the accounting session key exactly as the charging hook does — the
 * refund has to land in the SAME per-session counter file the charge wrote, so
 * this resolution order (stdin id > `CLAUDE_CODE_SESSION_ID`, then the
 * `current-session.json` semantic-id bridge) is a contract, not a preference.
 *
 * @param {object|null} input
 * @param {string|null} projectDir
 * @returns {Promise<string|null>}
 */
async function resolveSessionId(input, projectDir) {
  const stdinRawId = input?.session_id ?? input?.sessionId ?? null;
  const nativeRawId =
    typeof stdinRawId === 'string' && stdinRawId.length > 0
      ? stdinRawId
      : (process.env.CLAUDE_CODE_SESSION_ID ?? null);
  if (typeof nativeRawId !== 'string' || nativeRawId.length === 0) return null;

  let currentSession = null;
  if (projectDir) {
    const persisted = path.join(projectDir, '.orchestrator', 'current-session.json');
    if (existsSync(persisted)) {
      try {
        currentSession = await readJson(persisted);
      } catch {
        // Malformed or unreadable records conservatively retain the raw key.
      }
    }
  }
  return resolveIssueBudgetSessionId(nativeRawId, currentSession);
}

/**
 * Did the tool call this payload describes FAIL?
 *
 * ONLY a failure FIELD counts. The event name does NOT: `PostToolUseFailure`
 * also carries PRE-EXECUTION failures (measured: `corrective_context` entries
 * with `exit_code: null` for calls that never ran), so "the event fired" is not
 * evidence that the create ran and failed. The sibling
 * `hooks/post-tool-failure-corrective-context.mjs` reads only `exit_code` /
 * `error` for the same reason.
 *
 * `is_error` is read at BOTH levels. Top level is not speculation: the Cursor
 * bridge builds its canonical payload with `is_error: eventObject.is_error ??
 * eventObject.isError` at TOP level and forwards no `exit_code` and no `error`
 * key at all (`scripts/lib/cursor-hook-bridge.mjs`
 * `normalizeCursorHookPayload`) — so for a Cursor-bridged `postToolUseFailure`
 * the top-level flag is the ONLY failure field that can arrive.
 *
 * A payload whose event name claims a failure while carrying no failure field is
 * a deliberate but LOUD no-op (see the WARN in main()). Silence there is the
 * "built but never switched on" class this hook was caught in.
 *
 * @param {object} input
 * @returns {boolean}
 */
function isFailure(input) {
  if (typeof input?.exit_code === 'number' && input.exit_code !== 0) return true;
  if (typeof input?.error === 'string' && input.error.trim().length > 0) return true;
  if (input?.is_error === true) return true;
  const response = input?.tool_response;
  if (response && typeof response === 'object' && response.is_error === true) return true;
  return false;
}

/**
 * Does this payload CLAIM a failure by event name? Used ONLY to decide whether a
 * missing failure field deserves a WARN — an unclaimed success needs none.
 *
 * @param {object} input
 * @returns {boolean}
 */
function claimsFailure(input) {
  const event = input?.hook_event_name ?? input?.hookEventName ?? null;
  return event === 'PostToolUseFailure' || input?.cursor_event_name === 'postToolUseFailure';
}

/**
 * The harness's id for THIS tool call, when it publishes one — the first half of
 * a charge record's identity (`bookingId` in the shared core). Absent, the core
 * matches the deterministic session+command+index key instead. Several spellings
 * are accepted because the payload key is the harness's to choose; this resolver
 * is kept identical to the pre-hook's copy, since the two must read the same id
 * out of the same payload or the refund cannot find the charge.
 *
 * @param {object} input
 * @returns {string|null}
 */
function resolveToolCallId(input) {
  for (const value of [input?.tool_use_id, input?.toolUseId, input?.tool_call_id, input?.tool_id]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Resolve the repo root AND its issue-budget config together — the pair every
 * emitting branch needs, and the reason G4 can be honoured before the FIRST emit
 * rather than only before the refund (#1353 fix-pass).
 *
 * Deliberately NOT hoisted to the top of main(): the config read is a file read,
 * and G1/G2 plus "failed command creates no issue" must stay allocation-free.
 * Every caller sits behind a matcher hit, so an ordinary failing Bash call still
 * pays nothing.
 *
 * @returns {{ projectDir: string, config: ReturnType<typeof loadIssueBudgetConfig> }}
 */
function loadBudgetContext() {
  const projectDir = resolveProjectDir() || process.cwd();
  return { projectDir, config: loadIssueBudgetConfig(projectDir) };
}

/**
 * Event name for the refund decision (#1353). One record per decision, so a
 * census over N sessions can group by `reason` and see the whole population.
 */
const ISSUE_BUDGET_REFUNDED_EVENT = 'orchestrator.issue_budget.refunded';

/**
 * Emit ONE `orchestrator.issue_budget.refunded` record for this invocation.
 *
 * `reason` is a CLOSED enum, mapped onto the hook's branches:
 *   `no-signal`              — G2b: the payload carries no failure FIELD, so
 *                              there is no evidence the create ran and failed.
 *   `chain-not-attributable` — G3b: the failed command mixes the create with
 *                              other statements, so the exit code judges neither.
 *   `refunded`               — G5: at least one charge record was honoured.
 *   `not-charged`            — G5: no charge record matched (parked at the cap,
 *                              re-delivered failure, or an identity-less call
 *                              that was never persisted → `no-session`).
 * The fifth documented reason, `counter-at-zero`, has NO branch here: a matched
 * record whose counter is already 0 is absorbed inside `refundBooking`'s
 * never-below-zero guard and returns `refunded` like any other match, and an
 * UNmatched record returns `noop`/`not-charged`. Surfacing it would need a new
 * field on the shared core's verdict (`scripts/lib/issue-budget.mjs`), so it is
 * reported rather than faked from a value this hook cannot observe.
 *
 * PRIVACY: the payload carries NO command text, issue title or path. This record
 * travels verbatim over the optional Clank webhook with no redaction (same rule
 * as `orchestrator.issue_budget.reconciled`), where a `glab issue create --title
 * …` string or an absolute ledger path is owner data the receiver has no use for.
 *
 * Awaited AND caught: telemetry added to a hook silently disarms it unless both
 * hold — an unawaited promise loses the write when the process exits, and a
 * throwing emit (an unwritable ledger, a schema rejection) would otherwise reach
 * `main().catch` and turn a completed refund into a reported internal error.
 * `events.mjs` is imported LAZILY so the pass-through paths (G1/G2, the
 * overwhelming majority of Bash calls) never pay its module-load cost.
 *
 * @param {string} repoRoot
 * @param {'no-signal'|'chain-not-attributable'|'refunded'|'not-charged'} reason
 * @param {number} statementCount — issue-create statements the matcher found.
 * @param {'count'|'exempt'|null} unit — which counter was given back, read off
 *   the honoured charge records (`exempt` only when EVERY refund was an exempt
 *   one); `null` whenever nothing was refunded.
 * @returns {Promise<void>}
 */
async function emitRefundDecision(repoRoot, reason, statementCount, unit) {
  try {
    const { emitEvent, sessionAttribution } = await import('../scripts/lib/events.mjs');
    await emitEvent(
      ISSUE_BUDGET_REFUNDED_EVENT,
      {
        reason,
        unit,
        statement_count: statementCount,
        ...sessionAttribution(repoRoot),
      },
      { repoRoot },
    );
  } catch {
    // Best-effort telemetry — never the reason a refund reports failure.
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return;

  // G1 — only Bash is gated (the pre-hook charges only Bash).
  if (input.tool_name !== 'Bash') return;

  // G2 — command must be a non-empty string.
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return;

  // G2b — only a FAILED invocation is compensated, and only on the evidence of a
  // failure FIELD. A payload claiming failure by event name while carrying none
  // is reported rather than silently dropped.
  if (!isFailure(input)) {
    if (claimsFailure(input)) {
      process.stderr.write(
        '⚠ post-bash-issue-budget-refund: failure event carried no failure field ' +
          '(exit_code / error / is_error) — nothing refunded. On the Cursor bridge only ' +
          'top-level `is_error` is forwarded; without it no refund is possible.\n',
      );
      // The matcher runs here ONLY to scope the record: a `no-signal` line for
      // every failing Bash call would drown the census in commands the budget
      // never charged. The hook is registered on PostToolUseFailure alone
      // (hooks/hooks.json), so this is not a hot path for ordinary tool calls.
      const claimed = findIssueCreateStatements(command);
      if (claimed.length > 0) {
        // G4 ahead of the emit: a repo with the budget OFF was never charged, so
        // it is not part of the refund census (docs/events-schema.md).
        const { projectDir, config } = loadBudgetContext();
        if (config.mode !== 'off') {
          await emitRefundDecision(projectDir, 'no-signal', claimed.length, null);
        }
      }
    }
    return;
  }

  // G3 — shared matcher, per statement: the charge unit is the refund unit.
  const statements = findIssueCreateStatements(command);
  if (statements.length === 0) return;

  // G4 — config, read BEFORE the first emit below. `off` means nothing was ever
  // charged, so there is neither a slot to give back nor a decision to count.
  const { projectDir, config } = loadBudgetContext();
  if (config.mode === 'off') return;

  // G3b — one exit code judges the WHOLE call, so it is evidence about the
  // create only when the creates ARE the whole call.
  if (!statementsCoverWholeCommand(command)) {
    process.stderr.write(
      'ℹ post-bash-issue-budget-refund: failed command mixes an issue-create with other ' +
        'statements — chain-not-attributable, no slot refunded.\n',
    );
    await emitRefundDecision(projectDir, 'chain-not-attributable', statements.length, null);
    return;
  }

  const sessionId = await resolveSessionId(input, projectDir);
  const toolCallId = resolveToolCallId(input);

  // G5 — one refund per statement, each honoured ONLY against the charge record
  // the pre-hook wrote for the same (tool-call id, statement index) pair. The
  // record is REMOVED when honoured, so a re-delivered failure of the same call
  // gives back nothing; a statement that was PARKED instead of charged has no
  // record at all and is `not-charged`.
  const verdicts = statements.map((s, i) =>
    refundBooking({
      repoRoot: projectDir,
      sessionId,
      command: s.text,
      toolCallId,
      statementIndex: i,
      config,
    }),
  );

  const refunded = verdicts.filter(
    (v) => v.decision === 'refunded' || v.decision === 'refunded-exempt',
  );
  if (refunded.length > 0) {
    const last = refunded[refunded.length - 1];
    // stderr only: PostToolUse-family stdout would be an envelope Claude reads
    // as a decision, and this hook has none to make.
    process.stderr.write(
      `ℹ post-bash-issue-budget-refund: failed issue-create — ${refunded.length} slot(s) ` +
        `refunded (${last.count}/${last.max})\n`,
    );
  }

  // The unit is read off the honoured records, never re-classified from the
  // command text: `exempt` only when EVERY refund landed on the exempt counter,
  // so a mixed chain (one capped + one exempt create) reports the capped unit —
  // that is the counter the operator's cap is spent from.
  const unit =
    refunded.length === 0
      ? null
      : refunded.every((v) => v.decision === 'refunded-exempt')
        ? 'exempt'
        : 'count';
  await emitRefundDecision(
    projectDir,
    refunded.length > 0 ? 'refunded' : 'not-charged',
    statements.length,
    unit,
  );
}

// Top-level error handler — fail open, same posture as the sibling hooks.
main().catch((e) => {
  process.stderr.write(
    `⚠ post-bash-issue-budget-refund: internal error — ${e?.message || e}\n`,
  );
  process.exit(0);
});
