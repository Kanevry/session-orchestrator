/**
 * collector.test.mjs — Unit tests for the collect-emit confidence filter
 * (issue #566) applied inside `collectProposals()` of
 * `scripts/lib/memory-proposals/collector.mjs`.
 *
 * Scope: the SECOND confidence gate (Session Config key
 * `auto-dream.min-confidence`) applied at session-end Phase 3.6.3 — above the
 * existing write-time `memory.proposals.confidence-floor` enforced by
 * `scripts/memory-propose.mjs`.
 *
 * Integration tests for the full collector → sink → AUQ pipeline live at
 * `tests/scripts/lib/memory-proposals/collector-sink.test.mjs`; this file is
 * a focused regression for the #566 filter behaviour and the back-compat
 * guarantee (no minConfidence → no filtering).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectProposals } from '@lib/memory-proposals/collector.mjs';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid proposal JSONL line. `confidence` is the only field
 * the #566 filter inspects; everything else is plausible filler so the
 * deserializer accepts the record.
 */
function makeJsonl(confidence, subject = 'subject', extras = {}) {
  return JSON.stringify({
    schema_version: 1,
    id: `prop-${subject}`,
    type: 'workflow-pattern',
    subject,
    insight: 'insight body',
    evidence: 'evidence body',
    confidence,
    wave_id: 'W1',
    created_at: new Date().toISOString(),
    ...extras,
  });
}

