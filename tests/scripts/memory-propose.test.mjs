/**
 * tests/scripts/memory-propose.test.mjs
 *
 * CLI integration tests for scripts/memory-propose.mjs (issue #501, W2-I5).
 *
 * Strategy: spawn the CLI as a real subprocess via `spawn()` so every exit code,
 * stdout JSON shape, and file-system side effect is exercised through the actual
 * Node.js module resolution, without mocking any internals.
 *
 * Each test gets its own tmpdir as repoRoot. The CLI receives `cwd` set to the
 * tmpdir so resolveStateMdPath() discovers `.claude/STATE.md` there, not in the
 * real repo root.
 *
 * Coverage:
 *   Section A — argv validation (exit 4): 4 tests
 *   Section B — wrong-context (exit 3):   4 tests
 *   Section C — below-confidence-floor (exit 2):  2 tests
 *   Section D — happy path (exit 0 + exit 1 quota): 3 tests
 *   Section E — wrong-context env-var guard (#543 H3, exit 3): 3 tests
 *
 * Env-var convention (#543 H3 / #544 M2):
 *   The `runCli` helper deletes SO_WAVE_AGENT from the child env by default,
 *   then merges in `extraEnv`. Tests opt-in explicitly per call-site.
 *   - Section A: most tests omit SO_WAVE_AGENT because argv-required validation
 *     (Step 1) fires before the env-var guard (Step 2b). The two `--type`
 *     enum-validation tests DO set SO_WAVE_AGENT=1 because the enum check
 *     runs in Step 7 (schema validation), after the guard.
 *   - Section B: STATE.md-context rejection (Step 2) fires before the env-var
 *     guard, so no env-var injection is needed.
 *   - Sections C and D: opt-in via `extraEnv: { SO_WAVE_AGENT: '1' }` to pass
 *     the env-var guard and reach the success/floor paths.
 *   - Section E: intentionally omits / mis-sets SO_WAVE_AGENT to exercise
 *     the guard itself.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = resolve(__dirname, '../../');
const CLI_PATH = join(PROJECT_ROOT, 'scripts/memory-propose.mjs');

// ---------------------------------------------------------------------------
// STATE.md fixtures
// ---------------------------------------------------------------------------

const ACTIVE_STATE_MD = `---
schema-version: 1
session-type: deep
branch: main
issues: [501]
started_at: 2026-05-23T12:49:07.000Z
status: active
current-wave: 2
total-waves: 5
session: test-session-2026-05-23
session-start-ref: abc123
---
## Current Wave
Wave 2

## Wave History
(none)

## Deviations
(none)
`;

const COMPLETED_STATE_MD = `---
schema-version: 1
session-type: deep
branch: main
status: completed
current-wave: 5
total-waves: 5
session: test-session-done
---
## Current Wave
Wave 5
`;

const IDLE_STATE_MD = `---
schema-version: 1
session-type: deep
branch: main
status: idle
---
## Current Wave
(none)
`;

// Malformed = no YAML fences → parseStateMd returns null
const MALFORMED_STATE_MD = `This is just free text with no frontmatter at all.
It does not start with --- so parseStateMd will return null.
`;

// ---------------------------------------------------------------------------
// Minimal valid proposal args (type must be in PROPOSAL_TYPES)
// ---------------------------------------------------------------------------

const VALID_ARGS = [
  '--type', 'proven-pattern',
  '--subject', 'Test subject for CLI integration',
  '--insight', 'This is a test insight with enough detail',
  '--evidence', 'Observed during test run with spawn subprocess',
  '--confidence', '0.7',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const tmpDirs = [];

/**
 * Create a fresh tmpdir with the expected directory structure.
 * The `.claude/` subdirectory is always created.
 * `.orchestrator/metrics/` is created so the store can write to it.
 * Writes STATE.md when stateMd is provided.
 *
 * @param {{ stateMd?: string }} [opts]
 * @returns {string} absolute path to the tmpdir
 */
function setupTmpRepo({ stateMd } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-cli-test-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, '.claude'), { recursive: true });
  mkdirSync(join(dir, '.orchestrator', 'metrics'), { recursive: true });
  if (stateMd !== undefined) {
    writeFileSync(join(dir, '.claude', 'STATE.md'), stateMd, 'utf8');
  }
  return dir;
}

