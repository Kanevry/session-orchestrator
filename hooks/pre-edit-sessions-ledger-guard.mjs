#!/usr/bin/env node
/**
 * pre-edit-sessions-ledger-guard.mjs — PreToolUse `Edit|Write|MultiEdit` hook:
 * denies a TOOL write into the sessions ledger
 * (`.orchestrator/metrics/sessions.jsonl`, plus rotated `sessions.jsonl.<N>`).
 *
 * The sibling `pre-bash-sessions-ledger-guard.mjs` covers shell writes only; the
 * Edit/Write/MultiEdit tools were a second, unguarded route to the same file
 * (GitLab #1443 item 4). Editing the ledger in place skips the validating writer
 * (`scripts/emit-session.mjs`) and can silently rewrite records that are already
 * there — the ledger is append-only by contract.
 *
 * ## Fleet safety — allow is the default, deny is the exception
 *
 * This hook runs on EVERY Edit/Write/MultiEdit in every session on the host, so
 * it denies exactly one thing and allows everything else, including every
 * internal failure: empty or unparsable stdin, a missing `tool_input`, an
 * unknown `tool_name`, an absent `file_path`, or a repo module that fails to
 * load all exit 0 with no decision (the harness proceeds). Only a positively
 * identified ledger path is denied.
 *
 * ## Path scope — narrower than the Bash guard, on purpose
 *
 * The Bash guard matches on BASENAME (`sessions.jsonl` in any directory), because
 * a shell `cd .orchestrator/metrics && echo … >> sessions.jsonl` leaves only the
 * basename to see. The Edit/Write tools always carry the full target path, so
 * here the path must END in `.orchestrator/metrics/sessions.jsonl` (optionally
 * `.<digits>` for a rotated archive). Tmp-dir fixtures outside a
 * `.orchestrator/metrics/` directory, `sessions.jsonl.bak`, `learnings.jsonl` and
 * `events.jsonl` all allow. The comparison is case-insensitive because the
 * default macOS filesystem is: `Sessions.JSONL` there IS the ledger.
 *
 * Not covered (by design — a guard against the accident, not a containment
 * boundary): a symlink that points at the ledger under another name, and the
 * `NotebookEdit` tool (not in the matcher; it cannot target a `.jsonl` file
 * meaningfully).
 *
 * Named limits (measured 2026-09-25, security review of #1443):
 *
 * - The TRACKED fixture `tests/fixtures/harness-audit/clean-repo/.orchestrator/
 *   metrics/sessions.jsonl` matches the suffix and is DENIED (the Bash guard
 *   denies it too, by basename). No `tests/fixtures/` exemption on purpose: a
 *   path-prefix carve-out is a second hole, not a narrower guard. Editing that
 *   fixture is intentional maintenance — run with
 *   `SO_DISABLED_HOOKS=pre-edit-sessions-ledger-guard`.
 * - A payload over 1 MB fails OPEN: `readStdin` (`scripts/lib/io.mjs`) rejects
 *   past 1,048,576 bytes and the catch below allows. A whole-ledger `Write`
 *   carries the file as `content`, so it bypasses the guard once the ledger
 *   nears that size. Largest ledger on the reference host: 481,543 bytes
 *   (`wc -c` over all 31 `.orchestrator/metrics/sessions.jsonl` under the
 *   projects root). Revisit when any ledger passes ~900 KB.
 * - The case-insensitive match can DENY a distinct file on a case-sensitive
 *   filesystem (Linux): `.Orchestrator/METRICS/Sessions.JSONL` is not the
 *   ledger there, but is refused. Fails closed; same override as above.
 *
 * ## Platforms
 *
 * Cursor and Pi reach this hook through their bridges
 * (`scripts/lib/cursor-hook-bridge.mjs`, `scripts/lib/pi-hook-bridge.mjs`), which
 * rewrite native tool names to `Edit`/`Write`/`MultiEdit` and populate
 * `tool_input.file_path`. Codex is a documented gap in
 * `scripts/lib/validate/check-hooks-symmetry.mjs` (no Claude tool-name vocabulary).
 *
 * ## Override
 *
 *   SO_DISABLED_HOOKS=pre-edit-sessions-ledger-guard   (session-level)
 *   SO_HOOK_PROFILE=minimal|off
 */

