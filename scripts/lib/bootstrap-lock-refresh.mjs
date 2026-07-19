/**
 * bootstrap-lock-refresh.mjs — #57
 * Provenance-honest `.orchestrator/bootstrap.lock` refresh writer.
 *
 * `checkBootstrapLockFreshness()` (bootstrap-lock-freshness.mjs) can only ever
 * *diagnose* a stale/drifted lock — it is read-only by design. Before #57 the
 * only remediation the surrounding prose offered was `/bootstrap --retroactive`,
 * which is a no-op once the lock already has valid `version`/`tier` fields
 * (see the Retroactive Flow's idempotency guard in `skills/bootstrap/SKILL.md`)
 * — the operator would re-run the recommended command and see nothing change.
 *
 * `refreshBootstrapLock()` closes that gap: it acknowledges the current
 * plugin version and resets the freshness clock by appending/updating exactly
 * two fields — `refreshed-at` and `refreshed-plugin-version` — while leaving
 * every other line of the lock file byte-identical. The ORIGINAL bootstrap
 * provenance (`bootstrapped-at`/`timestamp`, `plugin-version`, `tier`,
 * `archetype`, `source`, …) is never rewritten. This is the load-bearing
 * guarantee: a refresh is an acknowledgement, not a re-bootstrap.
 *
 * Plain-JS — no Zod dependency. Never throws; every failure path returns a
 * structured `{ ok: false, reason, message }` object. Never fabricates a lock
 * — a missing or structurally invalid lock is refused, not synthesized.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { parseBootstrapLock } from './bootstrap-lock-freshness.mjs';

const PRECONDITION_MESSAGE_SUFFIX =
  'run /bootstrap or /bootstrap --retroactive first.';

/**
 * Locate the (trimmed, comment-skipping) line index for a given top-level
 * lock key, mirroring {@link parseBootstrapLock}'s own key-extraction rules
 * so upsert targets the same line parseBootstrapLock would report for `key`.
 *
 * @param {string[]} lines
 * @param {string} key
 * @returns {number} 0-based index, or -1 when not found.
 */
function findKeyLineIndex(lines, key) {
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;
    if (trimmed.slice(0, colonIdx).trim() === key) return i;
  }
  return -1;
}

/**
 * Replace the line for `key` in place, or append a new `key: value` line
 * when absent. Mutates `lines` in place; every other line is left untouched.
 *
 * @param {string[]} lines
 * @param {string} key
 * @param {string} value
 */
function upsertKeyLine(lines, key, value) {
  const formatted = `${key}: ${value}`;
  const idx = findKeyLineIndex(lines, key);
  if (idx === -1) {
    lines.push(formatted);
  } else {
    lines[idx] = formatted;
  }
}

/**
 * Strip CR/LF from a value before it is composed into an upserted `key:
 * value` lock line — defense-in-depth: a malformed `currentPluginVersion`
 * (or, symmetrically, the generated ISO timestamp) containing an embedded
 * newline could otherwise inject an arbitrary forged `key: value` line into
 * the lock file via {@link upsertKeyLine}. Never throws; non-string input is
 * returned unchanged (callers already guard the string check).
 *
 * @param {string} value
 * @returns {string}
 */
function sanitizeLockValue(value) {
  return typeof value === 'string' ? value.replace(/[\r\n]/g, '') : value;
}

/**
 * Atomically write `content` to `filePath` via tmp-file + renameSync — the
 * same crash-safe pattern used by `scripts/lib/io.mjs#writeJsonAtomicSync`
 * and `scripts/lib/session-lock.mjs`, adapted for raw (non-JSON) text.
 *
 * @param {string} filePath
 * @param {string} content
 */
function writeTextAtomicSync(filePath, content) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const tmpSuffix = randomBytes(6).toString('hex');
  const tmpFile = join(dir, `.bootstrap-lock-refresh.${tmpSuffix}.tmp`);
  writeFileSync(tmpFile, content, { encoding: 'utf8' });
  renameSync(tmpFile, filePath);
}

/**
 * Refreshes `.orchestrator/bootstrap.lock` in place: acknowledges the current
 * plugin version and resets the freshness clock without disturbing the
 * lock's original bootstrap provenance.
 *
 * Precondition: the lock must exist and parse with non-empty `version` and
 * `tier` fields. A missing or structurally invalid lock is refused — this
 * function never fabricates a lock (that is `/bootstrap` or
 * `/bootstrap --retroactive`'s job, not this one's).
 *
 * Write contract (provenance honesty, #57): every line of the existing lock
 * is preserved byte-for-byte EXCEPT the `refreshed-at` line (always written)
 * and the `refreshed-plugin-version` line (written only when
 * `currentPluginVersion` is a non-empty string). Re-running twice replaces
 * those two lines in place — it never duplicates them (idempotent).
 *
 * @param {{repoRoot: string, currentPluginVersion?: string, now?: number}} opts
 * @returns {{ok: true, path: string, refreshedAt: string, refreshedPluginVersion: string|null}
 *          | {ok: false, reason: 'missing-or-invalid', message: string}}
 */
export function refreshBootstrapLock({ repoRoot, currentPluginVersion, now = Date.now() } = {}) {
  if (!repoRoot) {
    return {
      ok: false,
      reason: 'missing-or-invalid',
      message: `bootstrap.lock: repoRoot not provided — ${PRECONDITION_MESSAGE_SUFFIX}`,
    };
  }

  const lockPath = join(repoRoot, '.orchestrator', 'bootstrap.lock');

  if (!existsSync(lockPath)) {
    return {
      ok: false,
      reason: 'missing-or-invalid',
      message: `bootstrap.lock missing — ${PRECONDITION_MESSAGE_SUFFIX}`,
    };
  }

  let raw;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return {
      ok: false,
      reason: 'missing-or-invalid',
      message: `bootstrap.lock: failed to read file — ${PRECONDITION_MESSAGE_SUFFIX}`,
    };
  }

  const parsed = parseBootstrapLock(raw);
  if (!parsed['version'] || !parsed['tier']) {
    return {
      ok: false,
      reason: 'missing-or-invalid',
      message: `bootstrap.lock: missing required version/tier fields — ${PRECONDITION_MESSAGE_SUFFIX}`,
    };
  }

  const hadTrailingNewline = raw.endsWith('\n');
  const lines = raw.split('\n');
  if (hadTrailingNewline) lines.pop(); // drop the implicit empty tail element from split()

  const refreshedAt = sanitizeLockValue(new Date(now).toISOString());
  const refreshedPluginVersion =
    typeof currentPluginVersion === 'string' && currentPluginVersion.length > 0
      ? sanitizeLockValue(currentPluginVersion)
      : null;

  upsertKeyLine(lines, 'refreshed-at', refreshedAt);
  if (refreshedPluginVersion !== null) {
    upsertKeyLine(lines, 'refreshed-plugin-version', refreshedPluginVersion);
  }

  const newContent = lines.join('\n') + (hadTrailingNewline ? '\n' : '');
  writeTextAtomicSync(lockPath, newContent);

  return {
    ok: true,
    path: lockPath,
    refreshedAt,
    refreshedPluginVersion,
  };
}
