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
 *   G4 config — `issue-budget` from CLAUDE.md/AGENTS.md. `mode: off` → allow.
 *   G5 exemption — priority::critical / carryover class / broken-window /
 *      the overflow collector itself bypass the cap unconditionally, keeping
 *      the session-end promises at SKILL.md:319 and :1113 intact.
 *   G6 charge the counter in .orchestrator/runtime/issue-budget.json.
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

import { readStdin, emitAllow, emitDeny } from '../scripts/lib/io.mjs';
import { resolveProjectDir } from '../scripts/lib/platform.mjs';
import { readJson } from '../scripts/lib/common.mjs';
import { isIssueCreate, extractTitle } from './_lib/vcs-create-matcher.mjs';
import {
  loadIssueBudgetConfig,
  chargeIssueBudget,
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
 * Pull the session_id from the hook stdin payload, with a single fallback to
 * the persisted file written by on-session-start.mjs. Mirrors the resolution
 * in pre-bash-templates-first.mjs. Returns null when neither source yields a
 * string — the counter then degrades to a per-repo counter, which still caps.
 *
 * @param {object|null} input
 * @param {string|null} projectDir
 * @returns {Promise<string|null>}
 */
async function resolveSessionId(input, projectDir) {
  const fromStdin = input?.session_id ?? input?.sessionId ?? null;
  if (typeof fromStdin === 'string' && fromStdin.length > 0) return fromStdin;

  if (!projectDir) return null;
  const persisted = path.join(projectDir, '.orchestrator', 'current-session.json');
  if (!existsSync(persisted)) return null;
  try {
    const data = await readJson(persisted);
    if (data && typeof data === 'object') {
      const sid = data.session_id ?? data.sessionId ?? null;
      if (typeof sid === 'string' && sid.length > 0) return sid;
    }
  } catch {
    // ignore — null below
  }
  return null;
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
