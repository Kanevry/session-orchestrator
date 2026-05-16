/**
 * tests/unit/hooks/operator-steer.test.mjs
 *
 * Unit tests for hooks/operator-steer.mjs (issue #409).
 *
 * The hook runs as a subprocess (like Claude Code does at runtime), so each
 * test spawns it with a temp project dir and inspects stdout, exit code, and
 * file-system state.
 *
 * SO_PROJECT_DIR is controlled via CLAUDE_PROJECT_DIR env var (the env-var
 * fast path in scripts/lib/platform.mjs resolveProjectDir).
 * Profile-gate early exit is controlled via SO_HOOK_PROFILE=off.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fsp, mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const HOOK_PATH = path.join(REPO_ROOT, 'hooks', 'operator-steer.mjs');

// ---------------------------------------------------------------------------
// Helper: run the hook as a subprocess
// ---------------------------------------------------------------------------

/**
 * Spawn operator-steer.mjs with a given project dir and optional env overrides.
 * Returns { code, stdout, stderr }.
 *
 * @param {string} projectDir - temp dir to use as SO_PROJECT_DIR
 * @param {Record<string, string>} [extraEnv]
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
async function runHook(projectDir, extraEnv = {}) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      // CLAUDE_PROJECT_DIR is the env-var fast path for resolveProjectDir()
      CLAUDE_PROJECT_DIR: projectDir,
      // Disable all other hooks noise from inherited env
      ...extraEnv,
    };

    const child = spawn(process.execPath, [HOOK_PATH], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    // Hook does not read stdin
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Helper: build .orchestrator dir inside a temp project dir
// ---------------------------------------------------------------------------

/**
 * Create a temp project dir with an `.orchestrator` sub-directory.
 * Returns the project dir path.
 */
function makeTempProject() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'op-steer-test-'));
  mkdirSync(path.join(dir, '.orchestrator'), { recursive: true });
  return dir;
}

/**
 * Write STEER.md inside the given project dir.
 */
function writeSteer(projectDir, contents) {
  writeFileSync(path.join(projectDir, '.orchestrator', 'STEER.md'), contents, 'utf8');
}

/**
 * Read STEER.md contents (returns null if absent).
 */
async function readSteer(projectDir) {
  const p = path.join(projectDir, '.orchestrator', 'STEER.md');
  try {
    return await fsp.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle: clean up temp dirs after each test
// ---------------------------------------------------------------------------

const tmpDirs = [];

beforeEach(() => {
  // Ensure tmpDirs is clear before each test
});

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fsp.rm(d, { recursive: true, force: true });
  }
});

function trackDir(dir) {
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('operator-steer.mjs', { timeout: 15000 }, () => {

  // ── Test 1: No STEER.md present ────────────────────────────────────────────
  it('exits 0 with empty stdout when STEER.md is absent', async () => {
    const dir = trackDir(makeTempProject());
    // Do NOT create STEER.md

    const result = await runHook(dir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
  });

  // ── Test 2: Whitespace-only STEER.md ───────────────────────────────────────
  it('exits 0 with empty stdout and does NOT truncate a whitespace-only STEER.md', async () => {
    const dir = trackDir(makeTempProject());
    const whitespaceContent = '\n\n  \n';
    writeSteer(dir, whitespaceContent);

    const result = await runHook(dir);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');

    // Implementation returns early before writeFileSync — file is unchanged.
    const afterContents = await readSteer(dir);
    expect(afterContents).toBe(whitespaceContent);
  });

  // ── Test 3: Populated STEER.md (single line) ───────────────────────────────
  it('emits JSON systemMessage and truncates STEER.md when it contains content', async () => {
    const dir = trackDir(makeTempProject());
    writeSteer(dir, 'focus on API endpoints');

    const result = await runHook(dir);

    expect(result.code).toBe(0);

    // stdout must be valid JSON with the expected systemMessage
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed).toEqual({ systemMessage: 'focus on API endpoints' });

    // File must be truncated to empty
    const afterContents = await readSteer(dir);
    expect(afterContents).toBe('');
  });

  // ── Test 4: Multi-line STEER.md ─────────────────────────────────────────────
  it('preserves all lines in the systemMessage and truncates the file', async () => {
    const dir = trackDir(makeTempProject());
    const multiLine = 'line 1\nline 2\nline 3';
    writeSteer(dir, multiLine);

    const result = await runHook(dir);

    expect(result.code).toBe(0);

    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.systemMessage).toBe('line 1\nline 2\nline 3');

    // All 3 lines must survive in the emitted message
    expect(parsed.systemMessage.split('\n')).toHaveLength(3);

    // File truncated
    const afterContents = await readSteer(dir);
    expect(afterContents).toBe('');
  });

  // ── Test 5: Profile-gate early exit via SO_HOOK_PROFILE=off ────────────────
  it('exits 0 with empty stdout and does NOT mutate STEER.md when profile gate says no', async () => {
    const dir = trackDir(makeTempProject());
    const steerContent = 'please do not truncate me';
    writeSteer(dir, steerContent);

    // SO_HOOK_PROFILE=off causes shouldRunHook() to return false → process.exit(0)
    const result = await runHook(dir, { SO_HOOK_PROFILE: 'off' });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');

    // File must NOT have been touched — early exit happens before any FS ops
    const afterContents = await readSteer(dir);
    expect(afterContents).toBe(steerContent);
  });

  // ── Test 6: Profile-gate via SO_DISABLED_HOOKS ─────────────────────────────
  it('exits 0 silently when operator-steer is listed in SO_DISABLED_HOOKS', async () => {
    const dir = trackDir(makeTempProject());
    const steerContent = 'also do not truncate me';
    writeSteer(dir, steerContent);

    const result = await runHook(dir, { SO_DISABLED_HOOKS: 'operator-steer' });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');

    const afterContents = await readSteer(dir);
    expect(afterContents).toBe(steerContent);
  });

  // ── Test 7: Error swallowing — STEER.md is a directory (read failure) ──────
  it('exits 0 even when reading STEER.md throws (e.g. it is a directory)', async () => {
    const dir = trackDir(makeTempProject());
    // Create STEER.md as a directory so readFileSync throws EISDIR
    mkdirSync(path.join(dir, '.orchestrator', 'STEER.md'));

    const result = await runHook(dir);

    // Hook must always exit 0 — informational, must never block Claude
    expect(result.code).toBe(0);
  });

  // ── Test 8: stdout is valid JSON (schema check for populated case) ──────────
  it('stdout JSON contains only the systemMessage key when STEER.md has content', async () => {
    const dir = trackDir(makeTempProject());
    writeSteer(dir, 'steer payload');

    const result = await runHook(dir);

    const parsed = JSON.parse(result.stdout.trim());
    // Must have exactly the systemMessage key — no extra fields in the envelope
    expect(Object.keys(parsed)).toEqual(['systemMessage']);
    expect(parsed.systemMessage).toBe('steer payload');
  });

});
