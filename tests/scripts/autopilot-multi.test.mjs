/**
 * tests/scripts/autopilot-multi.test.mjs
 *
 * Tests for scripts/autopilot-multi.mjs (W2 C5 + W3 P-Orchestration-Apply).
 *
 * Structure:
 *   1. import-safety canary — importing module must not invoke main()
 *   2. parseFlags (unit, no spawnSync)
 *   3. buildOrchestratorState (unit, pure function)
 *   4. main via spawnSync (full CLI behaviour)
 *
 * Falsification: every assertion uses hardcoded expected values.
 * Anti-pattern check: no branching inside it() blocks.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const SCRIPT = path.resolve(
  fileURLToPath(import.meta.url),
  '..',
  '..',
  '..',
  'scripts',
  'autopilot-multi.mjs',
);

// Normalize CRLF → LF so Windows spawnSync output matches Linux/macOS in
// string assertions (.toContain / .toMatch / .trim().match). No-op on LF.
const norm = (s) => (s ?? '').replace(/\r\n/g, '\n');

// ---------------------------------------------------------------------------
// 1. Import-safety canary
// ---------------------------------------------------------------------------

describe('import-safety canary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('importing the module does not invoke main() — process.exit is never called', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called unexpectedly during import');
    });

    // Cache-bust with a query param so we get a fresh specifier each run.
    await import(`${SCRIPT}?canary=${Date.now()}`);

    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('importing the module does not write to stdout', async () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await import(`${SCRIPT}?stdout-canary=${Date.now()}`);

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 2. parseFlags (unit)
// ---------------------------------------------------------------------------

describe('parseFlags (unit)', () => {
  // Dynamic import once; module is ESM-cached after first load within the suite.
  async function getParseFlags() {
    const mod = await import(SCRIPT);
    return mod.parseFlags;
  }

  it('returns all defaults when called with empty argv', async () => {
    const parseFlags = await getParseFlags();
    const flags = parseFlags([]);
    expect(flags).toMatchObject({
      maxStories: 3,
      maxHours: 8,
      inactivityTimeoutMs: 300000,
      draftMrPolicy: 'off',
      stallTimeoutSeconds: 600,
      dryRun: true,
      apply: false,
      json: false,
      verbose: false,
      help: false,
      version: false,
    });
  });

  it.each([
    ['above upper bound is clamped to 10', ['--max-stories', '15'], 10],
    ['below lower bound is clamped to 1', ['--max-stories', '0'], 1],
    ['value within range is preserved', ['--max-stories', '5'], 5],
    ['exact upper bound is preserved', ['--max-stories', '10'], 10],
    ['exact lower bound is preserved', ['--max-stories', '1'], 1],
  ])('maxStories: %s', async (_label, argv, expected) => {
    const parseFlags = await getParseFlags();
    expect(parseFlags(argv).maxStories).toBe(expected);
  });

  it('--max-hours 0.1 is clamped to 0.5', async () => {
    const parseFlags = await getParseFlags();
    expect(parseFlags(['--max-hours', '0.1']).maxHours).toBe(0.5);
  });

  it('--max-hours 30 is clamped to 24', async () => {
    const parseFlags = await getParseFlags();
    expect(parseFlags(['--max-hours', '30']).maxHours).toBe(24);
  });

  it('--inactivity-timeout 10 is clamped to 60s and converted to ms (60000)', async () => {
    const parseFlags = await getParseFlags();
    expect(parseFlags(['--inactivity-timeout', '10']).inactivityTimeoutMs).toBe(60000);
  });

  it('--inactivity-timeout 300 is within range and returned as 300000 ms', async () => {
    const parseFlags = await getParseFlags();
    expect(parseFlags(['--inactivity-timeout', '300']).inactivityTimeoutMs).toBe(300000);
  });

  it('--draft-mr on-loop-start sets draftMrPolicy', async () => {
    const parseFlags = await getParseFlags();
    expect(parseFlags(['--draft-mr', 'on-loop-start']).draftMrPolicy).toBe('on-loop-start');
  });

  it('--draft-mr on-green sets draftMrPolicy', async () => {
    const parseFlags = await getParseFlags();
    expect(parseFlags(['--draft-mr', 'on-green']).draftMrPolicy).toBe('on-green');
  });

  it('--draft-mr invalid throws a UserError', async () => {
    const parseFlags = await getParseFlags();
    expect(() => parseFlags(['--draft-mr', 'invalid'])).toThrow(
      '--draft-mr must be one of: off, on-loop-start, on-green. Got: "invalid"',
    );
  });

  it('--dry-run --apply mutex throws', async () => {
    const parseFlags = await getParseFlags();
    expect(() => parseFlags(['--dry-run', '--apply'])).toThrow(
      '--dry-run and --apply are mutually exclusive; pick one.',
    );
  });

  it('--apply alone sets apply:true and dryRun:false', async () => {
    const parseFlags = await getParseFlags();
    const flags = parseFlags(['--apply']);
    expect(flags.apply).toBe(true);
    expect(flags.dryRun).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. buildOrchestratorState (unit)
// ---------------------------------------------------------------------------

describe('buildOrchestratorState (unit)', () => {
  async function getBuildState() {
    const mod = await import(SCRIPT);
    return mod.buildOrchestratorState;
  }

  const baseFlags = {
    maxStories: 3,
    maxHours: 8,
    inactivityTimeoutMs: 300000,
    draftMrPolicy: 'off',
    stallTimeoutSeconds: 600,
    dryRun: true,
    apply: false,
    json: false,
    verbose: false,
  };

  const sampleIssues = [
    { iid: 1, title: 'Issue A', blocks: [], blockedBy: [], labels: [] },
    { iid: 2, title: 'Issue B', blocks: [], blockedBy: [], labels: [] },
    { iid: 3, title: 'Issue C', blocks: [], blockedBy: [], labels: [] },
    { iid: 4, title: 'Issue D', blocks: [], blockedBy: [], labels: [] },
  ];

  it('concurrencyCap respects maxStories when snapshot is null', async () => {
    const buildState = await getBuildState();
    const state = buildState(baseFlags, null, sampleIssues, 'run-001');
    expect(state.concurrencyCap).toBe(3);
  });

  it('executionPlan is sliced to concurrencyCap entries', async () => {
    const buildState = await getBuildState();
    const state = buildState(baseFlags, null, sampleIssues, 'run-001');
    expect(state.executionPlan).toHaveLength(3);
    expect(state.executionPlan[0]).toEqual({ iid: 1, title: 'Issue A' });
    expect(state.executionPlan[2]).toEqual({ iid: 3, title: 'Issue C' });
  });

  it('totalIssues and readyIssues reflect all provided issues', async () => {
    const buildState = await getBuildState();
    const state = buildState(baseFlags, null, sampleIssues, 'run-001');
    expect(state.totalIssues).toBe(4);
    expect(state.readyIssues).toBe(4);
  });

  it('snapshot cpuCores below maxStories reduces concurrencyCap', async () => {
    const buildState = await getBuildState();
    const snapshot = { cpuCores: 2 };
    const state = buildState(baseFlags, snapshot, sampleIssues, 'run-001');
    expect(state.concurrencyCap).toBe(2);
    expect(state.executionPlan).toHaveLength(2);
  });

  it('parentRunId is preserved in returned state', async () => {
    const buildState = await getBuildState();
    const state = buildState(baseFlags, null, sampleIssues, 'test-run-xyz');
    expect(state.parentRunId).toBe('test-run-xyz');
  });

  it('flags snapshot in returned state includes dryRun and apply', async () => {
    const buildState = await getBuildState();
    const state = buildState(baseFlags, null, sampleIssues, 'run-001');
    expect(state.flags.dryRun).toBe(true);
    expect(state.flags.apply).toBe(false);
    expect(state.flags.maxStories).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 4. main via spawnSync (full CLI behaviour)
// ---------------------------------------------------------------------------

describe('main (CLI via spawnSync)', () => {
  it('--help exits 0 and stdout contains USAGE:', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(norm(r.stdout)).toContain('USAGE:');
  });

  it('--help stdout contains --max-stories option documentation', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(norm(r.stdout)).toContain('--max-stories');
  });

  it('--version exits 0 and stdout matches semver', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--version'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(norm(r.stdout).trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('--dry-run --json exits 0 and emits a JSON envelope with success:true', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--json'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.success).toBe(true);
  });

  it('--dry-run --json envelope data.plan has concurrencyCap and executionPlan', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--json'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(typeof parsed.data.plan.concurrencyCap).toBe('number');
    expect(Array.isArray(parsed.data.plan.executionPlan)).toBe(true);
  });

  it('--dry-run --apply --json exits 1 (mutex violation)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--apply', '--json'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
  });

  it('--draft-mr foo exits 1 (invalid policy)', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--draft-mr', 'foo'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
  });

  it('--draft-mr foo stderr contains descriptive error message', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--draft-mr', 'foo'], { encoding: 'utf8' });
    expect(norm(r.stderr)).toContain('--draft-mr must be one of');
  });

  it('--dry-run --apply stderr contains mutex error message', () => {
    const r = spawnSync(process.execPath, [SCRIPT, '--dry-run', '--apply'], { encoding: 'utf8' });
    expect(r.status).toBe(1);
    expect(norm(r.stderr)).toContain('mutually exclusive');
  });
});
