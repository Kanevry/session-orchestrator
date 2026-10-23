#!/usr/bin/env node
/**
 * close-precheck.mjs — classify `<state-dir>/STATE.md` before `/close` hands
 * off to session-end (#1661). Logic: `lib/session-end/close-precheck.mjs`.
 *
 * Usage:
 *   node scripts/close-precheck.mjs [--repo-root <dir>] [--state-dir <dir>] [--confirm-own <token>] [--record-without-plan]
 *
 * `--confirm-own` takes the 16-hex `confirmToken` of an `ownership-unproven`
 * result and confirms that STATE.md as this session's while unchanged (#1718).
 *
 * Prints one JSON object: `verdict`, `runsSessionEnd`, `ownership`, `status`,
 * `stateSessionId`, `ownSessionIds`, `statePath`, optional `reason`; with
 * `ownership-unproven` also `wouldRun`, `confirmToken`, `session`, `startedAt`.
 * `--record-without-plan` (#1762): when the verdict does not hand off to
 * session-end, write this session's `status: closed-without-plan` record to
 * `sessions.jsonl` (`lib/session-end/close-without-plan.mjs`) and add its result
 * as `record` (`written`, `verified`, `reason`, `session_id`, `raw_session_id`).
 * Without the flag the output is unchanged.
 * Exit 0 for every verdict (a stop is an answer, not an error; Claude Code
 * marks every non-zero exit as a tool failure) · 2 usage error.
 */

import { classifyCloseState, RUNS_SESSION_END } from './lib/session-end/close-precheck.mjs';
import { recordCloseWithoutPlan } from './lib/session-end/close-without-plan.mjs';

function parseArgs(argv) {
  const out = { repoRoot: process.cwd(), stateDir: undefined, confirmToken: undefined, recordWithoutPlan: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo-root' || a === '--state-dir') {
      const v = argv[++i];
      if (!v) throw new Error(`${a} needs a value`);
      if (a === '--repo-root') out.repoRoot = v; else out.stateDir = v;
    } else if (a === '--confirm-own') {
      const v = argv[++i];
      if (!v || !/^[0-9a-f]{16}$/.test(v)) throw new Error('--confirm-own needs a 16-hex token');
      out.confirmToken = v;
    } else if (a === '--record-without-plan') {
      out.recordWithoutPlan = true;
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
  process.stdout.write('Usage: node scripts/close-precheck.mjs [--repo-root <dir>] [--state-dir <dir>] [--confirm-own <token>] [--record-without-plan]\n');
  process.exit(0);
}

const result = classifyCloseState({ repoRoot: args.repoRoot, stateDir: args.stateDir, confirmToken: args.confirmToken });
const out = { ...result, runsSessionEnd: RUNS_SESSION_END.has(result.verdict) };
if (args.recordWithoutPlan && !out.runsSessionEnd) {
  // recordCloseWithoutPlan answers every expected failure with a reason, but a
  // throw from below it (ledger-root resolution, registry) must not cost the
  // caller the verdict: the verdict is what `/close` acts on, the record is
  // secondary.
  try {
    out.record = await recordCloseWithoutPlan({ repoRoot: args.repoRoot, precheck: result });
  } catch {
    out.record = { written: false, reason: 'internal-error' };
  }
}
process.stdout.write(`${JSON.stringify(out)}\n`);
