/**
 * tests/scripts/lib/learnings/surface.test.mjs
 *
 * Unit tests for scripts/lib/learnings/surface.mjs — surfaceTopN().
 *
 * Pattern: mkdtempSync per-suite via beforeEach/afterEach, hardcoded
 * expected literals, frozen clock for expiry tests.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { surfaceTopN } from '@lib/learnings/surface.mjs';

// ---------------------------------------------------------------------------
// Tmp-dir lifecycle
// ---------------------------------------------------------------------------

let tmpDir;
let filePath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'surface-test-'));
  filePath = join(tmpDir, 'learnings.jsonl');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write JSONL lines to filePath. Each element is either a plain string
 *  (already serialised) or an object (will be JSON.stringify'd). */
function writeLines(...entries) {
  const content = entries.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n');
  writeFileSync(filePath, content, 'utf8');
}

/** A minimal valid learning entry above the default confidence floor. */
function entry(overrides = {}) {
  return {
    id: 'test-id',
    type: 'recurring-issue',
    subject: 'test subject',
    confidence: 0.8,
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('surfaceTopN', () => {
  // 1. Missing file → returns []
  it('returns [] when the file does not exist', async () => {
    const result = await surfaceTopN(join(tmpDir, 'nonexistent.jsonl'));
    expect(result).toEqual([]);
  });

  // 2. Empty file (0 bytes) → returns []
  it('returns [] for a zero-byte file', async () => {
    writeFileSync(filePath, '', 'utf8');
    const result = await surfaceTopN(filePath);
    expect(result).toEqual([]);
  });

  // 3. File with only blank lines → returns []
  it('returns [] for a file containing only blank lines', async () => {
    writeFileSync(filePath, '\n\n\n', 'utf8');
    const result = await surfaceTopN(filePath);
    expect(result).toEqual([]);
  });

  // 4. Malformed line in middle of valid lines → silently skipped, others surface
  it('skips malformed JSON lines and surfaces valid entries', async () => {
    const good = entry({ id: 'good', confidence: 0.9 });
    writeLines(good, 'NOT VALID JSON }{', entry({ id: 'good2', confidence: 0.7 }));
    const result = await surfaceTopN(filePath);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('good');
    expect(result[1].id).toBe('good2');
  });

  // 5. Single entry above floor → returns that 1 entry
  it('returns a single entry when only one entry is above the confidence floor', async () => {
    const e = entry({ id: 'solo', confidence: 0.5 });
    writeLines(e);
    const result = await surfaceTopN(filePath);
    expect(result).toEqual([e]);
  });

  // 6. Multiple entries above floor → sorted confidence DESC, sliced to n
  it('returns entries sorted by confidence DESC when all are above the floor', async () => {
    const low = entry({ id: 'low', confidence: 0.5, created_at: '2026-01-01T00:00:00Z' });
    const high = entry({ id: 'high', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' });
    const mid = entry({ id: 'mid', confidence: 0.7, created_at: '2026-01-01T00:00:00Z' });
    writeLines(low, high, mid);
    const result = await surfaceTopN(filePath, 10);
    expect(result[0].id).toBe('high');
    expect(result[1].id).toBe('mid');
    expect(result[2].id).toBe('low');
  });

  // 7. Confidence floor is STRICT >: confidence === 0.3 dropped, 0.31 kept
  it('drops entries with confidence exactly equal to the default floor (0.3)', async () => {
    const atFloor = entry({ id: 'at-floor', confidence: 0.3 });
    const aboveFloor = entry({ id: 'above-floor', confidence: 0.31 });
    writeLines(atFloor, aboveFloor);
    const result = await surfaceTopN(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('above-floor');
  });

  // 8. Custom confidenceFloor — 0.4 dropped when floor=0.5, 0.6 kept
  it('applies a custom confidenceFloor correctly', async () => {
    const dropped = entry({ id: 'dropped', confidence: 0.4 });
    const kept = entry({ id: 'kept', confidence: 0.6 });
    writeLines(dropped, kept);
    const result = await surfaceTopN(filePath, 5, { confidenceFloor: 0.5 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('kept');
  });

  // 9. Tiebreaker: same confidence, newer created_at wins
  it('breaks confidence ties by created_at DESC (newer first)', async () => {
    const older = entry({ id: 'older', confidence: 0.8, created_at: '2025-01-01T00:00:00Z' });
    const newer = entry({ id: 'newer', confidence: 0.8, created_at: '2026-03-01T00:00:00Z' });
    writeLines(older, newer);
    const result = await surfaceTopN(filePath, 10);
    expect(result[0].id).toBe('newer');
    expect(result[1].id).toBe('older');
  });

  // 10. Expired entry dropped; future expires_at kept
  it('drops entries whose expires_at is before now and keeps entries with future expires_at', async () => {
    const frozenNow = new Date('2026-05-23T12:00:00Z');
    const expired = entry({ id: 'expired', confidence: 0.9, expires_at: '2026-05-22T00:00:00Z' });
    const fresh = entry({ id: 'fresh', confidence: 0.8, expires_at: '2026-06-01T00:00:00Z' });
    writeLines(expired, fresh);
    const result = await surfaceTopN(filePath, 5, { now: frozenNow });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('fresh');
  });

  // 11. Entry missing expires_at → treated as not-expired (kept)
  it('keeps entries that have no expires_at field', async () => {
    const e = entry({ id: 'no-expiry', confidence: 0.75 });
    delete e.expires_at; // ensure field is absent
    writeLines(e);
    const result = await surfaceTopN(filePath, 5, { now: new Date('2099-01-01T00:00:00Z') });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('no-expiry');
  });

  // 12. Entry missing confidence → treated as 0 → dropped
  it('drops entries that have no confidence field', async () => {
    const noConf = { id: 'no-conf', type: 'recurring-issue', subject: 'x', created_at: '2026-01-01T00:00:00Z' };
    const withConf = entry({ id: 'with-conf', confidence: 0.8 });
    writeLines(noConf, withConf);
    const result = await surfaceTopN(filePath);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('with-conf');
  });

  // 13. N slicing: 5 valid entries, n=3 → exactly 3 returned (top-3 by confidence)
  it('slices the result to n entries', async () => {
    const entries = [
      entry({ id: 'e1', confidence: 0.9, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e2', confidence: 0.85, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e3', confidence: 0.80, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e4', confidence: 0.75, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e5', confidence: 0.70, created_at: '2026-01-01T00:00:00Z' }),
    ];
    writeLines(...entries);
    const result = await surfaceTopN(filePath, 3);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('e1');
    expect(result[1].id).toBe('e2');
    expect(result[2].id).toBe('e3');
  });

  // 14. Default n=5: file with 7 entries → returns exactly 5
  it('defaults n to 5, returning 5 entries from a 7-entry file', async () => {
    const entries = [
      entry({ id: 'a', confidence: 0.98, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'b', confidence: 0.95, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'c', confidence: 0.90, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'd', confidence: 0.85, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'e', confidence: 0.80, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'f', confidence: 0.75, created_at: '2026-01-01T00:00:00Z' }),
      entry({ id: 'g', confidence: 0.70, created_at: '2026-01-01T00:00:00Z' }),
    ];
    writeLines(...entries);
    const result = await surfaceTopN(filePath);
    expect(result).toHaveLength(5);
    expect(result[0].id).toBe('a');
    expect(result[4].id).toBe('e');
  });

  // 15. now passed as a number (epoch ms) — exercises the typeof nowOpt === 'number' branch
  it('accepts now as a numeric epoch ms for expiry evaluation', async () => {
    const nowMs = new Date('2026-05-23T12:00:00Z').getTime();
    const expired = entry({ id: 'expired-num', confidence: 0.9, expires_at: '2026-05-22T00:00:00Z' });
    const fresh = entry({ id: 'fresh-num', confidence: 0.8, expires_at: '2026-06-01T00:00:00Z' });
    writeLines(expired, fresh);
    const result = await surfaceTopN(filePath, 5, { now: nowMs });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('fresh-num');
  });

  // 16. Tiebreaker with entries missing created_at → stable sort, missing treated as epoch 0
  it('sorts entries missing created_at to the end of a confidence tie', async () => {
    const withDate = entry({ id: 'with-date', confidence: 0.8, created_at: '2026-01-01T00:00:00Z' });
    const noDate = { id: 'no-date', type: 'recurring-issue', subject: 'x', confidence: 0.8 };
    writeLines(withDate, noDate);
    const result = await surfaceTopN(filePath, 10);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('with-date');
    expect(result[1].id).toBe('no-date');
  });

  // 17. Stable sort when BOTH confidence AND created_at are tied — input order preserved (#541 G3)
  it('preserves input order for entries with identical confidence AND identical created_at (stable sort)', async () => {
    const first = entry({ id: 'first-in', confidence: 0.8, created_at: '2026-01-01T00:00:00Z' });
    const second = entry({ id: 'second-in', confidence: 0.8, created_at: '2026-01-01T00:00:00Z' });
    const third = entry({ id: 'third-in', confidence: 0.8, created_at: '2026-01-01T00:00:00Z' });
    writeLines(first, second, third);
    const result = await surfaceTopN(filePath, 10);
    expect(result).toHaveLength(3);
    expect(result[0].id).toBe('first-in');
    expect(result[1].id).toBe('second-in');
    expect(result[2].id).toBe('third-in');
  });
});
