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
 *  - promoteAndClear:    compose writeApproved + clearProposalsJsonl into a
 *    single verified-write-then-clear call (issue #828 — see function
 *    docstring for the incident class this closes: a caller that ran
 *    writeApproved() then clearProposalsJsonl() unconditionally could drain
 *    the queue even when writeApproved returned written:0).
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
 * (writeApproved fail-silent guard + clearProposalsJsonl archive-before-clear);
 * #828 (promoteAndClear — clear the queue ONLY after a verified write).
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

/**
 * Promote approved proposals AND clear the queue — but ONLY when the write
 * is verified complete. Composes writeApproved() + clearProposalsJsonl()
 * behind a single mechanical guard so a caller can no longer reproduce the
 * incident class this closes (#828, 2nd occurrence 2026-07-18): a caller
 * ran writeApproved() (which returned `written: 0` — e.g. every record
 * failed round-trip validation because `sessionId` was missing/wrong) and
 * then ran clearProposalsJsonl() anyway, unconditionally draining the queue
 * even though nothing had actually been promoted.
 *
 * writeApproved() and clearProposalsJsonl() themselves are untouched by this
 * function — both keep their existing signatures and never-throw-per-record
 * contracts. promoteAndClear() is a NEW, additive orchestration layer; it
 * does not replace direct calls to either lower-level function for callers
 * that need finer-grained control (e.g. archiveRejected() must still run as
 * a separate, caller-driven step between writeApproved() and this call — see
 * below).
 *
 * Guard (mechanical, not semantic): the clear proceeds if and only if
 * `writeApproved()` wrote exactly as many records as were requested
 * (`written === expected`) AND reported zero per-record errors. This is a
 * purely mechanical count/error check — it does NOT distinguish "operator
 * approved nothing this cycle" from "operator approved everything and it all
 * wrote cleanly". Both are `expected === 0` or `written === expected` with no
 * errors, and BOTH legitimately clear the queue. The only case the guard
 * blocks is a MISMATCH — some or all approved records failed to write — which
 * is precisely the #828 incident class.
 *
 * `approved: []` (or `approved` omitted) is a legitimate clear-with-nothing-
 * approved call: `expected` computes to 0, `writeApproved()` returns
 * `{written: 0, errors: []}` without touching the filesystem, the guard
 * evaluates `0 === 0 && no errors` → true, and the clear proceeds. This is
 * intentional — a cycle where the operator approved nothing must still be
 * able to drain a queue of now-rejected/stale proposals once the caller has
 * separately archived them via archiveRejected().
 *
 * archiveRejected() is INTENTIONALLY NOT folded into this function — it
 * operates on a disjoint subset of proposals (the rejected ones) and has no
 * bearing on whether the write of the APPROVED subset succeeded. Callers
 * should sequence: writeApproved-relevant work → archiveRejected(rejected) →
 * promoteAndClear(approved) (or call promoteAndClear() first, then
 * archiveRejected() — order between the two does not matter, since
 * archiveRejected() never reads or clears proposals.jsonl itself).
 *
 * Own argument-typo guard (own-level #797 mirror; fixes a reintroduction
 * found by session-reviewer): the original implementation destructured only
 * its three known keys and forwarded a FRESH `{ approved, repoRoot,
 * sessionId }` literal to writeApproved() — so a caller typo like
 * `promoteAndClear({ proposals: [...], sessionId, repoRoot })` silently
 * dropped the unrecognised `proposals` key. writeApproved() then received
 * `approved: undefined` with NO unknown keys (the fresh literal has none),
 * so writeApproved()'s OWN #797 rest-based typo guard could never fire —
 * it took the legitimate-no-op branch and returned `{written: 0, errors:
 * []}`, `expected` computed to 0, the mechanical guard evaluated
 * `0 === 0 && no errors` → true, and the queue was drained with
 * `cleared: true, skippedReason: null`. That is the exact #828 incident
 * class, reintroduced one layer up. Fix: promoteAndClear() now captures
 * `...rest` itself and throws its OWN `TypeError` when `approved ===
 * undefined` alongside unrecognised key(s) — before ever calling
 * writeApproved() — using the same detection shape and message wording as
 * writeApproved()'s guard (lines ~136-144 above). An explicit local guard
 * was chosen over forwarding `...rest` into writeApproved() so the typo is
 * caught (and named) at the layer the caller actually invoked, rather than
 * relying on an internal delegate to surface it.
 *
 * @param {object}   opts
 * @param {object[]} [opts.approved] - ProposalRecord[] selected by user via
 *   AUQ. Same contract as writeApproved()'s `approved` param:
 *   omitted/`undefined` WITH NO other (unrecognised) keys present is a
 *   legitimate no-op batch (computes `expected: 0`, clear proceeds — mirrors
 *   writeApproved()'s own no-op semantics exactly, see the guard above);
 *   omitted/`undefined` WITH unrecognised key(s) present throws `TypeError`
 *   (arg-name-typo detection, see above); present-but-not-an-array is a
 *   caller-mistake and is NOT pre-checked here — it is left to propagate as
 *   the `TypeError` writeApproved() already throws for that shape (avoids
 *   duplicating that validation in two places).
 * @param {string}   opts.sessionId - e.g. 'main-2026-05-23-1249-deep'. MUST be
 *   a non-empty string — this function throws `TypeError` immediately
 *   (before calling writeApproved()) when it is not, since a missing/blank
 *   sessionId is a caller bug (every record would fail writeApproved's
 *   round-trip validation with "missing required field: source_session",
 *   guaranteeing the write-verification guard below blocks the clear anyway
 *   — this throws earlier and louder rather than silently skipping to a
 *   `skippedReason`).
 * @param {string}   opts.repoRoot  - absolute project root path
 * @returns {Promise<{
 *   written: number,
 *   expected: number,
 *   errors: string[],
 *   cleared: boolean,
 *   summariesCleared: number,
 *   skippedReason: string|null,
 * }>}
 * @throws {TypeError} When `approved` is missing alongside unrecognised
 *   key(s) (own-level arg-typo guard), when `sessionId` is not a non-empty
 *   string, or (propagated) when `approved` is present but not an array.
 */
