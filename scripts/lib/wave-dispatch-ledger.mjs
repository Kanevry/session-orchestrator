/**
 * wave-dispatch-ledger.mjs — names and removal of the per-session dispatch
 * ledgers `hooks/pre-task-scope-disjoint.mjs` writes (#1493.3, #2020).
 *
 * The PreToolUse hook writes `.orchestrator/wave-dispatch-scopes.<token>.json`
 * (plus a `.lock` beside it) under its resolved session root, `<token>` being
 * the payload `session_id` reduced to a path-safe token. Until #2020 nothing
 * removed them: 64 files piled up in this plugin's main checkout, 18 in a
 * consumer repo within 10 days. `hooks/on-session-end.mjs` now removes the
 * ending session's own pair and sweeps old leftovers — both through THIS
 * module, so writer and remover cannot disagree on a file name.
 *
 * Stdlib-only leaf ON PURPOSE: the PreToolUse hook imports it statically
 * (like `native-command.mjs`), and a leaf with nothing but `node:` imports
 * cannot fail at ESM link time the way the late-bound repo modules can (#993).
 * Every function here is best-effort and never throws.
 */

import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

/** Directory (session-root relative) holding the ledgers. */
export const LEDGER_DIR_REL = '.orchestrator';

/** File-name stem shared by every per-session ledger and its lock. */
export const LEDGER_STEM = 'wave-dispatch-scopes';

/**
 * Longest session token a ledger file name carries. Harness session ids are
 * UUIDs (36 chars) and pass through unchanged; the cap only keeps a pathological
 * id below the 255-byte file-name limit. Two ids that sanitise to ONE token
 * share a file again — degraded to the pre-#1493 behaviour, never worse, since
 * `waveKey` still carries the raw id. Revisit if a harness ships ids that are
 * not path-safe.
 */
export const MAX_SESSION_TOKEN_CHARS = 128;

/** Token of a session id that has no usable character, and of a payload without one. */
export const NO_SESSION_TOKEN = 'no-session';

/**
 * NAMED CEILING (BV-004, #2020): the sweep removes a ledger of ANOTHER session
 * only once its mtime is older than 7 days. The hook rewrites the ledger on
 * every dispatch, so a session that dispatched within the last week keeps its
 * file; the worst case of a wrong removal is a live session idle for >7 days
 * losing its current wave's prior claims (less collision history on its next
 * dispatch, never a deny and never lost work). The session holding the root's
 * `session.lock` is spared regardless of age.
 * Revisit-Trigger: a session that legitimately idles >7 days and then reports a
 * missed scope collision, OR `ls .orchestrator/wave-dispatch-scopes.*.json | wc -l`
 * still passes 50 in a repo whose sessions end through SessionEnd.
 */
export const LEDGER_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Per-session file names: `<stem>.<token>.json` and `<stem>.<token>.lock`.
 * The legacy shared `<stem>.json` (pre-#1493, read once for migration) has no
 * token segment and never matches — the sweep leaves it alone.
 */
const SESSION_FILE_RE = new RegExp(`^${LEDGER_STEM}\\.(.+)\\.(json|lock)$`);

/**
 * The path-safe token a session id is filed under (`[A-Za-z0-9._-]`, capped at
 * `MAX_SESSION_TOKEN_CHARS`); `no-session` when the id has no usable character.
 *
 * @param {string} sessionId
 * @returns {string}
 */
export function ledgerTokenFor(sessionId) {
  const token = String(sessionId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, MAX_SESSION_TOKEN_CHARS);
  return /[A-Za-z0-9]/.test(token) ? token : NO_SESSION_TOKEN;
}

/**
 * The repo-relative paths of a session's ledger and its lock (#1493.3). No id
 * can name a file outside `.orchestrator/` — see {@link ledgerTokenFor}.
 *
 * @param {string} sessionId
 * @returns {{ ledgerRel: string, lockRel: string }}
 */
export function ledgerPathsFor(sessionId) {
  const base = path.join(LEDGER_DIR_REL, `${LEDGER_STEM}.${ledgerTokenFor(sessionId)}`);
  return { ledgerRel: `${base}.json`, lockRel: `${base}.lock` };
}

/** Unlink `file` when it is a regular file (never a symlink or directory); true when removed. */
function unlinkRegularFile(file) {
  try {
    if (!lstatSync(file).isFile()) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Remove THIS session's ledger and lock under `root`. Ownership is the name:
 * the token derives from the same raw payload `session_id` the PreToolUse hook
 * keyed the file with. A payload without a string id, or one whose token is
 * the shared `no-session` fallback, removes nothing — that file is not one
 * session's own.
 *
 * @param {string} root session root the PreToolUse hook anchored the ledger at
 * @param {unknown} rawSessionId the payload's `session_id`, unparsed
 * @returns {string[]} absolute paths removed
 */
export function removeOwnDispatchLedger(root, rawSessionId) {
  if (typeof root !== 'string' || root === '') return [];
  if (typeof rawSessionId !== 'string' || rawSessionId === '') return [];
  if (ledgerTokenFor(rawSessionId) === NO_SESSION_TOKEN) return [];
  const { ledgerRel, lockRel } = ledgerPathsFor(rawSessionId);
  return [ledgerRel, lockRel]
    .map((rel) => path.join(root, rel))
    .filter((file) => unlinkRegularFile(file));
}

/**
 * Remove per-session ledgers and locks under `root/.orchestrator` whose mtime
 * is older than `maxAgeMs` and whose token is not in `keepTokens`. Reads one
 * directory; never recurses, never follows a symlink, never touches the legacy
 * shared ledger or any non-ledger file.
 *
 * @param {string} root
 * @param {{ nowMs?: number, maxAgeMs?: number, keepTokens?: Iterable<string> }} [opts]
 * @returns {string[]} absolute paths removed
 */
export function sweepStaleDispatchLedgers(root, { nowMs = Date.now(), maxAgeMs = LEDGER_SWEEP_MAX_AGE_MS, keepTokens = [] } = {}) {
  if (typeof root !== 'string' || root === '') return [];
  const dir = path.join(root, LEDGER_DIR_REL);
  const keep = new Set(keepTokens);
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    const match = SESSION_FILE_RE.exec(name);
    if (!match || keep.has(match[1])) continue;
    const file = path.join(dir, name);
    try {
      const info = lstatSync(file);
      if (!info.isFile() || nowMs - info.mtimeMs <= maxAgeMs) continue;
    } catch {
      continue;
    }
    if (unlinkRegularFile(file)) removed.push(file);
  }
  return removed;
}