describe('collectProposals — #566 collect-emit confidence filter', () => {
  let tmpRepo;
  let proposalsJsonlPath;

  beforeEach(() => {
    // macOS /var → /private/var canonicalization for downstream realpath
    // checks.
    tmpRepo = realpathSync(mkdtempSync(join(tmpdir(), 'collector-566-')));
    proposalsJsonlPath = join(tmpRepo, '.orchestrator', 'metrics', 'proposals.jsonl');
    mkdirSync(join(tmpRepo, '.orchestrator', 'metrics'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpRepo, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // AC test — the headline assertion from issue #566
  // ─────────────────────────────────────────────────────────────────────────

  it('filters out records below minConfidence (0.4 dropped, 0.6 kept at floor 0.5)', async () => {
    // Two records: confidence 0.4 (must be filtered out) and 0.6 (must pass).
    // Created-at delta keeps FIFO ordering deterministic.
    const t1 = '2026-05-27T10:00:00.000Z';
    const t2 = '2026-05-27T10:00:01.000Z';
    const lines = [
      makeJsonl(0.4, 'low-conf-alpha', { created_at: t1 }),
      makeJsonl(0.6, 'high-conf-beta', { created_at: t2 }),
    ];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    const { queue } = await collectProposals({
      repoRoot: tmpRepo,
      minConfidence: 0.5,
    });

    // FALSIFICATION: if the filter were not applied (or applied with the
    // wrong comparator), the 0.4 record would survive and queue.length would
    // be 2.
    expect(queue).toHaveLength(1);
    expect(queue[0].confidence).toBe(0.6);
    expect(queue[0].subject).toBe('high-conf-beta');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Back-compat — null/undefined/non-number disables the filter
  // ─────────────────────────────────────────────────────────────────────────

  it('back-compat: minConfidence omitted leaves the queue unfiltered', async () => {
    const lines = [
      makeJsonl(0.4, 'low-conf-alpha'),
      makeJsonl(0.6, 'high-conf-beta'),
    ];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    // No minConfidence — filter must be inactive.
    const { queue } = await collectProposals({ repoRoot: tmpRepo });

    // FALSIFICATION: if the default were applied (e.g. 0.5) instead of being
    // disabled, the 0.4 record would be filtered and queue.length would be 1.
    expect(queue).toHaveLength(2);
  });

  it('back-compat: minConfidence=null leaves the queue unfiltered', async () => {
    const lines = [
      makeJsonl(0.4, 'low-conf'),
      makeJsonl(0.9, 'high-conf'),
    ];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    const { queue } = await collectProposals({ repoRoot: tmpRepo, minConfidence: null });

    expect(queue).toHaveLength(2);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Boundary semantics — `>=` not `>`
  // ─────────────────────────────────────────────────────────────────────────

  it('confidence exactly at the floor (0.5) is KEPT (>= comparator)', async () => {
    const lines = [makeJsonl(0.5, 'at-floor')];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    const { queue } = await collectProposals({ repoRoot: tmpRepo, minConfidence: 0.5 });

    // FALSIFICATION: if the comparator were `>` instead of `>=`, the
    // boundary record would be dropped and queue.length would be 0.
    expect(queue).toHaveLength(1);
    expect(queue[0].confidence).toBe(0.5);
  });

  it('confidence just below the floor (0.499) is DROPPED', async () => {
    const lines = [makeJsonl(0.499, 'just-below')];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    const { queue } = await collectProposals({ repoRoot: tmpRepo, minConfidence: 0.5 });

    // FALSIFICATION: an off-by-one in the floor comparison would let 0.499
    // pass and queue.length would be 1.
    expect(queue).toHaveLength(0);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Stats invariant — stats reflect full intake, NOT post-filter
  // ─────────────────────────────────────────────────────────────────────────

  it('stats.parse_errors reflects the raw file (not the post-filter queue)', async () => {
    // 3 valid records (one low-conf to be filtered out by minConfidence=0.5)
    // plus 1 malformed line. parse_errors must count the malformed line, NOT
    // the filtered one.
    const lines = [
      makeJsonl(0.4, 'low'),
      makeJsonl(0.7, 'mid'),
      'not valid json',
      makeJsonl(0.9, 'high'),
    ];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    const { queue, stats } = await collectProposals({
      repoRoot: tmpRepo,
      minConfidence: 0.5,
    });

    // queue: 2 (0.7, 0.9) — 0.4 filtered out, malformed dropped by deserializer
    expect(queue).toHaveLength(2);

    // parse_errors: raw lines (4) minus successfully parsed records (3 before
    // filter) = 1. If the filter were applied BEFORE the parse_errors
    // computation, parse_errors would be 4-2=2.
    expect(stats.parse_errors).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge — minConfidence=0 keeps everything (including 0.0 records)
  // ─────────────────────────────────────────────────────────────────────────

  it('minConfidence=0 keeps every record (even confidence=0)', async () => {
    const lines = [
      makeJsonl(0, 'zero'),
      makeJsonl(0.5, 'half'),
      makeJsonl(1, 'one'),
    ];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    const { queue } = await collectProposals({ repoRoot: tmpRepo, minConfidence: 0 });

    expect(queue).toHaveLength(3);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge — minConfidence=1 keeps only confidence=1 records
  // ─────────────────────────────────────────────────────────────────────────

  it('minConfidence=1 keeps only records with confidence exactly 1', async () => {
    const lines = [
      makeJsonl(0.99, 'almost'),
      makeJsonl(1, 'perfect'),
    ];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    const { queue } = await collectProposals({ repoRoot: tmpRepo, minConfidence: 1 });

    expect(queue).toHaveLength(1);
    expect(queue[0].subject).toBe('perfect');
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Edge — non-number minConfidence is treated as no filter
  // ─────────────────────────────────────────────────────────────────────────

  it('non-numeric minConfidence (string) leaves the queue unfiltered', async () => {
    const lines = [
      makeJsonl(0.1, 'a'),
      makeJsonl(0.9, 'b'),
    ];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    // @ts-expect-error — exercising defensive guard against bad operator config
    const { queue } = await collectProposals({ repoRoot: tmpRepo, minConfidence: 'abc' });

    // FALSIFICATION: if the guard `typeof === 'number'` were missing, a
    // string compare would coerce and drop records arbitrarily.
    expect(queue).toHaveLength(2);
  });

  it('NaN minConfidence leaves the queue unfiltered (Number.isFinite guard)', async () => {
    const lines = [
      makeJsonl(0.1, 'a'),
      makeJsonl(0.9, 'b'),
    ];
    writeFileSync(proposalsJsonlPath, lines.join('\n') + '\n', 'utf8');

    const { queue } = await collectProposals({ repoRoot: tmpRepo, minConfidence: Number.NaN });

    // FALSIFICATION: NaN >= NaN is false — every record would be filtered
    // out, queue.length would be 0. Number.isFinite catches this.
    expect(queue).toHaveLength(2);
  });
});
