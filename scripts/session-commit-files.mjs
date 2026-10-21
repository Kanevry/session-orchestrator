#!/usr/bin/env node
/**
 * session-commit-files.mjs — which files did one session commit, in which of
 * its own work trees (#1659).
 *
 * Read-only CLI over scripts/lib/session-work-trees.mjs: the session's
 * `(tree, start_ref)` pairs come from the `orchestrator.session.work_tree`
 * events in the default events ledger, and every tree is diffed INSIDE ITSELF
 * against its own start ref (`git -C <tree> diff --name-only <ref>..HEAD`).
 * Never a diff across two trees, never a write.
 *
 * Usage:
 *   node scripts/session-commit-files.mjs [--session-id <raw-id>] [--json]
 *
 * Exit codes: 0 success (also with zero trees), 2 usage error (unknown flag,
 * missing session id). Deviates from cli-design.md's `1` for input errors by
 * coordinator contract (#1659); documented in `--help`.
 */

import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import { readSessionWorkTrees, sessionCommitFiles } from './lib/session-work-trees.mjs';

const USAGE = `Usage: node scripts/session-commit-files.mjs [--session-id <raw-id>] [--json]

List the files one session committed, per own work tree (#1659).

Reads the session's (tree, start_ref) pairs from the
orchestrator.session.work_tree events of the default events ledger and runs
'git -C <tree> diff --name-only <start_ref>..HEAD' inside each tree only.
Read-only: writes nothing.

Options:
  --session-id <id>  raw session id (default: $CLAUDE_CODE_SESSION_ID)
  --json             print { trees, perTree, skipped, union, malformed, invalid,
                     complete[, error] } as JSON (complete: null = no ledger found)
  -h, --help         show this help

Default output (stdout): one line per tree '<tree>\\t<start_ref>\\t<n> files',
a blank line, then the union of files, one per line. Skipped trees and notes
go to stderr.

Exit codes:
  0  success (also when the session recorded no trees)
  2  usage error (unknown option, no session id)

Example:
  node scripts/session-commit-files.mjs --session-id "$CLAUDE_CODE_SESSION_ID" --json`;

/**
 * Run the CLI.
 *
 * @param {string[]} argv — arguments after the script path.
 * @param {{ env?: NodeJS.ProcessEnv,
 *           stdout?: (s: string) => void, stderr?: (s: string) => void }} [io]
 * @returns {number} exit code
 */
export function main(argv, {
  env = process.env,
  stdout = (s) => process.stdout.write(s),
  stderr = (s) => process.stderr.write(s),
} = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        'session-id': { type: 'string' },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (err) {
    stderr(`session-commit-files: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (values.help) {
    stdout(`${USAGE}\n`);
    return 0;
  }

  // Process-local identity only — never a repo-global file (#1659).
  const sessionId = (values['session-id'] ?? env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (sessionId === '') {
    stderr('session-commit-files: no session id (pass --session-id or set CLAUDE_CODE_SESSION_ID)\n');
    return 2;
  }

  const read = readSessionWorkTrees({ sessionId });
  const files = sessionCommitFiles({ trees: read.trees });

  // Notes go to stderr in BOTH modes, so `--json` never hides that the
  // answer is partial or that no ledger exists (#1659).
  if (read.error) stderr(`session-commit-files: ledger read failed: ${read.error}\n`);
  if (read.complete === null && !read.error) stderr('session-commit-files: no events ledger found\n');
  if (read.malformed > 0) stderr(`session-commit-files: ${read.malformed} unreadable ledger line(s)\n`);
  if (read.invalid > 0) {
    stderr(`session-commit-files: ignored ${read.invalid} own work_tree event(s) without a valid tree/start_ref\n`);
  }
  for (const s of files.skipped) {
    stderr(`session-commit-files: skipped ${s.tree} (${s.start_ref}): ${s.reason}\n`);
  }

  if (values.json) {
    stdout(`${JSON.stringify({
      trees: read.trees,
      perTree: files.perTree,
      skipped: files.skipped,
      union: files.union,
      malformed: read.malformed,
      invalid: read.invalid,
      complete: read.complete,
      ...(read.error ? { error: read.error } : {}),
    }, null, 2)}\n`);
    return 0;
  }

  if (read.trees.length === 0) {
    if (read.complete !== null) stderr(`session-commit-files: no work trees recorded for session ${sessionId}\n`);
    return 0;
  }
  if (files.perTree.length === 0) return 0; // every tree skipped — reported on stderr above
  const lines = files.perTree.map((t) => `${t.tree}\t${t.start_ref}\t${t.files.length} files`);
  stdout(`${lines.join('\n')}\n\n${files.union.map((f) => `${f}\n`).join('')}`);
  return 0;
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
