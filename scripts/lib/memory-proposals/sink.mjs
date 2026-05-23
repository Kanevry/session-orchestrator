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
 *  - Use the canonical two-phase path-safety guard validatePathInsideProject
 *    (from ../path-utils.mjs) with canonicalizeRoot:true on every write target.
 *  - Use the appendLearning() atomic-append pattern from learnings/io.mjs.
 *
 * Issue: #501 (F2.1 Memory-Proposals); #544 M3 (path-utils canonicalization).
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { appendLearning } from '../learnings/io.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';

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

  const learningsResult = validatePathInsideProject(LEARNINGS_REL, repoRoot, { canonicalizeRoot: true });
  if (!learningsResult.ok) {
    return { written: 0, errors: [`path-safety: ${learningsResult.reason} (${LEARNINGS_REL})`] };
  }
  const learningsPath = learningsResult.realPath ?? learningsResult.lexicalPath;

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

  const rejectedResult = validatePathInsideProject(REJECTED_LOG_REL, repoRoot, { canonicalizeRoot: true });
  if (!rejectedResult.ok) {
    return { archived: 0, errors: [`path-safety: ${rejectedResult.reason} (${REJECTED_LOG_REL})`] };
  }
  const rejectedLogPath = rejectedResult.realPath ?? rejectedResult.lexicalPath;

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
  const proposalsResult = validatePathInsideProject(PROPOSALS_REL, repoRoot, { canonicalizeRoot: true });
  if (!proposalsResult.ok) {
    return { cleared: false };
  }
  const proposalsPath = proposalsResult.realPath ?? proposalsResult.lexicalPath;

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
