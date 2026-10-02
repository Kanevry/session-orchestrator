/**
 * tail-window.mjs — the ONE bounded tail-window reader for append-only JSONL
 * ledgers and transcripts (#1272).
 *
 * Five call sites used to carry their own copy of this byte-window primitive,
 * and one of them (hooks/subagent-telemetry.mjs) ignored the returned read
 * length and decoded a whole `allocUnsafe` buffer — on a short read that is
 * uninitialised memory handed to JSON.parse. This module owns ONLY the byte
 * window; every caller keeps its own error mapping (null / [] / discriminated
 * result / throw) and its own line logic.
 *
 * Ceiling: the whole window is held in memory at once and decoded in one pass
 * — fine for the windows in use today (64 KiB .. 1 MiB). Revisit if a caller
 * needs a window above ~16 MiB: stream backwards in chunks instead.
 */

import fs from 'node:fs';

/**
 * `open(2)` flags of a `noFollow` read. `O_NOFOLLOW` refuses a symlink as the
 * last path component (ELOOP) in the open itself; `O_NONBLOCK` makes the
 * read-side open of a FIFO return at once instead of blocking until a writer
 * appears (a plain `'r'` open of a planted FIFO blocked a detached scan child
 * for good — reproduced 2026-10-02, #1487). On a regular file `O_NONBLOCK`
 * changes nothing. Both are POSIX-only; Node leaves them undefined on Windows,
 * where the read degrades to a plain open.
 */
const NO_FOLLOW_READ_FLAGS = fs.constants.O_RDONLY
  | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);

/**
 * Read the last `maxBytes` of `file` as UTF-8.
 *
 * `cut` is true when the window did not start at byte 0 — the first line of
 * `text` is then (or may be) a fragment of a record, possibly starting inside
 * a multi-byte UTF-8 sequence, and callers that parse lines should drop it.
 * Loops until the window is filled or the file reports EOF, so a short read
 * never leaves undecoded buffer bytes in `text`.
 *
 * THROWS on any fs error (ENOENT, EACCES, …) — mapping the failure is the
 * caller's decision.
 *
 * `opts.noFollow` is for a file a hostile local writer may have replaced: it
 * opens with {@link NO_FOLLOW_READ_FLAGS} and then refuses anything the
 * descriptor's `fstat` does not call a regular file (FIFO, directory, device),
 * so a symlink throws ELOOP and every other non-regular file throws
 * `ERR_NOT_REGULAR_FILE` — never a blocked open, never a read of a link
 * target. The default (`false`) is the plain `'r'` open every other caller uses.
 *
 * @param {string} file
 * @param {number} maxBytes  window size in bytes (> 0)
 * @param {{noFollow?: boolean}} [opts]
 * @returns {{ text: string, cut: boolean, size: number }}  `size` is the file size at open time
 */
export function readTailWindow(file, maxBytes, { noFollow = false } = {}) {
  const fd = fs.openSync(file, noFollow ? NO_FOLLOW_READ_FLAGS : 'r');
  try {
    const stats = fs.fstatSync(fd);
    if (noFollow && !stats.isFile()) {
      throw Object.assign(new Error('not a regular file'), { code: 'ERR_NOT_REGULAR_FILE' });
    }
    const size = stats.size;
    const want = Math.min(size, maxBytes);
    const start = size - want;
    const buf = Buffer.allocUnsafe(want);
    let read = 0;
    while (read < want) {
      const n = fs.readSync(fd, buf, read, want - read, start + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buf.subarray(0, read).toString('utf8'), cut: start > 0, size };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* best-effort */
    }
  }
}
