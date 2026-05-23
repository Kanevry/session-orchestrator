/**
 * memory-proposals/sink.mjs — Promotion + archival sink for AUQ-reviewed proposals.
 *
 * Converts AUQ-approved proposals into learnings.jsonl records and archives
 * rejected proposals to .orchestrator/proposals.rejected.log. Clears
 * proposals.jsonl at end-of-cycle.
 *
 * Responsibilities:
 *  - writeApproved:      promote approved ProposalRecords → learnings.jsonl
 *  - archiveRejected:    append rejected ProposalRecords → proposals.rejected.log
 *  - clearProposalsJsonl: truncate proposals.jsonl to 0 bytes
 *
 * All three exported functions:
 *  - Never throw on individual record errors — collect into errors[] and continue.
 *  - Use path-safety guards (isPathInside + realpathSync) on all write targets.
 *  - Use the appendLearning() atomic-append pattern from learnings/io.mjs.
 *
 * Issue: #501 (F2.1 Memory-Proposals)
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { realpathSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendLearning } from '../learnings/io.mjs';
import { isPathInside } from '../path-utils.mjs';

// ---------------------------------------------------------------------------
// Path constants (relative to repoRoot)
// ---------------------------------------------------------------------------

const LEARNINGS_REL = path.join('.orchestrator', 'metrics', 'learnings.jsonl');
const PROPOSALS_REL = path.join('.orchestrator', 'metrics', 'proposals.jsonl');
const REJECTED_LOG_REL = path.join('.orchestrator', 'proposals.rejected.log');

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve a repo-relative path and validate it is inside repoRoot.
 * Returns the resolved absolute path on success.
 * Throws if the resolved path escapes repoRoot (path-traversal guard).
 *
 * Uses realpathSync when the path already exists (symlink-escape check),
 * falls back to path.resolve when the path does not yet exist (ENOENT case).
 *
 * @param {string} repoRoot - absolute project root
 * @param {string} relPath  - path relative to repoRoot
 * @returns {string} resolved absolute path (safe)
 */
function _resolveAndValidate(repoRoot, relPath) {
  // Canonicalize repoRoot first so symlink-aware comparisons work on macOS
  // (where /var/... realpath-resolves to /private/var/...). Without this,
  // isPathInside rejects valid tmpdir paths whose canonical form differs
  // from the lexical form passed in.
  let canonicalRoot = repoRoot;
  if (existsSync(repoRoot)) {
    try {
      canonicalRoot = realpathSync(repoRoot);
    } catch {
      // Best-effort — fall back to lexical repoRoot if realpath fails.
    }
  }

  const resolved = path.resolve(canonicalRoot, relPath);

  // Lexical path-traversal guard (covers ../ and absolute-escape attacks)
  if (!isPathInside(resolved, canonicalRoot)) {
    throw new Error(
      `[sink] path-safety violation: resolved path escapes repoRoot (${relPath})`
    );
  }

  // Symlink-escape guard: only when path already exists
  if (existsSync(resolved)) {
    let real;
    try {
      real = realpathSync(resolved);
    } catch {
      // realpathSync should not throw on an existing path, but be defensive
      return resolved;
    }
    if (!isPathInside(real, canonicalRoot)) {
      throw new Error(
        `[sink] path-safety violation: realpath escapes repoRoot (${relPath})`
      );
    }
    return real;
  }

  return resolved;
}

/**
 * Build a learning record from an approved proposal.
 *
 * Adds the 6 required extra fields:
 *   schema_version, source_session, expires_at (via appendLearning),
 *   scope, occurrences, _provenance
 *
 * Strips proposed_by_agent (audit-only, not persisted in learnings — privacy).
 *
 * NOTE: expires_at derivation is delegated to appendLearning() in io.mjs,
 * which calls deriveExpiresAt(createdAt, type) from learnings/schema.mjs.
 * We do not pre-compute it here to avoid duplicating that logic.
 *
 * NOTE: scope 'project' from the task spec is not a valid VALID_SCOPES value
 * in learnings/schema.mjs (valid: 'local' | 'private' | 'public'). We use
 * 'local' as the correct project-scoped equivalent to avoid a ValidationError.
 *
 * @param {object} proposal  - full ProposalRecord
 * @param {string} sessionId - e.g. 'main-2026-05-23-1249-deep'
 * @returns {object} learning record ready for appendLearning()
 */
