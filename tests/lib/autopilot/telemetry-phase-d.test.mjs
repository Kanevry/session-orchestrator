// tests/lib/autopilot/telemetry-phase-d.test.mjs
//
// Behavioral tests for Phase-D additions to scripts/lib/autopilot/telemetry.mjs:
//   - writeMultiStoryCoordinatorEntry(entry, jsonlPath)
//   - linkChildLoopToCoordinator(childRunId, parentRunId)
//   - appendJsonlAtomic(record, jsonlPath) — shared helper (concurrent-write invariant)
//
// Uses real filesystem (mkdtempSync) per project test-quality rules.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeMultiStoryCoordinatorEntry,
  linkChildLoopToCoordinator,
  appendJsonlAtomic,
} from '../../../scripts/lib/autopilot/telemetry.mjs';

// ---------------------------------------------------------------------------
// Shared tmp directory per test
// ---------------------------------------------------------------------------

let tmp;
let jsonl;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'tel-pd-'));
  jsonl = path.join(tmp, 'autopilot.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// linkChildLoopToCoordinator
// ---------------------------------------------------------------------------

describe('linkChildLoopToCoordinator', () => {
  it('returns a linked=true object with child and parent populated', () => {
    const result = linkChildLoopToCoordinator('c1', 'p1');
    expect(result).toEqual({ linked: true, child: 'c1', parent: 'p1' });
  });
});

// ---------------------------------------------------------------------------
// writeMultiStoryCoordinatorEntry
// ---------------------------------------------------------------------------

describe('writeMultiStoryCoordinatorEntry', () => {
  it('writes a valid JSONL line with all canonical fields', () => {
    writeMultiStoryCoordinatorEntry(
      {
        run_id: 'multi-r1',
        started_at: '2026-05-11T16:00Z',
        ended_at: '2026-05-11T16:05Z',
        stop_reason: 'backlog-empty',
        loop_count: 3,
        completed_count: 3,
        failed_count: 0,
        child_run_ids: ['c1', 'c2', 'c3'],
        cohort_aborted: false,
      },
      jsonl,
    );

    const lines = readFileSync(jsonl, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]);
    expect(record).toMatchObject({
      schema_version: 1,
      kind: 'multi-story-coordinator',
      parent_run_id: null,
      child_run_ids: ['c1', 'c2', 'c3'],
      stop_reason: 'backlog-empty',
      loop_count: 3,
      completed_count: 3,
      failed_count: 0,
      cohort_aborted: false,
    });
  });

  it('appends successive calls — does not overwrite (two consecutive writes produce two lines)', () => {
    const baseEntry = {
      run_id: 'r1',
      started_at: '2026-05-11T10:00Z',
      ended_at: '2026-05-11T10:05Z',
      stop_reason: 'backlog-empty',
      loop_count: 1,
      completed_count: 1,
      failed_count: 0,
      child_run_ids: ['c1'],
      cohort_aborted: false,
    };

    writeMultiStoryCoordinatorEntry(baseEntry, jsonl);
    writeMultiStoryCoordinatorEntry({ ...baseEntry, run_id: 'r2', child_run_ids: ['c2'] }, jsonl);

    const lines = readFileSync(jsonl, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    expect(first.run_id).toBe('r1');
    expect(second.run_id).toBe('r2');
  });

  it('is fault-tolerant: unwritable path does not throw', () => {
    // Simulate an unwritable path by placing a regular file where the
    // function expects a directory, forcing the appendFileSync to fail.
    const blocker = path.join(tmp, 'blocker-file');
    writeFileSync(blocker, 'not-a-directory');
    // Now treat the file as if it were a directory — any child path is invalid.
    const unwritable = path.join(blocker, 'autopilot.jsonl');

    expect(() =>
      writeMultiStoryCoordinatorEntry(
        {
          run_id: 'r-fault',
          started_at: '2026-05-11T12:00Z',
          ended_at: '2026-05-11T12:01Z',
          stop_reason: 'backlog-empty',
          loop_count: 0,
          completed_count: 0,
          failed_count: 0,
          child_run_ids: [],
          cohort_aborted: false,
        },
        unwritable,
      ),
    ).not.toThrow();
  });

  it('applies default values: missing cohort_aborted defaults to false, missing loop_count defaults to 0', () => {
    writeMultiStoryCoordinatorEntry(
      {
        run_id: 'r-defaults',
        started_at: '2026-05-11T09:00Z',
        ended_at: '2026-05-11T09:01Z',
        stop_reason: 'backlog-empty',
        completed_count: 0,
        failed_count: 0,
        child_run_ids: [],
        // cohort_aborted and loop_count intentionally omitted
      },
      jsonl,
    );

    const record = JSON.parse(readFileSync(jsonl, 'utf8').trim());
    expect(record.cohort_aborted).toBe(false);
    expect(record.loop_count).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// appendJsonlAtomic — shared helper
// ---------------------------------------------------------------------------

describe('appendJsonlAtomic — shared atomic helper', () => {
  it('writes a single record as a valid JSONL line', () => {
    appendJsonlAtomic({ id: 'x1', value: 42 }, jsonl);

    const lines = readFileSync(jsonl, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual({ id: 'x1', value: 42 });
  });

  it('appends to an existing file without overwriting prior content', () => {
    appendJsonlAtomic({ id: 'first' }, jsonl);
    appendJsonlAtomic({ id: 'second' }, jsonl);

    const lines = readFileSync(jsonl, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toBe('first');
    expect(JSON.parse(lines[1]).id).toBe('second');
  });

  it('output file ends with a newline after each write', () => {
    appendJsonlAtomic({ id: 'nl-test' }, jsonl);
    const content = readFileSync(jsonl, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
  });

  it(
    '100 concurrent writes produce exactly 100 valid JSONL lines with no truncation or interleaved content',
    { timeout: 15_000 },
    async () => {
      const N = 100;

      // Launch N writes in parallel via Promise.all. Each write is
      // synchronous internally but they are dispatched concurrently from
      // this microtask queue. POSIX rename(2) atomicity guarantees each
      // completed write is fully visible before the next one can rename over it.
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          Promise.resolve().then(() => appendJsonlAtomic({ seq: i, marker: `worker-${i}` }, jsonl)),
        ),
      );

      const content = readFileSync(jsonl, 'utf8');
      const lines = content.trim().split('\n');

      // Exactly N lines — no lines lost, no extra empty lines
      expect(lines).toHaveLength(N);

      // Every line is valid JSON — no truncated/partial content
      const records = lines.map((line, idx) => {
        let parsed;
        expect(() => { parsed = JSON.parse(line); }, `line ${idx} must be valid JSON`).not.toThrow();
        return parsed;
      });

      // Every record has the expected shape (no interleaved bytes)
      for (const rec of records) {
        expect(typeof rec.seq).toBe('number');
        expect(typeof rec.marker).toBe('string');
        expect(rec.marker).toMatch(/^worker-\d+$/);
      }

      // All N unique seq values are present — no write was silently dropped
      const seqs = new Set(records.map((r) => r.seq));
      expect(seqs.size).toBe(N);
    },
  );
});
