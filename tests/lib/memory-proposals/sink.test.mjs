/**
 * sink.test.mjs — Regression tests for #797: writeApproved fail-silent on a
 * wrong argument name + clearProposalsJsonl draining the queue independent
 * of write success.
 *
 * Root cause (2nd occurrence of this gotcha class): `writeApproved({
 * proposals: [...] })` (wrong key — correct is `approved:`) previously
 * returned a silent `{ written: 0, errors: [] }` no-op because
 * `!Array.isArray(approved) || approved.length === 0` treated `undefined`
 * identically to a legitimate empty-array no-op call. A subsequent
 * `clearProposalsJsonl()` then drained the queue regardless, permanently
 * losing the approved proposals.
 *
 * Fix under test:
 *  - `writeApproved` now throws `TypeError` when `approved === undefined`
 *    AND the caller passed unrecognised key(s) — the signature of an
 *    arg-name typo, not a legitimate no-op.
 *  - `writeApproved` also throws `TypeError` when `approved` is present but
 *    not an array (clear contract violation).
 *  - The legitimate no-op shapes (`{ approved: [] }`, `{ approved: undefined
 *    }` with no other keys) still return `{ written: 0, errors: [] }`.
 *  - `clearProposalsJsonl` now archives the pre-clear content of
 *    proposals.jsonl to `.orchestrator/runtime/proposals-archive.jsonl`
 *    BEFORE truncating, giving a recovery path independent of whatever ran
 *    (or failed to run) before the clear.
 *
 * SUT: scripts/lib/memory-proposals/sink.mjs (writeApproved, clearProposalsJsonl)
 * Fixture seeding: scripts/lib/memory-proposals/{schema,store}.mjs (real fs
 * writes to isolated tmp directories — no mocks).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createProposalRecord } from '@lib/memory-proposals/schema.mjs';
import { appendProposal } from '@lib/memory-proposals/store.mjs';
import { writeApproved, clearProposalsJsonl } from '@lib/memory-proposals/sink.mjs';

const SESSION_ID = 'test-session-2026-07-12';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Build a valid ProposalRecord with sensible defaults; opts override. */
function makeRecord(opts = {}) {
  return createProposalRecord({
    type: 'workflow-pattern',
    subject: 'batch independent subtasks across agents',
    insight: 'Running independent subtasks concurrently reduces wall-clock time.',
    evidence: 'Observed across 3 sessions in 2026-07.',
    confidence: 0.85,
    waveId: 'W1',
    ...opts,
  });
}

