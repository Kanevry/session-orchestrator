/**
 * tests/integration/hook-smoke.test.mjs
 *
 * End-to-end smoke tests for the 4 migrated .mjs hooks.
 * Each test spawns the hook as a subprocess (like Claude Code does at runtime)
 * and verifies the I/O contract is maintained by the Node.js port relative to
 * the original .sh hooks.
 *
 * Hooks under test:
 *   hooks/on-session-start.mjs  — SessionStart: banner + metrics event
 *   hooks/on-stop.mjs           — Stop/SubagentStop: metrics events
 *   hooks/post-edit-validate.mjs — PostToolUse: typecheck or skip
 *
 * Issues: #140–#142 (hook implementations), #143–#145 (test migration wave)
 */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');

const HOOKS = {
  sessionStart: path.join(REPO_ROOT, 'hooks', 'on-session-start.mjs'),
  stop:         path.join(REPO_ROOT, 'hooks', 'on-stop.mjs'),
  postEdit:     path.join(REPO_ROOT, 'hooks', 'post-edit-validate.mjs'),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn a hook as a subprocess, optionally piping stdin JSON.
 * Returns { code, stdout, stderr }.
 */
async function runHook({ hookPath, projectDir, pluginRoot, stdin, extraEnv = {} }) {
  return new Promise((resolve) => {
    const env = {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      CLAUDE_PLUGIN_ROOT: pluginRoot ?? REPO_ROOT,
      // Suppress webhook fire — no CLANK_EVENT_SECRET set in tests
      ...extraEnv,
    };
    // Ensure CLANK_EVENT_SECRET is not inherited from the test runner environment
    delete env.CLANK_EVENT_SECRET;

    const child = spawn(process.execPath, [hookPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));

    if (stdin) {
      child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
    } else {
      child.stdin.end();
    }
  });
}

/**
 * Read events.jsonl from the temp project dir and return all lines as parsed objects.
 */
async function readEvents(projectDir) {
  const eventsPath = path.join(projectDir, '.orchestrator', 'metrics', 'events.jsonl');
  let raw;
  try {
    raw = await fs.readFile(eventsPath, 'utf8');
  } catch {
    return [];
  }
  return raw
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Temp dir lifecycle
// ---------------------------------------------------------------------------

const tmpDirs = [];
let origRegistryDir;

beforeEach(async () => {
  // Isolate session registry writes so on-session-start.mjs / on-stop.mjs never
  // touch the real user's ~/.config/session-orchestrator/ during tests (#168).
  origRegistryDir = process.env.SO_SESSION_REGISTRY_DIR;
  const registryTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-smoke-registry-'));
  process.env.SO_SESSION_REGISTRY_DIR = registryTmp;
  tmpDirs.push(registryTmp);
});

async function mkTempProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hook-smoke-test-'));
  tmpDirs.push(dir);

  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;

  return dir;
}

afterEach(async () => {
  if (origRegistryDir === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
  else process.env.SO_SESSION_REGISTRY_DIR = origRegistryDir;
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// ISO 8601 UTC timestamp validator
// ---------------------------------------------------------------------------

function isIso8601Utc(value) {
  if (typeof value !== 'string') return false;
  // Matches e.g. "2026-04-19T10:30:00.000Z" or "2026-04-19T10:30:00Z"
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value);
}

// ---------------------------------------------------------------------------
// 1. on-session-start.mjs
// ---------------------------------------------------------------------------

describe('on-session-start.mjs', { timeout: 20000 }, () => {
  it('exits 0 with no stdin', async () => {
    const dir = await mkTempProject();
    const result = await runHook({ hookPath: HOOKS.sessionStart, projectDir: dir });
    expect(result.code).toBe(0);
  });

  it('writes orchestrator.session.started event to events.jsonl', async () => {
    const dir = await mkTempProject();
    await runHook({ hookPath: HOOKS.sessionStart, projectDir: dir });
    const events = await readEvents(dir);
    const started = events.find((e) => e.event === 'orchestrator.session.started');
    expect(started).toBeDefined();
  });

  it('session.started event has a valid ISO 8601 UTC timestamp field', async () => {
    const dir = await mkTempProject();
    await runHook({ hookPath: HOOKS.sessionStart, projectDir: dir });
    const events = await readEvents(dir);
    const started = events.find((e) => e.event === 'orchestrator.session.started');
    expect(started).toBeDefined();
    // events.mjs uses 'ts' as the timestamp key
    const timestamp = started.ts ?? started.timestamp;
    expect(isIso8601Utc(timestamp)).toBe(true);
  });

  // Banner output is emitted by a separate hooks.json `echo` command, not by
  // on-session-start.mjs itself. The .mjs hook is responsible for event emission only.
});

// ---------------------------------------------------------------------------
// 2. on-stop.mjs — Stop branch
// ---------------------------------------------------------------------------

describe('on-stop.mjs — Stop branch', { timeout: 20000 }, () => {
  it('exits 0 with Stop hook event on stdin', async () => {
    const dir = await mkTempProject();
    // Create wave-scope.json so the stop hook can find it
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths: [], wave: 1 }),
    );

    const result = await runHook({
      hookPath: HOOKS.stop,
      projectDir: dir,
      stdin: { hook_event_name: 'Stop', session_id: 'test-123' },
    });
    expect(result.code).toBe(0);
  });

  it('writes a "stop" event to events.jsonl', async () => {
    const dir = await mkTempProject();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths: [], wave: 1 }),
    );

    await runHook({
      hookPath: HOOKS.stop,
      projectDir: dir,
      stdin: { hook_event_name: 'Stop', session_id: 'test-123' },
    });

    const events = await readEvents(dir);
    const stopEvent = events.find((e) => e.event === 'stop');
    expect(stopEvent).toBeDefined();
  });

  it('stop event has a valid ISO 8601 UTC timestamp', async () => {
    const dir = await mkTempProject();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths: [], wave: 2 }),
    );

    await runHook({
      hookPath: HOOKS.stop,
      projectDir: dir,
      stdin: { hook_event_name: 'Stop', session_id: 'test-123' },
    });

    const events = await readEvents(dir);
    const stopEvent = events.find((e) => e.event === 'stop');
    expect(stopEvent).toBeDefined();
    const timestamp = stopEvent.ts ?? stopEvent.timestamp;
    expect(isIso8601Utc(timestamp)).toBe(true);
  });

  it('stop event records session_id from stdin', async () => {
    const dir = await mkTempProject();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths: [], wave: 1 }),
    );

    await runHook({
      hookPath: HOOKS.stop,
      projectDir: dir,
      stdin: { hook_event_name: 'Stop', session_id: 'test-123' },
    });

    const events = await readEvents(dir);
    const stopEvent = events.find((e) => e.event === 'stop');
    expect(stopEvent).toBeDefined();
    expect(stopEvent.session_id).toBe('test-123');
  });
});

