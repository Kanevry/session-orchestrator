/**
 * Frontmatter mutation helpers for STATE.md.
 *
 * Pure functions — no file I/O.
 *
 * Plus a small I/O-touching surface (`writeStateMd`, `updateFrontmatterFieldsOnDisk`,
 * `touchUpdatedFieldOnDisk`) added for PRD 2026-05-22 § 4 Pattern 1 (issue #518).
 * These delegate to the pure helpers above but route the actual readFileSync /
 * writeFileSync through `withStateMdLock` from session-lock.mjs so concurrent
 * writers serialise mechanically rather than relying on PSA-004 discipline.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { parseStateMd, serializeStateMd } from './yaml-parser.mjs';
import { withStateMdLock } from '../session-lock.mjs';

/**
 * Sets frontmatter.updated to the given ISO 8601 timestamp and returns the
 * new contents. If the file has no frontmatter, returns input unchanged.
 *
 * @param {string} contents
 * @param {string} isoTimestamp
 * @returns {string}
 */
export function touchUpdatedField(contents, isoTimestamp) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  parsed.frontmatter.updated = isoTimestamp;
  return serializeStateMd(parsed);
}

/**
 * Additively writes frontmatter keys. Only keys present in `fields` are
 * touched; all other existing frontmatter keys (including unknown
 * extensions) are preserved verbatim.
 *
 * Value semantics:
 *   - `null` or `undefined` value → key is DELETED from the frontmatter
 *   - anything else → key is set/overwritten
 *
 * No-ops if `contents` has no frontmatter (returns input unchanged).
 *
 * @param {string} contents
 * @param {object} fields
 * @returns {string}
 */
export function updateFrontmatterFields(contents, fields) {
  const parsed = parseStateMd(contents);
  if (parsed === null) return contents;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    return contents;
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) {
      delete parsed.frontmatter[k];
    } else {
      parsed.frontmatter[k] = v;
    }
  }
  return serializeStateMd(parsed);
}

// ---------------------------------------------------------------------------
// On-disk wrappers (PRD 2026-05-22 § 4 — Pattern 1, issue #518)
// ---------------------------------------------------------------------------
//
// All STATE.md writes from .mjs callers SHOULD route through `writeStateMd`.
// Skill bodies that previously did inline `readFileSync(STATE) → transform →
// writeFileSync(STATE)` migrate to `await writeStateMd(repoRoot, contents => …)`,
// which mechanically serialises concurrent writers via `withStateMdLock`.

// Canonical STATE.md path candidates (matches harness-audit category1 order).
const STATE_MD_CANDIDATES = [
  '.claude/STATE.md',
  '.codex/STATE.md',
  '.cursor/STATE.md',
];

/**
 * Resolve the active STATE.md path under a given repo root.
 *
 * Returns the first existing candidate; falls back to `.claude/STATE.md` when
 * none exist (matches the create-on-first-write semantics expected by callers).
 *
 * @param {string|undefined} repoRoot
 * @returns {string}  Absolute path to STATE.md.
 */
export function resolveStateMdPath(repoRoot) {
  const root = repoRoot ?? process.cwd();
  for (const candidate of STATE_MD_CANDIDATES) {
    const abs = resolvePath(join(root, candidate));
    if (existsSync(abs)) return abs;
  }
  return resolvePath(join(root, STATE_MD_CANDIDATES[0]));
}

/**
 * Atomic write helper: write to a sibling tmp file then rename. Avoids
 * partial-write races with concurrent readers (e.g. session-start probes
 * reading STATE.md while a write is in flight).
 *
 * @param {string} filePath
 * @param {string} contents
 */
function writeFileAtomic(filePath, contents) {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  // Sibling tmp name uses high-entropy suffix to avoid collisions across
  // concurrent attempts. Tmp + rename is atomic on the same filesystem (POSIX).
  const tmpSuffix = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  const tmpFile = `${filePath}.tmp.${tmpSuffix}`;
  writeFileSync(tmpFile, contents, { encoding: 'utf8' });
  renameSync(tmpFile, filePath);
}