import path from 'node:path';

import { shouldRunHook } from './_lib/profile-gate.mjs';
import { isMainModule } from '../scripts/lib/is-main-module.mjs';

/** This hook's name — the `SO_DISABLED_HOOKS` key. */
const HOOK_NAME = 'pre-edit-sessions-ledger-guard';

/** The tools this hook judges. Anything else allows. */
const GUARDED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/**
 * The ledger, or a rotated archive of it, at the END of a normalized path.
 * Anchored on a separator (or the start) so `x.orchestrator/metrics/…` does not match.
 */
const LEDGER_PATH_RE = /(?:^|\/)\.orchestrator\/metrics\/sessions\.jsonl(?:\.\d+)?$/i;

/**
 * Upper bound on the echoed target in the deny reason. `emitDeny` clamps the
 * whole reason, so an unbounded path on line 1 would push the writer/reader
 * instructions off the end (same reasoning as the Bash guard's TARGET_ECHO_MAX).
 */
const TARGET_ECHO_MAX = 200;

/**
 * Does this `file_path` name the sessions ledger (or a rotated archive)?
 *
 * Backslashes are normalized first so a Windows-spelled path is not read as one
 * long filename (mirrors the Bash guard's `refersToLedger`), then
 * `path.posix.normalize` folds `..` and `//` so `metrics/../metrics/sessions.jsonl`
 * cannot sidestep the suffix match.
 *
 * @param {unknown} filePath
 * @returns {boolean}
 */
export function isLedgerPath(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const normalized = path.posix.normalize(filePath.replace(/\\/g, '/'));
  return LEDGER_PATH_RE.test(normalized);
}

/**
 * Read the payload and decide. Every non-ledger outcome returns without output
 * (exit 0 = no decision = allow).
 *
 * @returns {Promise<void>}
 */
async function main() {
  // Late-bound so a broken io.mjs lands in the fail-open catch below instead of
  // an ESM link-time crash, and so the stdin reader is the repo's shared one.
  const { readStdin, emitDeny } = await import('../scripts/lib/io.mjs');

  let input;
  try {
    input = await readStdin();
  } catch {
    return; // unparsable / oversized / timed-out stdin → allow
  }
  if (!input || typeof input !== 'object') return;
  if (!GUARDED_TOOLS.has(input.tool_name)) return;

  const filePath = input.tool_input?.file_path;
  if (!isLedgerPath(filePath)) return;

  const shown = filePath.length > TARGET_ECHO_MAX ? `${filePath.slice(0, TARGET_ECHO_MAX)}…` : filePath;
  emitDeny(
    [
      `${input.tool_name} on the sessions ledger blocked: '${shown}'`,
      `The ledger is append-only through its validating writer:`,
      `  node scripts/emit-session.mjs --entry '<json>'    (or pipe the JSON on stdin)`,
      `Read or verify it without writing:`,
      `  node scripts/check-sessions-integrity.mjs`,
      `Editing the file in place skips schema validation and can rewrite existing records.`,
      `Override (intentional maintenance only): run the session with`,
      `SO_DISABLED_HOOKS=${HOOK_NAME}`,
      `See: GitLab #1443, skills/session-end/session-metrics-write.md`,
    ].join('\n'),
  );
}

// Entry guard (#1393): run only as the node script the harness execs — a bare
// `import()` must run no handler and must not exit the importing process.
if (isMainModule(import.meta.url)) {
  if (!shouldRunHook(HOOK_NAME)) process.exit(0);

  // Fail-OPEN on any internal error: exit 0 with no stdout is "no decision".
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      process.stderr.write(`⚠ ${HOOK_NAME}: internal error — ${e?.message || e}\n`);
      process.exit(0);
    });
}
