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
 *   5. finalize (unit) — #905 success/exitCode/no-work classification
 *   6. fetchReadyBacklog (unit) — #904 glab -R host-pinning
 *   7. runApplyLoop (integration-ish, DI-stubbed wtPipeline/probe, real
 *      dep-graph + multi-killswitch) — #905 sweep regression guard
 *
 * Falsification: every assertion uses hardcoded expected values.
 * Anti-pattern check: no branching inside it() blocks.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as depGraphMod from '@lib/autopilot/dep-graph.mjs';
import * as mkLibMod from '@lib/autopilot/multi-killswitch.mjs';

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

// ---------------------------------------------------------------------------
// 5. finalize (unit) — #905 success/exitCode/no-work classification
// ---------------------------------------------------------------------------

describe('finalize (unit)', () => {
  async function getFinalize() {
    const mod = await import(SCRIPT);
    return mod.finalize;
  }

  it('5 no-work (fallback-to-manual) + 2 failed loops report success:false, exitCode 3', async () => {
    const finalize = await getFinalize();
    const allLoops = [
      { status: 'no-work', fallbackToManual: true },
      { status: 'no-work', fallbackToManual: true },
      { status: 'no-work', fallbackToManual: true },
      { status: 'no-work', fallbackToManual: true },
      { status: 'no-work', fallbackToManual: true },
      { status: 'failed', fallbackToManual: false },
      { status: 'failed', fallbackToManual: false },
    ];

    const result = finalize(allLoops, 'backlog-empty', Date.now());

    expect(result.data.completed).toBe(0);
    expect(result.data.noWork).toBe(5);
    expect(result.data.failed).toBe(2);
    expect(result.data.fellBackToManual).toBe(5);
    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(3);
  });

  it('empty backlog (zero registered loops) reports success:true, exitCode 0 (regression guard)', async () => {
    const finalize = await getFinalize();

    const result = finalize([], 'backlog-empty', Date.now());

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it('1 complete + 1 no-work loop reports success:true (at least one productive loop)', async () => {
    const finalize = await getFinalize();
    const allLoops = [
      { status: 'complete', fallbackToManual: false },
      { status: 'no-work', fallbackToManual: true },
    ];

    const result = finalize(allLoops, 'backlog-empty', Date.now());

    expect(result.success).toBe(true);
    expect(result.data.completed).toBe(1);
    expect(result.data.noWork).toBe(1);
    expect(result.exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. fetchReadyBacklog (unit) — #904 glab -R host-pinning
// ---------------------------------------------------------------------------

describe('fetchReadyBacklog (unit)', () => {
  async function getFetchReadyBacklog() {
    const mod = await import(SCRIPT);
    return mod.fetchReadyBacklog;
  }

  it('appends trailing -R <spec> when resolveRepoSpecFn resolves a spec', async () => {
    const fetchReadyBacklog = await getFetchReadyBacklog();
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '[]' });
    const resolveRepoSpecFn = () => 'https://gitlab.example.com/example-group/example-project.git';

    await fetchReadyBacklog(execFileFn, { repoRoot: '/tmp/example-repo', resolveRepoSpecFn });

    expect(execFileFn).toHaveBeenCalledWith(
      'glab',
      [
        'issue', 'list', '--label', 'status:ready', '--per-page', '50', '--output', 'json',
        '-R', 'https://gitlab.example.com/example-group/example-project.git',
      ],
      { shell: false, timeout: 30_000 },
    );
  });

  it('omits -R entirely when resolveRepoSpecFn returns undefined (never emits "-R undefined")', async () => {
    const fetchReadyBacklog = await getFetchReadyBacklog();
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '[]' });
    const resolveRepoSpecFn = () => undefined;

    await fetchReadyBacklog(execFileFn, { repoRoot: '/tmp/example-repo', resolveRepoSpecFn });

    expect(execFileFn).toHaveBeenCalledWith(
      'glab',
      ['issue', 'list', '--label', 'status:ready', '--per-page', '50', '--output', 'json'],
      { shell: false, timeout: 30_000 },
    );
  });

  it('calls resolveRepoSpecFn exactly once with {repoRoot, vcs: "gitlab"}', async () => {
    const fetchReadyBacklog = await getFetchReadyBacklog();
    const execFileFn = vi.fn().mockResolvedValue({ stdout: '[]' });
    const resolveRepoSpecFn = vi.fn().mockReturnValue(undefined);

    await fetchReadyBacklog(execFileFn, { repoRoot: '/tmp/example-repo', resolveRepoSpecFn });

    expect(resolveRepoSpecFn).toHaveBeenCalledOnce();
    expect(resolveRepoSpecFn).toHaveBeenCalledWith({ repoRoot: '/tmp/example-repo', vcs: 'gitlab' });
  });
});

// ---------------------------------------------------------------------------
// 7. runApplyLoop (integration-ish) — #905 sweep regression guard
//
// Uses the REAL dep-graph.mjs + multi-killswitch.mjs modules (pure, no I/O)
// and DI-stubs only wtPipeline.runStoryPipeline + probe.probe. No live glab
// calls anywhere in this describe block.
// ---------------------------------------------------------------------------

describe('runApplyLoop (integration-ish)', () => {
  async function getRunApplyLoop() {
    const mod = await import(SCRIPT);
    return mod.runApplyLoop;
  }

  function makeFlags() {
    return {
      maxStories: 1,
      maxHours: 8,
      inactivityTimeoutMs: 300000,
      draftMrPolicy: 'off',
      stallTimeoutSeconds: 600,
    };
  }

  it(
    'a fallback-to-manual StoryResult (0 iterations) registers as no-work, ' +
      'the loop terminates, and success is false (sweep regression guard, #905)',
    { timeout: 5000 },
    async () => {
      const runApplyLoop = await getRunApplyLoop();
      const state = {
        issues: [{ iid: 501, title: 'No-op issue', blocks: [], blockedBy: [], labels: ['status:ready'] }],
        parentRunId: 'test-run-no-work',
        flags: makeFlags(),
      };
      const libs = {
        depGraph: depGraphMod,
        wtPipeline: {
          runStoryPipeline: vi.fn().mockResolvedValue({
            killSwitch: null,
            iterationsCompleted: 0,
            fallbackToManual: true,
          }),
        },
        mkLib: mkLibMod,
        probe: { probe: vi.fn().mockResolvedValue(null) },
      };

      const result = await runApplyLoop(state, libs, {});

      expect(result.success).toBe(false);
      expect(result.data.noWork).toBe(1);
      expect(result.data.completed).toBe(0);
    },
  );

  it('a productive StoryResult (3 iterations, no fallback) registers as complete and reports success', async () => {
    const runApplyLoop = await getRunApplyLoop();
    const state = {
      issues: [{ iid: 502, title: 'Productive issue', blocks: [], blockedBy: [], labels: ['status:ready'] }],
      parentRunId: 'test-run-complete',
      flags: makeFlags(),
    };
    const libs = {
      depGraph: depGraphMod,
      wtPipeline: {
        runStoryPipeline: vi.fn().mockResolvedValue({
          killSwitch: null,
          iterationsCompleted: 3,
          fallbackToManual: false,
        }),
      },
      mkLib: mkLibMod,
      probe: { probe: vi.fn().mockResolvedValue(null) },
    };

    const result = await runApplyLoop(state, libs, {});

    expect(result.success).toBe(true);
    expect(result.data.completed).toBe(1);
    expect(result.data.noWork).toBe(0);
  });
});
