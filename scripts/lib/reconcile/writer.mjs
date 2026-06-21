/**
 * writer.mjs — FA3 writer seam for the Reconciliation Engine (Epic #693, issue #696).
 *
 * Persists APPROVED reconciliation rule proposals to `.claude/rules/` AFTER
 * operator approval. This is the one and only module that writes `.claude/rules/`
 * on behalf of the engine — the FA2 engine/renderer NEVER touch the filesystem
 * for rule files.
 *
 * Responsibilities:
 *  - Acquire a per-write file lock (`.orchestrator/rules.lock`) to serialise
 *    concurrent writers — mirrors PSA-005 (withStateMdLock) pattern.
 *  - For each approved proposal: path-safety guard → mkdirSync → atomic tmp+rename write.
 *  - For each rejected proposal: JSONL-append to `.orchestrator/reconcile.rejected.log`.
 *  - Never throws — all failures are collected into errors[] and returned.
 *
 * Path-safety:
 *  - `validatePathInsideProject(item.path, repoRoot, {canonicalizeRoot:true})` is
 *    the primary guard (two-phase lexical + realpath, CWE-22 defence).
 *  - Additional assertion: resolved path must be inside `<repoRoot>/.claude/rules/`.
 *  - Both guards must pass; failure skips the record and pushes an error string.
 *
 * Atomic write strategy (rule files):
 *  - Write content to `<target>.XXXXXXXX.tmp` via `writeFileSync`, then
 *    `renameSync` over the final path. Same-filesystem rename is atomic on POSIX,
 *    so the rule file is never partially visible. Mirrors idempotency.mjs pattern.
 *
 * JSONL append strategy (rejected log):
 *  - `appendFileSync` for the rejected log — each record is a self-contained line,
 *    and POSIX append (O_APPEND) is atomic for writes < PIPE_BUF (4096 bytes),
 *    which every JSONL record satisfies. Mirrors memory-proposals/sink.mjs pattern.
 *
 * DI-friendly: accepts repoRoot as a parameter; no global cwd assumptions.
 *
 * Plain Node ESM, no external deps — Node 20+ stdlib + sibling scripts/lib only.
 *
 * Part of Epic #693 → issue #696 (FA3 Advisory Delivery).
 *
 * @module reconcile/writer
 */