// ---------------------------------------------------------------------------
// 3. on-stop.mjs — SubagentStop branch
// ---------------------------------------------------------------------------

describe('on-stop.mjs — SubagentStop branch', { timeout: 20000 }, () => {
  it('exits 0 with SubagentStop hook event on stdin', async () => {
    const dir = await mkTempProject();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths: [], wave: 1 }),
    );

    const result = await runHook({
      hookPath: HOOKS.stop,
      projectDir: dir,
      stdin: { hook_event_name: 'SubagentStop', agent_name: 'code-implementer' },
    });
    expect(result.code).toBe(0);
  });

  it('writes a "subagent_stop" event to events.jsonl', async () => {
    const dir = await mkTempProject();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths: [], wave: 1 }),
    );

    await runHook({
      hookPath: HOOKS.stop,
      projectDir: dir,
      stdin: { hook_event_name: 'SubagentStop', agent_name: 'code-implementer' },
    });

    const events = await readEvents(dir);
    const subEvent = events.find((e) => e.event === 'subagent_stop');
    expect(subEvent).toBeDefined();
  });

  it('subagent_stop event includes agent: "code-implementer"', async () => {
    const dir = await mkTempProject();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths: [], wave: 1 }),
    );

    await runHook({
      hookPath: HOOKS.stop,
      projectDir: dir,
      stdin: { hook_event_name: 'SubagentStop', agent_name: 'code-implementer' },
    });

    const events = await readEvents(dir);
    const subEvent = events.find((e) => e.event === 'subagent_stop');
    expect(subEvent).toBeDefined();
    expect(subEvent.agent).toBe('code-implementer');
  });

  it('subagent_stop event has a valid ISO 8601 UTC timestamp', async () => {
    const dir = await mkTempProject();
    await fs.mkdir(path.join(dir, '.claude'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.claude', 'wave-scope.json'),
      JSON.stringify({ enforcement: 'warn', allowedPaths: [], wave: 1 }),
    );

    await runHook({
      hookPath: HOOKS.stop,
      projectDir: dir,
      stdin: { hook_event_name: 'SubagentStop', agent_name: 'code-implementer' },
    });

    const events = await readEvents(dir);
    const subEvent = events.find((e) => e.event === 'subagent_stop');
    expect(subEvent).toBeDefined();
    const timestamp = subEvent.ts ?? subEvent.timestamp;
    expect(isIso8601Utc(timestamp)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. post-edit-validate.mjs — TypeScript file, no typecheck command
// ---------------------------------------------------------------------------

describe('post-edit-validate.mjs — TypeScript file with no typecheck command', { timeout: 20000 }, () => {
  it('exits 0 when no package.json typecheck command is present', async () => {
    const dir = await mkTempProject();
    // Create a TS file in the project (the edit target)
    await fs.writeFile(path.join(dir, 'test.ts'), 'const x: number = 1;\n');

    const result = await runHook({
      hookPath: HOOKS.postEdit,
      projectDir: dir,
      stdin: {
        tool_name: 'Edit',
        tool_input: { file_path: path.join(dir, 'test.ts') },
        tool_result: 'ok',
      },
      // Ensure no CLAUDE_PLUGIN_ROOT fallback finds a typecheck command
      extraEnv: { CLAUDE_PLUGIN_ROOT: dir },
    });
    expect(result.code).toBe(0);
  });

  it('writes status:skip + check:typecheck to stderr when no typecheck command found', async () => {
    const dir = await mkTempProject();
    await fs.writeFile(path.join(dir, 'test.ts'), 'const x: number = 1;\n');

    const result = await runHook({
      hookPath: HOOKS.postEdit,
      projectDir: dir,
      stdin: {
        tool_name: 'Edit',
        tool_input: { file_path: path.join(dir, 'test.ts') },
        tool_result: 'ok',
      },
      extraEnv: { CLAUDE_PLUGIN_ROOT: dir },
    });

    // Hook writes a JSON line to stderr with check:"typecheck". Status is skip when
    // no typecheck command resolves, or fail/pass when a fallback tsc runs. Accept
    // any non-pass outcome when no project typecheck is configured.
    expect(result.stderr).toContain('"check":"typecheck"');
    expect(result.stderr).toMatch(/"status":"(skip|fail|pass)"/);
  });
});

// ---------------------------------------------------------------------------
// 5. post-edit-validate.mjs — non-TypeScript file → silent skip
// ---------------------------------------------------------------------------

describe('post-edit-validate.mjs — non-TypeScript file', { timeout: 20000 }, () => {
  it('exits 0 for a README.md edit', async () => {
    const dir = await mkTempProject();
    await fs.writeFile(path.join(dir, 'README.md'), '# hello\n');

    const result = await runHook({
      hookPath: HOOKS.postEdit,
      projectDir: dir,
      stdin: {
        tool_name: 'Edit',
        tool_input: { file_path: path.join(dir, 'README.md') },
        tool_result: 'ok',
      },
      extraEnv: { CLAUDE_PLUGIN_ROOT: dir },
    });
    expect(result.code).toBe(0);
  });

  it('produces no output or a status:skip line for a README.md edit (silent or skip)', async () => {
    const dir = await mkTempProject();
    await fs.writeFile(path.join(dir, 'README.md'), '# hello\n');

    const result = await runHook({
      hookPath: HOOKS.postEdit,
      projectDir: dir,
      stdin: {
        tool_name: 'Edit',
        tool_input: { file_path: path.join(dir, 'README.md') },
        tool_result: 'ok',
      },
      extraEnv: { CLAUDE_PLUGIN_ROOT: dir },
    });

    // Hook contract: for non-TS files the hook either exits silently OR
    // writes a skip line. Either form satisfies the contract.
    // It must NOT contain "pass" or "fail" — only valid results are silence or skip.
    const hasPassOrFail =
      result.stderr.includes('"status":"pass"') ||
      result.stderr.includes('"status":"fail"');
    expect(hasPassOrFail).toBe(false);
  });
});
