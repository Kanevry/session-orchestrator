/**
 * tests/hooks/post-edit-validate.test.mjs
 *
 * Tests for hooks/post-edit-validate.mjs — PostToolUse incremental typecheck hook.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin, assert exit code
 * and stderr JSONL shape for each behavioural case from the contract spec.
 *
 * Cases covered (≥7):
 *   1. success — typecheck passes for valid TS file
 *   2. failure — typecheck fails for invalid TS file
 *   3. timeout — typecheck command hangs beyond 2s
 *   4. config-disabled — gates['post-edit-validate'] === false → silent exit 0
 *   5. non-TS file — extension filter skips non-JS/TS files
 *   6. no-typecheck fallback chain — no commands found → status:skip
 *   7. empty stdin — null input → silent exit 0
 *   8. non-Edit/Write tool — Bash tool → silent exit 0
 *   9. file_path missing — malformed input → silent exit 0
 *
 * Issues: #139 (hook implementation)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/post-edit-validate.mjs');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook, pipe stdin JSON, collect stdout/stderr, resolve with exit code.
 * @param {object} opts
 * @param {string} opts.projectDir   - CLAUDE_PROJECT_DIR override
 * @param {string} opts.stdin        - raw stdin string
 * @param {Record<string,string>} [opts.extraEnv] - additional env vars
 */
async function runHook({ projectDir, stdin, extraEnv = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        ...extraEnv,
      },
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
 * Create a minimal temporary project directory with:
 *   - package.json (type: module)
 *   - CLAUDE.md with an optional Session Config block
 *   - .claude/ directory
 *   - optional .claude/wave-scope.json
 *
 * @param {object} opts
 * @param {object|null} [opts.scope]           - wave-scope.json content (null = don't create)
 * @param {string} [opts.claudeMdConfig]       - content to append as ## Session Config block
 * @returns {Promise<string>} absolute path to temp dir
 */
async function mkProject({ scope = null, claudeMdConfig = '' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'post-edit-test-'));

  await fs.mkdir(path.join(dir, '.claude'), { recursive: true });

  // Minimal package.json so npm-based typecheck commands work
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: 'test-project', type: 'module' }, null, 2),
  );

  // CLAUDE.md with optional Session Config section
  const configBlock = claudeMdConfig
    ? `\n## Session Config\n${claudeMdConfig}\n`
    : '';
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), `# Test Project${configBlock}`);

  if (scope !== null) {
    await fs.writeFile(
      path.join(dir, '.claude/wave-scope.json'),
      JSON.stringify(scope),
    );
  }

  return dir;
}

/**
 * Build a PostToolUse JSON payload for Edit/Write.
 * @param {string} filePath
 * @param {'Edit'|'Write'} [tool]
 */
function editPayload(filePath, tool = 'Edit') {
  return JSON.stringify({
    tool_name: tool,
    tool_input: { file_path: filePath },
    tool_result: '',
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

async function mkProjectTracked(opts) {
  const dir = await mkProject(opts);
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Helper: create a fake typecheck script that always exits 0 (pass) or 1 (fail)
// ---------------------------------------------------------------------------

/**
 * Write a tiny shell/node script to dir that exits with given code.
 * Returns absolute path to the script.
 *
 * On Windows, writes a .cmd file; on POSIX, a shebang'd .mjs.
 */
async function mkTypecheckScript(dir, exitCode) {
  const scriptPath = path.join(dir, 'fake-tc.mjs');
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env node\nprocess.exit(${exitCode});\n`,
    { mode: 0o755 },
  );
  return scriptPath;
}

/**
 * Write a fake typecheck script that sleeps longer than 2s (for timeout test).
 */
async function mkSlowScript(dir) {
  const scriptPath = path.join(dir, 'slow-tc.mjs');
  await fs.writeFile(
    scriptPath,
    `#!/usr/bin/env node\nsetTimeout(() => process.exit(0), 5000);\n`,
    { mode: 0o755 },
  );
  return scriptPath;
}

// ---------------------------------------------------------------------------
// Case 1: empty stdin → silent exit 0
// ---------------------------------------------------------------------------

describe('empty stdin', { timeout: 10000 }, () => {
  it('exits 0 silently when stdin is empty', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: '' });
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Case 2: non-Edit/Write tool → silent exit 0
// ---------------------------------------------------------------------------

describe('tool filter — non-Edit/Write', { timeout: 10000 }, () => {
  it('exits 0 without any stderr output for Bash tool', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'echo hi' },
        tool_result: 'hi',
      }),
    });
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Case 3: non-TS file → silent exit 0
// ---------------------------------------------------------------------------

describe('file extension filter — non-TS/JS file', { timeout: 10000 }, () => {
  it('exits 0 without stderr output for .md file', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'README.md')),
    });
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });

  it('exits 0 without stderr output for .sh file', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'deploy.sh')),
    });
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });

  it('exits 0 without stderr output for .json file', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'config.json')),
    });
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Case 4: file_path missing → silent exit 0
// ---------------------------------------------------------------------------

describe('missing file_path', { timeout: 10000 }, () => {
  it('exits 0 when tool_input.file_path is absent', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ tool_name: 'Edit', tool_input: {}, tool_result: '' }),
    });
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Case 5: gate disabled → silent exit 0
// ---------------------------------------------------------------------------

