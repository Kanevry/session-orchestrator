/**
 * tests/hooks/enforce-scope.test.mjs
 *
 * Regression tests for hooks/enforce-scope.mjs — PreToolUse Edit/Write scope gate.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin, assert exit code
 * and stdout/stderr for each behavioural case derived from the baseline spec
 * (v3-wave-hooks-baseline.md Part 4) plus security regressions.
 *
 * Issues: #137 (hook implementation), #143–#145 (test migration wave)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/enforce-scope.mjs');

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
 * Optionally creates a src/ subdirectory.
 */
async function mkProject(scope) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-scope-test-'));
  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
  await fs.mkdir(path.join(dir, 'src'), { recursive: true });
  await fs.writeFile(path.join(dir, '.claude/wave-scope.json'), JSON.stringify(scope));
  // init git so project-root detection works the same as production
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
// Helper: build a preToolUse JSON payload for Edit/Write
// ---------------------------------------------------------------------------

function editPayload(filePath, tool = 'Edit') {
  return JSON.stringify({
    tool_name: tool,
    tool_input: { file_path: filePath },
  });
}

// ---------------------------------------------------------------------------
// Tool filter — non-Edit/Write tools are always allowed
// ---------------------------------------------------------------------------

describe('tool filter', { timeout: 15000 }, () => {
  it('exits 0 when tool_name is Bash (not Edit or Write)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
      }),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Allow path — strict mode
// ---------------------------------------------------------------------------

describe('allow path — strict mode', { timeout: 15000 }, () => {
  it('exits 0 when file is inside an allowedPaths directory prefix', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', 'lib/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    expect(result.code).toBe(0);
  });

  it('exits 0 when file matches a recursive glob pattern in a nested subdirectory', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/**/*.tsx'],
    });
    // The directory does NOT need to exist on disk — hook resolves parent dirs
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'components', 'Button.tsx')),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deny path — strict mode
// ---------------------------------------------------------------------------

describe('deny path — strict mode', { timeout: 15000 }, () => {
  it('exits 2 when file is outside allowedPaths in strict mode', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', 'lib/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'unit.test.ts')),
    });
    expect(result.code).toBe(2);
  });

  it('stdout JSON contains permissionDecision deny when path is blocked', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/', 'lib/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'unit.test.ts')),
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('exits 2 when allowedPaths is empty and any file is edited', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'README.md')),
    });
    expect(result.code).toBe(2);
  });

  it('stdout JSON contains permissionDecision deny for empty allowedPaths', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: [],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'README.md')),
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

// ---------------------------------------------------------------------------
// Warn mode
// ---------------------------------------------------------------------------

describe('warn mode', { timeout: 15000 }, () => {
  it('exits 0 when enforcement is warn and file is out-of-scope', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'x.ts')),
    });
    expect(result.code).toBe(0);
  });

  it('writes a warning containing ⚠ to stderr in warn mode', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'warn',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'tests', 'x.ts')),
    });
    expect(result.stderr).toContain('⚠');
  });
});

// ---------------------------------------------------------------------------
// Enforcement off
// ---------------------------------------------------------------------------

describe('enforcement off', { timeout: 15000 }, () => {
  it('exits 0 regardless of file path when enforcement is off', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'off',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'etc', 'something.ts')),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Gate disabled — path-guard=false
// ---------------------------------------------------------------------------

describe('gate disabled — path-guard=false', { timeout: 15000 }, () => {
  it('exits 0 even for out-of-scope files when gates.path-guard is false', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
      gates: { 'path-guard': false },
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'forbidden', 'file.ts')),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// No scope file
// ---------------------------------------------------------------------------

describe('no scope file', { timeout: 15000 }, () => {
  it('exits 0 when .claude/wave-scope.json does not exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-scope-noscope-'));
    tmpDirs.push(dir);
    const { $ } = await import('zx');
    $.verbose = false;
    $.quiet = true;
    await $`git -C ${dir} init -q`;
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Path outside project root
// ---------------------------------------------------------------------------

describe('path outside project root', { timeout: 15000 }, () => {
  it('exits 2 in strict mode when file_path is outside the project root', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload('/etc/passwd'),
    });
    expect(result.code).toBe(2);
  });

  it('stdout JSON contains permissionDecision deny for path outside project root', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload('/etc/passwd'),
    });
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });
});

// ---------------------------------------------------------------------------
// Relative file_path resolved against projectRoot (SECURITY-REQ-06)
// ---------------------------------------------------------------------------

describe('relative file_path resolution — SECURITY-REQ-06', { timeout: 15000 }, () => {
  it('exits 0 for relative path "src/app.ts" resolved against CLAUDE_PROJECT_DIR when in-scope', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload('src/app.ts'),
    });
    expect(result.code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Symlink-escape regression (SECURITY-REQ-03 / F-02)
// ---------------------------------------------------------------------------

describe('symlink-escape regression — SECURITY-REQ-03 / F-02', { timeout: 15000 }, () => {
  it.skipIf(process.platform === 'win32')(
    'exits 2 in strict mode when file_path resolves via symlink to a path outside project root',
    async () => {
      const dir = await mkProjectTracked({
        enforcement: 'strict',
        allowedPaths: ['src/'],
      });
      // Create a symlink inside src/ that points to /etc/passwd
      const symlinkPath = path.join(dir, 'src', 'evil');
      try {
        await fs.symlink('/etc/passwd', symlinkPath);
      } catch {
        // If symlink creation fails (permissions/platform), skip gracefully
        return;
      }
      const result = await runHook({
        projectDir: dir,
        stdin: editPayload(symlinkPath),
      });
      // After realpath resolution /etc/passwd is outside project root → deny
      expect(result.code).toBe(2);
      expect(result.stdout).toContain('"permissionDecision":"deny"');
    },
  );
});

describe('coordinator carveout — #245', { timeout: 15000 }, () => {
  it('allows STATE.md write even when allowedPaths is empty', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: [],
    });
    const statePath = path.join(dir, '.claude', 'STATE.md');
    await fs.writeFile(statePath, '---\nstatus: active\n---\n');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(statePath),
    });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('"permissionDecision":"deny"');
  });

  it('allows STATE.md write when allowedPaths does not include it (strict)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const statePath = path.join(dir, '.claude', 'STATE.md');
    await fs.writeFile(statePath, '---\nstatus: active\n---\n');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(statePath),
    });
    expect(result.code).toBe(0);
  });

  it('allows wave-scope.json write (the manifest the hook itself reads)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const scopePath = path.join(dir, '.claude', 'wave-scope.json');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(scopePath, 'Write'),
    });
    expect(result.code).toBe(0);
  });

  it('does NOT carve out sibling files in .claude/ (narrow allowlist)', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const sibling = path.join(dir, '.claude', 'notes.md');
    await fs.writeFile(sibling, '# notes');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(sibling),
    });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('"permissionDecision":"deny"');
  });

  it('does NOT carve out a file that merely contains STATE.md in its name', async () => {
    const dir = await mkProjectTracked({
      enforcement: 'strict',
      allowedPaths: ['src/'],
    });
    const fake = path.join(dir, '.claude', 'STATE.md.bak');
    await fs.writeFile(fake, 'backup');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(fake),
    });
    expect(result.code).toBe(2);
  });
});
