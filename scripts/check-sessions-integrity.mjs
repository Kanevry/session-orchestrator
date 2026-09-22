#!/usr/bin/env node
// scripts/check-sessions-integrity.mjs
//
// CLI front-end for `checkSessionsIntegrity` (GitLab #1417).
//
// WHY THIS EXISTS:
//   session-end step 4a (`skills/session-end/session-metrics-write.md`) has to
//   prove that the session record it JUST appended to
//   `.orchestrator/metrics/sessions.jsonl` is schema-valid AND renderable by
//   vault-mirror — step 4 before it only proves the line is JSON. The #1408
//   record parsed fine and was still invalid (`ended_at` instead of
//   `completed_at`, four required fields missing), so vault-mirror dropped it as
//   `skipped-invalid` and that session got no vault note; nobody was told until
//   the NEXT session-start banner. Until now the check existed only as a
//   `node --input-type=module -e` one-liner inside the skill body, because the
//   function had no CLI entry point (`scripts/repair-invalid-sessions.mjs` is a
//   REPAIR path whose `--dry-run` exit reports repairability, not validity).
//
// WHAT IT CHECKS (exactly what the banner checks — no second opinion here):
//   every parseable record in the ledger is run through `validateSession()` AND
//   through vault-mirror's real render path. `--session-id` narrows the VERDICT
//   to one record; other sessions' findings are still printed (they are not this
//   close's to fix) but never decide the exit code.
//
// WHY A MISSING RECORD EXITS 1 (the deliberate call, #1417):
//   `checkSessionsIntegrity` is silent both when a named record is sound and
//   when it does not exist — "no finding" cannot tell those apart. Reporting the
//   absent case as success would make this guard fail-open in precisely the
//   shape it exists to catch: a close that proceeds with NO ledger record, one
//   notch worse than the #1408 invalid one. So with `--session-id` the ledger is
//   additionally read for that id and its absence is a named failure ("record
//   not found"), never a silent pass. Without `--session-id` there is no id to
//   be absent, and an empty/missing ledger is simply nothing to judge (exit 0).
//
// USAGE:
//   node scripts/check-sessions-integrity.mjs [--repo-root <path>] [--session-id <id>] [--json]
//
// EXIT CODES:
//   0  every judged record validates and mirrors
//   1  a judged record is schema-invalid, is dropped by vault-mirror, or (with
//      --session-id) is not in the ledger at all
//   2  tool error — unknown/incomplete flag, or an unreadable repo root
//
// Node stdlib only apart from two repo-local imports; safe to call from a hook,
// a skill body or CI without any dependency install.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkSessionsIntegrity, SESSIONS_PATH } from './lib/sessions-integrity-banner.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

const HELP_TEXT = `check-sessions-integrity.mjs — session-ledger schema + vault-mirror gate (#1417)

USAGE
  node scripts/check-sessions-integrity.mjs [options]

DESCRIPTION
  Runs every parseable record in .orchestrator/metrics/sessions.jsonl through
  validateSession() AND through vault-mirror's real render path — the same two
  populations the session-start banner reports. A record can pass one and fail
  the other, so both are checked and reported separately.

  This is the command form of session-end step 4a: after appending a session
  record, prove it is sound BEFORE the close continues.

OPTIONS
  --repo-root <path>   Repo root holding .orchestrator/metrics/ (default: cwd).
  --session-id <id>    Judge only the record(s) carrying this session_id. Other
                       sessions' findings are still printed but never decide the
                       exit code — they are pre-existing, not this close's to fix.
                       An id with NO record in the ledger is a FAILURE (exit 1),
                       not a silent pass: absent and sound are indistinguishable
                       to the checker, and the fail-open reading is the dangerous
                       one.
  --json               Emit one JSON result object on stdout (diagnostics stay
                       on stderr).
  --help, -h           Show this help and exit.
  --version            Print the package version and exit.

EXIT CODES
  0  every judged record validates and mirrors
  1  a judged record is schema-invalid, is dropped by vault-mirror, or (with
     --session-id) is not in the ledger at all
  2  tool error — unknown/incomplete flag, or an unreadable repo root

EXAMPLES
  node scripts/check-sessions-integrity.mjs
  node scripts/check-sessions-integrity.mjs --session-id main-2026-09-21-session-4
  node scripts/check-sessions-integrity.mjs --json | jq '.findings'
`;

/**
 * Parse argv. Returns `error` (a message) instead of throwing, so the caller
 * owns the exit code.
 *
 * @param {string[]} argv
 * @returns {{opts: {repoRoot: string|null, sessionId: string|null, json: boolean,
 *            help: boolean, version: boolean}, error: string|null}}
 */
export function parseArgs(argv) {
  const opts = { repoRoot: null, sessionId: null, json: false, help: false, version: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--repo-root':
      case '--session-id': {
        const value = argv[i + 1];
        // A flag whose value is missing — or is itself the next flag — must be a
        // usage error, never a silently empty filter that judges nothing.
        if (typeof value !== 'string' || value === '' || value.startsWith('--')) {
          return { opts, error: `${arg} requires a value` };
        }
        if (arg === '--repo-root') opts.repoRoot = value;
        else opts.sessionId = value;
        i += 1;
        break;
      }
      case '--json':
        opts.json = true;
        break;
      case '--help':
      case '-h':
        opts.help = true;
        break;
      case '--version':
        opts.version = true;
        break;
      default:
        return { opts, error: `unknown flag: ${arg}` };
    }
  }
  return { opts, error: null };
}