export async function promoteAndClear({ approved, sessionId, repoRoot, ...rest }) {
  if (approved === undefined) {
    const unknownKeys = Object.keys(rest);
    if (unknownKeys.length > 0) {
      throw new TypeError(
        `promoteAndClear: missing "approved" — got unknown key(s): ${unknownKeys.join(', ')}. Did you mean approved:?`
      );
    }
  }

  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new TypeError(
      `promoteAndClear: "sessionId" must be a non-empty string (got ${typeof sessionId})`
    );
  }

  // `expected` mirrors writeApproved()'s own no-op semantics: a non-array
  // `approved` (including `undefined`, already guarded above against the
  // arg-typo shape) computes as 0 here. When `approved` is present but
  // genuinely not an array, writeApproved() below throws its own TypeError
  // before this value is ever consulted by the guard.
  const expected = Array.isArray(approved) ? approved.length : 0;

  const w = await writeApproved({ approved, repoRoot, sessionId });

  const ok = w.written === expected && w.errors.length === 0;

  if (!ok) {
    const skippedReason =
      w.errors.length > 0
        ? 'write-errors'
        : `partial-write: ${w.written}/${expected} written`;
    // Clear is SKIPPED entirely — proposals.jsonl (and its summary sidecars)
    // remain untouched on this path. This is the mechanical fix for #828:
    // the queue is never drained on an unverified/incomplete write.
    return {
      ...w,
      expected,
      cleared: false,
      summariesCleared: 0,
      skippedReason,
    };
  }

  const c = await clearProposalsJsonl({ repoRoot });

  return {
    ...w,
    expected,
    cleared: c.cleared,
    summariesCleared: c.summariesCleared,
    skippedReason: null,
  };
}
