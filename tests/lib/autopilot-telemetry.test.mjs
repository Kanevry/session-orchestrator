/**
 * tests/lib/autopilot-telemetry.test.mjs
 * Unit tests for the extracted telemetry module from #326.
 * autopilot-telemetry.mjs is tested in isolation — no runLoop, no child processes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  writeAutopilotJsonl,
  defaultRunId,
  readHostClass,
  finalizeState,
} from '../../scripts/lib/autopilot-telemetry.mjs';

// Back-compat: also importable from autopilot.mjs
import {
  writeAutopilotJsonl as writeAutopilotJsonlViaBarrel,
  defaultRunId as defaultRunIdViaBarrel,
  readHostClass as readHostClassViaBarrel,
  finalizeState as finalizeStateViaBarrel,
} from '../../scripts/lib/autopilot.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'autopilot-telemetry-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// writeAutopilotJsonl
// ---------------------------------------------------------------------------

describe('writeAutopilotJsonl', () => {
  it('writes a valid JSON line to the destination file', () => {
    const jsonlPath = path.join(tmp, 'autopilot.jsonl');
    const state = { run_id: 'test-run', started_at: '2026-01-01T00:00:00.000Z' };

    writeAutopilotJsonl(state, jsonlPath);

    const content = readFileSync(jsonlPath, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.run_id).toBe('test-run');
    expect(parsed.started_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('creates parent directory when it does not exist', () => {
    const nestedDir = path.join(tmp, 'deep', 'nested', 'dir');
    const jsonlPath = path.join(nestedDir, 'autopilot.jsonl');
    const state = { run_id: 'dir-creation-test' };

    writeAutopilotJsonl(state, jsonlPath);

    expect(existsSync(jsonlPath)).toBe(true);
  });

  it('appends a new record to an existing JSONL file, preserving prior records', () => {
    const jsonlPath = path.join(tmp, 'autopilot.jsonl');
    const first = { run_id: 'first' };
    const second = { run_id: 'second' };

    writeAutopilotJsonl(first, jsonlPath);
    writeAutopilotJsonl(second, jsonlPath);

    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).run_id).toBe('first');
    expect(JSON.parse(lines[1]).run_id).toBe('second');
  });

  it('leaves no .tmp file after a successful write', () => {
    const jsonlPath = path.join(tmp, 'autopilot.jsonl');
    writeAutopilotJsonl({ run_id: 'atomicity-test' }, jsonlPath);

    const files = readdirSync(tmp);
    const tmpFiles = files.filter((f) => f.includes('.tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });

  it('throws TypeError when state is not an object', () => {
    const jsonlPath = path.join(tmp, 'autopilot.jsonl');
    expect(() => writeAutopilotJsonl('not-an-object', jsonlPath)).toThrow(TypeError);
  });

  it('throws TypeError when jsonlPath is empty string', () => {
    expect(() => writeAutopilotJsonl({ run_id: 'x' }, '')).toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------
// defaultRunId
// ---------------------------------------------------------------------------

describe('defaultRunId', () => {
  it('returns a string containing the branch name', () => {
    const runId = defaultRunId('main', Date.now());
    expect(runId).toContain('main');
  });

  it('returns a string containing date components from the provided timestamp', () => {
    // 2026-03-15T14:30:00Z
    const fixedMs = new Date('2026-03-15T14:30:00.000Z').getTime();
    const runId = defaultRunId('main', fixedMs);
    expect(runId).toContain('2026-03-15');
    expect(runId).toContain('1430');
  });

  it('ends with "-autopilot"', () => {
    const runId = defaultRunId('feat/my-feature', Date.now());
    expect(runId.endsWith('-autopilot')).toBe(true);
  });

  it('sanitizes branch name special characters (slashes become hyphens)', () => {
    const runId = defaultRunId('feat/some-feature', Date.now());
    expect(runId).not.toContain('/');
    expect(runId).toContain('feat-some-feature');
  });

  it('two calls with identical branch and timestamp produce the same run_id', () => {
    const fixedMs = 1746000000000;
    const id1 = defaultRunId('main', fixedMs);
    const id2 = defaultRunId('main', fixedMs);
    expect(id1).toBe(id2);
  });

  it('uses "unknown" when branch is null', () => {
    const runId = defaultRunId(null, Date.now());
    expect(runId).toContain('unknown');
  });
});

// ---------------------------------------------------------------------------
// readHostClass
// ---------------------------------------------------------------------------

describe('readHostClass', () => {
  it('returns null when the host.json file does not exist (no throw)', () => {
    const missing = path.join(tmp, 'nonexistent', 'host.json');
    expect(readHostClass(missing)).toBeNull();
  });

  it('returns the host_class string when the file is valid JSON with that field', () => {
    const hostJsonPath = path.join(tmp, 'host.json');
    writeFileSync(hostJsonPath, JSON.stringify({ host_class: 'mac-m2' }), 'utf8');
    expect(readHostClass(hostJsonPath)).toBe('mac-m2');
  });

  it('returns null when host.json is malformed JSON', () => {
    const hostJsonPath = path.join(tmp, 'host.json');
    writeFileSync(hostJsonPath, '{not valid json', 'utf8');
    expect(readHostClass(hostJsonPath)).toBeNull();
  });

  it('returns null when host.json exists but host_class field is absent', () => {
    const hostJsonPath = path.join(tmp, 'host.json');
    writeFileSync(hostJsonPath, JSON.stringify({ other_field: 'value' }), 'utf8');
    expect(readHostClass(hostJsonPath)).toBeNull();
  });

  it('returns null when host_class value is not a string', () => {
    const hostJsonPath = path.join(tmp, 'host.json');
    writeFileSync(hostJsonPath, JSON.stringify({ host_class: 42 }), 'utf8');
    expect(readHostClass(hostJsonPath)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// finalizeState
// ---------------------------------------------------------------------------

describe('finalizeState', () => {
  it('adds completed_at field as an ISO string', () => {
    const state = { started_at: '2026-01-01T00:00:00.000Z', run_id: 'test' };
    finalizeState(state, () => new Date('2026-01-01T00:01:00.000Z').getTime());
    expect(typeof state.completed_at).toBe('string');
    expect(state.completed_at).toBe('2026-01-01T00:01:00.000Z');
  });

  it('adds duration_seconds field as a non-negative number', () => {
    const state = { started_at: '2026-01-01T00:00:00.000Z', run_id: 'test' };
    finalizeState(state, () => new Date('2026-01-01T00:01:00.000Z').getTime());
    expect(state.duration_seconds).toBe(60);
  });

  it('preserves all existing state fields', () => {
    const state = {
      run_id: 'preserve-test',
      started_at: '2026-01-01T00:00:00.000Z',
      mode: 'deep',
      iteration: 3,
    };
    finalizeState(state, () => new Date('2026-01-01T00:05:00.000Z').getTime());
    expect(state.run_id).toBe('preserve-test');
    expect(state.mode).toBe('deep');
    expect(state.iteration).toBe(3);
  });

  it('sets duration_seconds to 0 when started_at is not a valid date', () => {
    const state = { started_at: 'not-a-date', run_id: 'bad-start' };
    finalizeState(state, () => Date.now());
    expect(state.duration_seconds).toBe(0);
  });

  it('duration_seconds is always non-negative even when clock appears to go backwards', () => {
    // nowMs returns a time before started_at (simulates skewed clock)
    const state = { started_at: '2026-01-01T01:00:00.000Z', run_id: 'skew-test' };
    finalizeState(state, () => new Date('2026-01-01T00:00:00.000Z').getTime());
    expect(state.duration_seconds).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Back-compat: barrel re-exports from autopilot.mjs
// ---------------------------------------------------------------------------

describe('barrel re-exports from autopilot.mjs', () => {
  it('writeAutopilotJsonl is accessible via autopilot.mjs', () => {
    expect(typeof writeAutopilotJsonlViaBarrel).toBe('function');
  });

  it('defaultRunId is accessible via autopilot.mjs', () => {
    expect(typeof defaultRunIdViaBarrel).toBe('function');
  });

  it('readHostClass is accessible via autopilot.mjs', () => {
    expect(typeof readHostClassViaBarrel).toBe('function');
  });

  it('finalizeState is accessible via autopilot.mjs', () => {
    expect(typeof finalizeStateViaBarrel).toBe('function');
  });

  it('writeAutopilotJsonl from autopilot.mjs behaves identically to the direct import', () => {
    const jsonlPath = path.join(tmp, 'barrel-compat.jsonl');
    const state = { run_id: 'barrel-test', started_at: '2026-01-01T00:00:00.000Z' };
    writeAutopilotJsonlViaBarrel(state, jsonlPath);
    const content = readFileSync(jsonlPath, 'utf8');
    expect(JSON.parse(content.trim()).run_id).toBe('barrel-test');
  });
});
