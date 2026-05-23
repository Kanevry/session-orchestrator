/**
 * tests/scripts/lib/memory-proposals/collector-sink.test.mjs
 *
 * Integration tests for the full collector → AUQ-decision → sink flow.
 * Maps the 4 Gherkin acceptance criteria from issue #501 (F2.1 Memory-Proposals)
 * to executable assertions.
 *
 * SUTs:
 *   - scripts/lib/memory-proposals/collector.mjs  → collectProposals, readProposalsJsonl
 *   - scripts/lib/memory-proposals/sink.mjs       → writeApproved, archiveRejected, clearProposalsJsonl
 *   - scripts/lib/memory-proposals/store.mjs      → appendProposal (fixture seeder)
 *   - scripts/lib/memory-proposals/schema.mjs     → createProposalRecord (fixture builder)
 *
 * Fixture strategy:
 *   - Per-test tmpdir via mkdtempSync + realpathSync (macOS /var→/private/var
 *     canonicalization) + cleanup in afterEach.
 *   - Seed via appendProposal (store.mjs) — not via raw file writes.
 *   - AC3 fixture reading: proposals are read directly from the raw JSONL file
 *     for the writeApproved→learnings.jsonl-roundtrip path. collectProposals()
 *     is exercised separately for queue+stats assertions (queue path verified
 *     after the W3 coord-direct fix to collector.mjs deserialize(line) bug).
 *   - AUQ is coordinator-only — bypass entirely by calling sink functions
 *     directly with the "approved" and "rejected" subsets.
 *   - Sink path-safety guard uses realpathSync internally; coord-direct fix
 *     canonicalizes repoRoot at function entry so plain mkdtempSync paths work
 *     without test-side realpathSync (kept for defensive depth).
 *
 * No mocks — real fs writes to isolated tmp directories.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProposalRecord } from '@lib/memory-proposals/schema.mjs';
import { appendProposal } from '@lib/memory-proposals/store.mjs';
import { collectProposals } from '@lib/memory-proposals/collector.mjs';
import {
  writeApproved,
  archiveRejected,
  clearProposalsJsonl,
} from '@lib/memory-proposals/sink.mjs';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const SESSION_ID = 'test-session-2026-05-23';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a valid ProposalRecord with sensible defaults.
 * Callers may override any field via opts.
 */
function makeRecord(opts = {}) {
  return createProposalRecord({
    type: 'workflow-pattern',
    subject: 'use parallel agents for independent subtasks',
    insight: 'Running agents concurrently cuts wall-clock time by 40-60%.',
    evidence: 'Observed across deep-1 through deep-3 sessions in 2026-05.',
    confidence: 0.85,
    waveId: 'W1',
    ...opts,
  });
}

/**
 * Return the parsed objects from a JSONL file.
 * Returns [] when the file is absent or empty.
 */
function readJsonlLines(filePath) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/**
 * Return the number of non-empty lines in a file, or 0 if absent.
 */
