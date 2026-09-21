#!/usr/bin/env node
/** Stdin-only boundary for commands/session.md; never executes task context. */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolveSessionInvocation } from './lib/session-invocation.mjs';

const HELP = `Usage: node scripts/resolve-session-invocation.mjs [--json] < arguments.txt

Read the complete /session argument text from UTF-8 stdin.
Resolve the leading housekeeping, feature, deep or ultradeep token; preserve
the rest as task context. Empty input defaults to deep. An invalid mode emits
a warning and resolves to deep, as the session command has always specified.

  --json     Emit one JSON object instead of a human-readable summary
  --help     Show this help
  --version  Show the plugin version

Example: node scripts/resolve-session-invocation.mjs --json < arguments.txt
Write arguments.txt with a file tool; do not interpolate user text into a shell.
Exit codes: 0 resolved (including fallback), 1 bad CLI arguments, 2 stdin I/O error
`;

let options;
try {
  options = parseArgs({
    options: { json: { type: 'boolean' }, help: { type: 'boolean' }, version: { type: 'boolean' } },
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
  const resolved = resolveSessionInvocation(input);
  if (resolved.invalidMode !== undefined) {
    process.stderr.write(
      `Invalid session type '${resolved.invalidMode}'. Valid types: housekeeping, feature, deep (alias: ultradeep). Falling back to deep.\n`,
    );
  }
  process.stdout.write(
    options.json
      ? `${JSON.stringify(resolved)}\n`
      : `Session type: ${resolved.sessionType}${resolved.profile ? ` (profile: ${resolved.profile})` : ''}\nTask context: ${resolved.context}\n`,
  );
}
