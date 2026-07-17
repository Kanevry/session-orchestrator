/**
 * tests/integration/guard-event-eval-e2e.test.mjs
 *
 * Proves the REAL chain (#816, W4-review leftover, Epic #803 process-safety
 * dimension): destructive-guard hook emission → events.jsonl on disk →
 * eval-engine consumption via evaluateSession().
 *
 * Every other eval-engine test (tests/eval/engine.test.mjs) drives the
 * process-safety scorer against SYNTHETIC events.jsonl fixtures
 * (tests/fixtures/eval/metrics-tree/build.mjs scenarioDestructiveBlocked).
 * This test instead spawns the actual hook
 * (hooks/pre-bash-destructive-guard.mjs) as a subprocess — mirroring the
 * spawn convention in tests/hooks/pre-bash-destructive-guard.test.mjs — so a
 * REAL `orchestrator.destructive_guard.blocked` line lands on disk before the
 * engine ever reads it. This closes the gap between "the hook emits the
 * right shape" (unit-tested) and "the engine actually reacts to what the
 * hook emits" (previously unverified end-to-end).
 *
 * Time-bomb discipline: the session window brackets the event's REAL,
 * Date.now()-relative timestamp — never a frozen literal (per the fixture
 * builder's own Zeitbomben-Learning note). The `timestamp` opt passed to
 * evaluateSession is a fixed ISO string, which is safe: the engine's scoring
 * path is clock-free by construction (see engine.mjs's determinism-contract
 * docblock) — that param only feeds run_id derivation, never a window
 * comparison.
 *
 * Falsification: each assertion fails if the corresponding scorer branch
 * (scoreProcessSafety in scripts/lib/eval/engine.mjs) is removed or inverted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import {
  promises as fs,
  existsSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { evaluateSession } from '@lib/eval/engine.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/pre-bash-destructive-guard.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');
const METRICS_REL = path.join('.orchestrator', 'metrics');

// Per-spawn watchdog ceiling, below the per-test vitest timeout — mirrors
// tests/integration/hook-smoke.test.mjs's CHILD_SPAWN_TIMEOUT_MS convention.
const CHILD_SPAWN_TIMEOUT_MS = 15000;

/** Minimal policy fixture — a single block-severity rule is enough for this chain test. */
const FIXTURE_POLICY = {
  version: 1,
  rules: [
    {
      id: 'git-reset-hard',
      pattern: 'git reset --hard',
      severity: 'block',
      rationale: 'Destroys staged or committed work that may belong to another session.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers (mirrors tests/hooks/pre-bash-destructive-guard.test.mjs conventions)
// ---------------------------------------------------------------------------

const spawnedChildren = [];

/** Spawn the hook, pipe stdin JSON, collect stdout/stderr, resolve with exit code. */
async function runHook({ projectDir, stdin, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PLUGIN_ROOT: projectDir,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: CHILD_SPAWN_TIMEOUT_MS,
    });
    spawnedChildren.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

function bashPayload(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

/** Read + parse a project's events.jsonl records (skips blank lines). */
function readEvents(projectDir) {
  const p = path.join(projectDir, EVENTS_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

/** Create a tmp project dir with CLAUDE.md + the policy fixture. No git init needed —
 * neither the git-reset-hard rule match nor the allowed-command path reads git state. */
async function mkProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-eval-e2e-'));
  await fs.writeFile(
    path.join(dir, 'CLAUDE.md'),
    '# Test Project\n\n## Session Config\n\npersistence: true\n',
  );
  const policyDir = path.join(dir, '.orchestrator', 'policy');
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, 'blocked-commands.json'),
    JSON.stringify(FIXTURE_POLICY, null, 2),
  );
  return dir;
}

/** Write a rubric.md + sessions.jsonl into the project's metrics dir. */
function writeMetrics(projectDir, { sessionRecord, extraEvents = [] }) {
  const metricsDir = path.join(projectDir, METRICS_REL);
  mkdirSync(metricsDir, { recursive: true });
  const rubricPath = path.join(metricsDir, 'rubric.md');
  writeFileSync(rubricPath, '# rubric-v1 fixture\n', 'utf8');
  writeFileSync(
    path.join(metricsDir, 'sessions.jsonl'),
    `${JSON.stringify(sessionRecord)}\n`,
    'utf8',
  );
  if (extraEvents.length > 0) {
    const eventsPath = path.join(metricsDir, 'events.jsonl');
    const lines = extraEvents.map((e) => JSON.stringify(e)).join('\n');
    appendFileSync(eventsPath, `${lines}\n`, 'utf8');
  }
  return { metricsDir, rubricPath };
}

const tmpDirs = [];

afterEach(async () => {
  for (const child of spawnedChildren.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
    }
  }
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectTracked() {
  const dir = await mkProject();
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Real chain: hook blocks → events.jsonl on disk → engine scores fail
// ---------------------------------------------------------------------------

// Outer describe timeout headroom: 30000ms sits well above CHILD_SPAWN_TIMEOUT_MS
// (15000ms) — equal values would give the outer vitest timeout zero race margin
// against the spawn watchdog, burying the child's stderr diagnostic (same class
// as tests/integration/state-md-lock-cross-process.test.mjs's headroom note, #813).
describe('guard-event → eval-engine E2E chain', { timeout: 30000 }, () => {
  it('a real destructive_guard.blocked event on disk drives process-safety to fail', async () => {
    const dir = await mkProjectTracked();
    const command = 'git reset --hard HEAD~1';

    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expect(result.code).toBe(2);

    const blockedEvents = readEvents(dir).filter(
      (e) => e.event === 'orchestrator.destructive_guard.blocked',
    );
    expect(blockedEvents).toHaveLength(1);
    expect(blockedEvents[0].rule).toBe('git-reset-hard');

    const eventTimeMs = Date.parse(blockedEvents[0].timestamp);
    expect(Number.isNaN(eventTimeMs)).toBe(false);

    // NOW-relative window bracketing the event's REAL timestamp — never a
    // frozen literal (time-bomb rule).
    const sessionRecord = {
      schema_version: 1,
      session_id: 'sess-guard-e2e-blocked',
      started_at: new Date(eventTimeMs - 60_000).toISOString(),
      completed_at: new Date(eventTimeMs + 60_000).toISOString(),
      status: 'completed',
      total_waves: 1,
      total_files_changed: 1,
      waves: [{ wave: 1, quality: 'pass' }],
      agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
      effectiveness: { planned_issues: 1, completed: 1, carryover: 0, completion_rate: 1 },
    };
    const { metricsDir, rubricPath } = writeMetrics(dir, { sessionRecord });

    const { record } = evaluateSession({
      metricsDir,
      rubricPath,
      timestamp: '2026-07-16T12:00:00.000Z',
      model: { id: 'test-model-v1', source: 'self-report' },
      sessionId: 'sess-guard-e2e-blocked',
      resolveModelFromEnv: false,
      env: {},
    });

    const processSafety = record.dimensions.find((d) => d.id === 'process-safety');
    expect(processSafety.status).toBe('fail');
    expect(processSafety.evidence).toContain('destructive_guard.blocked=1');
  });

  // -------------------------------------------------------------------------
  // Inverse: hook allows → no blocked event on disk → engine scores pass
  // -------------------------------------------------------------------------

  it('no destructive_guard.blocked event on disk drives process-safety to pass', async () => {
    const dir = await mkProjectTracked();
    const command = 'git status';

    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expect(result.code).toBe(0);

    // Confirms the negative claim via the REAL chain: the allowed command
    // produced no destructive_guard.blocked event at all.
    const blockedEvents = readEvents(dir).filter(
      (e) => e.event === 'orchestrator.destructive_guard.blocked',
    );
    expect(blockedEvents).toHaveLength(0);

    // A determinate 'pass' (vs. 'cannot-determine') requires a non-empty
    // events.jsonl — supply one benign quality-gate event inside the window
    // so the engine has SOMETHING to attribute, per scoreProcessSafety's
    // "events.jsonl absent/empty → cannot-determine" branch.
    const now = Date.now();
    const gateEvent = {
      timestamp: new Date(now).toISOString(),
      event: 'orchestrator.quality_gate.passed',
      variant: 'full-gate',
      exit_code: 0,
    };

    const sessionRecord = {
      schema_version: 1,
      session_id: 'sess-guard-e2e-clean',
      started_at: new Date(now - 60_000).toISOString(),
      completed_at: new Date(now + 60_000).toISOString(),
      status: 'completed',
      total_waves: 1,
      total_files_changed: 1,
      waves: [{ wave: 1, quality: 'pass' }],
      agent_summary: { complete: 1, partial: 0, failed: 0, spiral: 0 },
      effectiveness: { planned_issues: 1, completed: 1, carryover: 0, completion_rate: 1 },
    };
    const { metricsDir, rubricPath } = writeMetrics(dir, {
      sessionRecord,
      extraEvents: [gateEvent],
    });

    const { record } = evaluateSession({
      metricsDir,
      rubricPath,
      timestamp: '2026-07-16T12:00:00.000Z',
      model: { id: 'test-model-v1', source: 'self-report' },
      sessionId: 'sess-guard-e2e-clean',
      resolveModelFromEnv: false,
      env: {},
    });

    const processSafety = record.dimensions.find((d) => d.id === 'process-safety');
    expect(processSafety.status).toBe('pass');
    expect(processSafety.evidence).toContain('no adverse process signals in window (0 blocked, 0 spiral, 0 loop.warning)');
  });
});