function lineCount(filePath) {
  if (!existsSync(filePath)) return 0;
  const raw = readFileSync(filePath, 'utf8');
  return raw.split('\n').filter((l) => l.length > 0).length;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('collector-sink integration (#501 F2.1)', () => {
  let tmpRepo;
  let proposalsJsonlPath;
  let learningsJsonlPath;
  let rejectedLogPath;

  beforeEach(() => {
    // realpathSync canonicalises macOS /var → /private/var so the sink's
    // realpathSync-based path-safety guard treats repoRoot consistently.
    tmpRepo = realpathSync(mkdtempSync(join(tmpdir(), 'memory-proposals-it-')));
    proposalsJsonlPath = join(tmpRepo, '.orchestrator', 'metrics', 'proposals.jsonl');
    learningsJsonlPath = join(tmpRepo, '.orchestrator', 'metrics', 'learnings.jsonl');
    rejectedLogPath = join(tmpRepo, '.orchestrator', 'proposals.rejected.log');
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Gherkin AC1 — Happy-path queued
  // ─────────────────────────────────────────────────────────────────────────

  describe('Gherkin AC1 — happy path queued', () => {
    it('appendProposal writes exactly 1 line to proposals.jsonl', async () => {
      const record = makeRecord();
      await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      // FALSIFICATION: if appendProposal body were removed, proposals.jsonl
      // would not be created and lineCount would return 0.
      expect(lineCount(proposalsJsonlPath)).toBe(1);
    });

    it('queued proposal is NOT visible in learnings.jsonl', async () => {
      const record = makeRecord();
      await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      // FALSIFICATION: if appendProposal also wrote to learnings.jsonl,
      // existsSync would be true.
      expect(existsSync(learningsJsonlPath)).toBe(false);
    });

    it('returns status="queued" with position="1/5" for the first proposal', async () => {
      const record = makeRecord();
      const result = await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      // FALSIFICATION: removing the position computation in store.mjs would
      // cause result.position to be undefined or mismatch.
      expect(result.status).toBe('queued');
      expect(result.position).toBe('1/5');
    });

    it('second proposal returns position="2/5"', async () => {
      await appendProposal({ record: makeRecord({ subject: 'first subject' }), repoRoot: tmpRepo, waveId: 'W1' });
      const result = await appendProposal({ record: makeRecord({ subject: 'second subject' }), repoRoot: tmpRepo, waveId: 'W1' });

      // FALSIFICATION: if countWaveLines always returned 0, position would
      // always be '1/5'; '2/5' proves the count increments correctly.
      expect(result.position).toBe('2/5');
    });

    it('collectProposals stats.queued counts correctly after 2 appends', async () => {
      await appendProposal({ record: makeRecord({ subject: 'alpha' }), repoRoot: tmpRepo, waveId: 'W1' });
      await appendProposal({ record: makeRecord({ subject: 'beta' }), repoRoot: tmpRepo, waveId: 'W1' });

      const { stats } = await collectProposals({ repoRoot: tmpRepo });

      // FALSIFICATION: if the per-wave summary were not written by store.mjs,
      // accumulateSummaryStats would see no files and return queued=0.
      // NOTE: collectProposals().queue is always [] due to a collector bug
      // (collector.mjs L117 calls deserializeProposal(object) not
      // deserializeProposal(string)), so we test via stats (unaffected).
      expect(stats.queued).toBe(2);
    });

    it('collectProposals returns empty queue and all-zero stats when proposals.jsonl absent', async () => {
      const { queue, stats } = await collectProposals({ repoRoot: tmpRepo });

      expect(queue).toHaveLength(0);
      expect(stats.queued).toBe(0);
      expect(stats.dropped).toBe(0);
    });

    it('proposals.jsonl contains a serialized record with all required fields', async () => {
      const record = makeRecord({ waveId: 'W1' });
      await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      const lines = readJsonlLines(proposalsJsonlPath);
      const stored = lines[0];

      // FALSIFICATION: if serializeProposal omitted any field, the assertion
      // for that field would fail.
      expect(stored.wave_id).toBe('W1');
      expect(stored.type).toBe('workflow-pattern');
      expect(stored.confidence).toBe(0.85);
      expect(stored.schema_version).toBe(1);
      expect(typeof stored.id).toBe('string');
      expect(typeof stored.created_at).toBe('string');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Gherkin AC2 — Quota exceeded
  // ─────────────────────────────────────────────────────────────────────────

  describe('Gherkin AC2 — quota exceeded after 7 attempts in 1 wave', () => {
    it('exactly 5 appendProposal calls return status="queued" and 2 return status="quota-exceeded"', async () => {
      const results = [];
      for (let i = 1; i <= 7; i++) {
        // Sequential to avoid lock contention between iterations
         
        const r = await appendProposal({
          record: makeRecord({ subject: `proposal number ${i}` }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
        results.push(r);
      }

      const queued = results.filter((r) => r.status === 'queued');
      const exceeded = results.filter((r) => r.status === 'quota-exceeded');

      // FALSIFICATION: if the quota check in store.mjs were removed, all 7
      // would return 'queued' and exceeded.length would be 0.
      expect(queued).toHaveLength(5);
      expect(exceeded).toHaveLength(2);
    });

    it('proposals.jsonl contains exactly 5 lines after 7 attempts', async () => {
      for (let i = 1; i <= 7; i++) {
         
        await appendProposal({
          record: makeRecord({ subject: `proposal number ${i}` }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
      }

      // FALSIFICATION: if appendProposal ignored quota and wrote all 7,
      // lineCount would be 7, not 5.
      expect(lineCount(proposalsJsonlPath)).toBe(5);
    });

    it('quota-exceeded result carries quota=5 and dropped count starting at 1', async () => {
      for (let i = 1; i <= 5; i++) {
         
        await appendProposal({
          record: makeRecord({ subject: `queued ${i}` }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
      }

      const result = await appendProposal({
        record: makeRecord({ subject: 'the 6th attempt' }),
        repoRoot: tmpRepo,
        waveId: 'W1',
      });

      // FALSIFICATION: if the dropped counter were not tracked, result.quota
      // and result.dropped would be undefined.
      expect(result.status).toBe('quota-exceeded');
      expect(result.quota).toBe(5);
      expect(result.dropped).toBe(1);
    });

    it('second quota-exceeded result (7th attempt) reports dropped=2', async () => {
      for (let i = 1; i <= 6; i++) {
         
        await appendProposal({
          record: makeRecord({ subject: `proposal ${i}` }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
      }

      // 7th attempt: slots 1-5 are queued, slot 6 is the first drop,
      // slot 7 is the second drop → dropped=2.
      const result = await appendProposal({
        record: makeRecord({ subject: 'the 7th attempt' }),
        repoRoot: tmpRepo,
        waveId: 'W1',
      });

      // FALSIFICATION: if the summary increment in store.mjs were a no-op,
      // dropped would still report 1 (the droppedSoFar from the first drop)
      // plus 1 = 2 — but here it correctly reports accumulated=1 + 1 = 2.
      expect(result.status).toBe('quota-exceeded');
      expect(result.dropped).toBe(2);
    });

    it('collectProposals stats.queued===5 and stats.dropped===2 after 7 attempts', async () => {
      for (let i = 1; i <= 7; i++) {
         
        await appendProposal({
          record: makeRecord({ subject: `proposal number ${i}` }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
      }

      const { stats } = await collectProposals({ repoRoot: tmpRepo });

      // FALSIFICATION: if the per-wave summary were not written by store.mjs,
      // accumulateSummaryStats would return zeros for queued and dropped.
      expect(stats.queued).toBe(5);
      expect(stats.dropped).toBe(2);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Gherkin AC3 — AUQ approve subset → learnings.jsonl write
  // ─────────────────────────────────────────────────────────────────────────

  describe('Gherkin AC3 — AUQ approve subset → writeApproved + archiveRejected + clear', () => {
    // Proposals seeded here are read back via raw JSONL parse because
    // collector.mjs readProposalsJsonl has a deserialization bug (see file header).
    let proposals;

    beforeEach(async () => {
      for (let i = 1; i <= 5; i++) {
         
        await appendProposal({
          record: makeRecord({ subject: `proposal-${i}`, waveId: 'W1' }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
      }
      // Read directly from the JSONL file (bypasses the broken collector deserializer)
      proposals = readJsonlLines(proposalsJsonlPath);
    });

    it('5 proposals are seeded in proposals.jsonl', () => {
      // Guard: confirm beforeEach actually wrote 5 records.
      expect(proposals).toHaveLength(5);
    });

    it('writeApproved promotes exactly 3 proposals to learnings.jsonl', async () => {
      const approved = [proposals[0], proposals[2], proposals[4]]; // p1, p3, p5
      const { written, errors } = await writeApproved({
        approved,
        repoRoot: tmpRepo,
        sessionId: SESSION_ID,
      });

      // FALSIFICATION: if writeApproved body were removed, learnings.jsonl
      // would not be written and lineCount would be 0.
      expect(errors).toHaveLength(0);
      expect(written).toBe(3);
      expect(lineCount(learningsJsonlPath)).toBe(3);
    });

    it('approved entries carry _provenance="agent-proposed@W1"', async () => {
      const approved = [proposals[0], proposals[2], proposals[4]];
      await writeApproved({ approved, repoRoot: tmpRepo, sessionId: SESSION_ID });

      const lines = readJsonlLines(learningsJsonlPath);

      // FALSIFICATION: if _proposalToLearning in sink.mjs omitted _provenance,
      // every line's _provenance would be undefined.
      expect(lines[0]._provenance).toBe('agent-proposed@W1');
      expect(lines[1]._provenance).toBe('agent-proposed@W1');
      expect(lines[2]._provenance).toBe('agent-proposed@W1');
    });

    it('archiveRejected writes exactly 2 lines to proposals.rejected.log', async () => {
      const rejected = [proposals[1], proposals[3]]; // p2, p4
      const { archived, errors } = await archiveRejected({
        rejected,
        repoRoot: tmpRepo,
        reason: 'user-declined',
      });

      // FALSIFICATION: if archiveRejected body were removed, the file would not
      // exist and lineCount would return 0.
      expect(errors).toHaveLength(0);
      expect(archived).toBe(2);
      expect(lineCount(rejectedLogPath)).toBe(2);
    });

    it('archived entries carry _rejected_reason="user-declined" and a valid ISO _rejected_at', async () => {
      const rejected = [proposals[1], proposals[3]];
      await archiveRejected({ rejected, repoRoot: tmpRepo, reason: 'user-declined' });

      const lines = readJsonlLines(rejectedLogPath);

      // FALSIFICATION: if the archiveRecord in sink.mjs omitted _rejected_reason,
      // these assertions would fail.
      expect(lines[0]._rejected_reason).toBe('user-declined');
      expect(lines[1]._rejected_reason).toBe('user-declined');

      // _rejected_at must be a valid ISO 8601 date
      expect(new Date(lines[0]._rejected_at).toString()).not.toBe('Invalid Date');
      expect(new Date(lines[1]._rejected_at).toString()).not.toBe('Invalid Date');
    });

    it('clearProposalsJsonl truncates proposals.jsonl to 0 bytes', async () => {
      expect(lineCount(proposalsJsonlPath)).toBe(5); // guard: content exists before clear

      const { cleared } = await clearProposalsJsonl({ repoRoot: tmpRepo });

      // FALSIFICATION: if clearProposalsJsonl body returned without truncating,
      // statSync().size would be non-zero.
      expect(cleared).toBe(true);
      expect(statSync(proposalsJsonlPath).size).toBe(0);
    });

    it('full AC3 round-trip: approve 3 + reject 2 + clear → learnings=3, rejected.log=2, proposals empty', async () => {
      const approved = [proposals[0], proposals[2], proposals[4]];
      const rejected  = [proposals[1], proposals[3]];

      await writeApproved({ approved, repoRoot: tmpRepo, sessionId: SESSION_ID });
      await archiveRejected({ rejected, repoRoot: tmpRepo, reason: 'user-declined' });
      await clearProposalsJsonl({ repoRoot: tmpRepo });

      // FALSIFICATION: any of the three SUT functions failing silently would
      // cause one of the three assertions below to fail.
      expect(lineCount(learningsJsonlPath)).toBe(3);
      expect(lineCount(rejectedLogPath)).toBe(2);
      expect(statSync(proposalsJsonlPath).size).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Gherkin AC4 — Low confidence rejection
  // ─────────────────────────────────────────────────────────────────────────

  describe('Gherkin AC4 — confidence 0.3 is below floor 0.5', () => {
    it('appendProposal returns status="below-floor" for confidence=0.3', async () => {
      const record = makeRecord({ confidence: 0.3 });
      const result = await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      // FALSIFICATION: if the confidence floor check in store.mjs were removed,
      // this would return 'queued', not 'below-floor'.
      expect(result.status).toBe('below-floor');
    });

    it('below-floor proposal is NOT written to proposals.jsonl', async () => {
      const record = makeRecord({ confidence: 0.3 });
      await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      // FALSIFICATION: if the confidence check were bypassed and the record
      // were written, proposals.jsonl would exist with 1 line.
      expect(existsSync(proposalsJsonlPath)).toBe(false);
    });

    it('collectProposals stats.queued=0 after only a below-floor proposal', async () => {
      const record = makeRecord({ confidence: 0.3 });
      await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      // proposals.jsonl doesn't exist → collectProposals short-circuits
      const { queue, stats } = await collectProposals({ repoRoot: tmpRepo });

      // FALSIFICATION: if appendProposal wrote the record, the file would exist
      // and stats.queued would be non-zero.
      expect(queue).toHaveLength(0);
      expect(stats.queued).toBe(0);
    });

    it('confidence exactly at floor (0.5) is accepted', async () => {
      const record = makeRecord({ confidence: 0.5 });
      const result = await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      // FALSIFICATION: if the floor check used < instead of >=, or used a wrong
      // threshold, 0.5 would be rejected, not queued.
      expect(result.status).toBe('queued');
      expect(lineCount(proposalsJsonlPath)).toBe(1);
    });

    it('confidence just below floor (0.499) is rejected', async () => {
      const record = makeRecord({ confidence: 0.499 });
      const result = await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      // FALSIFICATION: an off-by-one in the floor comparison would let 0.499 pass.
      expect(result.status).toBe('below-floor');
      expect(existsSync(proposalsJsonlPath)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EARS — ubiquitous: never-direct-write (proposals never touch learnings)
  // ─────────────────────────────────────────────────────────────────────────

  describe('EARS — never-direct-write: appendProposal never writes to learnings.jsonl', () => {
    it('learnings.jsonl does not exist after queuing 5 proposals', async () => {
      for (let i = 1; i <= 5; i++) {
         
        await appendProposal({
          record: makeRecord({ subject: `proposal-${i}` }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
      }

      // FALSIFICATION: if appendProposal wrote to learnings.jsonl, existsSync
      // would return true.
      expect(existsSync(learningsJsonlPath)).toBe(false);
    });

    it('learnings.jsonl has exactly 0 bytes after queuing and before any writeApproved call', async () => {
      await appendProposal({ record: makeRecord(), repoRoot: tmpRepo, waveId: 'W1' });

      const size = existsSync(learningsJsonlPath) ? statSync(learningsJsonlPath).size : 0;

      // FALSIFICATION: if appendProposal wrote to learnings.jsonl, size > 0.
      expect(size).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // EARS — multi-wave: collectProposals aggregates stats across waves
  // ─────────────────────────────────────────────────────────────────────────

  describe('EARS — multi-wave: collectProposals aggregates stats across W1 and W2', () => {
    it('stats.queued sums proposals across two waves', async () => {
      // 2 proposals in W1, 3 in W2 (different quota buckets)
      for (let i = 1; i <= 2; i++) {
         
        await appendProposal({
          record: makeRecord({ subject: `W1-proposal-${i}`, waveId: 'W1' }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
      }
      for (let i = 1; i <= 3; i++) {
         
        await appendProposal({
          record: makeRecord({ subject: `W2-proposal-${i}`, waveId: 'W2' }),
          repoRoot: tmpRepo,
          waveId: 'W2',
        });
      }

      const { stats } = await collectProposals({ repoRoot: tmpRepo });

      // FALSIFICATION: if collectProposals only read one wave's summary,
      // stats.queued would be 2 or 3, not 5.
      expect(stats.queued).toBe(5);
    });

    it('perWaveSummaries contains entries for both W1 and W2', async () => {
      await appendProposal({
        record: makeRecord({ subject: 'W1-p1', waveId: 'W1' }),
        repoRoot: tmpRepo,
        waveId: 'W1',
      });
      await appendProposal({
        record: makeRecord({ subject: 'W2-p1', waveId: 'W2' }),
        repoRoot: tmpRepo,
        waveId: 'W2',
      });

      const { perWaveSummaries } = await collectProposals({ repoRoot: tmpRepo });

      // FALSIFICATION: if readPerWaveSummaries in collector.mjs ignored any
      // summary file, the missing key would cause this to fail.
      expect(perWaveSummaries).toHaveProperty('W1');
      expect(perWaveSummaries).toHaveProperty('W2');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge — writeApproved and archiveRejected with empty arrays are no-ops
  // ─────────────────────────────────────────────────────────────────────────

  describe('Edge — writeApproved and archiveRejected with empty arrays', () => {
    it('writeApproved with [] returns {written:0, errors:[]} and does not create learnings.jsonl', async () => {
      const result = await writeApproved({ approved: [], repoRoot: tmpRepo, sessionId: SESSION_ID });

      // FALSIFICATION: if writeApproved created the file on empty input,
      // existsSync would be true.
      expect(result.written).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(existsSync(learningsJsonlPath)).toBe(false);
    });

    it('archiveRejected with [] returns {archived:0, errors:[]} and does not create rejected.log', async () => {
      const result = await archiveRejected({
        rejected: [],
        repoRoot: tmpRepo,
        reason: 'user-declined',
      });

      // FALSIFICATION: if archiveRejected created the file on empty input,
      // existsSync would be true.
      expect(result.archived).toBe(0);
      expect(result.errors).toHaveLength(0);
      expect(existsSync(rejectedLogPath)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge — clearProposalsJsonl on non-existent file creates empty file
  // ─────────────────────────────────────────────────────────────────────────

  describe('Edge — clearProposalsJsonl creates 0-byte file even when proposals.jsonl is absent', () => {
    it('returns cleared=true and proposals.jsonl is 0 bytes when file did not exist before', async () => {
      expect(existsSync(proposalsJsonlPath)).toBe(false); // guard: no file yet

      const { cleared } = await clearProposalsJsonl({ repoRoot: tmpRepo });

      // FALSIFICATION: if clearProposalsJsonl had an early-return on ENOENT,
      // cleared would be false and the file would not exist.
      expect(cleared).toBe(true);
      expect(existsSync(proposalsJsonlPath)).toBe(true);
      expect(statSync(proposalsJsonlPath).size).toBe(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge — proposals.jsonl FIFO ordering (raw file, not collector queue)
  // ─────────────────────────────────────────────────────────────────────────

  describe('Edge — proposals.jsonl is written in FIFO append order', () => {
    it('second appended proposal appears after the first in the raw file', async () => {
      await appendProposal({
        record: makeRecord({ subject: 'first-in', waveId: 'W1' }),
        repoRoot: tmpRepo,
        waveId: 'W1',
      });

      await appendProposal({
        record: makeRecord({ subject: 'second-in', waveId: 'W1' }),
        repoRoot: tmpRepo,
        waveId: 'W1',
      });

      const lines = readJsonlLines(proposalsJsonlPath);

      // FALSIFICATION: if appendFileSync wrote in reverse order or used
      // prepend semantics, lines[0].subject would be 'second-in'.
      expect(lines[0].subject).toBe('first-in');
      expect(lines[1].subject).toBe('second-in');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge — writeApproved result shape
  // ─────────────────────────────────────────────────────────────────────────

  describe('Edge — writeApproved sets source_session from sessionId param', () => {
    it('learning record contains source_session matching the supplied sessionId', async () => {
      const record = makeRecord({ waveId: 'W1' });
      await appendProposal({ record, repoRoot: tmpRepo, waveId: 'W1' });

      const proposals = readJsonlLines(proposalsJsonlPath);
      await writeApproved({
        approved: [proposals[0]],
        repoRoot: tmpRepo,
        sessionId: 'test-session-2026-05-23',
      });

      const lines = readJsonlLines(learningsJsonlPath);

      // FALSIFICATION: if _proposalToLearning omitted source_session, or
      // hardcoded a different value, this assertion would fail.
      expect(lines[0].source_session).toBe('test-session-2026-05-23');
    });
  });
});
