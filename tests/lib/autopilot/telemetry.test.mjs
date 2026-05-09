/**
 * tests/lib/autopilot/telemetry.test.mjs
 * Unit tests for autopilot/telemetry.mjs — SCHEMA_VERSION, writeAutopilotJsonl
 * atomicity, defaultRunId format, readHostClass parsing, finalizeState mutation.
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
  SCHEMA_VERSION,
  writeAutopilotJsonl,
  defaultRunId,
  readHostClass,
  finalizeState,
} from '../../../scripts/lib/autopilot/telemetry.mjs';

let tmp;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ap-telemetry-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SCHEMA_VERSION
// ---------------------------------------------------------------------------

describe('SCHEMA_VERSION', () => {
  it('is 1 (canonical schema version for autopilot loop records)', () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it('is a number (not a string)', () => {
    expect(typeof SCHEMA_VERSION).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// writeAutopilotJsonl — atomicity + content
// ---------------------------------------------------------------------------

describe('writeAutopilotJsonl — writes a valid JSONL line', () => {
  it('creates the destination file with a parseable JSON line', () => {
    const jsonlPath = path.join(tmp, 'autopilot.jsonl');
    const state = { run_id: 'test-run', started_at: '2026-01-01T00:00:00.000Z' };

    writeAutopilotJsonl(state, jsonlPath);

    const content = readFileSync(jsonlPath, 'utf8');
    const parsed = JSON.parse(content.trim());
    expect(parsed.run_id).toBe('test-run');
    expect(parsed.started_at).toBe('2026-01-01T00:00:00.000Z');
  });

  it('creates parent directories when they do not exist', () => {
    const nestedPath = path.join(tmp, 'deep', 'nested', 'autopilot.jsonl');
    writeAutopilotJsonl({ run_id: 'dir-create-test' }, nestedPath);
    expect(existsSync(nestedPath)).toBe(true);
  });

  it('appends a second record to an existing JSONL file', () => {
    const jsonlPath = path.join(tmp, 'autopilot.jsonl');
    writeAutopilotJsonl({ run_id: 'first' }, jsonlPath);
    writeAutopilotJsonl({ run_id: 'second' }, jsonlPath);

    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).run_id).toBe('first');
    expect(JSON.parse(lines[1]).run_id).toBe('second');
  });

  it('leaves no .tmp- residue after a successful write', () => {
    const jsonlPath = path.join(tmp, 'autopilot.jsonl');
    writeAutopilotJsonl({ run_id: 'atomicity' }, jsonlPath);

    const residue = readdirSync(tmp).filter((f) => f.includes('.tmp-'));
    expect(residue).toHaveLength(0);
  });

  it('throws TypeError when state is null', () => {
    expect(() => writeAutopilotJsonl(null, path.join(tmp, 'x.jsonl'))).toThrow(TypeError);
  });

  it('throws TypeError when state is a string (not an object)', () => {
    expect(() => writeAutopilotJsonl('string', path.join(tmp, 'x.jsonl'))).toThrow(TypeError);
  });

  it('throws TypeError when jsonlPath is an empty string', () => {
    expect(() => writeAutopilotJsonl({ run_id: 'x' }, '')).toThrow(TypeError);
  });

  it('throws TypeError when jsonlPath is null', () => {
    expect(() => writeAutopilotJsonl({ run_id: 'x' }, null)).toThrow(TypeError);
  });

  it('written line ends with a newline character', () => {
    const jsonlPath = path.join(tmp, 'autopilot.jsonl');
    writeAutopilotJsonl({ run_id: 'newline-test' }, jsonlPath);
    const content = readFileSync(jsonlPath, 'utf8');
    expect(content.endsWith('\n')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// defaultRunId — format
// ---------------------------------------------------------------------------

describe('defaultRunId — run ID format', () => {
  it('ends with "-autopilot"', () => {
    const id = defaultRunId('main', Date.now());
    expect(id.endsWith('-autopilot')).toBe(true);
  });

  it('contains the branch name prefix', () => {
    const id = defaultRunId('my-branch', Date.now());
    expect(id).toContain('my-branch');
  });

  it('contains the UTC date components from the provided timestamp', () => {
    const fixedMs = new Date('2026-03-15T14:30:00.000Z').getTime();
    const id = defaultRunId('main', fixedMs);
    expect(id).toContain('2026-03-15');
    expect(id).toContain('1430');
  });

  it('sanitizes slashes in branch names to hyphens', () => {
    const id = defaultRunId('feat/my-feature', Date.now());
    expect(id).not.toContain('/');
    expect(id).toContain('feat-my-feature');
  });

  it('uses "unknown" when branch is null', () => {
    const id = defaultRunId(null, Date.now());
    expect(id).toContain('unknown');
  });

  it('uses "unknown" when branch is undefined', () => {
    const id = defaultRunId(undefined, Date.now());
    expect(id).toContain('unknown');
  });

  it('produces identical IDs for same branch and timestamp (deterministic)', () => {
    const fixedMs = 1746000000000;
    const id1 = defaultRunId('main', fixedMs);
    const id2 = defaultRunId('main', fixedMs);
    expect(id1).toBe(id2);
  });

  it('produces different IDs for different timestamps', () => {
    const base = new Date('2026-04-01T10:00:00.000Z').getTime();
    const id1 = defaultRunId('main', base);
    const id2 = defaultRunId('main', base + 60_000 * 60); // 1 hour later
    expect(id1).not.toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// readHostClass — parsing
// ---------------------------------------------------------------------------

describe('readHostClass — host.json parsing', () => {
  it('returns null when file does not exist (no throw)', () => {
    const missing = path.join(tmp, 'nonexistent', 'host.json');
    expect(readHostClass(missing)).toBeNull();
  });

  it('returns the host_class string when file is valid JSON with that field', () => {
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
// finalizeState — mutation
// ---------------------------------------------------------------------------

describe('finalizeState — stamps completed_at and duration_seconds', () => {
  it('adds completed_at as an ISO string matching the nowMs time', () => {
    const state = { started_at: '2026-01-01T00:00:00.000Z' };
    const endMs = new Date('2026-01-01T00:01:00.000Z').getTime();
    finalizeState(state, () => endMs);
    expect(state.completed_at).toBe('2026-01-01T00:01:00.000Z');
  });

  it('sets duration_seconds to 60 for a 1-minute run', () => {
    const state = { started_at: '2026-01-01T00:00:00.000Z' };
    const endMs = new Date('2026-01-01T00:01:00.000Z').getTime();
    finalizeState(state, () => endMs);
    expect(state.duration_seconds).toBe(60);
  });

  it('preserves all existing state fields unchanged', () => {
    const state = {
      run_id: 'preserve',
      started_at: '2026-01-01T00:00:00.000Z',
      mode: 'deep',
      iteration: 3,
    };
    finalizeState(state, () => new Date('2026-01-01T00:05:00.000Z').getTime());
    expect(state.run_id).toBe('preserve');
    expect(state.mode).toBe('deep');
    expect(state.iteration).toBe(3);
  });

  it('sets duration_seconds to 0 when started_at is not a valid date', () => {
    const state = { started_at: 'not-a-date' };
    finalizeState(state, () => Date.now());
    expect(state.duration_seconds).toBe(0);
  });

  it('duration_seconds is non-negative even when clock appears to go backwards', () => {
    const state = { started_at: '2026-01-01T01:00:00.000Z' };
    finalizeState(state, () => new Date('2026-01-01T00:00:00.000Z').getTime());
    expect(state.duration_seconds).toBeGreaterThanOrEqual(0);
  });
});
