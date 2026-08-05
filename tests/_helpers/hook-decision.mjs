/**
 * tests/_helpers/hook-decision.mjs
 *
 * The single assertion contract for a PreToolUse hook's allow/deny/warn decision.
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
 *
 * ## Helpers exported here
 *
 *   - `expectDeny` / `expectAllow` / `expectWarn` — the three decision classes.
 *     `expectDeny` and `expectWarn` take their contains-needle as either a single
 *     substring (the original form, unchanged) or an ARRAY of substrings that must
 *     ALL be present, and both accept a trailing `{ systemMessage }` option that
 *     pins the operator-visible headline by EQUALITY. Both additions exist so a
 *     caller never has to hand-roll a second assertion beside the contract — the
 *     hand-rolled ones are what drift when the protocol changes.
 *   - `expectGuardInactive` — the #992/#993 module-load-failure contract: a
 *     deny-capable hook whose repo dependency failed to load must FAIL OPEN
 *     VISIBLY (exit 0 + empty decision channel, so a broken module cannot brick
 *     the session, PLUS a `GUARD INACTIVE` banner on stderr). This is the shared
 *     assertion for all four late-binding hooks (destructive-guard,
 *     enforce-scope, enforce-commands, sessions-ledger-guard) — A2/A3 import it
 *     from here rather than re-hand-rolling the two-part check. It pins the
 *     hook-AGNOSTIC contract (fail-open + the marker); pass `{ hookName }` to
 *     additionally assert the hook-specific banner prefix and prove #993's
 *     no-hard-wired-literal property.
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
 * Assert that `actual` contains EVERY needle in `expected`.
 *
 * A deny reason routinely has to name BOTH the rule that fired AND the target it
 * fired on; before the array form, a caller could only pin one of the two here
 * and had to hand-roll the second assertion outside the contract (the B4 finding
 * class this closes). A bare string keeps its exact old meaning — it is simply a
 * one-element array.
 *
 * An explicitly-passed EMPTY array is rejected rather than treated as "no
 * needles": a dynamically-built `[]` would make the whole check vacuous, which is
 * the assert-nothing failure mode this module exists to prevent. `undefined`
 * still means "caller did not pin the text at all" and asserts nothing.
 *
 * @param {string} actual
 * @param {string|string[]|undefined} expected
 */
