/**
 * no-follow-open.mjs — open a regular file for reading without following a
 * symlink in the final path component, on every platform (#1744).
 *
 * Node leaves `fs.constants.O_NOFOLLOW` and `O_NONBLOCK` undefined on win32, so
 * callers that gated their read on those flags silently skipped it there.
 */

import { constants as fsConstants, promises as fsPromises } from 'node:fs';

const codedError = (message, code) => Object.assign(new Error(message), { code });

/**
 * Open `target` read-only without following a final-component symlink.
 *
 * - POSIX (`O_NOFOLLOW` and `O_NONBLOCK` both defined): one
 *   `open(O_RDONLY | O_NOFOLLOW | O_NONBLOCK)`; a symlink fails with the
 *   kernel's `ELOOP`. Callers keep doing their own stat checks on the handle.
 * - Fallback (either flag missing, i.e. win32): `lstat` first — a symlink
 *   (Node reports Windows junctions as symlinks too) throws `code: 'ELOOP'`, a
 *   non-regular file throws `code: 'ERR_NOT_REGULAR_FILE'`; then `open('r')`
 *   and compare the handle's identity with the lstat. A non-regular file or a
 *   different `dev`/`ino` closes the handle and throws `code: 'ERR_FILE_CHANGED'`
 *   (the path was swapped between check and open). Bigint stats, because
 *   Windows file IDs can exceed 2^53.
 *
 * BV-004 ceiling: the fallback still has a window between lstat and open. On
 * win32 there are no FIFOs in the filesystem namespace, so the open cannot
 * block, and the post-open identity check catches a swap. Revisit when a POSIX
 * platform lacks O_NONBLOCK, or a caller must read a FIFO-capable location on
 * such a platform.
 *
 * @param {string} target
 * @param {{ constants?: Record<string, number|undefined>, fsImpl?: typeof fsPromises }} [options]
 *   Injection exists only so the fallback branch is testable on POSIX CI;
 *   production callers pass nothing.
 * @returns {Promise<import('node:fs/promises').FileHandle>} caller closes it
 */
export async function openNoFollow(target, { constants = fsConstants, fsImpl = fsPromises } = {}) {
  if (typeof constants.O_NOFOLLOW === 'number' && typeof constants.O_NONBLOCK === 'number') {
    return fsImpl.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  }
  const before = await fsImpl.lstat(target, { bigint: true });
  if (before.isSymbolicLink()) throw codedError(`${target} is a symbolic link`, 'ELOOP');
  if (!before.isFile()) throw codedError(`${target} is not a regular file`, 'ERR_NOT_REGULAR_FILE');
  const handle = await fsImpl.open(target, 'r');
  try {
    const after = await handle.stat({ bigint: true });
    if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
      throw codedError(`${target} changed between check and open`, 'ERR_FILE_CHANGED');
    }
  } catch (err) {
    await handle.close();
    throw err;
  }
  return handle;
}