function _proposalToLearning(proposal, sessionId) {
  // Destructure to strip proposed_by_agent (privacy — not persisted)
  const { proposed_by_agent: _strip, ...base } = proposal;

  return {
    ...base,
    schema_version: 1,
    source_session: sessionId,
    scope: 'local',
    occurrences: 1,
    _provenance: `agent-proposed@${proposal.wave_id}`,
    // expires_at: intentionally omitted — appendLearning() derives it via
    //   deriveExpiresAt(created_at, type) from learnings/schema.mjs
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

/**
 * Promote AUQ-approved proposals to learnings.jsonl.
 *
 * For each approved proposal:
 *  1. Builds the learning record (adds 6 extra fields, strips proposed_by_agent).
 *  2. Appends to .orchestrator/metrics/learnings.jsonl via appendLearning().
 *
 * Individual record errors are collected into errors[] — the function never
 * throws on a per-record basis.
 *
 * @param {object}   opts
 * @param {object[]} opts.approved   - ProposalRecord[] selected by user via AUQ
 * @param {string}   opts.repoRoot   - absolute project root path
 * @param {string}   opts.sessionId  - e.g. 'main-2026-05-23-1249-deep'
 * @returns {Promise<{ written: number, errors: string[] }>}
 */
export async function writeApproved({ approved, repoRoot, sessionId }) {
  const errors = [];
  let written = 0;

  if (!Array.isArray(approved) || approved.length === 0) {
    return { written: 0, errors: [] };
  }

  let learningsPath;
  try {
    learningsPath = _resolveAndValidate(repoRoot, LEARNINGS_REL);
  } catch (err) {
    return { written: 0, errors: [`path-safety: ${err.message}`] };
  }

  for (const proposal of approved) {
    try {
      const learningRecord = _proposalToLearning(proposal, sessionId);
      await appendLearning(learningsPath, learningRecord);
      written++;
    } catch (err) {
      const id = (proposal && proposal.id) ? proposal.id : '<unknown>';
      errors.push(`proposal ${id}: ${err.message}`);
    }
  }

  return { written, errors };
}

/**
 * Archive AUQ-rejected proposals to .orchestrator/proposals.rejected.log.
 *
 * For each rejected proposal, appends a JSONL line:
 *   { ...originalProposal, _rejected_reason, _rejected_at }
 *
 * Individual record errors are collected into errors[] — the function never
 * throws on a per-record basis.
 *
 * @param {object}   opts
 * @param {object[]} opts.rejected - ProposalRecord[] declined by user
 * @param {string}   opts.repoRoot - absolute project root path
 * @param {string}   opts.reason   - 'user-declined' | 'overflow-truncate' | 'manual-skip'
 * @returns {Promise<{ archived: number, errors: string[] }>}
 */
export async function archiveRejected({ rejected, repoRoot, reason }) {
  const errors = [];
  let archived = 0;

  if (!Array.isArray(rejected) || rejected.length === 0) {
    return { archived: 0, errors: [] };
  }

  let rejectedLogPath;
  try {
    rejectedLogPath = _resolveAndValidate(repoRoot, REJECTED_LOG_REL);
  } catch (err) {
    return { archived: 0, errors: [`path-safety: ${err.message}`] };
  }

  // Ensure parent directory exists
  try {
    await mkdir(path.dirname(rejectedLogPath), { recursive: true });
  } catch (err) {
    return { archived: 0, errors: [`mkdir failed: ${err.message}`] };
  }

  const rejectedAt = new Date().toISOString();

  for (const proposal of rejected) {
    try {
      const archiveRecord = {
        ...proposal,
        _rejected_reason: reason,
        _rejected_at: rejectedAt,
      };
      const line = JSON.stringify(archiveRecord) + '\n';
      await appendFile(rejectedLogPath, line, 'utf8');
      archived++;
    } catch (err) {
      const id = (proposal && proposal.id) ? proposal.id : '<unknown>';
      errors.push(`proposal ${id}: ${err.message}`);
    }
  }

  return { archived, errors };
}

/**
 * Truncate proposals.jsonl to 0 bytes (end-of-cycle clear).
 *
 * Uses synchronous writeFileSync for atomic truncation — JSONL files
 * shorter than PIPE_BUF are written atomically on POSIX append, and
 * truncation to empty is a single syscall.
 *
 * Creates the file (with empty content) if it does not yet exist.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute project root path
 * @returns {Promise<{ cleared: boolean }>}
 */
export async function clearProposalsJsonl({ repoRoot }) {
  let proposalsPath;
  try {
    proposalsPath = _resolveAndValidate(repoRoot, PROPOSALS_REL);
  } catch {
    return { cleared: false };
  }

  try {
    // Ensure parent directory exists before truncate/create
    await mkdir(path.dirname(proposalsPath), { recursive: true });
    // Synchronous atomic truncate — single syscall, no partial-write risk
    writeFileSync(proposalsPath, '', 'utf8');
    return { cleared: true };
  } catch {
    return { cleared: false };
  }
}
