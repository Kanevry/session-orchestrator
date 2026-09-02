/**
 * atomic-json.mjs — shared atomic read-modify-write helper for JSON hook state.
 *
 * Extracted (issue #1197) from four byte-identical private copies of
 * `atomicMutateJson` that had accumulated independently in
 * `hooks/cwd-change-restore.mjs`, `hooks/on-session-end.mjs`,
 * `hooks/post-tool-batch-wave-signal.mjs`, and
 * `hooks/post-tool-failure-corrective-context.mjs` (measured 2026-09-02 @
 * a019d5a4 via `rg -n "function atomicMutateJson" hooks/` — 4 hits, one per
 * file, logic byte-identical modulo the per-file tmp-suffix and the
 * `fs.`-namespace-vs-named-import style `on-session-end.mjs` uses).
 *
 * F-H fix (W3-reviewer finding, #1197): the pre-extraction copies treated
 * EVERY read/parse failure as "file absent" and silently fell back to
 * `defaultValue` — so an unparsable file, `EISDIR`, `EACCES`, or a file
 * truncated mid-write by a concurrent writer was overwritten with
 * `defaultValue`-derived content instead of being left alone. Only `ENOENT`
 * (file genuinely does not exist yet) is a legitimate "start fresh" case;
 * every other failure now aborts BEFORE the tmp-write/rename stage and
 * reports `{ ok: false, reason }` — the original file is never touched.
 *
 * Return-object over throw (deliberate — see #1197 task note): all four
 * callers already run under `main().catch(() => {}).finally(() =>
 * process.exit(0))` — informational, never-deny hooks (verified 2026-09-02:
 * none of the four match a deny/block pattern) — so a thrown error would be
 * swallowed safely too. But in `post-tool-batch-wave-signal.mjs` a throw at
 * the FIRST call site (line ~278, the `last_batch` write) would abort
 * `main()` before it reaches the independent heartbeat-refresh block that
 * follows — a real behavioural loss the thrown-error path would introduce
 * silently. A result object lets every caller decide locally whether an RMW
 * failure should short-circuit the rest of `main()` or just get logged and
 * ignored, so no caller loses unrelated post-call behaviour by construction.
 *
 * NAMED CEILING (BV-004): tmp-file + rename makes each individual write
 * atomic, but not the full read-modify-write — two concurrent callers can
 * still interleave (both read the same `current`, both compute an update
 * from it, the second rename wins and silently drops the first mutation).
 * This module does not defend against that race. Revisit with a per-file
 * lock (e.g. an flock-style sidecar or `session-lock.mjs`'s lease pattern)
 * if `.orchestrator/current-session.json` writes start dropping fields
 * under concurrent-session load — no such loss has been measured yet.
 *
 * @module hooks/_lib/atomic-json
 */

import { readFile, writeFile, rename, mkdir, unlink } from 'node:fs/promises';
import path from 'node:path';

/**
 * Atomic read-modify-write of a JSON file via temp-file + rename.
 *
 * Reads the existing file and parses it as JSON. When the file does not
 * exist (`ENOENT`), starts from `defaultValue` — the only case in which
 * "file absent" is legitimate. Any OTHER read or parse failure (directory
 * at `filePath`, permission denied, truncated/corrupt JSON, …) aborts
 * WITHOUT calling `mutate` and WITHOUT writing anything — the original file
 * (if any) is left exactly as it was.
 *
 * On success, applies the synchronous `mutate` transformer, writes the
 * result to a `${filePath}.tmp-<suffix>-<pid>-<ts>` sibling, then renames it
 * over `filePath` (atomic on POSIX same-filesystem rename; best-effort on
 * Windows). If the write/rename stage itself fails, the tmp file is
 * best-effort unlinked so a failure never leaves an orphaned `.tmp-*`
 * artifact behind.
 *
 * @param {string} filePath — absolute path to the JSON file.
 * @param {object} defaultValue — starting value used ONLY when the file does
 *   not exist yet (`ENOENT`). Never applied on top of an unreadable-but-
 *   present file.
 * @param {function(object): object} mutate — pure synchronous transformer;
 *   receives the parsed current value (or `defaultValue`), returns the next
 *   value to persist.
 * @param {string} [tmpTag] — short tag folded into the tmp filename so
 *   concurrent callers targeting the same `filePath` from different hooks
 *   don't collide on the same tmp path (mirrors the per-caller suffixes the
 *   four pre-extraction copies used: `-cwd-`, `-ose-`, `-ptb-`, `-ptf-`).
 * @returns {Promise<{ ok: true, value: object } | { ok: false, reason: string }>}
 */
export async function atomicMutateJson(filePath, defaultValue, mutate, tmpTag = 'ajs') {
  let current = defaultValue;
  try {
    const raw = await readFile(filePath, 'utf8');
    current = JSON.parse(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      // File genuinely does not exist yet — the only legitimate "fresh
      // file" case. `current` already holds `defaultValue`.
    } else {
      // EISDIR, EACCES, a JSON.parse SyntaxError (unparsable/truncated
      // content), or anything else — never silently treat as "absent".
      // Abort before mutate/write; the original file is untouched.
      return { ok: false, reason: (err && err.code) || 'parse-error' };
    }
  }

  const updated = mutate(current);
  const tmp = `${filePath}.tmp-${tmpTag}-${process.pid}-${Date.now()}`;
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(tmp, JSON.stringify(updated, null, 2) + '\n', 'utf8');
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      // tmp was never created, or is already gone — nothing to clean up.
    }
    return { ok: false, reason: (err && err.code) || 'write-error' };
  }
  return { ok: true, value: updated };
}
