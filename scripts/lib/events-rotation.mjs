/**
 * events-rotation.mjs — size-based rotation for .orchestrator/metrics/events.jsonl.
 *
 * Contract: called from the session-start hook. Returns a result object; never
 * throws on fs errors (rotation failure must not break session-start). Uses
 * synchronous fs calls (the hook is short-lived; async adds complexity).
 *
 * Issue #251 (CRITICAL). Rotation fires only at session-start, not per-append —
 * per-append overhead is wasteful given ~6 KiB/day growth.
 *
 * Rename safety (POSIX): atomic rename is safe with in-flight writers. Old fds
 * continue writing to the original inode (now `events.jsonl.1`); new writers
 * will open the new file on next append.
 */

import { statSync, renameSync, unlinkSync, existsSync } from 'node:fs';

/**
 * Rotate the events log if it exceeds `maxSizeMb`.
 *
 * Shift scheme: `.N-1` → `.N`, …, `.1` → `.2`, active `events.jsonl` → `.1`.
 * The oldest backup (`events.jsonl.{maxBackups}`) is deleted before shifting.
 *
 * @param {object} opts
 * @param {string}  opts.logPath     — absolute path to `events.jsonl`
 * @param {number}  opts.maxSizeMb   — integer 1..1024
 * @param {number}  opts.maxBackups  — integer 1..20
 * @param {boolean} opts.enabled     — if false, returns early
 * @returns {{rotated: boolean, reason?: string, archivedAs?: string, sizeBefore?: number, maxBackups?: number, error?: string}}
 */
export function maybeRotate({ logPath, maxSizeMb, maxBackups, enabled } = {}) {
  // --- Input validation (throw — programmer error, not runtime fs failure) ---
  if (typeof logPath !== 'string' || logPath.length === 0) {
    throw new Error(`events-rotation: logPath must be a non-empty string, got ${typeof logPath}`);
  }
  if (!Number.isInteger(maxSizeMb) || maxSizeMb < 1 || maxSizeMb > 1024) {
    throw new Error(`events-rotation: maxSizeMb must be integer 1..1024, got ${maxSizeMb}`);
  }
  if (!Number.isInteger(maxBackups) || maxBackups < 1 || maxBackups > 20) {
    throw new Error(`events-rotation: maxBackups must be integer 1..20, got ${maxBackups}`);
  }

  if (enabled === false) {
    return { rotated: false, reason: 'disabled' };
  }

  try {
    if (!existsSync(logPath)) {
      return { rotated: false, reason: 'no-file' };
    }

    const sizeBefore = statSync(logPath).size;
    const threshold = maxSizeMb * 1024 * 1024;
    if (sizeBefore < threshold) {
      return { rotated: false, reason: 'under-threshold' };
    }

    // Drop the oldest backup if it exists — this keeps the ring bounded.
    const oldestPath = `${logPath}.${maxBackups}`;
    if (existsSync(oldestPath)) {
      unlinkSync(oldestPath);
    }

    // Shift `.N-1` → `.N`, …, `.1` → `.2`.
    for (let i = maxBackups - 1; i >= 1; i--) {
      const src = `${logPath}.${i}`;
      const dst = `${logPath}.${i + 1}`;
      if (existsSync(src)) {
        renameSync(src, dst);
      }
    }

    // Rotate active file to `.1`. POSIX atomic rename.
    renameSync(logPath, `${logPath}.1`);

    return {
      rotated: true,
      archivedAs: `${logPath}.1`,
      sizeBefore,
      maxBackups,
    };
  } catch (err) {
    // Never throw — rotation failure must not break session-start.
    return { rotated: false, reason: 'error', error: err?.message ?? String(err) };
  }
}
