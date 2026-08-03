/**
 * idempotency.test.mjs — Unit tests for the #647 C2 record-store I/O +
 * supersession + idempotency module.
 *
 * All disk access targets a per-test TEMP dir (mkdtempSync under os.tmpdir),
 * cleaned up in afterEach. The real `.orchestrator` store is never touched.
 *
 * Covers:
 *   - mergeCandidates writes fresh candidates + persists them for read-back.
 *   - the live → markProcessed → isProcessed lifecycle.
 *   - idempotent skip of an already-processed id on re-merge.
 *   - supersession of an older same-(source,target_path) candidate by a new id,
 *     and the two ways a candidate FAILS to supersede.
 *   - the read-side shape guard: a contaminated store drops foreign lines and
 *     COUNTS them (`dropped_on_read`) while every record minted by the real
 *     producer path (`candidate-intake.mjs`) survives — GitLab #955 finding 3.
 *   - the stderr WARN that covers the two rewrite/read paths whose return
 *     contract has no slot for that count (`markProcessed` / `isProcessed`),
 *     plus its per-store anti-spam memo.
 *   - loadCandidates returns [] for a missing file (plain-array contract).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeCandidates,
  markProcessed,
  isProcessed,
  loadCandidates,
  DEFAULT_STORE_PATH,
} from '@lib/skill-evolution/idempotency.mjs';
import { extractCandidates } from '@lib/skill-evolution/candidate-intake.mjs';

let tmpDir;
let storePath;

/** Minimal valid RepairCandidate (live: processed_at null, not superseded). */
function candidate(overrides = {}) {
  return {
    id: 'rc-aaaa1111',
    schema_version: 1,
    source: 'evolve-learning',
    source_ref: 'learn-1',
    target_path: 'scripts/lib/foo.mjs',
    evidence: 0.8,
    evidence_kind: 'confidence',
    proposed_change: 'Fix the default',
    rationale: 'because',
    created_at: '2026-06-14T12:00:00.000Z',
    processed_at: null,
    superseded_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'idempotency-test-'));
  storePath = join(tmpDir, 'repair-candidates.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('mergeCandidates', () => {
  it('writes fresh candidates and persists them for read-back', () => {
    const result = mergeCandidates({
      candidates: [
        candidate({ id: 'rc-1111' }),
        candidate({ id: 'rc-2222', target_path: 'scripts/lib/bar.mjs' }),
      ],
      storePath,
    });
    expect(result).toEqual({
      written: 2,
      superseded: 0,
      skipped_processed: 0,
      dropped_on_read: 0,
      total: 2,
    });
    expect(loadCandidates({ storePath }).map((r) => r.id)).toEqual(['rc-1111', 'rc-2222']);
  });
});

describe('markProcessed + isProcessed', () => {
  it('reports a live candidate unprocessed, then processed after stamping', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    expect(isProcessed({ id: 'rc-1111', storePath })).toBe(false);

    const marked = markProcessed({ id: 'rc-1111', storePath, now: '2026-06-14T13:00:00.000Z' });
    expect(marked).toEqual({ ok: true });
    expect(isProcessed({ id: 'rc-1111', storePath })).toBe(true);
  });

  it('returns not-found when stamping an id that does not exist', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    expect(markProcessed({ id: 'rc-missing', storePath })).toEqual({ ok: false, reason: 'not-found' });
  });
});

describe('idempotency — re-merge of a processed id', () => {
  it('skips a re-merged already-processed id without re-adding it', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    markProcessed({ id: 'rc-1111', storePath, now: '2026-06-14T13:00:00.000Z' });

    const result = mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    expect(result).toEqual({
      written: 0,
      superseded: 0,
      skipped_processed: 1,
      dropped_on_read: 0,
      total: 1,
    });
  });
});

describe('supersession', () => {
  it('stamps the older same-(source,target_path) candidate with the new id', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-old' })], storePath });
    const result = mergeCandidates({ candidates: [candidate({ id: 'rc-new' })], storePath });
    expect(result).toEqual({
      written: 1,
      superseded: 1,
      skipped_processed: 0,
      dropped_on_read: 0,
      total: 2,
    });

    const older = loadCandidates({ storePath }).find((r) => r.id === 'rc-old');
    expect(older.superseded_by).toBe('rc-new');
  });

  // BOTH halves of the supersession key must match. Pinning only the
  // target_path half would stay green if the `rec.source === cand.source`
  // comparison were dropped — which would falsely supersede a drift-check
  // candidate with an evolve-learning one aimed at the same file.
  it.each([
    ['a different target_path', { target_path: 'scripts/lib/bar.mjs' }],
    ['a different source', { source: 'drift-check' }],
  ])('does not supersede a candidate with %s', (_label, newFields) => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-old' })], storePath });
    const result = mergeCandidates({
      candidates: [candidate({ id: 'rc-new', ...newFields })],
      storePath,
    });
    expect(result).toEqual({
      written: 1,
      superseded: 0,
      skipped_processed: 0,
      dropped_on_read: 0,
      total: 2,
    });
    expect(loadCandidates({ storePath }).find((r) => r.id === 'rc-old').superseded_by).toBeNull();
  });
});

