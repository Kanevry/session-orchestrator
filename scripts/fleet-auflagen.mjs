#!/usr/bin/env node
/**
 * fleet-auflagen.mjs — read this session's navigator conditions ("Auflagen")
 * and accept them only when they belong to this repo (#1520, navigator#190).
 *
 * Thin CLI over `readAuflagen()` in `scripts/lib/fleet-protocol.mjs`, called by
 * session-start Phase 7.6 after the check-in.
 *
 * Usage:
 *   node scripts/fleet-auflagen.mjs <session_id> [--render]
 *
 * The own repo is `CLAUDE_PROJECT_DIR` (trimmed) or the working directory.
 *
 * stdout: one JSON line — `{ state: 'absent' }`, `{ state: 'accepted', auflagen }`
 * or `{ state: 'rejected', reason }`. A rejected file counts as absent: the
 * Standard-Auflagen apply. On rejection a WARN line goes to stderr.
 *
 * --render (#1809): after the JSON line, print `renderAuflagenNotice()` — the
 * navigator's `grenze` from an accepted file, verbatim under a header line (or a
 * withheld notice when it carries control characters). Nothing extra otherwise.
 * The JSON line itself is then written by `terminalSafeJson()`: the same
 * characters as `\uXXXX` escapes, so it cannot print what the notice withholds;
 * `JSON.parse` returns the same value. Without --render it is byte for byte
 * `JSON.stringify`.
 *
 * Exit codes:
 *   0 — any of the three states (rejection is a result, not an error)
 *   2 — usage error (no session id)
 */

import { readAuflagen, renderAuflagenNotice, terminalSafeJson } from './lib/fleet-protocol.mjs';
import { isMainModule } from './lib/is-main-module.mjs';

const PREFIX = 'fleet-auflagen:';

/** @returns {Promise<number>} exit code */
async function main() {
  const args = process.argv.slice(2);
  const render = args.includes('--render');
  const sessionId = args.find((a) => a !== '--render');
  if (!sessionId) {
    process.stderr.write(`${PREFIX} usage: fleet-auflagen.mjs <session_id> [--render]\n`);
    return 2;
  }
  const repoRoot = (process.env.CLAUDE_PROJECT_DIR || '').trim() || process.cwd();
  const result = await readAuflagen(sessionId, { repoRoot });
  if (result.state === 'rejected') {
    process.stderr.write(
      `${PREFIX} WARN: auflagen file ignored (${result.reason}) — treated as absent, Standard-Auflagen apply\n`,
    );
  }
  process.stdout.write((render ? terminalSafeJson(result) : JSON.stringify(result)) + '\n');
  if (render) {
    const lines = renderAuflagenNotice(result);
    if (lines.length > 0) process.stdout.write(lines.join('\n') + '\n');
  }
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