/**
 * Spawn the CLI in `cwd` with the given args and resolve when the process exits.
 *
 * The CLI requires `SO_WAVE_AGENT=1` to pass the wrong-context env-var guard
 * (#543 H3). The helper does NOT inject it by default — opt-in per test via
 * `extraEnv: { SO_WAVE_AGENT: '1' }`. This keeps the guard explicit at every
 * call-site and makes Section E (guard-under-test) trivially expressible.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeout?: number, extraEnv?: Record<string, string> }} [opts]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(cwd, args, { timeout = 15_000, extraEnv = {} } = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';

    // Strip any pre-existing SO_WAVE_AGENT from process.env so the test's
    // env-var semantics are deterministic. Tests opt-in explicitly via extraEnv.
    const baseEnv = { ...process.env };
    delete baseEnv.SO_WAVE_AGENT;

    const proc = spawn('node', [CLI_PATH, ...args], {
      cwd,
      env: { ...baseEnv, ...extraEnv },
      // Spawn with pipe stdio so we collect everything.
    });

    const killTimer = setTimeout(() => {
      proc.kill();
      reject(new Error(`CLI process timed out after ${timeout}ms`));
    }, timeout);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(killTimer);
      resolve({ code: code ?? -1, stdout: stdout.trim(), stderr: stderr.trim() });
    });

    proc.on('error', (err) => {
      clearTimeout(killTimer);
      reject(err);
    });
  });
}

/**
 * Parse stdout as JSON, throwing an informative error on failure.
 * @param {string} stdout
 * @returns {object}
 */
function parseJSON(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`stdout is not valid JSON: ${JSON.stringify(stdout)}`);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ===========================================================================
// Section A — Argv validation (exit 4)
// ===========================================================================

describe('Section A — argv validation (exit 4)', () => {
  it('exits 4 when no args are supplied', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { code } = await runCli(dir, []);
    expect(code).toBe(4);
  });

  it('stdout contains "--type is required" when no args are supplied', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { stdout } = await runCli(dir, []);
    const result = parseJSON(stdout);
    expect(result.validation).toContain('--type is required');
  });

  it('stdout contains "--subject is required" when no args are supplied', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { stdout } = await runCli(dir, []);
    const result = parseJSON(stdout);
    expect(result.validation).toContain('--subject is required');
  });

  it('stdout.status equals "error" when no args are supplied', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { stdout } = await runCli(dir, []);
    const result = parseJSON(stdout);
    expect(result.status).toBe('error');
  });

  // --type enum validation runs in schema validation (Step 7), which fires
  // AFTER both the STATE.md status check (Step 2) and the SO_WAVE_AGENT
  // env-var guard (Step 2b, #543 H3). The test must set the env-var so we
  // actually reach Step 7 — without it the env-var guard would intercept
  // with exit 3 first.
  it('exits 4 when --type is not a valid enum value', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'invalid-nonexistent-type',
      '--subject', 'Subject',
      '--insight', 'Insight text here',
      '--evidence', 'Evidence text here',
      '--confidence', '0.7',
    ];
    const { code } = await runCli(dir, args, { extraEnv: { SO_WAVE_AGENT: '1' } });
    expect(code).toBe(4);
  });

  it('stdout.validation array is non-empty on invalid --type', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'invalid-nonexistent-type',
      '--subject', 'Subject',
      '--insight', 'Insight text here',
      '--evidence', 'Evidence text here',
      '--confidence', '0.7',
    ];
    const { stdout } = await runCli(dir, args, { extraEnv: { SO_WAVE_AGENT: '1' } });
    const result = parseJSON(stdout);
    expect(result.validation.length).toBeGreaterThanOrEqual(1);
  });

  it('exits 4 when --confidence is not a number', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'proven-pattern',
      '--subject', 'Subject',
      '--insight', 'Insight text here',
      '--evidence', 'Evidence text here',
      '--confidence', 'not-a-number',
    ];
    const { code } = await runCli(dir, args);
    expect(code).toBe(4);
  });

  it('stdout.validation contains confidence error when --confidence is not a number', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'proven-pattern',
      '--subject', 'Subject',
      '--insight', 'Insight text here',
      '--evidence', 'Evidence text here',
      '--confidence', 'not-a-number',
    ];
    const { stdout } = await runCli(dir, args);
    const result = parseJSON(stdout);
    expect(result.validation.some((msg) => msg.includes('--confidence'))).toBe(true);
  });

  it('exits 4 when --subject is an empty string', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'proven-pattern',
      '--subject', '',
      '--insight', 'Insight text here',
      '--evidence', 'Evidence text here',
      '--confidence', '0.7',
    ];
    const { code } = await runCli(dir, args);
    expect(code).toBe(4);
  });
});