/**
 * Lock-guarded STATE.md read-transform-write.
 *
 * Acquires `.orchestrator/state.lock` for the duration of the read +
 * transform + write, releasing it on completion or throw. Concurrent
 * callers serialize on the lock; the second caller observes the first
 * caller's write.
 *
 * The transformer receives the CURRENT contents (string) and MUST return
 * the new contents (string). If the transformer returns `null` or
 * `undefined`, the write is skipped and the lock released — this is the
 * intended path for "read, decide, no-op" flows.
 *
 * If STATE.md does not exist on disk, the transformer receives an empty
 * string. Callers that need to assert presence should `existsSync` upfront.
 *
 * @param {string|undefined} repoRoot
 * @param {(contents: string) => string|null|undefined|Promise<string|null|undefined>} transformer
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs]  — passed to acquireStateLock.
 * @param {string} [opts.holder]     — human-readable holder identifier.
 * @param {number} [opts.pollMs]     — test-only override of poll cadence.
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 */
export async function writeStateMd(repoRoot, transformer, opts = {}) {
  if (typeof transformer !== 'function') {
    throw new TypeError('writeStateMd: transformer must be a function');
  }
  const statePath = resolveStateMdPath(repoRoot);
  return withStateMdLock(
    repoRoot,
    async () => {
      const before = existsSync(statePath) ? readFileSync(statePath, 'utf8') : '';
      const after = await transformer(before);
      if (after === null || after === undefined) {
        return { written: false, path: statePath, contents: null };
      }
      if (typeof after !== 'string') {
        throw new TypeError('writeStateMd: transformer must return a string or null');
      }
      if (after === before) {
        // No textual change — skip the write to keep mtime stable.
        return { written: false, path: statePath, contents: before };
      }
      writeFileAtomic(statePath, after);
      return { written: true, path: statePath, contents: after };
    },
    { timeoutMs: opts.timeoutMs, holder: opts.holder, pollMs: opts.pollMs }
  );
}

/**
 * Guard: throws a clear Error when repoRoot is undefined, null, or empty.
 * Parallel-session CWD drift (PSA rules) makes `process.cwd()` fallbacks a
 * footgun — callers MUST be explicit about which repo root they target.
 *
 * @param {unknown} repoRoot
 * @param {string} fnName  — name of the calling function, for error messages
 */
function requireRepoRoot(repoRoot, fnName) {
  if (!repoRoot) {
    throw new Error(
      `${fnName}: repoRoot is required (got ${typeof repoRoot}). Pass an explicit repo root, e.g. via execSync('git rev-parse --show-toplevel').`
    );
  }
}

/**
 * Convenience wrapper: apply `updateFrontmatterFields` under the state-lock.
 * Pure callers (in-memory transforms) should keep using
 * `updateFrontmatterFields` directly — this wrapper exists for call sites
 * that previously did the read + transform + write inline.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {object} fields
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function updateFrontmatterFieldsOnDisk(repoRoot, fields, opts = {}) {
  requireRepoRoot(repoRoot, 'updateFrontmatterFieldsOnDisk');
  return writeStateMd(repoRoot, (contents) => updateFrontmatterFields(contents, fields), opts);
}

/**
 * Convenience wrapper: apply `touchUpdatedField` under the state-lock.
 *
 * @param {string} repoRoot  — absolute path to the repository root (required)
 * @param {string} [isoTimestamp]  — defaults to current time when omitted.
 * @param {object} [opts]
 * @returns {Promise<{ written: boolean, path: string, contents: string|null }>}
 * @throws {Error} when repoRoot is undefined, null, or empty
 */
export async function touchUpdatedFieldOnDisk(repoRoot, isoTimestamp, opts = {}) {
  requireRepoRoot(repoRoot, 'touchUpdatedFieldOnDisk');
  const ts = typeof isoTimestamp === 'string' && isoTimestamp.length > 0
    ? isoTimestamp
    : new Date().toISOString();
  return writeStateMd(repoRoot, (contents) => touchUpdatedField(contents, ts), opts);
}
