#!/usr/bin/env node
/** Stdin-only boundary for commands/session.md; never executes task context. */
import { accessSync, constants, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveSessionInvocation } from './lib/session-invocation.mjs';
import { readCanonicalSessions } from './lib/sessions-canonical.mjs';
import { isRealSession } from './lib/session-schema/filters.mjs';
import { resolveEventsLedgerRoot } from './lib/platform.mjs';

/**
 * One ledger: `false` when absent, `undefined` when present but not a readable
 * file, else whether it holds a real session.
 *
 * @param {string} root
 * @returns {boolean|undefined}
 */
function ledgerHasHistory(root) {
  const file = join(root, '.orchestrator', 'metrics', 'sessions.jsonl');
  try {
    if (!statSync(file).isFile()) return undefined;
    accessSync(file, constants.R_OK);
  } catch (error) {
    return error?.code === 'ENOENT' ? false : undefined;
  }
  return readCanonicalSessions({ filePath: file }).some(isRealSession);
}

/**
 * Whether the repo holds a real session of its own: `true`/`false`, or
 * `undefined` when that cannot be measured. sessions.jsonl is gitignored, so a
 * linked worktree also reads its main checkout's ledger (`resolveEventsLedgerRoot`);
 * one with history in either place has history. A ledger that exists but
 * cannot be read is "not measured", never "no history".
 *
 * @param {string} repoRoot
 * @returns {boolean|undefined}
 */
function measureHistory(repoRoot) {
  const roots = [...new Set([resolve(repoRoot), resolveEventsLedgerRoot(repoRoot)])];
  let unmeasured = false;
  for (const root of roots) {
    const has = ledgerHasHistory(root);
    if (has === true) return true;
    if (has === undefined) unmeasured = true;
  }
  return unmeasured ? undefined : false;
}

const HELP = `Usage: node scripts/resolve-session-invocation.mjs [--json] [--repo-root <dir>] < arguments.txt

Read the complete /session argument text from UTF-8 stdin.
Resolve the leading housekeeping, feature, deep or ultradeep token; preserve
the rest as task context. Empty input defaults to deep. An invalid mode emits
a warning and resolves to deep, as the session command has always specified.
A bare /session in a repo whose .orchestrator/metrics/sessions.jsonl holds no
real session adds defaultReason "no-session-history": ask for task and mode
before starting. A linked git worktree reads its main checkout's ledger; an
unreadable ledger counts as not measured and adds nothing.

  --json             Emit one JSON object instead of a human-readable summary
  --repo-root <dir>  Project root whose session history is read (default: cwd)
  --help             Show this help
  --version          Show the plugin version

Example: node scripts/resolve-session-invocation.mjs --json < arguments.txt
Write arguments.txt with a file tool; do not interpolate user text into a shell.
Exit codes: 0 resolved (including fallback), 1 bad CLI arguments, 2 stdin I/O error
`;

let options;
try {
  options = parseArgs({
    options: {
      json: { type: 'boolean' },
      'repo-root': { type: 'string' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
    allowPositionals: false,
  }).values;
} catch (error) {
  process.stderr.write(`session-invocation: ${error.message}\n`);
  process.exit(1);
}

if (options.help) {
  process.stdout.write(HELP);
} else if (options.version) {
  process.stdout.write(
    `${JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version}\n`,
  );
} else {
  let input;
  try {
    input = readFileSync(0, 'utf8');
  } catch {
    process.stderr.write('session-invocation: could not read UTF-8 stdin\n');
    process.exit(2);
  }
  // History is read only for a bare /session: an explicit mode never needs it.
  const hasHistory =
    input.trim() === '' ? measureHistory(options['repo-root'] || process.cwd()) : undefined;
  const resolved = resolveSessionInvocation(input, { hasHistory });
  if (resolved.invalidMode !== undefined) {
    process.stderr.write(
      `Invalid session type '${resolved.invalidMode}'. Valid types: housekeeping, feature, deep (alias: ultradeep). Falling back to deep.\n`,
    );
  }
  process.stdout.write(
    options.json
      ? `${JSON.stringify(resolved)}\n`
      : `Session type: ${resolved.sessionType}${resolved.profile ? ` (profile: ${resolved.profile})` : ''}${resolved.defaultReason ? ` (default: ${resolved.defaultReason})` : ''}\nTask context: ${resolved.context}\n`,
  );
}
