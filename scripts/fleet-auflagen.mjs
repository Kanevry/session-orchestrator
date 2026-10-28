#!/usr/bin/env node
/**
 * fleet-auflagen.mjs — read this session's navigator conditions ("Auflagen")
 * and accept them only when they belong to this repo (#1520, navigator#190).
 *
 * Thin CLI over `readAuflagen()` in `scripts/lib/fleet-protocol.mjs`, called by
 * session-start Phase 7.6 after the check-in.
 *
 * Usage:
 *   node scripts/fleet-auflagen.mjs <session_id> [<session_id>...] [--render]
 *
 * The own repo is `CLAUDE_PROJECT_DIR` (trimmed) or the working directory.
 *
 * Candidate keys (#1839): the navigator may key a file by the native session
 * UUID instead of the semantic id. So the reader tries this process's native id
 * first (`readProcessLocalSessionIds()`, only when it is a native UUID), then
 * every positional id in order, de-duplicated. Among accepted files the newest
 * `zeit` wins (a resumed session keeps its UUID, so an older UUID-keyed file
 * must not shadow a fresh semantic one; ties keep key order); otherwise the
 * first rejected one is reported; otherwise absent. The repo check is
 * `readAuflagen()`'s, per key.
 *
 * stdout: one JSON line — `{ state: 'absent' }`, `{ state: 'accepted', auflagen, key }`
 * or `{ state: 'rejected', reason, key }`. A rejected file counts as absent: the
 * Standard-Auflagen apply. Per rejected candidate a WARN line naming the key
 * goes to stderr.
 *
 * --render (#1809, #1842): after the JSON line, print `renderAuflagenNotice()` —
 * always at least one boundary: the navigator's `grenze` from an accepted file,
 * verbatim under a header line; a withheld notice (control characters, not a
 * string) followed by the Standard-Grenzsatz; or, for absent, rejected or an
 * accepted file without `grenze`, the Standard-Grenzsatz under its own header.
 * The JSON line itself is then written by `terminalSafeJson()`: the same
 * characters as `\uXXXX` escapes, so it cannot print what the notice withholds;
 * `JSON.parse` returns the same value. Without --render it is byte for byte
 * `JSON.stringify`.
 *
 * Exit codes:
 *   0 — any of the three states (rejection is a result, not an error)
 *   2 — usage error (no positional session id)
 */

import { isNativeUuid, readAuflagen, renderAuflagenNotice, terminalSafeJson } from './lib/fleet-protocol.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { readProcessLocalSessionIds } from './lib/session-identity/own-session.mjs';

const PREFIX = 'fleet-auflagen:';

/** The navigator stamps `zeit` as `date -u +%FT%TZ`. */
const UTC_SECONDS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** Clock skew tolerated before a `zeit` counts as future-dated. */
const ZEIT_SKEW_MS = 5 * 60_000;

/** @returns {Promise<number>} exit code */
async function main() {
  const args = process.argv.slice(2);
  const render = args.includes('--render');
  const positional = args.filter((a) => a !== '--render');
  if (positional.length === 0) {
    process.stderr.write(`${PREFIX} usage: fleet-auflagen.mjs <session_id> [<session_id>...] [--render]\n`);
    return 2;
  }
  const [nativeId] = readProcessLocalSessionIds();
  const keys = [...new Set([...(isNativeUuid(nativeId) ? [nativeId] : []), ...positional])];
  const repoRoot = (process.env.CLAUDE_PROJECT_DIR || '').trim() || process.cwd();
  let result = { state: 'absent' };
  let rejected = null;
  let newest = -Infinity;
  for (const key of keys) {
    const r = await readAuflagen(key, { repoRoot });
    if (r.state === 'accepted') {
      // Newest `zeit` wins; ties keep key order. A `zeit` that is not the
      // navigator's UTC-seconds form, or lies more than ZEIT_SKEW_MS ahead,
      // ranks last — a future-dated file must not win every later read.
      const zeit = r.auflagen.zeit;
      const ms = typeof zeit === 'string' && UTC_SECONDS_RE.test(zeit) ? Date.parse(zeit) : NaN;
      const rank = Number.isFinite(ms) && ms <= Date.now() + ZEIT_SKEW_MS ? ms : -Infinity;
      if (result.state !== 'accepted' || rank > newest) {
        result = { ...r, key };
        newest = rank;
      }
    }
    if (r.state === 'rejected') {
      process.stderr.write(
        `${PREFIX} WARN: auflagen file ${terminalSafeJson(key)} ignored (${r.reason}) — treated as absent, Standard-Auflagen apply\n`,
      );
      rejected ??= { ...r, key };
    }
  }
  if (result.state !== 'accepted' && rejected) result = rejected;
  process.stdout.write((render ? terminalSafeJson(result) : JSON.stringify(result)) + '\n');
  if (render) {
    process.stdout.write(renderAuflagenNotice(result).join('\n') + '\n');
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
