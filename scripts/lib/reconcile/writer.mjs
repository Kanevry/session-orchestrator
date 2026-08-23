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
 *  - For each approved proposal: path-safety guard → STRUCTURAL content gate
 *    (#1015, see {@link frontmatterRefusalReason}) → mkdirSync → atomic
 *    tmp+rename write → stamp the idempotency sidecar terminal via
 *    `markCandidateProcessed` (issue #484 point 1) so a later reconcile run's
 *    `isProcessed()` check does not re-propose the same learning.
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
import { parseGlobsFrontmatter } from '../rule-loader.mjs';
import { markCandidateProcessed } from './idempotency.mjs';

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

/**
 * STRUCTURAL content gate (#1015) — the last chokepoint before disk.
 *
 * Every other defence in this module is PATH-oriented (`validatePathInsideProject`,
 * the `.claude/rules/` confinement assertion, the parent-symlink realpath check,
 * the file lock). Not one of them inspects a single byte of `content`, so a rule
 * document whose frontmatter was corrupted upstream — by an injected newline in
 * an agent-authored field, or by truncation — reached disk unexamined.
 *
 * This gate re-parses the rendered document with the REAL loader parser and
 * refuses the write when the document could not be audited or would load
 * always-on. It is deliberately STRUCTURAL, not content-semantic: it never
 * inspects or rewrites what the text SAYS, only whether the document still
 * serialises to the frontmatter contract it claims. Neutralising agent text is
 * the renderer's single responsibility; this gate does not duplicate it.
 *
 * Two proven injection outcomes it catches (both verified against the real
 * parser + `rule-loader.mjs`):
 *  - an injected `\n---` closes the frontmatter early → `globs` becomes null and
 *    `learning-key`/`expires-at` are gone → `rule-loader.mjs` (~:519-530) pushes
 *    the entry with `alwaysOn: true` and no expiry;
 *  - an injected newline followed by a colon-less line → `parseGlobsFrontmatter`
 *    THROWS → `rule-loader.mjs` (~:500-507) falls back to
 *    `globs=null, meta={}, parseError=true` → always-on again, and with empty
 *    meta it passes every gate by design.
 *
 * Scope (#1018 L2) — three tiers, deliberately not one:
 *
 *  1. PARSE — every document. Unparseable means unsafe, not unknown.
 *  2. `alwaysApply: true` — every document, regardless of any marker. A rule
 *     file that DECLARES itself always-on is precisely the outcome this gate
 *     exists to prevent, and declaring it must not be the way around the gate.
 *     Before #1018 this check sat behind the `auto-generated: true` branch, so
 *     a document with `alwaysApply: true` and no `auto-generated` key was
 *     written to disk unexamined — measured, not inferred: a `writeApprovedRules`
 *     probe returned `written: 1` for exactly that input.
 *  3. The never-always-on invariant set (activation axis, non-empty globs,
 *     `learning-key`, `expires-at`) — every document carrying ANY machine-
 *     provenance marker (`auto-generated: true`, `learning-key`, or
 *     `expires-at`). Keying on the marker SET rather than on `auto-generated`
 *     alone means a document that loses its `auto-generated` line to truncation
 *     but keeps its provenance keys is still held to the invariant.
 *
 * Why tier 3 is marker-scoped and not universal — measured against the live
 * corpus, not assumed: applying the invariant set to EVERY document would
 * refuse 16 of the 29 files currently in `.claude/rules/`. Those 16 are the
 * hand-authored always-on rules (`development.md`, `security.md`,
 * `parallel-sessions.md`, …), for which always-on is the intended, correct
 * shape — they carry no frontmatter at all. A universal gate would therefore
 * refuse the legitimate majority of the corpus to catch a machine-path defect.
 * Marker-scoped refuses 0 of 29. The module's general contract survives: a
 * caller may still write a document with no frontmatter.
 *
 * CEILING (BV-004): the marker set is a fixed three-key list, not a schema
 * lookup. Revisit if the renderer gains a fourth provenance key, or if a second
 * non-reconcile caller of `writeApprovedRules` appears — today there is exactly
 * one production caller and it passes renderer output.
 *
 * Mirrors `scripts/lib/validate/check-rules.mjs`, which enforces the same
 * invariants as a CI gate. Two enforcement points, one invariant: CI catches
 * what is already on disk, this catches it before it lands.
 *
 * @param {string} content - the full rendered markdown document.
 * @returns {string|null} a refusal reason, or `null` when the document is sound.
 */
function frontmatterRefusalReason(content) {
  let parsed;
  try {
    parsed = parseGlobsFrontmatter(content);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    return `frontmatter does not parse (${msg}) — rule-loader.mjs treats a parse error as ALWAYS-ON with empty meta, so this file would load in every context and pass every gate`;
  }

  const { globs, meta } = parsed;
  const hasKey = (key) => Object.prototype.hasOwnProperty.call(meta, key);

  const problems = [];

  // ── Tier 2: binds on EVERY document (see the scope note above) ────────────
  // Not gated behind any marker: a document that declares itself always-on is
  // the exact outcome this gate prevents, so the declaration cannot be the
  // escape hatch. The renderer only ever emits `alwaysApply: false`.
  if (meta.alwaysApply === true) {
    problems.push(
      'alwaysApply: true — a rule written through this writer must never declare itself always-on (the renderer only ever emits false)',
    );
  }

  // ── Tier 3: binds on any machine-provenance-bearing document ──────────────
  // Marker-scoped rather than universal so the hand-authored always-on corpus
  // (16 of 29 live rule files) keeps writing; marker-scoped rather than
  // `auto-generated`-only so a document that loses that line to truncation but
  // keeps its provenance keys is still held to the invariant.
  const isProvenanceBearing =
    meta['auto-generated'] === true || hasKey('learning-key') || hasKey('expires-at');

  if (isProvenanceBearing) {
    const hasEmptyGlobs = Array.isArray(globs) && globs.length === 0;
    const hasGlobs = Array.isArray(globs) && globs.length > 0;
    const hasHostClass = hasKey('host-class');

    if (hasEmptyGlobs) {
      // NOT the "no axis" case and NOT always-on — the opposite: rule-loader.mjs
      // excludes on `globs.length === 0` unconditionally, AFTER gating, so the
      // rule never loads in ANY context even alongside a host-class: key.
      problems.push('empty globs array (globs: []) — the rule would match nothing and never load in ANY context');
    } else if (!hasGlobs && !hasHostClass) {
      problems.push('no activation axis (globs absent AND host-class absent) — the rule would load always-on');
    }
    if (!hasKey('learning-key')) {
      problems.push('missing required frontmatter key: learning-key');
    }
    if (!hasKey('expires-at')) {
      problems.push('missing required frontmatter key: expires-at');
    }
  }

  if (problems.length === 0) return null;
  return `rule fails the never-always-on invariant: ${problems.join('; ')}`;
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
      // Shared stamp for every candidate this batch writes — mirrors `rejectedAt`
      // below (step 2), one timestamp per invocation rather than one per item.
      const approvedAt = new Date().toISOString();

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

        // Structural content gate (#1015) — runs BEFORE any mkdir/tmp-file
        // creation, so a refused write leaves no `.tmp` residue behind.
        const refusal = frontmatterRefusalReason(item.content);
        if (refusal !== null) {
          errors.push(`content-structure: "${item.path}" — ${refusal} — skipped`);
          continue;
        }

        // Ensure .claude/rules/ exists and write atomically
        let writeOk = false;
        try {
          mkdirSync(rulesDir, { recursive: true });
          writeTextAtomic(absPath, item.content);
          written++;
          writeOk = true;
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          errors.push(`write failed "${item.path}": ${msg}`);
        }

        // Stamp the idempotency sidecar (issue #484 point 1): once a rule
        // file is on disk, the candidate that proposed it must be marked
        // terminal, or the next reconcile run has no way to know the
        // proposal was already acted on and re-proposes it. Best-effort and
        // gated on a successful write — the rule file landing is the thing
        // that matters; a stamp failure is reported but does not undo it.
        if (writeOk && typeof item.learningKey === 'string' && item.learningKey.length > 0) {
          const stampResult = markCandidateProcessed({
            learningKey: item.learningKey,
            outcome: 'written',
            processedAt: approvedAt,
            fallbackSlug: item.slug,
            fallbackCandidateId: item.candidateId,
            fallbackConfidence: item.confidence,
            repoRoot,
          });
          if (!stampResult.written) {
            errors.push(
              `sidecar-stamp failed for "${item.path}" (learningKey=${item.learningKey}) — rule file was written but the idempotency sidecar was not updated`,
            );
          }
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
