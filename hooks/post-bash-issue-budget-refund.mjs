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
 *      `chain-not-attributable`.
 *   G4 config — `mode: off` → nothing (there was no charge to give back).
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
    }
    return;
  }

  // G3 — shared matcher, per statement: the charge unit is the refund unit.
  const statements = findIssueCreateStatements(command);
  if (statements.length === 0) return;

  // G3b — one exit code judges the WHOLE call, so it is evidence about the
  // create only when the creates ARE the whole call.
  if (!statementsCoverWholeCommand(command)) {
    process.stderr.write(
      'ℹ post-bash-issue-budget-refund: failed command mixes an issue-create with other ' +
        'statements — chain-not-attributable, no slot refunded.\n',
    );
    return;
  }

  const projectDir = resolveProjectDir() || process.cwd();

  // G4 — config. `off` means nothing was ever charged.
  const config = loadIssueBudgetConfig(projectDir);
  if (config.mode === 'off') return;

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
}

// Top-level error handler — fail open, same posture as the sibling hooks.
main().catch((e) => {
  process.stderr.write(
    `⚠ post-bash-issue-budget-refund: internal error — ${e?.message || e}\n`,
  );
  process.exit(0);
});
