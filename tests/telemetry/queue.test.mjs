/**
 * tests/telemetry/queue.test.mjs
 *
 * Coverage for scripts/lib/telemetry/queue.mjs — the host-local bounded
 * NDJSON offline queue (Epic #841, Issue #844 FA3). Every test injects a
 * mkdtempSync path via the `{ path }` option; no test ever touches
 * TELEMETRY_QUEUE_PATH's real on-disk location.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

import {
  enqueue,
  drain,
  peekAll,
  dropOldest,
  clear,
  queueStats,
  TELEMETRY_QUEUE_PATH,
  MAX_BATCHES,
  MAX_QUEUE_BYTES,
} from '@lib/telemetry/queue.mjs';

let tmpDir;
let queuePath;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'telemetry-queue-'));
  queuePath = join(tmpDir, 'telemetry-queue.ndjson');
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Contract constants
// ---------------------------------------------------------------------------

describe('exported contract constants', () => {
  it('TELEMETRY_QUEUE_PATH ends at .config/session-orchestrator/telemetry-queue.ndjson', () => {
    expect(TELEMETRY_QUEUE_PATH.endsWith(join('.config', 'session-orchestrator', 'telemetry-queue.ndjson'))).toBe(true);
  });

  it('MAX_BATCHES is 50', () => {
    expect(MAX_BATCHES).toBe(50);
  });

  it('MAX_QUEUE_BYTES is 262144 (256 KiB)', () => {
    expect(MAX_QUEUE_BYTES).toBe(262144);
  });
});

// ---------------------------------------------------------------------------
// 1. enqueue on a non-existent directory
// ---------------------------------------------------------------------------

describe('enqueue — directory creation', () => {
  it('creates missing parent directories and writes the first entry', () => {
    const nestedPath = join(tmpDir, 'nested', 'dir', 'telemetry-queue.ndjson');
    const result = enqueue({ event: 'session_start' }, { path: nestedPath });

    expect(result).toEqual({ ok: true, dropped: 0, total: 1 });
    expect(existsSync(nestedPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Batch-count cap (FIFO eviction)
// ---------------------------------------------------------------------------

describe('enqueue — batch-count cap', () => {
  it('drops the single oldest entry when the 51st batch is enqueued', () => {
    const baseMs = Date.parse('2026-01-01T00:00:00.000Z');
    let lastResult;
    for (let i = 0; i < 51; i++) {
      lastResult = enqueue(
        { index: i },
        { path: queuePath, now: new Date(baseMs + i * 1000).toISOString() },
      );
    }

    expect(lastResult).toEqual({ ok: true, dropped: 1, total: 50 });

    const entries = peekAll({ path: queuePath });
    expect(entries).toHaveLength(50);
    // Batch index 0 (the oldest) was evicted; index 1 is now the oldest survivor.
    expect(entries[0].batch).toEqual({ index: 1 });
    expect(entries[49].batch).toEqual({ index: 50 });
  });
});

// ---------------------------------------------------------------------------
// 3. Byte cap (FIFO eviction)
// ---------------------------------------------------------------------------

describe('enqueue — byte cap', () => {
  it('drops oldest entries until the queue is back under MAX_QUEUE_BYTES', () => {
    const payload = 'x'.repeat(20 * 1024); // 20 KiB per batch
    let lastResult;
    for (let i = 0; i < 20; i++) {
      // 20 batches * ~20 KiB ≈ 400 KiB, comfortably above the 256 KiB cap,
      // while staying well under the 50-batch count cap (isolates the byte
      // cap from the count cap).
      lastResult = enqueue({ index: i, data: payload }, { path: queuePath });
    }

    expect(lastResult.ok).toBe(true);
    expect(lastResult.dropped).toBeGreaterThan(0);

    const stats = queueStats({ path: queuePath });
    expect(stats.bytes).toBeLessThanOrEqual(MAX_QUEUE_BYTES);

    // Oldest survivor's index must be > 0 — index 0 was evicted first.
    const entries = peekAll({ path: queuePath });
    expect(entries[0].batch.index).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Corrupted line survival
// ---------------------------------------------------------------------------

describe('enqueue / peekAll — corrupted line tolerance', () => {
  it('drops a corrupted line on the next rewrite and never throws', () => {
    const line1 = JSON.stringify({ queued_at: '2026-01-01T00:00:00.000Z', batch: { index: 0 } });
    const line3 = JSON.stringify({ queued_at: '2026-01-01T00:00:02.000Z', batch: { index: 2 } });
    writeFileSync(queuePath, `${line1}\nnot-valid-json{{{\n${line3}\n`, 'utf8');

    const before = peekAll({ path: queuePath });
    expect(before).toHaveLength(2);

    const result = enqueue({ index: 3 }, { path: queuePath, now: '2026-01-01T00:00:03.000Z' });
    expect(result).toEqual({ ok: true, dropped: 0, total: 3 });

    const raw = readFileSync(queuePath, 'utf8');
    expect(raw.includes('not-valid-json')).toBe(false);

    const after = peekAll({ path: queuePath });
    expect(after.map((e) => e.batch)).toEqual([{ index: 0 }, { index: 2 }, { index: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// 5. drain — successful sender
// ---------------------------------------------------------------------------

describe('drain — successful sender', () => {
  it('empties the queue and reports sent=N, remaining=0', async () => {
    enqueue({ index: 0 }, { path: queuePath, now: '2026-01-01T00:00:00.000Z' });
    enqueue({ index: 1 }, { path: queuePath, now: '2026-01-01T00:00:01.000Z' });
    enqueue({ index: 2 }, { path: queuePath, now: '2026-01-01T00:00:02.000Z' });

    const sent = [];
    const result = await drain({
      path: queuePath,
      sender: async (batches) => {
        sent.push(...batches);
      },
    });

    expect(result).toEqual({ sent: 3, remaining: 0, dropped: 0 });
    expect(sent).toEqual([{ index: 0 }, { index: 1 }, { index: 2 }]);
    expect(readFileSync(queuePath, 'utf8')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. drain — rejecting sender leaves the queue byte-identical
// ---------------------------------------------------------------------------

describe('drain — rejecting sender', () => {
  it('leaves the queue file byte-identical and reports sent=0', async () => {
    enqueue({ index: 0 }, { path: queuePath, now: '2026-01-01T00:00:00.000Z' });
    enqueue({ index: 1 }, { path: queuePath, now: '2026-01-01T00:00:01.000Z' });
    const before = readFileSync(queuePath, 'utf8');

    const result = await drain({
      path: queuePath,
      sender: async () => {
        throw new Error('network unreachable');
      },
    });

    expect(result).toEqual({ sent: 0, remaining: 2, dropped: 0 });
    expect(readFileSync(queuePath, 'utf8')).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7. drain — no sender is a no-op
// ---------------------------------------------------------------------------

describe('drain — no sender', () => {
  it('is a no-op and reports remaining=count', async () => {
    enqueue({ index: 0 }, { path: queuePath, now: '2026-01-01T00:00:00.000Z' });
    enqueue({ index: 1 }, { path: queuePath, now: '2026-01-01T00:00:01.000Z' });

    const result = await drain({ path: queuePath });

    expect(result).toEqual({ sent: 0, remaining: 2, dropped: 0 });
    expect(peekAll({ path: queuePath })).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 8. clear
// ---------------------------------------------------------------------------

describe('clear', () => {
  it('empties the queue to a zero-byte, still-existing file', () => {
    enqueue({ index: 0 }, { path: queuePath, now: '2026-01-01T00:00:00.000Z' });

    const result = clear({ path: queuePath });

    expect(result).toEqual({ ok: true });
    expect(existsSync(queuePath)).toBe(true);
    expect(readFileSync(queuePath, 'utf8')).toBe('');
    expect(queueStats({ path: queuePath })).toEqual({ count: 0, bytes: 0 });
  });
});

// ---------------------------------------------------------------------------
// 9. queueStats
// ---------------------------------------------------------------------------

describe('queueStats', () => {
  it('reports plausible count and bytes for a populated queue', () => {
    enqueue({ index: 0 }, { path: queuePath, now: '2026-01-01T00:00:00.000Z' });
    enqueue({ index: 1 }, { path: queuePath, now: '2026-01-01T00:00:01.000Z' });
    enqueue({ index: 2 }, { path: queuePath, now: '2026-01-01T00:00:02.000Z' });

    const stats = queueStats({ path: queuePath });

    expect(stats.count).toBe(3);
    expect(stats.bytes).toBeGreaterThan(0);
  });

  it('reports count=0, bytes=0 for a missing queue file', () => {
    const missing = join(tmpDir, 'never-written.ndjson');
    expect(queueStats({ path: missing })).toEqual({ count: 0, bytes: 0 });
  });
});

// ---------------------------------------------------------------------------
// 10. Atomicity smoke test — no leftover tmp file
// ---------------------------------------------------------------------------

describe('atomicity smoke test', () => {
  it('leaves no .tmp.* file in the queue directory after enqueue', () => {
    enqueue({ index: 0 }, { path: queuePath, now: '2026-01-01T00:00:00.000Z' });

    const files = readdirSync(dirname(queuePath));
    const tmpFiles = files.filter((name) => /^\.tmp\./.test(name));
    expect(tmpFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// dropOldest — additional coverage for the public API surface
// ---------------------------------------------------------------------------

describe('dropOldest', () => {
  it('drops the N oldest entries and keeps the newest survivors', () => {
    enqueue({ index: 0 }, { path: queuePath, now: '2026-01-01T00:00:00.000Z' });
    enqueue({ index: 1 }, { path: queuePath, now: '2026-01-01T00:00:01.000Z' });
    enqueue({ index: 2 }, { path: queuePath, now: '2026-01-01T00:00:02.000Z' });
    enqueue({ index: 3 }, { path: queuePath, now: '2026-01-01T00:00:03.000Z' });
    enqueue({ index: 4 }, { path: queuePath, now: '2026-01-01T00:00:04.000Z' });

    const result = dropOldest(2, { path: queuePath });

    expect(result).toEqual({ dropped: 2, remaining: 3 });
    const survivors = peekAll({ path: queuePath }).map((e) => e.batch);
    expect(survivors).toEqual([{ index: 2 }, { index: 3 }, { index: 4 }]);
  });
});