// ===========================================================================
// Section B — Wrong-context (exit 3)
// ===========================================================================

describe('Section B — wrong-context (exit 3)', () => {
  it('exits 3 when STATE.md is absent', async () => {
    // No stateMd supplied — .claude/ directory exists but STATE.md does not
    const dir = setupTmpRepo();
    const { code } = await runCli(dir, VALID_ARGS);
    expect(code).toBe(3);
  });

  it('stdout.status equals "rejected-wrong-context" when STATE.md is absent', async () => {
    const dir = setupTmpRepo();
    const { stdout } = await runCli(dir, VALID_ARGS);
    const result = parseJSON(stdout);
    expect(result.status).toBe('rejected-wrong-context');
  });

  it('stdout.detail mentions STATE.md when it is absent', async () => {
    const dir = setupTmpRepo();
    const { stdout } = await runCli(dir, VALID_ARGS);
    const result = parseJSON(stdout);
    expect(result.detail).toContain('STATE.md');
  });

  it('exits 3 when STATE.md status is "completed"', async () => {
    const dir = setupTmpRepo({ stateMd: COMPLETED_STATE_MD });
    const { code } = await runCli(dir, VALID_ARGS);
    expect(code).toBe(3);
  });

  it('stdout.detail mentions "active" when STATE.md status is "completed"', async () => {
    const dir = setupTmpRepo({ stateMd: COMPLETED_STATE_MD });
    const { stdout } = await runCli(dir, VALID_ARGS);
    const result = parseJSON(stdout);
    expect(result.detail).toContain('active');
  });

  it('exits 3 when STATE.md status is "idle"', async () => {
    const dir = setupTmpRepo({ stateMd: IDLE_STATE_MD });
    const { code } = await runCli(dir, VALID_ARGS);
    expect(code).toBe(3);
  });

  it('stdout.status equals "rejected-wrong-context" when STATE.md status is "idle"', async () => {
    const dir = setupTmpRepo({ stateMd: IDLE_STATE_MD });
    const { stdout } = await runCli(dir, VALID_ARGS);
    const result = parseJSON(stdout);
    expect(result.status).toBe('rejected-wrong-context');
  });

  it('exits 3 when STATE.md has no YAML frontmatter fences (malformed)', async () => {
    const dir = setupTmpRepo({ stateMd: MALFORMED_STATE_MD });
    const { code } = await runCli(dir, VALID_ARGS);
    expect(code).toBe(3);
  });

  it('stdout.status equals "rejected-wrong-context" when STATE.md is malformed', async () => {
    const dir = setupTmpRepo({ stateMd: MALFORMED_STATE_MD });
    const { stdout } = await runCli(dir, VALID_ARGS);
    const result = parseJSON(stdout);
    expect(result.status).toBe('rejected-wrong-context');
  });
});

// ===========================================================================
// Section C — Below confidence floor (exit 2)
// ===========================================================================

