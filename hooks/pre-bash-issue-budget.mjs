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
 *   G3 matcher — `gh|glab … issue create|new` plus the REST route
 *      (`gh|glab api … /issues`, #1163) only. PR/MR creation passes.
 *      Verb-resolved since #1145, so a wrapped (`nohup`), absolute-path or
 *      env-prefixed create is seen; a `--help` invocation is not (it creates
 *      nothing). Since #1163 the matcher returns EVERY create statement of the
 *      chain, and the cap charges ONE unit per statement.
 *   G4 config — `issue-budget` from CLAUDE.md/AGENTS.md. `mode: off` → allow.
 *   G3b bulk — a create inside a shell LOOP body creates an unknowable number
 *      of issues (#1145). `strict` → deny; `warn` → allow with an explicit
 *      undercount notice. See the block comment above formatLoopDenyReason for
 *      why not "charge 1".
 *   G5 exemption — priority::critical / carryover class / broken-window /
 *      the overflow collector itself bypass the cap unconditionally, keeping
 *      the session-end promises at SKILL.md:319 and :1113 intact.
 *   G6 charge the counter ONCE PER ISSUE-CREATE STATEMENT in
 *      .orchestrator/runtime/issue-budget/<hash>.json
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
import { findIssueCreateStatements, findLoopedIssueCreates } from './_lib/vcs-create-matcher.mjs';
import {
  loadIssueBudgetConfig,
  resolveIssueBudgetSessionId,
  chargeIssueBudget,
  classifyExemption,
  formatBlockReason,
  readBudgetState,
  writeBudgetState,
  budgetStatePath,
  buildOverflowRecord,
} from '../scripts/lib/issue-budget.mjs';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';
import { existsSync } from 'node:fs';
import path from 'node:path';

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
 * The harness's id for THIS tool call, when it publishes one — the first half of
 * a charge record's identity (see `chargeIssueBudget`). Several spellings are
 * accepted because the payload key is the harness's to choose, and a missed id
 * silently degrades to the deterministic command key rather than failing.
 *
 * Kept byte-identical in shape to the refund hook's copy: the two must resolve
 * the same id from the same payload or the refund cannot find the charge.
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
 * chained with `&&` — is not a "loop". Since #1163 it is charged 50, once per
 * issue-create STATEMENT: until then this comment CLAIMED that behaviour while
 * the code called `chargeIssueBudget` exactly once per Bash tool call with the
 * whole command string, so `glab issue create --title A && glab issue create
 * --title B` charged 1 for 2 (measured 2026-09-09). The claim is now true
 * because `findIssueCreateStatements` supplies the per-statement units and the
 * exemption is classified per statement too. Revisit this
 * choice if the overflow triage of a per-session counter file
 * (`.orchestrator/runtime/issue-budget/<hash>.json`) shows operators routinely
 * hitting this deny on loops over a KNOWN literal word list; the cheap answer
 * then is to count that list, never to fall back to "charge 1".
 *
 * Deliberately NOT `formatBlockReason`: that text promises "parked as overflow
 * entry #N … nothing is lost", which would be false here — an uncountable bulk
 * request is not parked, it is handed back whole.
 *
 * ## Why the lane is a parameter (#1379)
 *
 * Until 2026-09-17 this text said "sits inside a shell loop body (`do … done`)"
 * on BOTH lanes, so the `xargs` deny (`echo b | xargs -I% glab issue create
 * --title junk%` — no loop anywhere) sent the operator looking for a loop the
 * command does not have. Only the lane SENTENCE varies; every other line is
 * byte-identical across lanes, and tests pin them.
 *
 * @param {{ "max-per-session": number }} config
 * @param {{ lane?: "loop"|"xargs"|"mixed" }} [opts]
 * @returns {string}
 */
function formatLoopDenyReason(config, { lane = 'loop' } = {}) {
  const LANE_SENTENCES = {
    loop: [
      'The `issue create` call sits inside a shell loop body (`do … done`), so the cap cannot',
      'charge it honestly: the word list is expanded by the shell AFTER this hook runs, so',
      '`for i in $(seq 1 50)` would file 50 issues against a count of 1.',
    ],
    xargs: [
      'The `issue create` call is driven by `xargs`, so the cap cannot charge it honestly: the',
      'word list arrives on stdin AFTER this hook runs, so `seq 1 50 | xargs` would file 50',
      'issues against a count of 1.',
    ],
    mixed: [
      'The `issue create` calls are driven by a shell loop body (`do … done`) AND by `xargs`,',
      'so the cap cannot charge them honestly: both word lists are produced AFTER this hook',
      'runs, so `seq 1 50 | xargs` would file 50 issues against a count of 1.',
    ],
  };
  return [
    'issue-budget: this command creates an UNKNOWN number of issues — refusing to guess.',
    ...(LANE_SENTENCES[lane] ?? LANE_SENTENCES.loop),
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

/**
 * Park every chargeable statement of a command that does NOT fit under the cap,
 * and return a `formatBlockReason`-shaped verdict for the deny envelope.
 *
 * ## Why this is not `chargeIssueBudget`
 *
 * `chargeIssueBudget` decides ONE creation against the current count, and its
 * strict branch parks only when the count is ALREADY at the cap. A chain of
 * statements that straddles the cap (count 11, max 12, three creates) has no
 * single call shape in that API: the first statement would be ALLOWED and
 * counted, and the deny that follows would leave that count standing for an
 * issue nobody created. So the fit is judged for the chain as a whole and the
 * whole chain is parked — count and exempt untouched, because nothing ran.
 *
 * The exemption CLASSIFICATION still comes from the shared core
 * (`classifyExemption`, applied by the caller); what is local here is only the
 * bookkeeping write, through the module's own public `writeBudgetState`.
 *
 * An identity-less invocation (no session key) must not write at all — the
 * legacy flat path is shared across sessions and writing it would reset a live
 * session's count and drop its parked overflow. Same rule `chargeIssueBudget`'s
 * `persist` applies; the deny still happens, only unrecorded.
 *
 * @param {{ projectDir: string, sessionId: string|null,
 *           state: { count: number, exempt: number, overflow: object[], sessionId: string|null },
 *           chargeable: Array<{ text: string, title: string|null, description: string|null,
 *                               descriptionFile: string|null, repo: string|null,
 *                               cwdChanged: boolean }>,
 *           cwd?: string|null,
 *           config: { "max-per-session": number, mode: string, overflow: string },
 *           now?: string }} opts
 * @returns {{ count: number, max: number, overflowPath: string,
 *             overflowSink: string, overflowCount: number }}
 */
function parkOverflow({
  projectDir,
  sessionId,
  state,
  chargeable,
  config,
  cwd = null,
  now = new Date().toISOString(),
}) {
  state.sessionId = sessionId;
  for (const s of chargeable) {
    state.overflow.push(buildOverflowRecord({
      repoRoot: projectDir,
      title: s.title,
      description: s.description,
      descriptionFile: s.descriptionFile,
      repo: s.repo,
      cwd,
      cwdChanged: s.cwdChanged,
      command: s.text,
      at: now,
    }));
  }
  if (sessionId !== null) writeBudgetState(projectDir, state);
  return {
    count: state.count,
    max: config['max-per-session'],
    overflowPath: budgetStatePath(projectDir, sessionId),
    overflowSink: config.overflow,
    overflowCount: state.overflow.length,
  };
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

  // G3 — shared matcher, PER STATEMENT (#1163). Only ISSUE creation is capped;
  // `pr`/`mr` create pass. An empty list is the old `!isIssueCreate(command)`
  // short-circuit, unchanged.
  const statements = findIssueCreateStatements(command);
  if (statements.length === 0) return emitAllow();

  const projectDir = resolveProjectDir() || process.cwd();

  // G4 — config.
  const config = loadIssueBudgetConfig(projectDir);
  if (config.mode === 'off') return emitAllow();

  // G3b — bulk creation whose multiplicity is not computable (#1145). Two
  // sources, one policy: a LOOP BODY (#1145) and an `xargs`-driven create
  // (#1289), where the word list arrives on stdin. Both file N issues for one
  // statement, so both are denied rather than charged 1 — the fix had to land
  // here and not only in `isLoopedIssueCreate`, because G3 above short-circuits
  // on `statements.length === 0` and an xargs create used to produce zero
  // statements, so no loop-side fix could ever run.
  //
  // THE INVARIANT (rewritten 2026-09-16): the exemption is classified on the
  // statement that CAUSED the bulk classification — never on `statements[0]`,
  // and never on the whole command. A `[Carryover]` create standing NEXT TO an
  // uncountable one is an unrelated neighbour and must not lift the deny; a
  // `[Carryover]` create that IS the bulk statement keeps its documented
  // unconditional pass (session-end's "those are never deferred" promise, which
  // holds inside a loop too). Measured 2026-09-16 against the previous
  // `statements[0]` binding, both lanes ALLOW where they must DENY:
  //   glab issue create --title "[Carryover] real"; echo X | xargs -I% glab issue create --title %
  //   glab issue create --title "[Carryover] real"; for i in 1 2 3; do glab issue create --title junk$i; done
  // Same class as the bypass-scoping regression on `matchesBypass` — a matcher
  // widened per statement while its exemption stayed whole-command
  // (`.claude/rules/guard-design.md` § "Widening a matcher without narrowing
  // its bypass", #1106).
  //
  // Fail-CLOSED when a command carries SEVERAL bulk statements and only some are
  // exempt: `some()` over the non-exempt ones denies, because the command as a
  // whole still files an uncountable number of untemplated issues.
  //
  // EVERY loop, not the first (#1379): the loop lane used to contribute at most
  // ONE entry here, so an exempt FIRST loop was the only loop classified and
  // every later loop went unjudged. Reproduced 2026-09-17 @ `9e8146b4`:
  //   for i in 1 2 3; do glab issue create --label carryover --title x$i; done;
  //   for j in 1 2 3; do glab issue create --title junk$j; done  → ALLOW (count=1)
  const bulkEntries = [
    ...findLoopedIssueCreates(command).map((tokens) => ({
      lane: 'loop',
      text: tokens.map((t) => t.text).join(' '),
    })),
    ...statements.filter((s) => s.bulk).map((s) => ({ lane: 'xargs', text: s.text })),
  ];
  const uncountableEntries = bulkEntries.filter((e) => !classifyExemption(e.text).exempt);
  const uncountableBulk = uncountableEntries.length > 0;
  // ONE lane resolution for BOTH reports (#1379 follow-up). The deny already
  // named the lane it fired on; the `warn` undercount notice at the bottom of
  // main() said "inside a loop body" unconditionally, so the xargs lane — where
  // no loop exists anywhere in the command — sent the operator looking for one.
  // Resolved here rather than twice, so the two reports can never disagree.
  const uncountableLanes = new Set(uncountableEntries.map((e) => e.lane));
  const uncountableLane =
    uncountableLanes.size > 1 ? 'mixed' : ([...uncountableLanes][0] ?? 'loop');
  if (uncountableBulk && config.mode === 'strict') {
    // Nothing is charged and nothing is parked — the command is handed back
    // whole, which is what makes unrolling it the correct next action.
    return emitDeny(formatLoopDenyReason(config, { lane: uncountableLane }));
  }

  const sessionId = await resolveSessionId(input, projectDir);

  // G5 pre-flight — a Bash call is ATOMIC from this hook's point of view: a
  // deny refuses the WHOLE command, so not one of its statements runs. Charging
  // statement-by-statement until one blocks would therefore count creations
  // that never happened (and double-count them when the operator re-issues the
  // command unrolled). So the fit is decided BEFORE any charge, and a command
  // that does not fit parks every chargeable statement without counting any.
  const chargeable = statements.filter((s) => !classifyExemption(s.text).exempt);
  if (config.mode === 'strict' && chargeable.length > 0) {
    const state = readBudgetState(projectDir, sessionId);
    if (state.count + chargeable.length > config['max-per-session']) {
      return emitDeny(formatBlockReason(parkOverflow({
        projectDir, sessionId, state, chargeable, config, cwd: input.cwd,
      })));
    }
  }

  // G6 — charge ONE unit per issue-create STATEMENT. The decision itself stays
  // in the shared core (scripts/lib/issue-budget.mjs), so the programmatic path
  // (scripts/lib/spiral-carryover.mjs runCli) decides identically; what changed
  // in #1163 is only HOW MANY times it is asked. Each statement is judged on
  // its OWN text: `glab issue create --title REAL && glab issue create
  // --label carryover --title X` is 1 charge + 1 exemption, never 2 exemptions.
  // `toolCallId` + the statement index are the CHARGE RECORD's identity (#1347):
  // the refund hook may only give back a slot it can find in `charged[]`, so the
  // charge has to be recorded under the same pair the PostToolUseFailure payload
  // for this very call will present. Absent an id, the deterministic
  // session+command+index key carries it.
  const toolCallId = resolveToolCallId(input);
  const verdicts = statements.map((s, i) =>
    chargeIssueBudget({
      repoRoot: projectDir,
      sessionId,
      command: s.text,
      title: s.title,
      description: s.description,
      descriptionFile: s.descriptionFile,
      repo: s.repo,
      cwd: input.cwd,
      cwdChanged: s.cwdChanged,
      toolCallId,
      statementIndex: i,
      config,
    }),
  );
  const verdict = verdicts[verdicts.length - 1];
  const exemptions = verdicts.filter((v) => v.decision === 'exempt');
  const blocked = verdicts.find((v) => v.decision === 'block');

  if (exemptions.length > 0) {
    const reasons = [...new Set(exemptions.map((v) => v.reason))].join(', ');
    process.stderr.write(
      `ℹ pre-bash-issue-budget: ${exemptions.length} exempt statement(s) (${reasons}) — ` +
        `cap not charged (${verdict.count}/${verdict.max})\n`,
    );
  }

  if (verdicts.some((v) => v.decision === 'warn')) {
    process.stderr.write(
      `⚠ pre-bash-issue-budget: session cap exceeded — ${verdict.count}/${verdict.max} ` +
        `issues created (mode: warn — allowing). Set \`issue-budget.mode: strict\` to enforce.\n`,
    );
    return emitAllow();
  }

  if (exemptions.length === statements.length) return emitAllow();

  if (blocked) {
    // Single channel (#906). formatBlockReason's multi-line text — overflow
    // store path, the [Backlog-Sammel] fold-in promise, the exemption list and
    // the cap-raising hint — used to go to stderr AND to a duplicated `exit 2`
    // stdout envelope, the mixed form the hook docs forbid. None of that
    // guidance is lost: it now rides in permissionDecisionReason, which is fed
    // to Claude (the actor that must re-file or defer the issue), while the
    // operator gets the first line as the systemMessage headline. Under exit 0
    // a stderr write would only reach the debug log — dead, but alive-looking.
    return emitDeny(formatBlockReason(blocked));
  }

  // A PERMITTED bulk create is charged ONCE, which is an undercount by
  // construction. `mode: warn` means "report, do not block", so the report has
  // to name the undercount out loud — a silent 1-for-N is the exact failure the
  // deny above exists to prevent, and `warn` must not reintroduce it quietly.
  // emitWarn, not stderr: under exit 0 stderr reaches only the debug log (#916).
  //
  // GATED ON THE BULK STATEMENTS, NEVER ON THE LAST VERDICT (2026-09-17). The
  // condition used to read `verdict.decision === 'allow'`, i.e. the verdict of
  // the LAST statement of the chain — so one exempt statement written AFTER an
  // uncountable one silenced the notice the two paragraphs above declare
  // mandatory. Reproduced through this hook binary in `mode: warn`:
  //   for i in 1 2; do glab issue create --title j$i; done; \
  //     glab issue create --title "[Carryover] z"
  //   → stdout EMPTY, ledger count=1 exempt=1 (the trailing exempt statement is
  //     an unrelated neighbour, exactly as in G3b's own invariant); without it,
  //     the identical loop reported the UNDERCOUNT.
  // Reaching this point already means no statement blocked and none warned
  // (both branches above return), so the uncountable bulk statement — non-exempt
  // by construction of `uncountableEntries` — was charged as 1. The two negated
  // conditions are kept explicit so a future reordering of those branches cannot
  // turn this back into a report about the wrong statement.
  if (uncountableBulk && !blocked && !verdicts.some((v) => v.decision === 'warn')) {
    const LANE_PHRASES = {
      loop: 'inside a loop body',
      xargs: 'driven by `xargs`',
      mixed: 'inside a loop body and by `xargs`',
    };
    return emitWarn(
      `pre-bash-issue-budget: bulk create ${LANE_PHRASES[uncountableLane]} charged as 1 ` +
        `(${verdict.count}/${verdict.max}) — the real number of issues this files is not ` +
        `knowable before the word list is expanded, so the count is an UNDERCOUNT. ` +
        `Set \`issue-budget.mode: strict\` to deny this shape instead.`,
    );
  }

  // 'allow' / 'off'
  return emitAllow();
}

// Entry guard (#1393): run only as the node script the harness execs — a bare
// `import()` must run no handler and must not exit the importing process.
if (isMainModule(import.meta.url)) {
  // Opt-out per session via SO_DISABLED_HOOKS=pre-bash-issue-budget; the
  // "minimal"/"off" profiles disable it like every other non-core hook.
  if (!shouldRunHook('pre-bash-issue-budget')) process.exit(0);

  // Top-level error handler — fail open, same posture as the sibling hooks.
  main().catch((e) => {
    process.stderr.write(
      `⚠ pre-bash-issue-budget: internal error — ${e?.message || e}\n`,
    );
    process.exit(0);
  });
}
