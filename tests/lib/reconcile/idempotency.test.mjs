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
  it('is deterministic and rc-prefixed — same inputs yield the same id', () => {
    const a = makeCandidateId('fragile-pattern/zx-imports', 'slug-abc');
    const b = makeCandidateId('fragile-pattern/zx-imports', 'slug-abc');
    expect(a).toBe(b);
    expect(a).toMatch(/^rc-[0-9a-f]{8}$/);
  });

  it('yields a different id for a different slug', () => {
    const a = makeCandidateId('fragile-pattern/zx-imports', 'slug-abc');
    const b = makeCandidateId('fragile-pattern/zx-imports', 'slug-xyz');
    expect(a).not.toBe(b);
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
