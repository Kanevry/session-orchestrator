/**
 * tests/hooks/pre-bash-staging-fence.test.mjs
 *
 * Tests for hooks/pre-bash-staging-fence.mjs — PSA-004 sub-mode C staging-
 * fence intent logger.
 *
 * Strategy: spawn the hook as a subprocess with JSON stdin matching the
 * harness PreToolUse contract. Assert exit code, stderr, and fence file
 * presence / shape.
 *
 * Issue: #557
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = resolve(import.meta.dirname, '../..', 'hooks/pre-bash-staging-fence.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook with a JSON PreToolUse payload on stdin.
 * Env-vars in `env` override process.env. Passes CLAUDE_PROJECT_DIR from the
 * test's projectDir unless overridden.
 */
function runHook({ toolName = 'Bash', command = '', env = {}, projectDir }) {
  const input = JSON.stringify({
    tool_name: toolName,
    tool_input: { command },
  });
  return spawnSync('node', [HOOK], {
    input,
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      // Strip variables that would bypass the hook during tests unless the
      // caller explicitly sets them.
      SO_DISABLED_HOOKS: '',
      SO_HOOK_PROFILE: '',
      SO_WAVE_AGENT: '',
      ...env,
    },
  });
}

/**
 * Return all .json files (excluding dot-files) written inside the fence dir.
 */
function fenceFiles(projectDir) {
  const fenceDir = join(projectDir, '.orchestrator', 'staging-fence');
  if (!existsSync(fenceDir)) return [];
  return readdirSync(fenceDir).filter((f) => f.endsWith('.json') && !f.startsWith('.'));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let projectDir;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), 'staging-fence-test-'));
  mkdirSync(join(projectDir, '.orchestrator', 'staging-fence'), { recursive: true });
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('pre-bash-staging-fence — gate ladder G1-G6', { timeout: 15000 }, () => {
  // G1 — non-Bash tool is allowed unconditionally; no fence file written.
  it('G1: non-Bash tool exits 0 and writes no fence file', () => {
    const result = runHook({
      toolName: 'Read',
      command: 'git add foo.ts',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G2 — empty command is allowed; no fence file written.
  it('G2: empty command exits 0 and writes no fence file', () => {
    const result = runHook({
      command: '',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G3 — regex positive match: `git add foo.ts`
  it('G3 match: "git add foo.ts" exits 0 and writes a fence file', () => {
    const result = runHook({
      command: 'git add foo.ts',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(1);
  });

  // G3 — regex positive match: `git add -A` (stage all)
  it('G3 match: "git add -A" exits 0 and writes a fence file', () => {
    const result = runHook({
      command: 'git add -A',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(1);
  });

  // G3 — regex positive match: `git add --all`
  it('G3 match: "git add --all" exits 0 and writes a fence file', () => {
    const result = runHook({
      command: 'git add --all',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(1);
  });

  // G3 — regex positive match: `git add -- foo.ts` (explicit double-dash)
  it('G3 match: "git add -- foo.ts" exits 0 and writes a fence file', () => {
    const result = runHook({
      command: 'git add -- foo.ts',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(1);
  });

  // G3 — regex positive match: chained command with git add
  it('G3 match: chained "cd subdir && git add foo.ts" exits 0 and writes a fence file', () => {
    const result = runHook({
      command: 'cd subdir && git add foo.ts',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(1);
  });

  // G3 — regex negative match: `git addremote` must NOT match (word boundary).
  it('G3 non-match: "git addremote" exits 0 and writes NO fence file', () => {
    const result = runHook({
      command: 'git addremote origin https://example.com',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G3 — regex negative match: `git adapter`
  it('G3 non-match: "git adapter" exits 0 and writes NO fence file', () => {
    const result = runHook({
      command: 'git adapter --dry-run',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G4 — context gate: SO_WAVE_AGENT unset → coordinator context → no fence.
  it('G4: SO_WAVE_AGENT unset exits 0 and writes no fence file', () => {
    const result = runHook({
      command: 'git add foo.ts',
      env: { SO_WAVE_AGENT: '' }, // unset / empty = not a wave-agent
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G5+G6 — fence file schema check: correct JSON shape written.
  it('G5+G6: fence file has correct JSON shape with required fields', () => {
    const result = runHook({
      command: 'git add src/foo.ts',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    const files = fenceFiles(projectDir);
    expect(files).toHaveLength(1);

    const fenceDir = join(projectDir, '.orchestrator', 'staging-fence');
    const body = JSON.parse(readFileSync(join(fenceDir, files[0]), 'utf8'));

    expect(typeof body.agent_id).toBe('string');
    expect(body.agent_id.length).toBeGreaterThan(0);
    expect(typeof body.pid).toBe('number');
    expect(typeof body.host).toBe('string');
    expect(typeof body.started_at).toBe('string');
    expect(Array.isArray(body.staged_paths)).toBe(true);
    expect(body.staged_paths).toHaveLength(1);
    expect(body.staged_paths[0].command).toBe('git add src/foo.ts');
    expect(typeof body.staged_paths[0].timestamp).toBe('string');
  });

  // G6 append — two separate invocations for the same agent each write their
  // own fence file (fresh Node process each time → unique random suffix).
  it('G6 append: two git-add invocations write two separate fence files', () => {
    runHook({ command: 'git add foo.ts', env: { SO_WAVE_AGENT: '1' }, projectDir });
    runHook({ command: 'git add bar.ts', env: { SO_WAVE_AGENT: '1' }, projectDir });
    // Each subprocess is a fresh Node process → unique random suffix → 2 files.
    expect(fenceFiles(projectDir)).toHaveLength(2);
  });

  // Bypass — SO_DISABLED_HOOKS=pre-bash-staging-fence → exits 0, no fence.
  it('bypass: SO_DISABLED_HOOKS=pre-bash-staging-fence exits 0 and writes no fence file', () => {
    const result = runHook({
      command: 'git add foo.ts',
      env: { SO_WAVE_AGENT: '1', SO_DISABLED_HOOKS: 'pre-bash-staging-fence' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // Bypass — SO_HOOK_PROFILE=off → exits 0, no fence.
  it('bypass: SO_HOOK_PROFILE=off exits 0 and writes no fence file', () => {
    const result = runHook({
      command: 'git add foo.ts',
      env: { SO_WAVE_AGENT: '1', SO_HOOK_PROFILE: 'off' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(0);
  });

  // G3 match — env-var prefix before git add (e.g. GIT_COMMITTER_NAME=foo git add .)
  it('G3 match: env-var prefix "GIT_COMMITTER_NAME=foo git add ." writes a fence file', () => {
    const result = runHook({
      command: 'GIT_COMMITTER_NAME=foo git add .',
      env: { SO_WAVE_AGENT: '1' },
      projectDir,
    });
    expect(result.status).toBe(0);
    expect(fenceFiles(projectDir)).toHaveLength(1);
  });
});