/** Return parsed JSONL objects from filePath, or [] when absent. */
function readJsonlLines(filePath) {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

/** Return the raw (unparsed) content of filePath, or '' when absent. */
function readRaw(filePath) {
  return existsSync(filePath) ? readFileSync(filePath, 'utf8') : '';
}

describe('sink.mjs — #797 writeApproved fail-silent guard + clear-archive', () => {
  let tmpRepo;
  let proposalsJsonlPath;
  let learningsJsonlPath;
  let archiveJsonlPath;

  beforeEach(() => {
    // realpathSync canonicalises macOS /var → /private/var so the sink's
    // realpathSync-based path-safety guard treats repoRoot consistently.
    tmpRepo = realpathSync(mkdtempSync(join(tmpdir(), 'sink-797-')));
    proposalsJsonlPath = join(tmpRepo, '.orchestrator', 'metrics', 'proposals.jsonl');
    learningsJsonlPath = join(tmpRepo, '.orchestrator', 'metrics', 'learnings.jsonl');
    archiveJsonlPath = join(tmpRepo, '.orchestrator', 'runtime', 'proposals-archive.jsonl');
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // KERN-REGRESSION — wrong arg name must throw, not silently no-op
  // ─────────────────────────────────────────────────────────────────────────

  describe('KERN-REGRESSION — wrong argument name throws instead of silently no-op-ing', () => {
    it('writeApproved({ proposals: [...] }) throws TypeError naming the mistake', async () => {
      const record = makeRecord();

      // FALSIFICATION: pre-fix, this call returned `{ written: 0, errors: [] }`
      // without throwing — indistinguishable from "operator approved nothing".
      // The fix must reject the call outright.
      await expect(
        writeApproved({ proposals: [record], repoRoot: tmpRepo, sessionId: SESSION_ID }),
      ).rejects.toThrow(TypeError);

      await expect(
        writeApproved({ proposals: [record], repoRoot: tmpRepo, sessionId: SESSION_ID }),
      ).rejects.toThrow(/approved/i);
    });

    it('does not create learnings.jsonl when writeApproved is called with the wrong key', async () => {
      const record = makeRecord();

      await expect(
        writeApproved({ proposals: [record], repoRoot: tmpRepo, sessionId: SESSION_ID }),
      ).rejects.toThrow();

      // FALSIFICATION: if the pre-fix silent no-op path ran, no file would be
      // created either — this assertion alone doesn't distinguish fixed from
      // broken, but combined with the throw assertion above it locks the
      // full contract: the call must fail LOUDLY, not silently no-op.
      expect(existsSync(learningsJsonlPath)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Legitimate no-op shapes must keep working
  // ─────────────────────────────────────────────────────────────────────────

  describe('legitimate no-op call shapes are preserved', () => {
    it('{ approved: [] } returns { written: 0, errors: [] } without throwing', async () => {
      const result = await writeApproved({ approved: [], repoRoot: tmpRepo, sessionId: SESSION_ID });

      expect(result).toEqual({ written: 0, errors: [] });
      expect(existsSync(learningsJsonlPath)).toBe(false);
    });

    it('{ approved: undefined } with no other keys returns { written: 0, errors: [] }', async () => {
      const result = await writeApproved({ approved: undefined, repoRoot: tmpRepo, sessionId: SESSION_ID });

      expect(result).toEqual({ written: 0, errors: [] });
      expect(existsSync(learningsJsonlPath)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Non-array approved is a clear contract violation
  // ─────────────────────────────────────────────────────────────────────────

  describe('non-array "approved" is rejected', () => {
    it('approved: "nicht-array" throws TypeError', async () => {
      await expect(
        writeApproved({ approved: 'nicht-array', repoRoot: tmpRepo, sessionId: SESSION_ID }),
      ).rejects.toThrow(TypeError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Happy path — correct arg name still writes N learnings
  // ─────────────────────────────────────────────────────────────────────────

  describe('happy path — correct "approved" key writes every record', () => {
    it('writes 3 learnings for 3 approved proposals', async () => {
      for (let i = 1; i <= 3; i++) {
        await appendProposal({
          record: makeRecord({ subject: `proposal-${i}` }),
          repoRoot: tmpRepo,
          waveId: 'W1',
        });
      }
      const proposals = readJsonlLines(proposalsJsonlPath);
      expect(proposals).toHaveLength(3); // guard: seeding worked

      const { written, errors } = await writeApproved({
        approved: proposals,
        repoRoot: tmpRepo,
        sessionId: SESSION_ID,
      });

      expect(errors).toHaveLength(0);
      expect(written).toBe(3);
      expect(readJsonlLines(learningsJsonlPath)).toHaveLength(3);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // clearProposalsJsonl — archive-before-clear
  // ─────────────────────────────────────────────────────────────────────────

  describe('clearProposalsJsonl archives pre-clear content before truncating', () => {
    it('archive file receives the exact pre-clear proposals.jsonl content', async () => {
      await appendProposal({ record: makeRecord({ subject: 'alpha' }), repoRoot: tmpRepo, waveId: 'W1' });
      await appendProposal({ record: makeRecord({ subject: 'beta' }), repoRoot: tmpRepo, waveId: 'W1' });

      const preClearContent = readRaw(proposalsJsonlPath);
      expect(preClearContent.length).toBeGreaterThan(0); // guard: content exists

      await clearProposalsJsonl({ repoRoot: tmpRepo });

      // FALSIFICATION: if the archive-before-clear step were absent, the
      // archive file would not exist at all.
      expect(existsSync(archiveJsonlPath)).toBe(true);
      expect(readRaw(archiveJsonlPath)).toBe(preClearContent);
    });

    it('proposals.jsonl is empty after the clear (queue drained as before)', async () => {
      await appendProposal({ record: makeRecord(), repoRoot: tmpRepo, waveId: 'W1' });

      await clearProposalsJsonl({ repoRoot: tmpRepo });

      expect(readRaw(proposalsJsonlPath)).toBe('');
    });

    it('a second clear on an already-empty queue does not duplicate the archive content', async () => {
      await appendProposal({ record: makeRecord({ subject: 'gamma' }), repoRoot: tmpRepo, waveId: 'W1' });

      await clearProposalsJsonl({ repoRoot: tmpRepo });
      const archiveAfterFirstClear = readRaw(archiveJsonlPath);
      expect(archiveAfterFirstClear.length).toBeGreaterThan(0); // guard

      // Second clear: proposals.jsonl is now 0 bytes (existing but empty).
      await clearProposalsJsonl({ repoRoot: tmpRepo });

      // FALSIFICATION: if clearProposalsJsonl archived unconditionally
      // (ignoring the empty-content guard), the archive would grow even
      // though nothing new was queued.
      expect(readRaw(archiveJsonlPath)).toBe(archiveAfterFirstClear);
    });

    it('the archive accumulates across two separate non-empty clear cycles', async () => {
      await appendProposal({ record: makeRecord({ subject: 'round-1' }), repoRoot: tmpRepo, waveId: 'W1' });
      await clearProposalsJsonl({ repoRoot: tmpRepo });
      const afterRound1 = readJsonlLines(archiveJsonlPath);
      expect(afterRound1).toHaveLength(1); // guard

      await appendProposal({ record: makeRecord({ subject: 'round-2' }), repoRoot: tmpRepo, waveId: 'W1' });
      await clearProposalsJsonl({ repoRoot: tmpRepo });
      const afterRound2 = readJsonlLines(archiveJsonlPath);

      // FALSIFICATION: if the archive write overwrote instead of appended,
      // afterRound2 would still have length 1 (only round-2's entry).
      expect(afterRound2).toHaveLength(2);
      expect(afterRound2[0].subject).toBe('round-1');
      expect(afterRound2[1].subject).toBe('round-2');
    });

    it('clearing an absent proposals.jsonl (never seeded) produces no archive file', async () => {
      expect(existsSync(proposalsJsonlPath)).toBe(false); // guard: nothing seeded

      const { cleared } = await clearProposalsJsonl({ repoRoot: tmpRepo });

      // FALSIFICATION: if the "existsSync before read" guard were removed,
      // this call could throw (ENOENT) or create a spurious empty archive.
      expect(cleared).toBe(true);
      expect(existsSync(archiveJsonlPath)).toBe(false);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Full regression round-trip: the exact #797 failure sequence, now safe
  // ─────────────────────────────────────────────────────────────────────────

  describe('#797 full round-trip: wrong-arg call is rejected, correct call + clear preserves recovery copy', () => {
    it('correct writeApproved followed by clearProposalsJsonl leaves an archive recovery copy', async () => {
      await appendProposal({ record: makeRecord({ subject: 'recoverable' }), repoRoot: tmpRepo, waveId: 'W1' });
      const proposals = readJsonlLines(proposalsJsonlPath);

      const { written, errors } = await writeApproved({
        approved: proposals,
        repoRoot: tmpRepo,
        sessionId: SESSION_ID,
      });
      expect(errors).toHaveLength(0);
      expect(written).toBe(1);

      await clearProposalsJsonl({ repoRoot: tmpRepo });

      // Even though writeApproved succeeded here, the archive still exists as
      // a defense-in-depth recovery copy of what was cleared.
      const archived = readJsonlLines(archiveJsonlPath);
      expect(archived).toHaveLength(1);
      expect(archived[0].subject).toBe('recoverable');
      expect(readJsonlLines(learningsJsonlPath)).toHaveLength(1);
    });
  });
});
