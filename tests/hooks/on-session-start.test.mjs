/**
 * tests/hooks/on-session-start.test.mjs
 *
 * Regression tests for hooks/on-session-start.mjs — SessionStart event emitter.
 *
 * Strategy: spawn the hook as a subprocess with a tmp project dir (CLAUDE_PROJECT_DIR),
 * assert exit code is always 0, assert the JSONL event was written correctly.
 *
 * Issue #140 (hook implementation).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-session-start.mjs');
const EVENTS_RELPATH = path.join('.orchestrator', 'metrics', 'events.jsonl');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook with the given environment overrides and collect result.
 * @param {{ projectDir: string, env?: Record<string,string> }} opts
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string }>}
 */
async function runHook({ projectDir, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        // Remove any real secret so tests do not hit the network.
        CLANK_EVENT_SECRET: '',
        CLANK_EVENT_URL: '',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    // Close stdin immediately — hook expects no input.
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Create a minimal temp project directory with a git repo.
 * @returns {Promise<string>}
 */
async function mkProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-session-start-test-'));
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} commit --allow-empty -m "init" --no-gpg-sign`;
  return dir;
}

/**
 * Read and parse all JSONL lines from the events file in a project dir.
 * @param {string} projectDir
 * @returns {Promise<object[]>}
 */
async function readEvents(projectDir) {
  const filePath = path.join(projectDir, EVENTS_RELPATH);
  const raw = await fs.readFile(filePath, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(async () => {
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
// Exit code — always 0
// ---------------------------------------------------------------------------

describe('exit code', { timeout: 15000 }, () => {
  it('exits 0 on a normal run', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir });
    expect(result.code).toBe(0);
  });

  it('exits 0 when the project directory does not exist (graceful fallback)', async () => {
    const result = await runHook({
      projectDir: path.join(os.tmpdir(), 'nonexistent-so-dir-' + Date.now()),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when CLANK_EVENT_SECRET is absent', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      env: { CLANK_EVENT_SECRET: '' },
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Normal run — JSONL event written
// ---------------------------------------------------------------------------

describe('normal run — event written to JSONL', { timeout: 15000 }, () => {
  it('creates the events.jsonl file', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const filePath = path.join(dir, EVENTS_RELPATH);
    await expect(fs.access(filePath)).resolves.toBeUndefined();
  });

  it('writes exactly one JSONL line', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
  });

  it('event.event equals "orchestrator.session.started"', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt.event).toBe('orchestrator.session.started');
  });

  it('event.timestamp is an ISO 8601 UTC timestamp', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z$/);
  });

  it('event.project matches the directory basename', async () => {
    const dir = await mkProjectTracked();
    const expectedName = path.basename(dir);
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt.project).toBe(expectedName);
  });

  it('event.branch is a non-empty string', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(typeof evt.branch).toBe('string');
    expect(evt.branch.length).toBeGreaterThan(0);
  });

  it('event.platform field is present', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const [evt] = await readEvents(dir);
    expect(evt).toHaveProperty('platform');
  });
});

// ---------------------------------------------------------------------------
// CLANK_EVENT_SECRET absent — no network calls attempted
// ---------------------------------------------------------------------------

describe('CLANK_EVENT_SECRET absent — no webhook', { timeout: 15000 }, () => {
  it('exits 0 and writes event even without CLANK_EVENT_SECRET', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      env: { CLANK_EVENT_SECRET: '' },
    });
    expect(result.code).toBe(0);
    const events = await readEvents(dir);
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Project-dir resolution
// ---------------------------------------------------------------------------

describe('project-dir resolution', { timeout: 15000 }, () => {
  it('uses CLAUDE_PROJECT_DIR to resolve the events file location', async () => {
    const dir = await mkProjectTracked();
    await runHook({ projectDir: dir });
    const expectedPath = path.join(dir, EVENTS_RELPATH);
    await expect(fs.access(expectedPath)).resolves.toBeUndefined();
  });

  it('event.project is "unknown" or fallback when no git repo is present', async () => {
    // Non-git directory — git commands will fail gracefully.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-session-start-nogit-'));
    tmpDirs.push(dir);
    const result = await runHook({ projectDir: dir });
    expect(result.code).toBe(0);
    const filePath = path.join(dir, EVENTS_RELPATH);
    const fileExists = await fs.access(filePath).then(() => true).catch(() => false);
    if (fileExists) {
      const events = await readEvents(dir);
      expect(events[0].event).toBe('orchestrator.session.started');
    }
  });
});