describe('read-side shape guard (#955 finding 3)', () => {
  // The sibling reconcile store was contaminated by a hand-written report
  // artefact that the old permissive `typeof parsed === 'object'` check
  // accepted. This store is the near-twin. The guard must drop foreign lines
  // AND count them — a full-rewrite store that drops silently loses data
  // unattributably — WITHOUT rejecting anything the real producer mints.
  it('keeps every candidate-intake record, drops and counts the foreign lines', () => {
    // N = 2 legitimate candidates, minted by the REAL producer path (one per feeder).
    const real = extractCandidates({
      learnings: [
        {
          id: 'learn-1',
          confidence: 0.9,
          subject: 'stale default in scripts/lib/foo.mjs',
          insight: 'fix the default in scripts/lib/foo.mjs',
        },
      ],
      driftResult: {
        status: 'ok',
        errors: [
          { check: 'session-config-parity', file: 'CLAUDE.md', line: 12, message: 'missing key' },
        ],
      },
      now: '2026-07-31T12:00:00.000Z',
    });
    expect(real).toHaveLength(2);

    // M = 4 foreign lines, one per rejection branch.
    const foreign = [
      // 1. the concrete incident shape: a report artefact (no id/source/target_path)
      JSON.stringify({ candidate_id: 'rc-x', generated_at: '2026-07-31', status: 'candidate' }),
      // 2. malformed JSON — the parse-catch branch
      '{ not json',
      // 3. a JSON array — the Array.isArray branch
      JSON.stringify([1, 2, 3]),
      // 4. structurally close but unusable: empty target_path
      JSON.stringify({ id: 'rc-zzz', source: 'evolve-learning', target_path: '' }),
    ];

    // Interleave so the guard cannot pass by position (e.g. a first-line-only check).
    writeFileSync(
      storePath,
      [foreign[0], JSON.stringify(real[0]), foreign[1], foreign[2], JSON.stringify(real[1]), foreign[3]].join('\n') +
        '\n',
      'utf8',
    );

    // Read side: the 2 real records survive, the 4 foreign lines do not.
    expect(loadCandidates({ storePath }).map((r) => r.id)).toEqual([real[0].id, real[1].id]);

    // Merge side: the drop is COUNTED, and separately from `skipped_processed`.
    expect(mergeCandidates({ candidates: [], storePath })).toEqual({
      written: 0,
      superseded: 0,
      skipped_processed: 0,
      dropped_on_read: 4,
      total: 2,
    });

    // ...and the full rewrite has evicted the foreign lines from disk.
    expect(loadCandidates({ storePath }).map((r) => r.id)).toEqual([real[0].id, real[1].id]);
  });

  // TV-001 — the bug this catches, which the case above does NOT: the case above
  // proves the drop is COUNTED through `mergeCandidates`'s result object. But
  // `markProcessed` rewrites the store in full too, and its `{ok, reason}`
  // contract has no slot for a count — so before the readStore-level WARN, a
  // stamp DELETED foreign lines from disk with nothing anywhere reporting it.
  // `isProcessed` reads through the same guard, and both run far more often than
  // a merge, so the most-travelled deletion path was the silent one. This is a
  // regression the hardening itself introduced: the pre-guard `readStore` kept
  // any object, so a foreign record SURVIVED a markProcessed rewrite verbatim.
  // The second half pins the anti-spam memo — a per-read warn would emit one
  // line per candidate in the engine's isProcessed loop, which is how a warning
  // becomes noise and stops being read.
  it('WARNs on stderr when markProcessed/isProcessed delete foreign lines, once per skip-count', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      // --- Store A: markProcessed silently deleted 3 foreign lines. ---
      const real = [candidate({ id: 'rc-1111' }), candidate({ id: 'rc-2222', target_path: 'b.mjs' })];
      const foreign = [
        JSON.stringify({ candidate_id: 'rc-x', generated_at: '2026-07-31', status: 'candidate' }),
        '{ not json',
        JSON.stringify({ id: 'rc-zzz', source: 'evolve-learning', target_path: '' }),
      ];
      writeFileSync(
        storePath,
        [foreign[0], JSON.stringify(real[0]), foreign[1], JSON.stringify(real[1]), foreign[2]].join('\n') + '\n',
        'utf8',
      );

      expect(markProcessed({ id: 'rc-1111', storePath, now: '2026-07-31T13:00:00.000Z' })).toEqual({ ok: true });

      // The M=3 foreign lines are GONE from disk; the N=2 real ones remain.
      const onDisk = readFileSync(storePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      expect(onDisk.map((r) => r.id)).toEqual(['rc-1111', 'rc-2222']);
      expect(onDisk[0].processed_at).toBe('2026-07-31T13:00:00.000Z');

      // ...and stderr carried a WARN naming that count and the store.
      expect(stderr).toHaveBeenCalledTimes(1);
      const warn = String(stderr.mock.calls[0][0]);
      expect(warn).toContain('3 unreadable record(s)');
      expect(warn).toContain(storePath);

      // --- Store B: the read-only path warns too, and repeat reads do not spam. ---
      const storeB = join(tmpDir, 'store-b.jsonl');
      writeFileSync(storeB, `${foreign[0]}\n${JSON.stringify(real[0])}\n`, 'utf8');

      expect(isProcessed({ id: 'rc-1111', storePath: storeB })).toBe(false);
      expect(isProcessed({ id: 'rc-1111', storePath: storeB })).toBe(false);
      expect(stderr).toHaveBeenCalledTimes(2);
      expect(String(stderr.mock.calls[1][0])).toContain('1 unreadable record(s)');
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('loadCandidates', () => {
  it('returns an empty array for a missing file', () => {
    expect(loadCandidates({ storePath: join(tmpDir, 'does-not-exist.jsonl') })).toEqual([]);
    expect(loadCandidates({ storePath: join(tmpDir, DEFAULT_STORE_PATH) })).toEqual([]);
  });
});
