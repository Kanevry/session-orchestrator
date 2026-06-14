/**
 * idempotency.test.mjs — Unit tests for the #647 C2 record-store I/O +
 * supersession + idempotency module.
 *
 * All disk access targets a per-test TEMP dir (mkdtempSync under os.tmpdir),
 * cleaned up in afterEach. The real `.orchestrator` store is never touched.
 *
 * Covers:
 *   - mergeCandidates writes fresh candidates.
 *   - markProcessed + isProcessed lifecycle.
 *   - idempotent skip of an already-processed id on re-merge.
 *   - supersession of an older same-(source,target_path) candidate by a new id.
 *   - loadCandidates returns [] for a missing file.
 *   - DEFAULT_STORE_PATH constant contract.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  mergeCandidates,
  markProcessed,
  isProcessed,
  loadCandidates,
  DEFAULT_STORE_PATH,
} from '@lib/skill-evolution/idempotency.mjs';

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

describe('DEFAULT_STORE_PATH', () => {
  it('points at the runtime work-queue under .orchestrator', () => {
    expect(DEFAULT_STORE_PATH).toBe('.orchestrator/runtime/repair-candidates.jsonl');
  });
});

describe('mergeCandidates', () => {
  it('writes two fresh candidates', () => {
    const result = mergeCandidates({
      candidates: [candidate({ id: 'rc-1111' }), candidate({ id: 'rc-2222', target_path: 'scripts/lib/bar.mjs' })],
      storePath,
    });
    expect(result).toEqual({ written: 2, superseded: 0, skipped_processed: 0, total: 2 });
  });

  it('persists merged candidates so loadCandidates reads them back', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    const loaded = loadCandidates({ storePath });
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe('rc-1111');
  });
});

describe('markProcessed + isProcessed', () => {
  it('marks a candidate processed and reports it as processed', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    const marked = markProcessed({ id: 'rc-1111', storePath, now: '2026-06-14T13:00:00.000Z' });
    expect(marked).toEqual({ ok: true });
    expect(isProcessed({ id: 'rc-1111', storePath })).toBe(true);
  });

  it('returns not-found when stamping an id that does not exist', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    expect(markProcessed({ id: 'rc-missing', storePath })).toEqual({ ok: false, reason: 'not-found' });
  });

  it('reports a live (unprocessed) candidate as not processed', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    expect(isProcessed({ id: 'rc-1111', storePath })).toBe(false);
  });
});

describe('idempotency — re-merge of a processed id', () => {
  it('skips a re-merged already-processed id without re-adding it', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    markProcessed({ id: 'rc-1111', storePath, now: '2026-06-14T13:00:00.000Z' });

    const result = mergeCandidates({ candidates: [candidate({ id: 'rc-1111' })], storePath });
    expect(result).toEqual({ written: 0, superseded: 0, skipped_processed: 1, total: 1 });
  });
});

describe('supersession', () => {
  it('stamps the older same-(source,target_path) candidate with the new id', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-old' })], storePath });
    const result = mergeCandidates({
      candidates: [candidate({ id: 'rc-new' })],
      storePath,
    });
    expect(result).toEqual({ written: 1, superseded: 1, skipped_processed: 0, total: 2 });

    const loaded = loadCandidates({ storePath });
    const older = loaded.find((r) => r.id === 'rc-old');
    expect(older.superseded_by).toBe('rc-new');
  });

  it('does not supersede a candidate with a different source or target_path', () => {
    mergeCandidates({ candidates: [candidate({ id: 'rc-old', target_path: 'scripts/lib/foo.mjs' })], storePath });
    const result = mergeCandidates({
      candidates: [candidate({ id: 'rc-new', target_path: 'scripts/lib/bar.mjs' })],
      storePath,
    });
    expect(result).toEqual({ written: 1, superseded: 0, skipped_processed: 0, total: 2 });
  });
});

describe('loadCandidates', () => {
  it('returns an empty array for a missing file', () => {
    expect(loadCandidates({ storePath: join(tmpDir, 'does-not-exist.jsonl') })).toEqual([]);
  });
});
