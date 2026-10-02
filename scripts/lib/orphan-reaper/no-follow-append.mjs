/**
 * orphan-reaper/no-follow-append.mjs — the ONE hardened JSONL append the
 * reaper's two ledgers share: the B5 kill audit (`reaper-audit.mjs`) and the
 * gate-process ledger (`../process-group.mjs`). It was inline in the audit
 * writer; the gate ledger still used a plain `appendFileSync(path)` (#1489).
 *
 * Imports nothing but `node:fs`, so `process-group.mjs` takes it without
 * growing its closure. The read-side twin is `readTailWindow(file, n,
 * { noFollow: true })` in `../tail-window.mjs`.
 */

import { appendFileSync, closeSync, constants as fsConstants, fstatSync, openSync } from 'node:fs';

/** The one refusal every hardened ledger writer prints — the appends here and
 *  the atomic prune rewrites (`replaceRegularFile`) in both ledger modules. */
export const NOT_A_REGULAR_FILE = 'not a regular file (a symlink is never written through) — left untouched';

/**
 * `open(2)` flags of the append. `O_NOFOLLOW` makes the kernel refuse a
 * symlink as the last path component (ELOOP) in the same call that opens the
 * file, so there is no lstat-then-open window; `O_NONBLOCK` turns a planted FIFO
 * with no reader into ENXIO instead of blocking in `open` (a plain append open
 * of a FIFO waits for a reader that never comes — reproduced 2026-10-02, #1487).
 * On a regular file `O_NONBLOCK` changes nothing.
 * Named ceiling (BV-004): both are POSIX-only — Node leaves them undefined on
 * Windows, where a linked ledger is still followed; revisit if the reaper or the
 * gate ledger ever runs there.
 */
const APPEND_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT
  | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);

/** @returns {Error & {code: string}} */
function notARegularFile() {
  return Object.assign(new Error(NOT_A_REGULAR_FILE), { code: 'ERR_NOT_REGULAR_FILE' });
}

/**
 * Append `data` to `target`, creating it if absent — but never THROUGH a link
 * and never blocked by a FIFO.
 *
 * The check is the open itself ({@link APPEND_FLAGS}) plus an `fstat` of the
 * descriptor that was opened — never a separate lstat. That `fstat` refuses
 * what the open let through: a FIFO that HAD a reader, a directory, a device,
 * and a HARD-linked file (`nlink !== 1`): `ln <victim> <ledger>` passes every
 * symlink check, and each append would then land in the victim (reproduced
 * 2026-10-02 against the audit).
 *
 * THROWS — mapping a failure to a WARN line is the caller's job, as with
 * `readTailWindow`. A symlink or any non-regular file throws
 * `code: 'ERR_NOT_REGULAR_FILE'` with message {@link NOT_A_REGULAR_FILE}; a
 * hard-linked file throws `code: 'ERR_HARD_LINKED'`; a FIFO without a reader
 * throws the kernel's ENXIO unchanged; every other fs error passes through.
 *
 * @param {string} target  Absolute path; its directory must already exist.
 * @param {string} data
 * @returns {void}
 */
export function appendNoFollow(target, data) {
  let fd;
  try {
    fd = openSync(target, APPEND_FLAGS);
  } catch (err) {
    throw err?.code === 'ELOOP' ? notARegularFile() : err;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw notARegularFile();
    if (stats.nlink !== 1) {
      throw Object.assign(
        new Error(`hard-linked (${stats.nlink} names) — an append would write into every one of them; left untouched`),
        { code: 'ERR_HARD_LINKED' },
      );
    }
    appendFileSync(fd, data, 'utf8');
  } finally {
    try { closeSync(fd); } catch { /* nothing left to release */ }
  }
}