describe('Section C — below-floor (exit 2)', () => {
  const WAVE_AGENT_ENV = { extraEnv: { SO_WAVE_AGENT: '1' } };

  it('exits 2 when confidence is 0.3 (below default floor of 0.5)', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'proven-pattern',
      '--subject', 'Test subject',
      '--insight', 'Test insight content',
      '--evidence', 'Test evidence content',
      '--confidence', '0.3',
    ];
    const { code } = await runCli(dir, args, WAVE_AGENT_ENV);
    expect(code).toBe(2);
  });

  it('stdout.status equals "rejected-low-confidence" when confidence is 0.3', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'proven-pattern',
      '--subject', 'Test subject',
      '--insight', 'Test insight content',
      '--evidence', 'Test evidence content',
      '--confidence', '0.3',
    ];
    const { stdout } = await runCli(dir, args, WAVE_AGENT_ENV);
    const result = parseJSON(stdout);
    expect(result.status).toBe('rejected-low-confidence');
  });

  it('stdout.floor is 0.5 and stdout.provided is 0.3', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'proven-pattern',
      '--subject', 'Test subject',
      '--insight', 'Test insight content',
      '--evidence', 'Test evidence content',
      '--confidence', '0.3',
    ];
    const { stdout } = await runCli(dir, args, WAVE_AGENT_ENV);
    const result = parseJSON(stdout);
    expect(result.floor).toBe(0.5);
    expect(result.provided).toBe(0.3);
  });

  // store.mjs check is: record.confidence < confidenceFloor (strict <)
  // Therefore confidence === 0.5 is NOT below floor and should succeed (exit 0).
  it('exits 0 (not 2) when confidence equals the floor (0.5 === floor)', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const args = [
      '--type', 'proven-pattern',
      '--subject', 'Boundary test at floor',
      '--insight', 'Insight at exactly the confidence floor value',
      '--evidence', 'Evidence at exactly the confidence floor value',
      '--confidence', '0.5',
    ];
    const { code } = await runCli(dir, args, WAVE_AGENT_ENV);
    expect(code).toBe(0);
  });
});

// ===========================================================================
// Section D — Happy path (exit 0) and quota-exceeded (exit 1)
// ===========================================================================

describe('Section D — happy path and quota', () => {
  const WAVE_AGENT_ENV = { extraEnv: { SO_WAVE_AGENT: '1' } };

  it('exits 0 when all args are valid and STATE.md status is active', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { code } = await runCli(dir, VALID_ARGS, WAVE_AGENT_ENV);
    expect(code).toBe(0);
  });

  it('stdout.status equals "queued" on success', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { stdout } = await runCli(dir, VALID_ARGS, WAVE_AGENT_ENV);
    const result = parseJSON(stdout);
    expect(result.status).toBe('queued');
  });

  it('stdout.wave equals "W2" matching STATE.md current-wave=2', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { stdout } = await runCli(dir, VALID_ARGS, WAVE_AGENT_ENV);
    const result = parseJSON(stdout);
    expect(result.wave).toBe('W2');
  });

  it('stdout.position equals "1/5" on first proposal', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { stdout } = await runCli(dir, VALID_ARGS, WAVE_AGENT_ENV);
    const result = parseJSON(stdout);
    expect(result.position).toBe('1/5');
  });

  it('proposals.jsonl line is written after successful proposal', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    await runCli(dir, VALID_ARGS, WAVE_AGENT_ENV);
    const jsonlPath = join(dir, '.orchestrator', 'metrics', 'proposals.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
  });

  it('proposals.jsonl line contains the submitted subject', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    await runCli(dir, VALID_ARGS, WAVE_AGENT_ENV);
    const jsonlPath = join(dir, '.orchestrator', 'metrics', 'proposals.jsonl');
    const contents = readFileSync(jsonlPath, 'utf8');
    const line = JSON.parse(contents.trim().split('\n')[0]);
    expect(line.subject).toBe('Test subject for CLI integration');
  });

  it('proposals.jsonl line contains wave_id matching the STATE.md wave', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    await runCli(dir, VALID_ARGS, WAVE_AGENT_ENV);
    const jsonlPath = join(dir, '.orchestrator', 'metrics', 'proposals.jsonl');
    const contents = readFileSync(jsonlPath, 'utf8');
    const line = JSON.parse(contents.trim().split('\n')[0]);
    expect(line.wave_id).toBe('W2');
  });

  it('stdout.position advances on the second proposal in the same repo', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    // First call
    await runCli(dir, VALID_ARGS, WAVE_AGENT_ENV);
    // Second call with a different subject to avoid confusion
    const args2 = [
      '--type', 'anti-pattern',
      '--subject', 'Second proposal subject',
      '--insight', 'Second insight text',
      '--evidence', 'Second evidence text',
      '--confidence', '0.8',
    ];
    const { code, stdout } = await runCli(dir, args2, WAVE_AGENT_ENV);
    expect(code).toBe(0);
    const result = parseJSON(stdout);
    expect(result.position).toBe('2/5');
  });

  it('exits 1 with quota-exceeded after 5 proposals in the same wave', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });

    // Submit 5 proposals to fill the quota
    for (let i = 1; i <= 5; i++) {
      const args = [
        '--type', 'proven-pattern',
        '--subject', `Quota-fill proposal ${i}`,
        '--insight', `Insight for proposal ${i}`,
        '--evidence', `Evidence for proposal ${i}`,
        '--confidence', '0.7',
      ];
      const { code } = await runCli(dir, args, WAVE_AGENT_ENV);
      expect(code).toBe(0);
    }

    // 6th proposal must be rejected
    const args6 = [
      '--type', 'proven-pattern',
      '--subject', 'Over-quota proposal',
      '--insight', 'This should be dropped',
      '--evidence', 'This should be dropped',
      '--confidence', '0.7',
    ];
    const { code } = await runCli(dir, args6, WAVE_AGENT_ENV);
    expect(code).toBe(1);
  });

  it('stdout.status equals "quota-exceeded" on the 6th proposal', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });

    // Fill quota
    for (let i = 1; i <= 5; i++) {
      const args = [
        '--type', 'proven-pattern',
        '--subject', `Quota proposal ${i}`,
        '--insight', `Insight ${i}`,
        '--evidence', `Evidence ${i}`,
        '--confidence', '0.7',
      ];
      await runCli(dir, args, WAVE_AGENT_ENV);
    }

    // 6th
    const args6 = [
      '--type', 'proven-pattern',
      '--subject', 'Overflow proposal',
      '--insight', 'Over the limit',
      '--evidence', 'Over the limit',
      '--confidence', '0.7',
    ];
    const { stdout } = await runCli(dir, args6, WAVE_AGENT_ENV);
    const result = parseJSON(stdout);
    expect(result.status).toBe('quota-exceeded');
  });

  it('stdout.quota equals 5 on quota-exceeded response', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });

    for (let i = 1; i <= 5; i++) {
      const args = [
        '--type', 'proven-pattern',
        '--subject', `Quota proposal ${i}`,
        '--insight', `Insight ${i}`,
        '--evidence', `Evidence ${i}`,
        '--confidence', '0.7',
      ];
      await runCli(dir, args, WAVE_AGENT_ENV);
    }

    const args6 = [
      '--type', 'proven-pattern',
      '--subject', 'Overflow check',
      '--insight', 'Overflow insight',
      '--evidence', 'Overflow evidence',
      '--confidence', '0.7',
    ];
    const { stdout } = await runCli(dir, args6, WAVE_AGENT_ENV);
    const result = parseJSON(stdout);
    expect(result.quota).toBe(5);
  });
});