import { mkdirSync, writeFileSync, renameSync, appendFileSync, realpathSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { withFileLock } from '../file-lock.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';

// ---------------------------------------------------------------------------
// Path constants (relative to repoRoot)
// ---------------------------------------------------------------------------

/** Lock file that serialises concurrent rule-write operations. */
const RULES_LOCK_REL = path.join('.orchestrator', 'rules.lock');

/** Directory where auto-generated rule files are written (repo-relative). */
const RULES_DIR_REL = path.join('.claude', 'rules');

/** Rejected-proposals log for rules declined by the operator (repo-relative). */
const REJECTED_LOG_REL = path.join('.orchestrator', 'reconcile.rejected.log');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute rules directory for the given repoRoot. Used both for
 * the per-proposal assertion and for mkdirSync.
 *
 * @param {string} repoRoot
 * @returns {string}
 */
function rulesAbsDir(repoRoot) {
  return path.resolve(repoRoot, RULES_DIR_REL);
}

/**
 * Write `content` to `destPath` atomically via tmp+rename.
 *
 * Uses a random 8-hex-char suffix for the tmp file to avoid collisions when
 * multiple proposals write to the same directory concurrently (defensive;
 * under the lock this should not happen, but the pattern is cheap).
 *
 * Throws on filesystem errors — callers must catch.
 *
 * @param {string} destPath - absolute path of the target rule file.
 * @param {string} content  - UTF-8 text content to write.
 */
function writeTextAtomic(destPath, content) {
  const dir = path.dirname(destPath);
  mkdirSync(dir, { recursive: true });
  const suffix = randomBytes(4).toString('hex');
  const tmpPath = `${destPath}.${suffix}.tmp`;
  writeFileSync(tmpPath, content, 'utf8');
  renameSync(tmpPath, destPath);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} WriterApprovedItem
 * @property {string} slug     - kebab-case slug (from renderer.mjs / engine.mjs).
 * @property {string} path     - repo-relative rule path (`.claude/rules/<slug>.md`).
 * @property {string} content  - full rendered markdown content.
 * @property {string} [learningKey]
 * @property {number} [confidence]
 * @property {string} [candidateId]
 * @property {string} [status]
 */

/**
 * @typedef {Object} WriterRejectedItem
 * @property {string} [learningKey]
 * @property {string} [type]
 * @property {string} [reason]
 * @property {string} [status]
 */

/**
 * @typedef {Object} WriteApprovedRulesResult
 * @property {number}   written   - number of rule files successfully written.
 * @property {number}   archived  - number of rejected records appended to the log.
 * @property {string[]} errors    - per-item error strings (never fatal).
 */

/**
 * Persist approved reconciliation rule proposals to `.claude/rules/` and
 * archive rejected proposals to the rejected log.
 *
 * NEVER throws — all per-item failures are collected into `errors[]`.
 *
 * @param {Object}                opts
 * @param {WriterApprovedItem[]}  opts.approved   - proposals approved by the operator.
 * @param {WriterRejectedItem[]}  [opts.rejected]  - proposals declined by the operator.
 * @param {string}                opts.repoRoot   - absolute repo root path.
 * @param {string}                [opts.sessionId] - current session id (informational; unused in v1).
 * @returns {Promise<WriteApprovedRulesResult>}
 */
export async function writeApprovedRules({ approved, rejected = [], repoRoot, sessionId: _sessionId }) {
  // Defensive: coerce inputs
  const approvedItems = Array.isArray(approved) ? approved : [];
  const rejectedItems = Array.isArray(rejected) ? rejected : [];

  if (approvedItems.length === 0 && rejectedItems.length === 0) {
    return { written: 0, archived: 0, errors: [] };
  }

  const lockPath = path.join(repoRoot, RULES_LOCK_REL);

  // Ensure .orchestrator dir exists so lock acquisition can create the lock file.
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch {
    // Non-fatal: withFileLock will surface the fs-error if the lock cannot be created.
  }

  // Acquire the rules lock — serialises concurrent rule writes.
  const lockResult = await withFileLock(
    lockPath,
    async () => {
      /** @type {string[]} */
      const errors = [];
      let written = 0;
      let archived = 0;

      const rulesDir = rulesAbsDir(repoRoot);

      // Parent-directory symlink hardening (#697 security follow-up): if
      // `.claude/rules/` is itself a pre-planted symlink to a directory outside
      // the repo, a lexically-safe leaf path would still be written through it.
      // Resolve the directory's realpath once and refuse all writes if it
      // escapes the canonical repo root. Requires local FS write access to
      // exploit (below the VCS trust boundary) but the guard is one cheap call.
      let rulesDirSafe = true;
      try {
        mkdirSync(rulesDir, { recursive: true });
        let canonRoot = repoRoot;
        try { canonRoot = realpathSync(repoRoot); } catch { /* fall back to lexical */ }
        const expectedRulesDir = path.resolve(canonRoot, RULES_DIR_REL);
        const realRulesDir = realpathSync(rulesDir);
        if (realRulesDir !== expectedRulesDir && !realRulesDir.startsWith(expectedRulesDir + path.sep)) {
          errors.push('path-confinement: .claude/rules/ resolves outside the repo (symlinked dir) — all approved writes skipped');
          rulesDirSafe = false;
        }
      } catch { /* mkdir/realpath failure — per-item writes will surface errors normally */ }

      // ── Step 1: write approved rule files ──────────────────────────────────
      for (const item of approvedItems) {
        if (!rulesDirSafe) break;
        // Guard: item must have a path string
        if (!item || typeof item.path !== 'string' || item.path.length === 0) {
          errors.push(`approved item missing path: ${JSON.stringify(item)}`);
          continue;
        }

        // Primary path-safety guard (two-phase lexical + realpath, CWE-22 defence)
        const pathResult = validatePathInsideProject(item.path, repoRoot, { canonicalizeRoot: true });
        if (!pathResult.ok) {
          errors.push(`path-safety (${pathResult.reason}): "${item.path}" — skipped`);
          continue;
        }

        // Resolve the absolute write target from the validated lexical path
        const absPath = pathResult.realPath ?? pathResult.lexicalPath;

        // Defense-in-depth: assert the resolved path is inside .claude/rules/.
        // Canonicalize repoRoot the same way validatePathInsideProject does
        // (opts.canonicalizeRoot:true) so the prefix check is consistent on
        // platforms where os.tmpdir() has a symlink (e.g. macOS /var → /private/var).
        let canonRoot = repoRoot;
        try { canonRoot = realpathSync(repoRoot); } catch { /* ENOENT/EACCES: fall back to lexical */ }
        const resolvedRulesDir = path.resolve(canonRoot, RULES_DIR_REL);
        if (!absPath.startsWith(resolvedRulesDir + path.sep) && absPath !== resolvedRulesDir) {
          errors.push(`path-confinement: "${item.path}" resolves outside .claude/rules/ — skipped`);
          continue;
        }

        // Guard: content must be a string
        if (typeof item.content !== 'string') {
          errors.push(`approved item "${item.path}" has non-string content — skipped`);
          continue;
        }

        // Ensure .claude/rules/ exists and write atomically
        try {
          mkdirSync(rulesDir, { recursive: true });
          writeTextAtomic(absPath, item.content);
          written++;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          errors.push(`write failed "${item.path}": ${msg}`);
        }
      }

      // ── Step 2: archive rejected proposals to the rejected log ─────────────
      if (rejectedItems.length > 0) {
        const rejectedLogRelPath = REJECTED_LOG_REL;
        const logResult = validatePathInsideProject(rejectedLogRelPath, repoRoot, { canonicalizeRoot: true });

        if (!logResult.ok) {
          errors.push(`path-safety (rejected log): ${logResult.reason} (${rejectedLogRelPath})`);
        } else {
          const rejectedLogPath = logResult.realPath ?? logResult.lexicalPath;

          // Ensure parent directory exists
          try {
            mkdirSync(path.dirname(rejectedLogPath), { recursive: true });
          } catch (err) {
            const msg = err && err.message ? err.message : String(err);
            errors.push(`mkdir failed (rejected log): ${msg}`);
          }

          const rejectedAt = new Date().toISOString();

          for (const item of rejectedItems) {
            try {
              const archiveRecord = {
                ...item,
                _rejected_reason: (item && typeof item.reason === 'string' && item.reason !== '')
                  ? item.reason
                  : 'user-declined',
                _rejected_at: rejectedAt,
              };
              const line = JSON.stringify(archiveRecord) + '\n';
              appendFileSync(rejectedLogPath, line, 'utf8');
              archived++;
            } catch (err) {
              const msg = err && err.message ? err.message : String(err);
              const key = (item && item.learningKey) ? item.learningKey : '<unknown>';
              errors.push(`archive failed "${key}": ${msg}`);
            }
          }
        }
      }

      return { written, archived, errors };
    },
    { timeoutMs: 10000 },
  );

  // If lock acquisition failed, return a zeroed result with the lock error.
  if (lockResult.ok === false) {
    return {
      written: 0,
      archived: 0,
      errors: [`lock-${lockResult.reason ?? 'unknown'}`],
    };
  }

  // Unwrap the result returned from inside the lock body.
  return lockResult.value;
}
