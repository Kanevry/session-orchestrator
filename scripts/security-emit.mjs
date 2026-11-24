#!/usr/bin/env node
/**
 * security-emit.mjs — records one `orchestrator.security.command` event for a
 * `/security` result and passes the result through unchanged (#2201).
 *
 * `scripts/security.mjs` is strictly read-only (no file, no event). The
 * `/security` skill pipes its `--json` output through this emitter:
 *
 *   node scripts/security.mjs --mode deps --json --repo-root <root> \
 *     | node scripts/security-emit.mjs --repo-root <root>
 *
 * Contract:
 *   - reads exactly ONE JSON document on stdin and writes the SAME bytes to
 *     stdout first, whatever happens next — the emitter never breaks the
 *     skill's output;
 *   - input that is not JSON or not a Result (`isResult()` from
 *     `scripts/lib/security/contract.mjs`) or names an unknown mode: no event,
 *     one stderr line, exit 0;
 *   - a missing or non-directory `--repo-root` or an unknown flag: stdin is
 *     still passed through, then exit 2;
 *   - the event write is best-effort: a failure is one stderr line and changes
 *     neither the exit code nor the pass-through.
 *
 * Payload, COUNTS ONLY (the ledger may be POSTed to a webhook): `mode` and
 * `status` (both closed sets), `findings`, `not_checked`, `checks`, then for
 * mode `deps` `fix_now` / `can_wait` / `not_reachable` (from the findings'
 * `rank` key), for every other mode `failed_checks`. It is built from numbers
 * and the two closed-set strings only, so no package name, advisory id, file
 * path, reason or detail text can reach the record.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { isMainModule } from './lib/is-main-module.mjs';
import { MODES, isResult } from './lib/security/contract.mjs';

export const SECURITY_COMMAND_EVENT = 'orchestrator.security.command';

const EXIT_INPUT = 2;

const USAGE = `Usage: node scripts/security-emit.mjs --repo-root <absolute path>

Reads one /security result JSON (scripts/security.mjs --json) on stdin, writes
it unchanged to stdout and records one ${SECURITY_COMMAND_EVENT} event
(counts only) in the event ledger of <repo-root>.

Options:
  --repo-root <path>  repository whose event ledger receives the event (required)
  -h, --help          show this help

Exit codes: 0 passed through (event recorded, or skipped for invalid input
with one stderr line); 2 usage error (stdin is still passed through).`;

/**
 * Counts-only event payload for a valid Result. Reads nothing but numbers and
 * the closed-set `mode`/`status` strings.
 * @param {import('./lib/security/contract.mjs').Result} result
 * @returns {Record<string, string|number>}
 */
export function buildCommandPayload(result) {
  const payload = {
    mode: result.mode,
    status: result.status,
    findings: result.findings.length,
    not_checked: result.notChecked,
    checks: result.checks.length,
  };
  if (result.mode === 'deps') {
    const countRank = (rank) => result.findings.filter((f) => f.rank === rank).length;
    payload.fix_now = countRank('fix-now');
    payload.can_wait = countRank('can-wait');
    payload.not_reachable = countRank('not-reachable');
  } else {
    payload.failed_checks = result.checks.filter((c) => c.state === 'fail').length;
  }
  return payload;
}

function diag(message) {
  process.stderr.write(`security-emit: ${message}\n`);
}

/** Validate args, pass stdin through, then record the event. */
async function main() {
  let values;
  let usageError = null;
  try {
    ({ values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        'repo-root': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    usageError = err.message;
    values = {};
  }

  if (!usageError && values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const repoRootArg = typeof values['repo-root'] === 'string' ? values['repo-root'].trim() : '';
  let repoRoot = null;
  if (!usageError) {
    if (repoRootArg === '') {
      usageError = '--repo-root is required';
    } else {
      repoRoot = resolve(repoRootArg);
      // A typo'd root would otherwise be CREATED by the event writer's mkdir.
      if (!existsSync(repoRoot) || !statSync(repoRoot).isDirectory()) {
        usageError = `--repo-root is not an existing directory: ${repoRootArg}`;
      }
    }
  }

  // Pass-through comes first, unconditionally: the emitter sits at the end of
  // the skill's pipe, so its output must never depend on what follows.
  let raw;
  try {
    raw = readFileSync(0);
  } catch (err) {
    diag(`could not read stdin: ${err.message}`);
    raw = Buffer.alloc(0);
  }
  process.stdout.write(raw);

  if (usageError) {
    diag(`${usageError}\n\n${USAGE}`);
    return EXIT_INPUT;
  }

  let result;
  try {
    result = JSON.parse(raw.toString('utf8'));
  } catch {
    diag(`stdin is not JSON; no ${SECURITY_COMMAND_EVENT} event recorded`);
    return 0;
  }
  if (!isResult(result) || !MODES.includes(result.mode)) {
    diag(`stdin is not a /security result; no ${SECURITY_COMMAND_EVENT} event recorded`);
    return 0;
  }

  try {
    // Lazy import: events.mjs pulls in platform resolution at module load.
    const { emitEvent } = await import('./lib/events.mjs');
    const { dotGitAncestor } = await import('./lib/platform.mjs');
    // BV-004 ceiling: discover the checkout by its .git entry; emitEvent maps linked worktrees.
    // Revisit-Trigger: a checkout with no discoverable .git entry needs a shared ledger.
    await emitEvent(SECURITY_COMMAND_EVENT, buildCommandPayload(result), { repoRoot: dotGitAncestor(repoRoot) || repoRoot });
  } catch (err) {
    diag(`event write failed (output unaffected): ${err?.message ?? err}`);
  }
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      diag(`unexpected error: ${err?.message ?? err}`);
      process.exitCode = 0;
    },
  );
}
