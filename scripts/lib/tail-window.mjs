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
 * @param {string} file
 * @param {number} maxBytes  window size in bytes (> 0)
 * @returns {{ text: string, cut: boolean, size: number }}  `size` is the file size at open time
 */
export function readTailWindow(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
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