/**
 * Count the ledger records carrying `sessionId`. Unparseable lines are skipped —
 * the same posture the banner takes: this judges schema integrity, not file
 * corruption.
 *
 * @param {string} repoRoot
 * @param {string} sessionId
 * @returns {number}
 */
function countLedgerRecords(repoRoot, sessionId) {
  const filePath = join(repoRoot, SESSIONS_PATH);
  if (!existsSync(filePath)) return 0;
  let matched = 0;
  for (const line of readFileSync(filePath, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record && typeof record === 'object' && record.session_id === sessionId) matched += 1;
  }
  return matched;
}

/**
 * Run the check and return a plain result object. Never throws; never exits.
 *
 * @param {{repoRoot?: string, sessionId?: string|null}} [opts]
 * @returns {{ok: boolean, exitCode: 0|1|2, repoRoot: string, sessionId: string|null,
 *            total: number|null, matched: number|null, severity: 'warn'|'alert'|null,
 *            message: string|null, findings: {kind: string, line: number, sessionId: string, error: string}[],
 *            error: string|null}}
 */
export function runSessionsIntegrityCheck({ repoRoot, sessionId = null } = {}) {
  const root = resolve(repoRoot ?? process.cwd());
  const base = {
    ok: false,
    exitCode: 2,
    repoRoot: root,
    sessionId: sessionId ?? null,
    total: null,
    matched: null,
    severity: null,
    message: null,
    findings: [],
    error: null,
  };

  try {
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return { ...base, error: `repo root is not a directory: ${root}` };
    }
  } catch (err) {
    return { ...base, error: `repo root unreadable: ${err?.message ?? String(err)}` };
  }

  const banner = checkSessionsIntegrity({ repoRoot: root });

  const findings = banner
    ? [
        ...banner.schemaInvalid.map((f) => ({ kind: 'schema-invalid', ...f })),
        ...banner.mirrorSkipped.map((f) => ({ kind: 'mirror-skipped', ...f })),
      ]
    : [];

  const result = {
    ...base,
    total: banner ? banner.total : null,
    severity: banner ? banner.severity : null,
    message: banner ? banner.message : null,
    findings,
  };

  if (sessionId === null || sessionId === undefined) {
    // No filter: every finding decides.
    const ok = findings.length === 0;
    return { ...result, ok, exitCode: ok ? 0 : 1 };
  }

  const matched = countLedgerRecords(root, sessionId);
  const mine = findings.filter((f) => f.sessionId === sessionId);

  if (matched === 0) {
    return {
      ...result,
      matched,
      ok: false,
      exitCode: 1,
      error:
        `no record with session_id "${sessionId}" in ${SESSIONS_PATH} — ` +
        'it was never written, or it was written under a different id. ' +
        'Re-emit it via scripts/emit-session.mjs.',
    };
  }

  const ok = mine.length === 0;
  return { ...result, matched, ok, exitCode: ok ? 0 : 1 };
}

function readVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(SELF_DIR, '..', 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

// CLI entry — only when run directly, never on import (an import must do
// nothing: this module is loaded by tests and is reachable from hook code).
if (isMainModule(import.meta.url)) {
  const { opts, error } = parseArgs(process.argv.slice(2));

  if (error !== null) {
    process.stderr.write(`[check-sessions-integrity] ${error}\n`);
    process.stderr.write('Run with --help for usage.\n');
    process.exit(2);
  }

  if (opts.help) {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (opts.version) {
    process.stdout.write(`${readVersion()}\n`);
    process.exit(0);
  }

  const repoRootArg =
    opts.repoRoot === null ? undefined : isAbsolute(opts.repoRoot) ? opts.repoRoot : resolve(process.cwd(), opts.repoRoot);

  const result = runSessionsIntegrityCheck({ repoRoot: repoRootArg, sessionId: opts.sessionId });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(result.exitCode);
  }

  // The banner text covers EVERY record, including other sessions' pre-existing
  // findings — printed for visibility, even when the verdict below is clean.
  if (result.message) process.stderr.write(`${result.message}\n`);
  if (result.error) process.stderr.write(`[check-sessions-integrity] ${result.error}\n`);

  if (result.exitCode === 2) process.exit(2);

  if (result.ok) {
    const scope = result.sessionId ? `record "${result.sessionId}"` : 'every ledger record';
    process.stdout.write(`[check-sessions-integrity] OK — ${scope} validates and mirrors\n`);
    process.exit(0);
  }

  const scope = result.sessionId ? `session "${result.sessionId}"` : 'the sessions ledger';
  process.stderr.write(
    `[check-sessions-integrity] FAIL — ${scope} is not sound. ` +
      'Re-emit the affected record(s) via scripts/emit-session.mjs ' +
      '(bulk repair: node scripts/repair-invalid-sessions.mjs --apply).\n',
  );
  process.exit(1);
}
