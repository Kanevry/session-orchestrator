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
 *   8. non-Edit/Write/MultiEdit tool — Bash tool → silent exit 0
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
async function runHook({ projectDir, stdin, extraEnv = {}, nodeArgs = [] }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, HOOK], {
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
 * Build a PostToolUse JSON payload for Edit/Write/MultiEdit.
 * @param {string} filePath
 * @param {'Edit'|'Write'|'MultiEdit'} [tool]
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
 * Write a tiny node script to dir that exits with given code.
 * Returns absolute path to the script. Every caller runs it as
 * `${process.execPath} <script>`, so it needs neither a shebang nor an exec bit.
 */
async function mkTypecheckScript(dir, exitCode) {
  const scriptPath = path.join(dir, 'fake-tc.mjs');
  await fs.writeFile(scriptPath, `process.exit(${exitCode});\n`);
  return scriptPath;
}

/**
 * Write a fake typecheck script that sleeps longer than 2s (for timeout test).
 */
async function mkSlowScript(dir) {
  const scriptPath = path.join(dir, 'slow-tc.mjs');
  await fs.writeFile(scriptPath, `setTimeout(() => process.exit(0), 5000);\n`);
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
// Case 2: non-Edit/Write/MultiEdit tool → silent exit 0
// ---------------------------------------------------------------------------

describe('tool filter — non-Edit/Write/MultiEdit', { timeout: 10000 }, () => {
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
  it.each(['.md', '.sh', '.json'])('exits 0 without stderr output for %s file', async (extension) => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, `ignored${extension}`)),
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
    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ""${process.execPath}" "${scriptPath}""\n`;
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

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ""${process.execPath}" "${scriptPath}""\n`;
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
  it('reports timeout rather than failure and stays within the 5s hook budget', async () => {
    const dir = await mkProjectTracked();
    const scriptPath = await mkSlowScript(dir);

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ""${process.execPath}" "${scriptPath}""\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

    const start = Date.now();
    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', 'app.ts')),
    });
    const elapsed = Date.now() - start;

    expect(result.code).toBe(0);
    // Must finish before the outer 5s hook budget.
    expect(elapsed).toBeLessThan(5000);

    // Timeout has its own observable status.
    const lines = result.stderr.split('\n').filter(l => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.check).toBe('typecheck');
    expect(parsed.status).toBe('timeout');
    expect(parsed.reason).toBe('typecheck timed out after 2s');
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

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ""${process.execPath}" "${scriptPath}""\n`;
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
// Case 11: every edit-shaped tool triggers typecheck
// ---------------------------------------------------------------------------

describe('edit-shaped tools trigger typecheck', { timeout: 15000 }, () => {
  it.each([
    ['Write', 'new-file.ts'],
    ['MultiEdit', 'edited-file.ts'],
  ])('emits JSONL on stderr when tool_name is %s', async (tool, fileName) => {
    const dir = await mkProjectTracked();
    const scriptPath = await mkTypecheckScript(dir, 0);

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ""${process.execPath}" "${scriptPath}""\n`;
    await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

    const result = await runHook({
      projectDir: dir,
      stdin: editPayload(path.join(dir, 'src', fileName), tool),
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

    const claudeMd = `# Test\n\n## Session Config\ntypecheck-command: ""${process.execPath}" "${scriptPath}""\n`;
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

describe("gate toggle — a PEER's manifest cannot disable this session's gate (#1504)", { timeout: 10000 }, () => {
  it("runs the check when only a peer's manifest sets post-edit-validate=false", async () => {
    // Bug caught: findScopeFile() took the first manifest that exists, so a
    // peer session's `gates['post-edit-validate']: false` silenced this
    // session's post-edit typecheck.
    const dir = await mkProjectTracked({
      scope: { session_id: 'peer-session-zz', gates: { 'post-edit-validate': false } },
      claudeMdConfig: 'typecheck-command: none',
    });
    const payload = JSON.parse(editPayload(path.join(dir, 'src', 'app.ts')));
    const result = await runHook({
      projectDir: dir,
      stdin: JSON.stringify({ ...payload, session_id: 'own-session-aa' }),
      extraEnv: { PATH: '/usr/bin:/bin' },
    });
    expect(result.code).toBe(0);
    const lines = result.stderr.split('\n').filter((l) => l.trim());
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(JSON.parse(lines[0]).status).toBe('skip');
  });
});

// Quoted executable/script paths must survive the real config-to-shell boundary.
// Session Config removes one surrounding double-quote pair from the value.
describe('configured command with spaces', () => {
  it.each([0, 1])('executes a quoted script in a b and reports exit %s correctly', async (exitCode) => {
    const dir = await mkProjectTracked();
    const scriptDir = path.join(dir, 'a b');
    await fs.mkdir(scriptDir);
    const script = await mkTypecheckScript(scriptDir, exitCode);
    await fs.writeFile(script, `process.stderr.write('script in a b executed\\n'); process.exit(${exitCode});`);
    await fs.writeFile(path.join(dir, 'CLAUDE.md'),
      `# Test\n\n## Session Config\ntypecheck-command: ""${process.execPath}" "${script}""\n`);
    const result = await runHook({ projectDir: dir, stdin: editPayload(path.join(dir, 'app.ts')) });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stderr.trim());
    expect(parsed.status).toBe(exitCode === 0 ? 'pass' : 'fail');
    if (exitCode !== 0) expect(parsed.reason).toBe('script in a b executed');
  });
});

// #1612: simulate PATH with npx available, but no compiler. Intercept npx
// before spawning so the regression can NEVER contact the registry.
async function instrumentCompilerDiscovery(dir) {
  const preload = path.join(dir, 'discovery.mjs');
  const marker = path.join(dir, 'spawned.jsonl');
  await fs.writeFile(preload, `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { appendFileSync } from 'node:fs';
    const originalSync = cp.spawnSync;
    const originalSpawn = cp.spawn;
    cp.spawnSync = (cmd, args, opts) => {
      if (cmd === 'which' || cmd === 'where.exe') {
        return { status: args[0] === 'npx' ? 0 : 1, stdout: args[0] === 'npx' ? 'npx' : '' };
      }
      return originalSync(cmd, args, opts);
    };
    cp.spawn = (cmd, ...args) => {
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify(cmd) + '\\n');
      if (/\\bnpx\\b/.test(cmd)) throw new Error('npx spawn forbidden (#1612)');
      return originalSpawn(cmd, ...args);
    };
    syncBuiltinESMExports();
  `);
  return { preload, marker };
}

it('without node_modules skips even when npx exists, and never spawns npx (#1612)', async () => {
  const dir = await mkProjectTracked({ claudeMdConfig: 'typecheck-command: none' });
  const { preload, marker } = await instrumentCompilerDiscovery(dir);
  const result = await runHook({ projectDir: dir, stdin: editPayload(path.join(dir, 'app.ts')), nodeArgs: ['--import', preload] });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('"status":"skip"');
  await expect(fs.access(marker)).rejects.toThrow();
});

it('R1-07 runs the local Node compiler from a literal percent and space path', async () => {
  const parent = await mkProjectTracked({ claudeMdConfig: 'typecheck-command: none' });
  const dir = path.join(parent, '%USERNAME% with spaces');
  await fs.mkdir(dir);
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), '# Project\n## Session Config\ntypecheck-command: none\n');
  const { preload, marker } = await instrumentCompilerDiscovery(parent);
  const bin = path.join(dir, 'node_modules', 'typescript', 'bin');
  await fs.mkdir(bin, { recursive: true });
  const compiler = path.join(bin, 'tsc');
  await fs.writeFile(compiler, "if (process.argv[2] !== '--noEmit') process.exit(1);\n");
  const result = await runHook({ projectDir: dir, stdin: editPayload(path.join(dir, 'app.ts')), nodeArgs: ['--import', preload] });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain('"status":"pass"');
  expect(JSON.parse((await fs.readFile(marker, 'utf8')).trim())).toBe(process.execPath);
});

it.each([null, 0])('R1-04 post-edit Windows timeout avoids CIM for child exitCode %s', async exitCode => {
  const dir = await mkProjectTracked({ claudeMdConfig: 'typecheck-command: fixture-typecheck' });
  const preload = path.join(dir, 'windows-budget.mjs');
  const marker = path.join(dir, 'native-calls.jsonl');
  await fs.writeFile(preload, `
    import cp from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    import { EventEmitter } from 'node:events';
    import { PassThrough } from 'node:stream';
    import { appendFileSync } from 'node:fs';
    Object.defineProperty(process, 'platform', { value: 'win32' });
    cp.spawn = () => {
      const child = new EventEmitter();
      child.pid = 999999; child.exitCode = ${JSON.stringify(exitCode)}; child.signalCode = null;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      setInterval(() => {}, 1000);
      return child;
    };
    cp.spawnSync = (file, args) => {
      appendFileSync(${JSON.stringify(marker)}, JSON.stringify({ file, args }) + '\\n');
      if (/powershell/i.test(file)) throw Error('CIM violates hook budget');
      return { status: 0 };
    };
    syncBuiltinESMExports();
  `);
  const result = await runHook({ projectDir: dir, stdin: editPayload(path.join(dir, 'app.ts')), nodeArgs: ['--import', preload] });
  expect(result.code, result.stderr).toBe(0);
  expect(result.stderr).toContain('"status":"timeout"');
  const calls = await fs.readFile(marker, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return '';
    throw error;
  });
  expect(calls).not.toMatch(/powershell/i);
  expect(calls.trim().split('\n').filter(Boolean).map(line => JSON.parse(line).args))
    .toEqual(exitCode === null ? [['/PID', '999999', '/T', '/F']] : []);
});
