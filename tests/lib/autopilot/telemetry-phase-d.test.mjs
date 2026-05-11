// tests/lib/autopilot/telemetry-phase-d.test.mjs
//
// Behavioral tests for Phase-D additions to scripts/lib/autopilot/telemetry.mjs:
//   - writeMultiStoryCoordinatorEntry(entry, jsonlPath)
//   - linkChildLoopToCoordinator(childRunId, parentRunId)
//
// Uses real filesystem (mkdtempSync) per project test-quality rules.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  writeMultiStoryCoordinatorEntry,
  linkChildLoopToCoordinator,
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
