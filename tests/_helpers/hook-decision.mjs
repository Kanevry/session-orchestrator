/**
 * tests/_helpers/hook-decision.mjs
 *
 * The single assertion contract for a PreToolUse hook's allow/deny decision.
 *
 * ## Why this exists
 *
 * Claude Code's PreToolUse protocol offers two mutually exclusive channels:
 * `exit 2` (stderr-only — "Claude Code ignores stdout and any JSON in it") or
 * `exit 0` + a decision envelope on stdout. Running both at once is what #906
 * fixed: the hooks exited 2 AND printed JSON, so the JSON was discarded, the
 * operator saw only `hook error: … No stderr output`, and wave agents — reading
 * that as a crash rather than a policy block — started routing around the
 * enforcement layer via plain Bash.
 *
 * Every deny-capable hook now emits, on stdout, exactly:
 *
 *   {"hookSpecificOutput":{"hookEventName":"PreToolUse",
 *                          "permissionDecision":"deny",
 *                          "permissionDecisionReason":"<reason — suggestion>"},
 *    "systemMessage":"⛔ <first line>"}
 *
 * ## The trap this helper closes
 *
 * Under `exit 0`, THE EXIT CODE NO LONGER DISCRIMINATES allow from deny — both
 * are 0. A bare `expect(code).toBe(0)` in an allow-path test is therefore an
 * assert-nothing: it passes whether the hook allowed or denied. stdout is the
 * only channel that still carries the distinction:
 *
 *   - deny  → exit 0 AND exactly one `hookSpecificOutput` line on stdout
 *   - allow → exit 0 AND stdout EMPTY
 *
 * `expectAllow`'s empty-stdout half is load-bearing for exactly that reason.
 * Six test files grew their own near-copies of these two helpers during the
 * migration; this module is the one place the contract lives, so the next
 * protocol change touches one file rather than six.
 *
 * Accepts both spawn shapes: `{ code }` (async `child_process.spawn` wrapper)
 * and `{ status }` (`spawnSync`).
 */

import { expect } from 'vitest';

/**
 * Normalise the exit code across the two spawn conventions in this suite.
 *
 * @param {{code?: number|null, status?: number|null}} result
 * @returns {number|null|undefined}
 */
function exitCodeOf(result) {
  return result.code ?? result.status;
}

/**
 * Assert a PreToolUse hook DENIED, and return the parsed envelope.
 *
 * Checks the full contract — not just the decision field:
 *   - exit 0 (never 2: `exit 2` throws the reason away)
 *   - stdout carries exactly ONE non-blank line
 *   - top-level keys are EXACTLY `hookSpecificOutput` + `systemMessage`
 *     (an exclusivity guard: a regression to the deprecated flat
 *     `{permissionDecision, reason}` form, or a stray extra key, fails here
 *     instead of passing silently)
 *   - `hookEventName` is `PreToolUse`, `permissionDecision` is `deny`
 *   - `permissionDecisionReason` is a non-empty string
 *   - `systemMessage` opens with the ⛔ headline — the operator-visible half
 *     that was invisible pre-#906
 *
 * @param {{code?: number|null, status?: number|null, stdout: string}} result
 * @param {string|{reasonContains?: string}} [expectedReason] - substring the
 *   `permissionDecisionReason` must contain; either bare or as `{reasonContains}`.
 * @returns {{hookSpecificOutput: {hookEventName: string, permissionDecision: string, permissionDecisionReason: string}, systemMessage: string}}
 */
export function expectDeny(result, expectedReason) {
  expect(exitCodeOf(result)).toBe(0);

  const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);

  const obj = JSON.parse(lines[0]);
  expect(Object.keys(obj).sort()).toEqual(['hookSpecificOutput', 'systemMessage']);
  expect(obj.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(obj.hookSpecificOutput.permissionDecision).toBe('deny');
  expect(typeof obj.hookSpecificOutput.permissionDecisionReason).toBe('string');
  expect(obj.hookSpecificOutput.permissionDecisionReason.length).toBeGreaterThan(0);
  expect(obj.systemMessage.startsWith('⛔')).toBe(true);

  const needle =
    typeof expectedReason === 'string' ? expectedReason : expectedReason?.reasonContains;
  if (needle !== undefined) {
    expect(obj.hookSpecificOutput.permissionDecisionReason).toContain(needle);
  }

  return obj;
}

/**
 * Assert a PreToolUse hook ALLOWED: exit 0 AND nothing decision-shaped on stdout.
 *
 * The empty-stdout half is the whole assertion — see the module docblock. Do not
 * weaken it to an exit-code check; that is precisely the assert-nothing this
 * helper exists to prevent.
 *
 * @param {{code?: number|null, status?: number|null, stdout: string}} result
 */
export function expectAllow(result) {
  expect(exitCodeOf(result)).toBe(0);
  expect(result.stdout.trim()).toBe('');
}
