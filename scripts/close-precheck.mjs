#!/usr/bin/env node
/**
 * close-precheck.mjs — classify `<state-dir>/STATE.md` before `/close` hands
 * off to session-end (#1661). Logic: `lib/session-end/close-precheck.mjs`.
 *
 * Usage:
 *   node scripts/close-precheck.mjs [--repo-root <dir>] [--state-dir <dir>]
 *
 * Prints one JSON object: `verdict`, `runsSessionEnd`, `ownership`, `status`,
 * `stateSessionId`, `ownSessionIds`, `statePath`, optional `reason`.
 * Exit 0 for every verdict (a stop is an answer, not an error; Claude Code
 * marks every non-zero exit as a tool failure) · 2 usage error.
 */

import { classifyCloseState, RUNS_SESSION_END } from './lib/session-end/close-precheck.mjs';

function parseArgs(argv) {
  const out = { repoRoot: process.cwd(), stateDir: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo-root' || a === '--state-dir') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      if (a === '--repo-root') out.repoRoot = v; else out.stateDir = v;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  return out;
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`close-precheck: ${err.message}\n`);
  process.exit(2);
}
if (args.help) {
  process.stdout.write('Usage: node scripts/close-precheck.mjs [--repo-root <dir>] [--state-dir <dir>]\n');
  process.exit(0);
}

const result = classifyCloseState({ repoRoot: args.repoRoot, stateDir: args.stateDir });
process.stdout.write(`${JSON.stringify({ ...result, runsSessionEnd: RUNS_SESSION_END.has(result.verdict) })}\n`);