function expectContainsAll(actual, expected) {
  if (expected === undefined) return;
  const needles = Array.isArray(expected) ? expected : [expected];
  expect(needles.length).toBeGreaterThan(0);
  for (const needle of needles) {
    expect(actual).toContain(needle);
  }
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
 * The reason needle may be a single substring or an ARRAY of substrings, in which
 * case EVERY element must be contained — deny reasons usually have to name both
 * the rule id and the target, and pinning only one of the two forced callers to
 * hand-roll a second assertion outside this contract. Pass `{ systemMessage }` to
 * additionally pin the operator-visible headline EXACTLY (the base `⛔` prefix
 * check above still runs; the exact pin is strictly narrower, never a relaxation).
 *
 * All four call shapes below are equivalent-or-narrower supersets of each other,
 * and the two legacy ones behave exactly as they always did:
 *
 *   expectDeny(res, 'PSA-003')                                  // legacy: one needle
 *   expectDeny(res, { reasonContains: 'PSA-003' })              // legacy: object form
 *   expectDeny(res, ['PSA-003', 'git reset'])                   // every needle must hit
 *   expectDeny(res, ['PSA-003'], { systemMessage: '⛔ Blocked' }) // + exact headline
 *   expectDeny(res, { reasonContains: ['PSA-003'], systemMessage: '⛔ Blocked' })
 *
 * @param {{code?: number|null, status?: number|null, stdout: string}} result
 * @param {string|string[]|{reasonContains?: string|string[], systemMessage?: string}} [expectedReason] -
 *   substring(s) the `permissionDecisionReason` must ALL contain; either bare
 *   (string or array) or as `{reasonContains}`. The object form may also carry
 *   `systemMessage`, identically to the `opts` argument.
 * @param {{systemMessage?: string}} [opts] - when `systemMessage` is given, the
 *   envelope's `systemMessage` must EQUAL it exactly. Takes precedence over a
 *   `systemMessage` supplied via the object form of `expectedReason`.
 * @returns {{hookSpecificOutput: {hookEventName: string, permissionDecision: string, permissionDecisionReason: string}, systemMessage: string}}
 */
export function expectDeny(result, expectedReason, opts = {}) {
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

  const isOptionBag =
    expectedReason !== null &&
    typeof expectedReason === 'object' &&
    !Array.isArray(expectedReason);
  const needles = isOptionBag ? expectedReason.reasonContains : expectedReason;
  expectContainsAll(obj.hookSpecificOutput.permissionDecisionReason, needles);

  const systemMessage =
    opts.systemMessage ?? (isOptionBag ? expectedReason.systemMessage : undefined);
  if (systemMessage !== undefined) {
    expect(obj.systemMessage).toBe(systemMessage);
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

/**
 * Assert a PreToolUse hook emitted a WARN notice (allow-WITH-notice), and return
 * the parsed envelope.
 *
 * `emitWarn` (#916) is a THIRD decision class beside allow and deny: the warn
 * path's decision is still "allow", but — unlike a silent allow — it carries an
 * operator-visible notice on the top-level `systemMessage` field, because stderr
 * is not surfaced under exit 0. The contract is:
 *
 *   - exit 0 (a warn is an allow — never 2)
 *   - stdout carries exactly ONE non-blank line
 *   - top-level keys are EXACTLY `['systemMessage']` — the exclusivity guard.
 *     A regression that routed warn through `emitDeny` would add
 *     `hookSpecificOutput`/`permissionDecision`, and the harness would read the
 *     notice as a BLOCK. Asserting the full key-set (not just presence) is what
 *     makes that regression fail here instead of passing silently.
 *
 * Needle handling is symmetric with `expectDeny`: a bare string behaves exactly as
 * before, an ARRAY requires every element to be contained, and `{ systemMessage }`
 * pins the notice EXACTLY instead of by substring.
 *
 * @param {{code?: number|null, status?: number|null, stdout: string}} result
 * @param {string|string[]} [text] - substring(s) the `systemMessage` must ALL contain.
 * @param {{systemMessage?: string}} [opts] - when `systemMessage` is given, the
 *   envelope's `systemMessage` must EQUAL it exactly.
 * @returns {{systemMessage: string}}
 */
export function expectWarn(result, text, opts = {}) {
  expect(exitCodeOf(result)).toBe(0);

  const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
  expect(lines).toHaveLength(1);

  const obj = JSON.parse(lines[0]);
  expect(Object.keys(obj)).toEqual(['systemMessage']);
  expect(typeof obj.systemMessage).toBe('string');

  expectContainsAll(obj.systemMessage, text);

  if (opts.systemMessage !== undefined) {
    expect(obj.systemMessage).toBe(opts.systemMessage);
  }

  return obj;
}

/**
 * Assert a deny-capable hook FAILED OPEN VISIBLY on a module-load failure
 * (#992/#993): exit 0 with an EMPTY decision channel (a broken repo dependency
 * must not brick the session — so the guard allows) AND a `GUARD INACTIVE` banner
 * on stderr (so the outage is never silent, which is the whole #992 repair).
 *
 * The banner's prefix and consequence prose are hook-specific; this helper pins
 * only the hook-AGNOSTIC contract. Pass `{ hookName }` to also assert the
 * hook-specific prefix — `<hookName>: GUARD INACTIVE` — which is the #993
 * non-regression proof that the loader emits the CALLER's name, not a hard-wired
 * `pre-bash-destructive-guard` literal.
 *
 * @param {{code?: number|null, status?: number|null, stdout: string, stderr: string}} result
 * @param {{hookName?: string}} [opts]
 */
export function expectGuardInactive(result, { hookName } = {}) {
  // Fail-OPEN: the decision channel stays empty (allow), never a deny envelope —
  // reuses expectAllow's empty-stdout half so a regression that started emitting
  // a decision here fails loudly.
  expectAllow(result);
  expect(result.stderr).toContain('GUARD INACTIVE');
  if (hookName !== undefined) {
    expect(result.stderr).toContain(`${hookName}: GUARD INACTIVE`);
  }
}
