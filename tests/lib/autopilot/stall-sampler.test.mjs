/**
 * tests/lib/autopilot/stall-sampler.test.mjs
 * Unit tests for autopilot/stall-sampler.mjs — mtime-based progress sampler
 * for the STALL_TIMEOUT kill-switch (ADR-364, issue #371).
 *
 * Uses real temp directories + real files (mkdtempSync + writeFileSync +
 * utimesSync to control mtime precisely). DI seam `nowMs` is frozen via a
 * fixture closure to make stallSeconds assertions deterministic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  sampleProgress,
  SAMPLE_CADENCE_MS,
} from '@lib/autopilot/stall-sampler.mjs';

let tmp;
let jsonlPath;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'stall-sampler-test-'));
  jsonlPath = path.join(tmp, 'autopilot.jsonl');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Helper: create autopilot.jsonl with a precise mtime.
 * Returns the mtime in milliseconds as observed by statSync (filesystem may
 * round seconds, so we read it back rather than trusting our input).
 */
function createJsonlAt(mtimeMs) {
  writeFileSync(jsonlPath, '{"schema_version":1}\n', 'utf8');
  const seconds = mtimeMs / 1000;
  utimesSync(jsonlPath, seconds, seconds);
  return statSync(jsonlPath).mtimeMs;
}

describe('sampleProgress', () => {
  it('returns progressed=true when mtime is within sample cadence', () => {
    const fileMtimeMs = createJsonlAt(1_700_000_000_000);
    const now = fileMtimeMs + 5_000; // 5s after mtime — within 30s window
    const result = sampleProgress({
      autopilotJsonlPath: jsonlPath,
      nowMs: () => now,
    });
    expect(result.progressed).toBe(true);
    expect(result.stallSeconds).toBe(5);
    expect(result.lastMarker).toBe(fileMtimeMs);
    expect(result.marker).toBe('autopilot.jsonl:mtime');
  });

  it('returns progressed=false and stallSeconds=N when mtime is older than threshold', () => {
    const fileMtimeMs = createJsonlAt(1_700_000_000_000);
    const now = fileMtimeMs + 700_000; // 700s after mtime — well past 600s threshold
    const result = sampleProgress({
      autopilotJsonlPath: jsonlPath,
      stallTimeoutSeconds: 600,
      nowMs: () => now,
    });
    expect(result.progressed).toBe(false);
    expect(result.stallSeconds).toBe(700);
    expect(result.marker).toBe('autopilot.jsonl:mtime');
  });

  it('honors a custom stallTimeoutSeconds', () => {
    const fileMtimeMs = createJsonlAt(1_700_000_000_000);
    const now = fileMtimeMs + 60_000; // 60s after mtime
    const result = sampleProgress({
      autopilotJsonlPath: jsonlPath,
      stallTimeoutSeconds: 30,
      nowMs: () => now,
    });
    expect(result.stallSeconds).toBe(60);
    // 60s > SAMPLE_CADENCE_MS (30s) so progressed=false regardless of stallTimeoutSeconds.
    expect(result.progressed).toBe(false);
  });

  it('returns marker:missing and stallSeconds:0 when file does not exist', () => {
    const missingPath = path.join(tmp, 'does-not-exist.jsonl');
    const result = sampleProgress({
      autopilotJsonlPath: missingPath,
      nowMs: () => 1_700_000_000_000,
    });
    expect(result).toEqual({
      progressed: false,
      lastMarker: null,
      stallSeconds: 0,
      marker: 'missing',
    });
  });

  it('clamps negative stall to 0 on clock skew', () => {
    const fileMtimeMs = createJsonlAt(1_700_000_000_000);
    const now = fileMtimeMs - 10_000; // 10s BEFORE mtime — future-mtime/clock-skew case
    const result = sampleProgress({
      autopilotJsonlPath: jsonlPath,
      nowMs: () => now,
    });
    expect(result.stallSeconds).toBe(0);
    // Negative delta < SAMPLE_CADENCE_MS, so still considered fresh.
    expect(result.progressed).toBe(true);
  });

  it('returns marker:autopilot.jsonl:mtime on success', () => {
    const fileMtimeMs = createJsonlAt(1_700_000_000_000);
    const result = sampleProgress({
      autopilotJsonlPath: jsonlPath,
      nowMs: () => fileMtimeMs,
    });
    expect(result.marker).toBe('autopilot.jsonl:mtime');
  });
});

describe('SAMPLE_CADENCE_MS', () => {
  it('is exactly 30_000 ms', () => {
    // Load-bearing constant shared with the kill-switch caller. Pinning the
    // value catches accidental drift.
    expect(SAMPLE_CADENCE_MS).toBe(30_000);
  });
});
