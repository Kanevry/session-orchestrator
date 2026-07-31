/**
 * idempotency.test.mjs — Unit tests for the #695 FA2 Reconciliation Engine
 * record-store I/O + logical dedupe + idempotency module
 * (`scripts/lib/reconcile/idempotency.mjs`).
 *
 * ALL disk access targets a per-test TEMP dir (mkdtempSync under os.tmpdir),
 * cleaned up in afterEach. The real `.orchestrator/runtime/` store is NEVER
 * touched. The store path is passed explicitly so resolveStorePath stays inside
 * the temp tree.
 *
 * The idempotency KEY is the logical `learning_key` (issue #695), not the
 * physical hashed `id` — these tests assert dedupe + processed-guard against
 * `learning_key`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_STORE_PATH,
  makeCandidateId,
  loadCandidates,
  isProcessed,
  mergeCandidates,
} from '../../../scripts/lib/reconcile/idempotency.mjs';

let tmpDir;
let storePath;

/** Minimal valid ReconcileCandidate (live: processed_at null). */
function candidate(overrides = {}) {
  return {
    id: 'rc-aaaa1111',
    schema_version: 1,
    learning_key: 'fragile-pattern/zx-imports',
    slug: 'fragile-pattern-zx-imports-660952b',
    status: 'proposed',
    reason: 'reconciliation engine proposed a conditional rule',
    confidence: 0.8,
    created_at: '2026-06-21T00:00:00.000Z',
    processed_at: null,
    superseded_by: null,
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'reconcile-idempotency-'));
  storePath = join(tmpDir, 'reconcile-candidates.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('DEFAULT_STORE_PATH', () => {
  it('points at the reconcile work-queue under .orchestrator/runtime', () => {
    expect(DEFAULT_STORE_PATH).toBe('.orchestrator/runtime/reconcile-candidates.jsonl');
  });
});

describe('makeCandidateId', () => {
  // TV-003 consolidation: the former "deterministic and rc-prefixed" and
  // "different id for a different slug" cases exercised the same one-line pure
  // function over the same inputs; merged into one case covering both halves of
  // its contract (stability + slug-sensitivity) with no assertion lost.
  it('is deterministic, rc-prefixed, and slug-sensitive', () => {
    const a = makeCandidateId('fragile-pattern/zx-imports', 'slug-abc');
    const b = makeCandidateId('fragile-pattern/zx-imports', 'slug-abc');
    const c = makeCandidateId('fragile-pattern/zx-imports', 'slug-xyz');
    expect(a).toBe(b);
    expect(a).toMatch(/^rc-[0-9a-f]{8}$/);
    expect(a).not.toBe(c);
  });
});

