#!/usr/bin/env node
/**
 * pre-bash-issue-budget.mjs — PreToolUse hook: caps how many issues one
 * session may create via `gh|glab issue create|new`.
 *
 * Sibling of pre-bash-templates-first.mjs (#519); both share the PreToolUse
 * Bash matcher and run sequentially. The create-command matcher is IMPORTED
 * from hooks/_lib/vcs-create-matcher.mjs rather than duplicated, so the two
 * hooks can never drift on what counts as an issue-create call.
 *
 * Where templates-first asks "did you read a template?" (a QUALITY gate), this
 * hook asks "how many have you already filed?" (a QUANTITY gate). The existing
 * `discovery-severity-threshold` / `discovery-confidence-threshold` config keys
 * do not answer the second question — they are per-finding filters, their `low`
 * default filters nothing, and the largest producers never read them.
 *
 * Decision flow:
 *   G1 tool filter — only Bash is gated.
 *   G2 command is a non-empty string.
 *   G3 matcher — `gh|glab … issue create|new` only. PR/MR creation passes.
 *      Verb-resolved since #1145, so a wrapped (`nohup`), absolute-path or
 *      env-prefixed create is seen; a `--help` invocation is not (it creates
 *      nothing).
 *   G4 config — `issue-budget` from CLAUDE.md/AGENTS.md. `mode: off` → allow.
 *   G3b bulk — a create inside a shell LOOP body creates an unknowable number
 *      of issues (#1145). `strict` → deny; `warn` → allow with an explicit
 *      undercount notice. See the block comment above formatLoopDenyReason for
 *      why not "charge 1".
 *   G5 exemption — priority::critical / carryover class / broken-window /
 *      the overflow collector itself bypass the cap unconditionally, keeping
 *      the session-end promises at SKILL.md:319 and :1113 intact.
 *   G6 charge the counter in .orchestrator/runtime/issue-budget/<hash>.json
 *      (one file per session since #1141 — see scripts/lib/issue-budget.mjs
 *      `budgetStateRel`).
 *      under cap → allow; over cap + `warn` → allow with stderr notice;
 *      over cap + `strict` → park in `overflow[]`, then deny via emitDeny.
 *
 * Fail-safe posture: any internal exception is swallowed in main().catch and
 * the hook exits 0 (allow). Same rationale as pre-bash-templates-first.mjs —
 * a budget gate that crashes must not wedge a session; the worst case is a
 * missed enforcement.
 *
 * Exit codes:
 *   0  — every path. Pass-through (G1-G5 short-circuits, under cap, warn mode,
 *        error) emits nothing; the strict over-cap path emits the deny envelope
 *        on stdout. Exit 2 is NEVER used: Claude Code discards stdout on exit 2,
 *        which would throw away the deny envelope entirely (#906).
 */

import { readStdin, emitAllow, emitDeny, emitWarn } from '../scripts/lib/io.mjs';
import { resolveProjectDir } from '../scripts/lib/platform.mjs';
import { readJson } from '../scripts/lib/common.mjs';
import { isIssueCreate, isLoopedIssueCreate, extractTitle } from './_lib/vcs-create-matcher.mjs';
import {
  loadIssueBudgetConfig,
  resolveIssueBudgetSessionId,
  chargeIssueBudget,
  classifyExemption,
  formatBlockReason,
} from '../scripts/lib/issue-budget.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';

