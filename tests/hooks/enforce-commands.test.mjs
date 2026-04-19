/**
 * tests/hooks/enforce-commands.test.mjs
 *
 * Regression tests for hooks/enforce-commands.mjs — PreToolUse Bash command gate.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin, assert exit code
 * and stdout/stderr for each behavioural case derived from the baseline spec
 * (v3-wave-hooks-baseline.md Part 2) plus F-01 shell-operator bypass regressions.
 *
 * Issues: #138 (hook implementation), #143–#145 (test migration wave)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/enforce-commands.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook, pipe stdin JSON, collect stdout/stderr, resolve with exit code.
 */
async function runHook({ projectDir, stdin }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/**
 * Create a temporary project directory with a .claude/wave-scope.json and a git repo.
 */
async function mkProject(scope) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-cmd-test-'));
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/wave-scope.json'), JSON.stringify(scope));
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;
  return dir;
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

async function mkProjectTracked(scope) {
  const dir = await mkProject(scope);
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Helper: build a preToolUse JSON payload for Bash
// ---------------------------------------------------------------------------

function bashPayload(command) {
  return JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command },
  });
}

// ---------------------------------------------------------------------------
// Tool filter — non-Bash tools are always allowed
// ---------------------------------------------------------------------------

describe('tool filter', { timeout: 15000 }, () => {
  it('exits 0 when tool_name is Edit (not Bash)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        tool_name: 'Edit',
        tool_input: { file_path: 'src/app.ts' },
      }),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Explicit blockedCommands — strict mode
// ---------------------------------------------------------------------------

describe('explicit blockedCommands — strict mode', { timeout: 15000 }, () => {
  it('exits 0 when command does not match any blocked pattern', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls -la'),
    });
    expect(result.code).toBe(0);
  });

  it('exits 2 when command matches a blocked pattern', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(2);
  });

  it('stdout JSON contains permissionDecision deny when command is blocked', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('exits 0 for "rm-rf /home" — word boundary prevents false positive match', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    // "rm-rf" is a different token from "rm -rf", should NOT match
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm-rf /home'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Warn mode
// ---------------------------------------------------------------------------

describe('warn mode', { timeout: 15000 }, () => {
  it('exits 0 when enforcement is warn even if command matches a blocked pattern', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(0);
  });

  it('writes a warning containing ⚠ to stderr in warn mode', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.stderr).toContain('⚠');
  });
});

// ---------------------------------------------------------------------------
// Enforcement off
// ---------------------------------------------------------------------------

describe('enforcement off', { timeout: 15000 }, () => {
  it('exits 0 regardless of blocked command when enforcement is off', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'off',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gate disabled — command-guard=false
// ---------------------------------------------------------------------------

describe('gate disabled — command-guard=false', { timeout: 15000 }, () => {
  it('exits 0 even for blocked command when gates.command-guard is false', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
      gates: { 'command-guard': false },
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Fallback blocklist (empty blockedCommands)
// ---------------------------------------------------------------------------

describe('fallback blocklist — empty blockedCommands', { timeout: 15000 }, () => {
  it('exits 2 for "git push --force" via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push --force origin main'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "git push -f" short form via fallback blocklist (#138)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push -f origin main'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "git reset --hard" via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "DROP TABLE" (uppercase) via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('psql -c "DROP TABLE users"'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "drop table" (lowercase) via fallback blocklist (#138)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('psql -c "drop table users"'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for "git checkout -- ." via fallback blocklist', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git checkout -- .'),
    });
    expect(result.code).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// F-01 regression — shell-operator bypass attempts
//
// Attackers may try to hide a blocked command inside a shell operator sequence.
// The hook must detect the blocked pattern anywhere in the full command string,
// not only at the top level.
// ---------------------------------------------------------------------------

describe('F-01 regression — shell-operator bypass', { timeout: 15000 }, () => {
  it('exits 2 for semicolon-chained command: "ls;rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls;rm -rf /'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for && chained command: "ls&&rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls&&rm -rf /'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for || chained command: "ls||rm -rf /"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls||rm -rf /'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for subshell: "(rm -rf /)"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('(rm -rf /)'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for backtick substitution: "`rm -rf /`"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('`rm -rf /`'),
    });
    expect(result.code).toBe(2);
  });

  it('exits 2 for dollar-paren substitution: "$(rm -rf /)"', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      blockedCommands: ['rm -rf'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('$(rm -rf /)'),
    });
    expect(result.code).toBe(2);
  });
});