describe('loadCandidates', () => {
  it('returns an empty array for a missing file (no throw)', () => {
    expect(loadCandidates({ storePath: join(tmpDir, 'does-not-exist.jsonl') })).toEqual([]);
  });

  it('skips a malformed line and returns the valid records (no throw)', () => {
    const valid = JSON.stringify(candidate({ learning_key: 'fragile-pattern/zx-imports' }));
    writeFileSync(storePath, `${valid}\nthis is not json\n`, 'utf8');

    const loaded = loadCandidates({ storePath });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].learning_key).toBe('fragile-pattern/zx-imports');
  });

  // TV-001 — the bug this catches, which the rest of the suite lets through:
  // on 2026-07-31 a wave-agent hand-wrote 16 report records into the real store
  // (`.orchestrator/runtime/reconcile-candidates.jsonl`) in a shape NO writer in
  // this repo produces — `candidate_id`/`generated_at`/`status:"candidate"`, no
  // `created_at`, no `schema_version`, no `processed_at`. readStore accepted every
  // non-array object verbatim, so those records entered the work-queue: they were
  // returned by loadCandidates, counted by the reconcile nudge banner's
  // `lastRunCandidateCount`, and yet invisible to `_lastRunAt` (which reads
  // `created_at`) — a non-empty store reporting "no reconcile run on record".
  // Every other test in this file feeds the store WRITER-FAITHFUL records plus
  // one unparseable line; a well-formed record of the WRONG SHAPE was never
  // exercised, so nothing here goes red when the guard is removed.
  // Fixture is a golden record: field set + order copied from a real line of the
  // 2026-07-31 store, long text values truncated (testing.md § Fixtures Mirror
  // Production Data). NOTE it carries a valid `learning_key` — only the missing
  // `created_at` rejects it, so a `learning_key`-only guard would NOT bite.
  it('rejects a shape-foreign record (candidate_id/generated_at, no created_at)', () => {
    const foreign = {
      learning_key: 'anti-pattern/console-log-process-exit-drops-stdout',
      slug: 'anti-pattern-console-log-process-exit-drops-stdout-91c32e4',
      confidence: 0.95,
      always_apply: 'false',
      globs: ['scripts/lib/**'],
      scope: 'glob-scoped',
      expires_at: '2026-10-27',
      description: 'Node stdout is ASYNC on a pipe (macOS)',
      candidate_id: 'rc-f587113f',
      rule_path: '.claude/rules/anti-pattern-console-log-process-exit-drops-stdout-91c32e4.md',
      status: 'candidate',
      generated_at: '2026-07-31T07:09:33.905Z',
      generated_by: 'W3-reconcile-candidate-dry-run',
    };
    const valid = candidate({ learning_key: 'fragile-pattern/zx-imports' });
    writeFileSync(storePath, `${JSON.stringify(foreign)}\n${JSON.stringify(valid)}\n`, 'utf8');

    // Read side: the foreign record never reaches a consumer.
    const loaded = loadCandidates({ storePath });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].learning_key).toBe('fragile-pattern/zx-imports');

    // Write side: the drop is reported, not silent, and the store is purged of it.
    const result = mergeCandidates({ candidates: [], storePath });
    expect(result.skipped).toBe(1);
    expect(result.merged.map((r) => r.learning_key)).toEqual(['fragile-pattern/zx-imports']);
    expect(loadCandidates({ storePath })).toHaveLength(1);
  });
});

describe('mergeCandidates', () => {
  it('writes one new candidate into an empty store and reads it back', () => {
    const result = mergeCandidates({ candidates: [candidate()], storePath });
    expect(result.written).toBe(true);

    const loaded = loadCandidates({ storePath });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      learning_key: 'fragile-pattern/zx-imports',
      status: 'proposed',
      confidence: 0.8,
    });
  });

  it('dedupes by learning_key — re-merging the same key keeps exactly one line (latest wins)', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-old', reason: 'first' })], storePath });
    mergeCandidates({ candidates: [candidate({ id: 'rc-new', reason: 'second' })], storePath });

    const loaded = loadCandidates({ storePath });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('rc-new');
    expect(loaded[0].reason).toBe('second');
  });

  it('does not overwrite a processed candidate when a new same-key candidate is merged', () => {
    mergeCandidates({
      candidates: [candidate({ id: 'rc-done', processed_at: '2026-06-21T12:00:00.000Z' })],
      storePath,
    });
    mergeCandidates({ candidates: [candidate({ id: 'rc-new', processed_at: null })], storePath });

    const loaded = loadCandidates({ storePath });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('rc-done');
    expect(loaded[0].processed_at).toBe('2026-06-21T12:00:00.000Z');
  });
});

describe('isProcessed', () => {
  it('returns true when existing holds the same learning_key with a terminal processed_at', () => {
    const cand = candidate({ learning_key: 'fragile-pattern/zx-imports' });
    const existing = [candidate({ learning_key: 'fragile-pattern/zx-imports', processed_at: '2026-06-21T12:00:00.000Z' })];
    expect(isProcessed(cand, existing)).toBe(true);
  });

  it('returns false when the matching existing candidate is still live (processed_at null)', () => {
    const cand = candidate({ learning_key: 'fragile-pattern/zx-imports' });
    const existing = [candidate({ learning_key: 'fragile-pattern/zx-imports', processed_at: null })];
    expect(isProcessed(cand, existing)).toBe(false);
  });

  it('returns false when no existing candidate shares the learning_key', () => {
    const cand = candidate({ learning_key: 'fragile-pattern/zx-imports' });
    const existing = [candidate({ learning_key: 'anti-pattern/other', processed_at: '2026-06-21T12:00:00.000Z' })];
    expect(isProcessed(cand, existing)).toBe(false);
  });
});
