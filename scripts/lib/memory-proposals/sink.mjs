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
 *  - clearProposalsJsonl: atomically clear proposals.jsonl (tmp + rename),
 *    archiving the pre-clear content to a recovery sidecar first, AND
 *    reset every per-wave proposals-summary-*.json sidecar in the same
 *    metrics directory (issue #723 B3 — see function docstring for the
 *    fleet-wide desync bug this closes).
 *
 * All three exported functions:
 *  - Never throw on individual record errors — collect into errors[] and continue.
 *  - Use the canonical two-phase path-safety guard validatePathInsideProject
 *    (from ../path-utils.mjs) with canonicalizeRoot:true on every write target.
 *  - Use the appendLearning() atomic-append pattern from learnings/io.mjs.
 *
 * writeApproved additionally guards against a caller-mistake class (#797):
 * calling `writeApproved({ proposals: [...] })` instead of
 * `writeApproved({ approved: [...] })` previously returned a silent
 * `{ written: 0, errors: [] }` no-op — indistinguishable from "nothing was
 * approved". A subsequent `clearProposalsJsonl()` then drained the queue
 * anyway, permanently losing the approved proposals. `writeApproved` now
 * throws a `TypeError` when `approved` is `undefined` but the caller passed
 * OTHER (unrecognised) keys — the signature that fingerprints an arg-name
 * typo rather than a legitimate no-op call.
 *
 * Issue: #501 (F2.1 Memory-Proposals); #544 M3 (path-utils canonicalization);
 * #723 B3 (clearProposalsJsonl atomicity + summary-reset fix); #797
 * (writeApproved fail-silent guard + clearProposalsJsonl archive-before-clear).
 */

import { appendFile, mkdir, readdir, rm } from 'node:fs/promises';
import { writeFileSync, renameSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { appendLearning } from '../learnings/io.mjs';
import { validatePathInsideProject } from '../path-utils.mjs';

// ---------------------------------------------------------------------------
// Path constants (relative to repoRoot)
// ---------------------------------------------------------------------------

const LEARNINGS_REL = path.join('.orchestrator', 'metrics', 'learnings.jsonl');
const PROPOSALS_REL = path.join('.orchestrator', 'metrics', 'proposals.jsonl');
const REJECTED_LOG_REL = path.join('.orchestrator', 'proposals.rejected.log');
// #797 recovery sidecar: pre-clear proposals.jsonl content is appended here
// before every truncate, so a downstream clear that follows a botched
// writeApproved call (or any other pre-clear mistake) is recoverable.
const PROPOSALS_ARCHIVE_REL = path.join('.orchestrator', 'runtime', 'proposals-archive.jsonl');

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
 * Argument contract (#797 fail-silent guard):
 *  - `approved` is an array (possibly empty) → normal path / legitimate no-op.
 *  - `approved` is `undefined` and no OTHER (unrecognised) key was passed →
 *    legitimate no-op (e.g. an empty-selection AUQ round) → `{written:0, errors:[]}`.
 *  - `approved` is `undefined` BUT the caller passed unrecognised key(s)
 *    (e.g. `{ proposals: [...] }` instead of `{ approved: [...] }`) → throws
 *    `TypeError`, since this is almost certainly an arg-name typo that would
 *    otherwise silently no-op and lose the proposals on the next
 *    `clearProposalsJsonl()` call.
 *  - `approved` is defined but not an array → throws `TypeError` (clear
 *    contract violation, not a legitimate call shape).
 *
 * @param {object}   opts
 * @param {object[]} [opts.approved] - ProposalRecord[] selected by user via AUQ
 * @param {string}   opts.repoRoot   - absolute project root path
 * @param {string}   opts.sessionId  - e.g. 'main-2026-05-23-1249-deep'
 * @returns {Promise<{ written: number, errors: string[] }>}
 * @throws {TypeError} When `approved` is missing alongside unrecognised keys,
 *   or when `approved` is present but not an array.
 */
export async function writeApproved({ approved, repoRoot, sessionId, ...rest }) {
  const errors = [];
  let written = 0;

  if (approved === undefined) {
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      throw new TypeError(
        `writeApproved: missing "approved" — got unknown key(s): ${unknownKeys.join(', ')}. Did you mean approved:?`
      );
    }
    return { written: 0, errors: [] };
  }

  if (!Array.isArray(approved)) {
    throw new TypeError(
      `writeApproved: "approved" must be an array of ProposalRecord objects (got ${typeof approved})`
    );
  }

  if (approved.length === 0) {
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
 * Atomically clear proposals.jsonl AND reset every per-wave summary sidecar
 * (end-of-cycle clear).
 *
 * Root cause this fixes (#723 B3, reproduced fleet-wide 3x): the previous
 * implementation truncated ONLY proposals.jsonl via a direct `writeFileSync`
 * — it never reset the per-wave `proposals-summary-<wave-id>.json` sidecars
 * written by `store.mjs` `incrementSummary()`. `collector.mjs`
 * `accumulateSummaryStats()` reads `stats.queued` exclusively from those
 * summary files, and its short-circuit (return zero stats when
 * proposals.jsonl does not exist) never engages after a clear because the
 * clear leaves a 0-byte-but-EXISTING file behind. Net effect: every
 * session-end after the first non-empty cycle reported a stale
 * `queued > 0` count against a genuinely empty (0-byte) proposals.jsonl.
 *
 * Three-step fix:
 *  0. (#797) Archive the pre-clear content of proposals.jsonl (if non-empty)
 *     by appending it verbatim to `.orchestrator/runtime/proposals-archive.jsonl`
 *     BEFORE truncating. This is the recovery path for the drain-after-
 *     fail-silent-write class of bug: `clearProposalsJsonl()` unconditionally
 *     drains the queue regardless of whether the preceding `writeApproved()`
 *     call actually wrote anything, so a caller-side mistake (wrong arg name,
 *     partial write failure) no longer means the queued proposals are gone
 *     for good — they are recoverable from the archive sidecar. Best-effort:
 *     an archive failure never blocks the clear itself, and an empty/missing
 *     proposals.jsonl produces no archive append (nothing to preserve).
 *  1. Clear proposals.jsonl via tmp-file + rename (POSIX-atomic on the same
 *     filesystem) instead of an in-place `writeFileSync` truncate — this also
 *     brings the implementation in line with the documented contract in
 *     `agents/memory-proposal-collector.md` ("atomic clear ... write empty
 *     content to a tmp file, then rename over the target"), so a concurrent
 *     reader never observes a partially-truncated file.
 *  2. Remove every `proposals-summary-*.json` sidecar in the same metrics
 *     directory so the NEXT `collectProposals()` call starts from zero
 *     instead of re-summing a prior cycle's counters.
 *
 * Contract (skills/session-end/SKILL.md § 3.6 failure modes): this function
 * must NEVER throw. Step 1 failures short-circuit with
 * `{ cleared: false, summariesCleared: 0 }`. Step 2 is best-effort per file —
 * a single summary file that fails to delete is skipped (not fatal) so a
 * transient fs error on one sidecar cannot block the whole clear.
 *
 * Creates the file (with empty content) if it does not yet exist.
 *
 * @param {object} opts
 * @param {string} opts.repoRoot - absolute project root path
 * @returns {Promise<{ cleared: boolean, summariesCleared: number }>}
 */
export async function clearProposalsJsonl({ repoRoot }) {
  const proposalsResult = validatePathInsideProject(PROPOSALS_REL, repoRoot, { canonicalizeRoot: true });
  if (!proposalsResult.ok) {
    return { cleared: false, summariesCleared: 0 };
  }
  const proposalsPath = proposalsResult.realPath ?? proposalsResult.lexicalPath;
  const metricsDirPath = path.dirname(proposalsPath);

  // Step 0 (#797): archive pre-clear content before truncating. Best-effort
  // — never lets an archive-side failure block the clear (same never-throw
  // contract as the rest of this function).
  if (existsSync(proposalsPath)) {
    try {
      const preClearContent = readFileSync(proposalsPath, 'utf8');
      if (preClearContent.length > 0) {
        const archiveResult = validatePathInsideProject(PROPOSALS_ARCHIVE_REL, repoRoot, { canonicalizeRoot: true });
        if (archiveResult.ok) {
          const archivePath = archiveResult.realPath ?? archiveResult.lexicalPath;
          await mkdir(path.dirname(archivePath), { recursive: true });
          const normalized = preClearContent.endsWith('\n') ? preClearContent : `${preClearContent}\n`;
          await appendFile(archivePath, normalized, 'utf8');
        }
      }
    } catch {
      // Best-effort — a read/append failure on the archive sidecar must not
      // block the clear itself (function-level never-throw contract).
    }
  }

  try {
    // Ensure parent directory exists before clear/create.
    await mkdir(metricsDirPath, { recursive: true });
    // Atomic clear: write empty content to a tmp file, then rename over the
    // target — a concurrent hook reading proposals.jsonl mid-clear observes
    // either the pre-clear content or the fully-cleared file, never a
    // partial truncate.
    const tmpSuffix = crypto.randomBytes(6).toString('hex');
    const tmpFile = path.join(metricsDirPath, `.proposals.jsonl.tmp.${tmpSuffix}`);
    writeFileSync(tmpFile, '', 'utf8');
    renameSync(tmpFile, proposalsPath);
  } catch {
    return { cleared: false, summariesCleared: 0 };
  }

  // Reset per-wave summaries so a subsequent collectProposals() does not
  // re-report a prior cycle's queued/dropped/below_floor counts against the
  // now-empty proposals.jsonl (the #723 B3 root cause described above).
  let summariesCleared = 0;
  try {
    const names = await readdir(metricsDirPath);
    const summaryFiles = names.filter(
      (n) => n.startsWith('proposals-summary-') && n.endsWith('.json')
    );
    for (const filename of summaryFiles) {
      try {
        await rm(path.join(metricsDirPath, filename), { force: true });
        summariesCleared++;
      } catch {
        // Best-effort per file — a single sidecar failing to delete must not
        // fail the overall clear (function-level never-throw contract).
      }
    }
  } catch {
    // Metrics dir became unreadable between mkdir and readdir (e.g. removed
    // concurrently) — non-fatal, the JSONL clear above already succeeded.
  }

  return { cleared: true, summariesCleared };
}