// ===========================================================================
// Section E — Wrong-context env-var guard (#543 H3, exit 3)
// ===========================================================================
//
// These tests exercise the per-process `SO_WAVE_AGENT=1` env-var guard added
// in #543 H3. STATE.md is set to `status: active` so the existing context
// checks pass; only the env-var assertion can produce the rejection.
// Strict equality with '1' is verified — '0' and 'true' must both fail.

describe('Section E — wrong-context env-var guard (#543 H3, exit 3)', () => {
  it('exits 3 when SO_WAVE_AGENT is unset even with active STATE.md', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    // No extraEnv → helper strips SO_WAVE_AGENT from process.env
    const { code, stdout } = await runCli(dir, VALID_ARGS);
    expect(code).toBe(3);
    const result = parseJSON(stdout);
    expect(result.status).toBe('rejected-wrong-context');
    expect(result.detail).toContain('wave-executor');
  });

  it('exits 3 when SO_WAVE_AGENT is "0" (strict equality with "1")', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { code, stdout } = await runCli(dir, VALID_ARGS, {
      extraEnv: { SO_WAVE_AGENT: '0' },
    });
    expect(code).toBe(3);
    const result = parseJSON(stdout);
    expect(result.status).toBe('rejected-wrong-context');
    expect(result.detail).toContain('SO_WAVE_AGENT=1');
  });

  it('exits 3 when SO_WAVE_AGENT is "true" (strict equality with "1")', async () => {
    const dir = setupTmpRepo({ stateMd: ACTIVE_STATE_MD });
    const { code, stdout } = await runCli(dir, VALID_ARGS, {
      extraEnv: { SO_WAVE_AGENT: 'true' },
    });
    expect(code).toBe(3);
    const result = parseJSON(stdout);
    expect(result.status).toBe('rejected-wrong-context');
    expect(result.detail).toContain('SO_WAVE_AGENT=1');
  });
});
