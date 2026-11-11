#!/usr/bin/env node
/**
 * issue-balance.mjs — print this session's issue balance for the session-end
 * Phase 6 Final Report (#1947). Logic: `scripts/lib/issue-balance.mjs`.
 *
 * Usage:
 *   node scripts/issue-balance.mjs --record <file> [--close-results <file>]
 *        [--session-id <id>] [--raw-session-id <id>] [--vcs gitlab|github]
 *        [--no-repo] [--json] [--repo-root <dir>]
 *
 *   --record          JSON file holding the in-memory session record
 *                     (the one Phase 3.7 appends to sessions.jsonl)
 *   --close-results   stdout of `issue-close-strip-labels.mjs --close`
 *                     (one JSON object per line); a missing file falls back
 *                     to `issues_closed` of the record, a malformed one is
 *                     reported "nicht messbar"
 *   --no-repo         skip the "Repo heute" VCS read
 *
 * Exit codes: 0 printed (any measurement state), 1 bad arguments.
 * Never exits non-zero for an unmeasurable value — that is reported in the line.
 */

import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import { reconcileIssueBudget } from './lib/issue-budget-reconcile.mjs';
import {
  computeIssueBalance,
  fetchRepoToday,
  formatIssueBalance,
  readCloseResults,
} from './lib/issue-balance.mjs';

/** @param {string[]} argv @returns {number} */
export function main(argv = process.argv.slice(2)) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        record: { type: 'string' },
        'close-results': { type: 'string' },
        'session-id': { type: 'string' },
        'raw-session-id': { type: 'string' },
        vcs: { type: 'string' },
        'no-repo': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'repo-root': { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    }));
  } catch (err) {
    process.stderr.write(`issue-balance: ${err.message}\n`);
    return 1;
  }
  if (values.help) {
    process.stdout.write('Usage: issue-balance --record <file> [--close-results <file>] [--session-id <id>] [--raw-session-id <id>] [--vcs gitlab|github] [--no-repo] [--json]\n');
    return 0;
  }
  const repoRoot = values['repo-root'] ?? process.cwd();
  let record = null;
  if (values.record) {
    try {
      record = JSON.parse(readFileSync(values.record, 'utf8'));
    } catch {
      // An unreadable record must not read as "0 created": mark the field so.
      record = { issues_created: 'unreadable', issues_closed: 'unreadable' };
    }
  }
  const reconcile = reconcileIssueBudget({
    repoRoot,
    record,
    sessionId: values['session-id'] ?? null,
    rawSessionId: values['raw-session-id'] ?? null,
  });
  const now = new Date();
  const repoToday = values['no-repo'] ? null : fetchRepoToday({ repoRoot, vcs: values.vcs ?? null, now });
  const balance = computeIssueBalance({
    record,
    reconcile,
    closeResults: readCloseResults(values['close-results']),
    repoToday,
    now,
  });
  process.stdout.write(values.json ? `${JSON.stringify(balance)}\n` : `${formatIssueBalance(balance)}\n`);
  return 0;
}

if (isMainModule(import.meta.url)) process.exitCode = main();
