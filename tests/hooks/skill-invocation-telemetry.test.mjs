/**
 * tests/hooks/skill-invocation-telemetry.test.mjs
 *
 * Integration tests for hooks/skill-invocation-telemetry.mjs (epic #645, issue #644).
 *
 * Strategy: spawn the hook as a real subprocess, feed JSON via stdin, assert:
 *   - exit code is always 0 (informational hook — must never block)
 *   - a 'selected' record is appended when tool_name is "Skill"
 *   - no record is appended when tool_name is not "Skill"
 *   - malformed stdin → exit 0, no crash
 *
 * CRITICAL isolation: we redirect SO_PROJECT_DIR to a per-test tmp dir via
 * CLAUDE_PROJECT_DIR so the real .orchestrator/metrics/skill-invocations.jsonl
 * is never touched. Cleanup is enforced in afterEach.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/skill-invocation-telemetry.mjs');
const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook, feed stdinPayload, collect stdout/stderr, resolve with exit code.
 * Sets CLAUDE_PROJECT_DIR to projectDir so SO_PROJECT_DIR points at our tmp dir.
 * Sets SO_HOOK_PROFILE=full to ensure the hook is not gated off.
 */
function runHook({ projectDir, stdinPayload, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        SO_HOOK_PROFILE: 'full',
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdinPayload ?? '');
  });
}

/**
 * Build the JSONL path that the hook writes to for a given projectDir.
 */
function invocationsPath(projectDir) {
  return path.join(projectDir, '.orchestrator', 'metrics', 'skill-invocations.jsonl');
}

/**
 * Build a Skill tool PreToolUse payload.
 */
function skillPayload(skillName, sessionId = 'test-session-123') {
  return JSON.stringify({
    tool_name: 'Skill',
    tool_input: { skill: skillName },
    session_id: sessionId,
  });
}

/**
 * Build a non-Skill tool PreToolUse payload.
 */
function nonSkillPayload(toolName = 'Bash') {
  return JSON.stringify({
    tool_name: toolName,
    tool_input: { command: 'ls -la' },
    session_id: 'test-session-123',
  });
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

async function mkTmpProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-telemetry-test-'));
  // Create a minimal CLAUDE.md so platform.mjs resolves it as a project dir
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# test\n');
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// T1 — Skill tool triggers a record
// ---------------------------------------------------------------------------

describe('Skill tool invocation', { timeout: 15000 }, () => {
  it('exits 0 when tool_name is "Skill"', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({ projectDir: dir, stdinPayload: skillPayload('discovery') });
    expect(result.code).toBe(0);
  });

  it('appends a record with event="selected" and skill from tool_input', async () => {
    const dir = await mkTmpProject();
    await runHook({ projectDir: dir, stdinPayload: skillPayload('session-orchestrator:discovery') });

    const jsonlPath = invocationsPath(dir);
    expect(existsSync(jsonlPath)).toBe(true);
    const line = readFileSync(jsonlPath, 'utf8').trim();
    const record = JSON.parse(line);
    expect(record.event).toBe('selected');
    expect(record.skill).toBe('session-orchestrator:discovery');
  });

  it('appended record has schema_version: 1', async () => {
    const dir = await mkTmpProject();
    await runHook({ projectDir: dir, stdinPayload: skillPayload('my-skill') });

    const line = readFileSync(invocationsPath(dir), 'utf8').trim();
    const record = JSON.parse(line);
    expect(record.schema_version).toBe(1);
  });

  it('appended record has a valid ISO timestamp', async () => {
    const dir = await mkTmpProject();
    const before = Date.now();
    await runHook({ projectDir: dir, stdinPayload: skillPayload('my-skill') });
    const after = Date.now();

    const line = readFileSync(invocationsPath(dir), 'utf8').trim();
    const record = JSON.parse(line);
    const ts = Date.parse(record.timestamp);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 5000); // 5s grace for process startup
  });

  it('captures session_id from stdin payload', async () => {
    const dir = await mkTmpProject();
    await runHook({
      projectDir: dir,
      stdinPayload: skillPayload('test-skill', 'session-xyz-999'),
    });

    const line = readFileSync(invocationsPath(dir), 'utf8').trim();
    const record = JSON.parse(line);
    expect(record.session_id).toBe('session-xyz-999');
  });

  it('stores skill="unknown" when tool_input.skill is absent', async () => {
    const dir = await mkTmpProject();
    await runHook({
      projectDir: dir,
      stdinPayload: JSON.stringify({ tool_name: 'Skill', tool_input: {}, session_id: 's1' }),
    });

    const line = readFileSync(invocationsPath(dir), 'utf8').trim();
    const record = JSON.parse(line);
    expect(record.skill).toBe('unknown');
  });

  it('stores session_id: null when session_id is absent from payload', async () => {
    const dir = await mkTmpProject();
    await runHook({
      projectDir: dir,
      stdinPayload: JSON.stringify({ tool_name: 'Skill', tool_input: { skill: 'foo' } }),
    });

    const line = readFileSync(invocationsPath(dir), 'utf8').trim();
    const record = JSON.parse(line);
    expect(record.session_id).toBeNull();
  });

  it('appends a second record on a second invocation — file has 2 lines', async () => {
    const dir = await mkTmpProject();
    await runHook({ projectDir: dir, stdinPayload: skillPayload('skill-a', 'sess-1') });
    await runHook({ projectDir: dir, stdinPayload: skillPayload('skill-b', 'sess-2') });

    const lines = readFileSync(invocationsPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).skill).toBe('skill-a');
    expect(JSON.parse(lines[1]).skill).toBe('skill-b');
  });
});