describe('gate disabled — post-edit-validate=false', { timeout: 10000 }, () => {
  it('exits 0 without any stderr output when gate is disabled', async () => {
    const dir = await mkProjectTracked({
      scope: { gates: { 'post-edit-validate': false } },
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    expect(result.code).toBe(0);
    expect(result.stderr.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Case 6: no typecheck command found → status:skip
// ---------------------------------------------------------------------------

describe('no typecheck command → status:skip', { timeout: 10000 }, () => {
  it('emits {"check":"typecheck","status":"skip",...} to stderr and exits 0', async () => {
    // Set typecheck-command: none in Session Config so config.mjs returns null,
    // AND use a minimal PATH so tsgo/tsc/npx are not found on disk.
    // config.mjs _coerceString returns null for "none" values.
    const dir = await mkProjectTracked({
      claudeMdConfig: 'typecheck-command: none',
    });
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
      // Isolate PATH so no tsgo/tsc/npx is found as fallback
      extraEnv: { PATH: '/usr/bin:/bin' },
    });
    expect(result.code).toBe(0);

    // stderr must contain a valid JSON line with status:skip
    const lines = result.stderr.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.check).toBe('typecheck');
    expect(parsed.status).toBe('skip');
    expect(typeof parsed.file).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Case 7: typecheck passes → status:pass
// ---------------------------------------------------------------------------

describe('typecheck passes → status:pass', { timeout: 15000 }, () => {
  it('emits JSONL with status:pass and numeric duration_ms when typecheck exits 0', async () => {
    const dir = await mkProjectTracked();
    const scriptPath = await mkTypecheckScript(dir, 0);

    // Configure Session Config to use our fake script
    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ${process.execPath} ${scriptPath}\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });

    expect(result.code).toBe(0);

    const lines = result.stderr.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.check).toBe('typecheck');
    expect(parsed.status).toBe('pass');
    expect(typeof parsed.file).toBe('string');
    expect(typeof parsed.duration_ms).toBe('number');
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Case 8: typecheck fails → status:fail
// ---------------------------------------------------------------------------

describe('typecheck fails → status:fail', { timeout: 15000 }, () => {
  it('emits JSONL with status:fail and numeric duration_ms when typecheck exits non-zero', async () => {
    const dir = await mkProjectTracked();
    const scriptPath = await mkTypecheckScript(dir, 1);

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ${process.execPath} ${scriptPath}\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'broken.ts')),
    });

    expect(result.code).toBe(0);

    const lines = result.stderr.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.check).toBe('typecheck');
    expect(parsed.status).toBe('fail');
    expect(typeof parsed.file).toBe('string');
    expect(typeof parsed.duration_ms).toBe('number');
    expect(parsed.duration_ms).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Case 9: typecheck timeout → exits 0 (never blocks)
// ---------------------------------------------------------------------------

describe('typecheck timeout — never blocks', { timeout: 15000 }, () => {
  it('exits 0 within a reasonable time even when typecheck hangs', async () => {
    const dir = await mkProjectTracked();
    const scriptPath = await mkSlowScript(dir);

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ${process.execPath} ${scriptPath}\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

    const start = Date.now();
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    const elapsed = Date.now() - start;

    expect(result.code).toBe(0);
    // Should complete well within 10s (2s timeout + process overhead)
    expect(elapsed).toBeLessThan(10000);

    // Should still emit a JSONL line (pass or fail — timeout resolves to fail)
    const lines = result.stderr.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.check).toBe('typecheck');
    expect(['pass', 'fail']).toContain(parsed.status);
    expect(typeof parsed.duration_ms).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Case 10: JSONL shape contract — relative file path
// ---------------------------------------------------------------------------

describe('JSONL shape — relative file path', { timeout: 15000 }, () => {
  it('file field is relative to project root (not absolute)', async () => {
    const dir = await mkProjectTracked();
    const scriptPath = await mkTypecheckScript(dir, 0);

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ${process.execPath} ${scriptPath}\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

    const absFile = path.join(dir, 'src', 'index.ts');
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(absFile),
    });

    const lines = result.stderr.split('\n').filter(l => l.trim());
    const parsed = JSON.parse(lines[0]);
    // Must not be an absolute path
    expect(path.isAbsolute(parsed.file)).toBe(false);
    expect(parsed.file).toBe(path.join('src', 'index.ts'));
  });
});

// ---------------------------------------------------------------------------
// Case 11: Write tool also triggers (not just Edit)
// ---------------------------------------------------------------------------

describe('Write tool triggers typecheck', { timeout: 15000 }, () => {
  it('emits JSONL on stderr when tool_name is Write', async () => {
    const dir = await mkProjectTracked();
    const scriptPath = await mkTypecheckScript(dir, 0);

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ${process.execPath} ${scriptPath}\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'new-file.ts'), 'Write'),
    });

    expect(result.code).toBe(0);
    const lines = result.stderr.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.check).toBe('typecheck');
    expect(parsed.status).toBe('pass');
  });
});

// ---------------------------------------------------------------------------
// Case 12: .mjs extension triggers typecheck
// ---------------------------------------------------------------------------

describe('.mjs extension triggers typecheck', { timeout: 15000 }, () => {
  it('emits JSONL on stderr for .mjs file', async () => {
    const dir = await mkProjectTracked();
    const scriptPath = await mkTypecheckScript(dir, 0);

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ${process.execPath} ${scriptPath}\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'scripts', 'helper.mjs')),
    });

    expect(result.code).toBe(0);
    const lines = result.stderr.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.check).toBe('typecheck');
    expect(typeof parsed.duration_ms).toBe('number');
  });
});
