#!/usr/bin/env node
/**
 * fleet-auflagen.mjs — read this session's navigator conditions ("Auflagen")
 * and accept them only when they belong to this repo (#1520, navigator#190).
 *
 * Thin CLI over `readAuflagen()` in `scripts/lib/fleet-protocol.mjs`, called by
 * session-start Phase 7.6 after the check-in.
 *
 * Usage:
 *   node scripts/fleet-auflagen.mjs <session_id>
 *
 * The own repo is `CLAUDE_PROJECT_DIR` (trimmed) or the working directory.
 *
 * stdout: one JSON line — `{ state: 'absent' }`, `{ state: 'accepted', auflagen }`
 * or `{ state: 'rejected', reason }`. A rejected file counts as absent: the
 * Standard-Auflagen apply. On rejection a WARN line goes to stderr.
 *
 * Exit codes:
 *   0 — any of the three states (rejection is a result, not an error)
 *   2 — usage error (no session id)
 */

import { readAuflagen } from './lib/fleet-protocol.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const PREFIX = 'fleet-auflagen:';

/** @returns {Promise<number>} exit code */
async function main() {
  const sessionId = process.argv[2];
  if (!sessionId) {
    process.stderr.write(`${PREFIX} usage: fleet-auflagen.mjs <session_id>\n`);
    return 2;
  }
  const repoRoot = (process.env.CLAUDE_PROJECT_DIR || '').trim() || process.cwd();
  const result = await readAuflagen(sessionId, { repoRoot });
  if (result.state === 'rejected') {
    process.stderr.write(
      `${PREFIX} WARN: auflagen file ignored (${result.reason}) — treated as absent, Standard-Auflagen apply\n`,
    );
  }
  process.stdout.write(JSON.stringify(result) + '\n');
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then(
    (code) => { process.exitCode = code; },
    (err) => {
      process.stderr.write(`${PREFIX} ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    },
  );
}