// ---------------------------------------------------------------------------
// T2 — Non-Skill tools are ignored
// ---------------------------------------------------------------------------

describe('non-Skill tool invocation', { timeout: 15000 }, () => {
  it('exits 0 for tool_name="Bash"', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({ projectDir: dir, stdinPayload: nonSkillPayload('Bash') });
    expect(result.code).toBe(0);
  });

  it('does NOT write any record when tool_name="Bash"', async () => {
    const dir = await mkTmpProject();
    await runHook({ projectDir: dir, stdinPayload: nonSkillPayload('Bash') });
    expect(existsSync(invocationsPath(dir))).toBe(false);
  });

  it('exits 0 for tool_name="Edit"', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({ projectDir: dir, stdinPayload: nonSkillPayload('Edit') });
    expect(result.code).toBe(0);
  });

  it('does NOT write any record when tool_name="Read"', async () => {
    const dir = await mkTmpProject();
    await runHook({ projectDir: dir, stdinPayload: nonSkillPayload('Read') });
    expect(existsSync(invocationsPath(dir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T3 — Resilience: malformed / empty stdin must never crash or block
// ---------------------------------------------------------------------------

describe('resilience — malformed stdin', { timeout: 15000 }, () => {
  it('exits 0 for empty stdin — never crashes', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({ projectDir: dir, stdinPayload: '' });
    expect(result.code).toBe(0);
  });

  it('exits 0 for non-JSON stdin', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({ projectDir: dir, stdinPayload: 'not json at all' });
    expect(result.code).toBe(0);
  });

  it('exits 0 for partial/truncated JSON', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({ projectDir: dir, stdinPayload: '{"tool_name":' });
    expect(result.code).toBe(0);
  });

  it('exits 0 for a JSON array (wrong shape)', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({ projectDir: dir, stdinPayload: '[]' });
    expect(result.code).toBe(0);
  });

  it('does NOT write a record for malformed stdin', async () => {
    const dir = await mkTmpProject();
    await runHook({ projectDir: dir, stdinPayload: 'not json at all' });
    expect(existsSync(invocationsPath(dir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T4 — Profile gate: SO_HOOK_PROFILE=off disables the hook
// ---------------------------------------------------------------------------

describe('profile gate', { timeout: 15000 }, () => {
  it('exits 0 without writing any record when SO_HOOK_PROFILE=off', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({
      projectDir: dir,
      stdinPayload: skillPayload('discovery'),
      env: { SO_HOOK_PROFILE: 'off' },
    });
    expect(result.code).toBe(0);
    // The hook exits immediately on profile=off, before any IO
    expect(existsSync(invocationsPath(dir))).toBe(false);
  });

  it('exits 0 without writing when hook is individually disabled via SO_DISABLED_HOOKS', async () => {
    const dir = await mkTmpProject();
    const result = await runHook({
      projectDir: dir,
      stdinPayload: skillPayload('discovery'),
      env: { SO_DISABLED_HOOKS: 'skill-invocation-telemetry', SO_HOOK_PROFILE: 'full' },
    });
    expect(result.code).toBe(0);
    expect(existsSync(invocationsPath(dir))).toBe(false);
  });
});