// Opt-out per session via SO_DISABLED_HOOKS=pre-bash-issue-budget; the
// "minimal"/"off" profiles disable it like every other non-core hook.
if (!shouldRunHook('pre-bash-issue-budget')) process.exit(0);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the accounting session key from the native hook payload. A persisted
 * semantic id can bridge repeated calls only when its recorded raw id exactly
 * matches the native stdin id; it never substitutes for a missing raw id.
 *
 * ENV FALLBACK (#1141). A PreToolUse payload without `session_id` used to
 * resolve to `null`, and an identity-less charge neither reads nor persists —
 * so for that payload shape the cap was silently OFF. The harness also exports
 * `CLAUDE_CODE_SESSION_ID` (measured: it equals the `session.lock` `session_id`
 * and survives into subagents), which is a native id of the same kind as the
 * stdin one, so it is a faithful substitute rather than a guess. Note the
 * NAME: there is no `CLAUDE_SESSION_ID` — reading that spelling is what left
 * the identical fallback in `scripts/lib/spiral-carryover.mjs` dead code.
 *
 * stdin still wins: it is the id of THIS tool call, whereas the env var is the
 * id of the process tree, and the two differ in a nested harness.
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
 * THE CHOICE (#1145) — stated once, so the loop behaviour is explicit rather
 * than emergent.
 *
 * `for t in a b c; do glab issue create --title $t; done` is textually ONE
 * create statement that files THREE issues. Three answers were available and
 * none is obviously right:
 *
 *   charge 1  — the ledger then carries a number it KNOWS is wrong.
 *               `for i in $(seq 1 50)` files 50 issues against a count of 1, so
 *               the cap stays nominally armed while actually uncapped. That is
 *               strictly worse than the pre-#1145 miss, because the pre-fix
 *               state at least did not LOOK accounted.
 *   charge N  — not computable at hook time. The word list can be
 *               `$(cat backlog.txt)`, `"$@"`, or a glob; this hook runs BEFORE
 *               the shell expands any of them.
 *   deny      — CHOSEN. A quantity gate that cannot count the quantity must
 *               refuse, not guess. It is fully recoverable: unrolling the loop
 *               into separate create calls charges each one correctly, and the
 *               deny reason says exactly that. Denying costs one round-trip;
 *               guessing costs the cap its credibility.
 *
 * The choice is mode-scoped, because `mode` is the operator's declared
 * enforcement level and this gate has no standing to exceed it:
 *   strict → deny;  warn → allow + an explicit undercount notice;  off → allow.
 * The exemption classes (priority::critical, carryover, broken-window) are
 * checked FIRST and pass through untouched, so session-end's "those are never
 * deferred" promise survives a looped carryover sweep.
 *
 * NAMED CEILING (BV-004): a loop is detected by `do`/`done` in command position
 * (see `isLoopedIssueCreate`), so an UNROLLED bulk create — 50 create statements
 * chained with `&&` — is not a "loop" and is charged 50, correctly. Revisit this
 * choice if the overflow triage of a per-session counter file
 * (`.orchestrator/runtime/issue-budget/<hash>.json`) shows operators routinely
 * hitting this deny on loops over a KNOWN literal word list; the cheap answer
 * then is to count that list, never to fall back to "charge 1".
 *
 * Deliberately NOT `formatBlockReason`: that text promises "parked as overflow
 * entry #N … nothing is lost", which would be false here — an uncountable bulk
 * request is not parked, it is handed back whole.
 *
 * @param {{ "max-per-session": number }} config
 * @returns {string}
 */
function formatLoopDenyReason(config) {
  return [
    'issue-budget: this command creates an UNKNOWN number of issues — refusing to guess.',
    'The `issue create` call sits inside a shell loop body (`do … done`), so the cap cannot',
    'charge it honestly: the word list is expanded by the shell AFTER this hook runs, so',
    '`for i in $(seq 1 50)` would file 50 issues against a count of 1.',
    '',
    'Nothing was parked as overflow, because nothing is lost: re-issue the create calls as',
    'SEPARATE commands and each one is counted normally against the cap',
    `(${config['max-per-session']} per session).`,
    '',
    'Exempt from the cap even inside a loop: priority::critical, the carryover class',
    '(SPIRAL/FAILED, [Carryover]), and broken-window closure issues.',
    'To change the enforcement level, edit `issue-budget.mode` in the Session Config:',
    '`warn` reports without blocking, `off` disables the gate.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();
  if (!input) return emitAllow();

  // G1 — only Bash is gated.
  if (input.tool_name !== 'Bash') return emitAllow();

  // G2 — command must be a non-empty string.
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) return emitAllow();

  // G3 — shared matcher. Only ISSUE creation is capped; `pr`/`mr` create pass.
  if (!isIssueCreate(command)) return emitAllow();

  const projectDir = resolveProjectDir() || process.cwd();

  // G4 — config.
  const config = loadIssueBudgetConfig(projectDir);
  if (config.mode === 'off') return emitAllow();

  // G3b — bulk creation whose multiplicity is not computable (#1145). The
  // exemption is asked FIRST, through the same classifier chargeIssueBudget
  // uses, so a looped carryover sweep keeps its unconditional pass.
  const uncountableBulk =
    isLoopedIssueCreate(command) && !classifyExemption(command).exempt;
  if (uncountableBulk && config.mode === 'strict') {
    // Nothing is charged and nothing is parked — the command is handed back
    // whole, which is what makes unrolling it the correct next action.
    return emitDeny(formatLoopDenyReason(config));
  }

  const sessionId = await resolveSessionId(input, projectDir);

  // G5 + G6 — exemption check and counter charge live in the shared core so
  // the programmatic path (scripts/lib/spiral-carryover.mjs runCli) decides
  // identically.
  const verdict = chargeIssueBudget({
    repoRoot: projectDir,
    sessionId,
    command,
    title: extractTitle(command),
    config,
  });

  if (verdict.decision === 'exempt') {
    process.stderr.write(
      `ℹ pre-bash-issue-budget: exempt (${verdict.reason}) — cap not charged ` +
        `(${verdict.count}/${verdict.max})\n`,
    );
    return emitAllow();
  }

  if (verdict.decision === 'warn') {
    process.stderr.write(
      `⚠ pre-bash-issue-budget: session cap exceeded — ${verdict.count}/${verdict.max} ` +
        `issues created (mode: warn — allowing). Set \`issue-budget.mode: strict\` to enforce.\n`,
    );
    return emitAllow();
  }

  if (verdict.decision === 'block') {
    // Single channel (#906). formatBlockReason's multi-line text — overflow
    // store path, the [Backlog-Sammel] fold-in promise, the exemption list and
    // the cap-raising hint — used to go to stderr AND to a duplicated `exit 2`
    // stdout envelope, the mixed form the hook docs forbid. None of that
    // guidance is lost: it now rides in permissionDecisionReason, which is fed
    // to Claude (the actor that must re-file or defer the issue), while the
    // operator gets the first line as the systemMessage headline. Under exit 0
    // a stderr write would only reach the debug log — dead, but alive-looking.
    emitDeny(formatBlockReason(verdict));
  }

  // A PERMITTED bulk create is charged ONCE, which is an undercount by
  // construction. `mode: warn` means "report, do not block", so the report has
  // to name the undercount out loud — a silent 1-for-N is the exact failure the
  // deny above exists to prevent, and `warn` must not reintroduce it quietly.
  // emitWarn, not stderr: under exit 0 stderr reaches only the debug log (#916).
  if (uncountableBulk && verdict.decision === 'allow') {
    return emitWarn(
      `pre-bash-issue-budget: bulk create inside a loop body charged as 1 ` +
        `(${verdict.count}/${verdict.max}) — the real number of issues this files is not ` +
        `knowable before the shell expands the word list, so the count is an UNDERCOUNT. ` +
        `Set \`issue-budget.mode: strict\` to deny this shape instead.`,
    );
  }

  // 'allow' / 'off'
  return emitAllow();
}

// Top-level error handler — fail open, same posture as the sibling hooks.
main().catch((e) => {
  process.stderr.write(
    `⚠ pre-bash-issue-budget: internal error — ${e?.message || e}\n`,
  );
  process.exit(0);
});
