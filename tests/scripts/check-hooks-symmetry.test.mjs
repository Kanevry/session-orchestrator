/**
 * tests/scripts/check-hooks-symmetry.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-hooks-symmetry.mjs.
 * Spawns the script as a child process and verifies exit codes + stdout shape.
 *
 * Non-happy-path tests use synthetic fixture directories built with mkdtempSync.
 * Only the "real plugin" test exercises the actual hooks/ directory.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../scripts/lib/validate/check-hooks-symmetry.mjs',
);
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Normalize CRLF → LF so Windows spawnSync output matches Linux/macOS in
// string assertions (.toContain / .split('\n') / regex match). No-op on LF.
const norm = (s) => (s ?? '').replace(/\r\n/g, '\n');

function runValidator(pluginRoot) {
  const r = spawnSync(process.execPath, [SCRIPT, pluginRoot], { encoding: 'utf8', timeout: 15_000 });
  // Normalize stdout/stderr in-place so all downstream string assertions
  // (`.toContain` / `.split('\n')` / regex) are CRLF-safe on Windows.
  return { ...r, stdout: norm(r.stdout), stderr: norm(r.stderr) };
}

/**
 * Creates a temp dir with a hooks/ subdir.
 * Returns the temp dir path; caller is responsible for cleanup.
 */
function makeFixtureDir() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-hooks-symmetry-'));
  mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  return dir;
}

/**
 * Writes hooks/hooks.json, hooks/hooks-codex.json, and optionally hooks/hooks-cursor.json
 * into a fixture directory using the Claude/Codex event-object shape.
 *
 * Each event key maps to an array of matchers, each with a hooks array whose
 * command references hooks/<handler>.
 */
function writeHooksJsons(dir, { claude, codex, cursor } = {}) {
  const hooksDir = path.join(dir, 'hooks');

  if (claude !== undefined) {
    writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(claude));
  }
  if (codex !== undefined) {
    writeFileSync(path.join(hooksDir, 'hooks-codex.json'), JSON.stringify(codex));
  }
  if (cursor !== undefined) {
    writeFileSync(path.join(hooksDir, 'hooks-cursor.json'), JSON.stringify(cursor));
  }
}

/**
 * Builds a minimal valid Claude/Codex hooks JSON object whose events point at
 * the given handler filenames (relative, e.g. 'my-handler.mjs').
 */
function buildClaudeHooks(events) {
  const hooks = {};
  for (const [eventName, handler] of Object.entries(events)) {
    hooks[eventName] = [
      {
        matcher: 'startup',
        hooks: [
          {
            type: 'command',
            command: `node "$CLAUDE_PLUGIN_ROOT/hooks/${handler}"`,
          },
        ],
      },
    ];
  }
  return { hooks };
}

/**
 * Builds a minimal valid Cursor hooks JSON object.
 */
function buildCursorHooks(events) {
  const hooks = {};
  for (const [eventName, handler] of Object.entries(events)) {
    hooks[eventName] = { script: `hooks/${handler}` };
  }
  return { hooks };
}

// ---------------------------------------------------------------------------
// Real-plugin happy path
// ---------------------------------------------------------------------------

describe('check-hooks-symmetry.mjs — real plugin root', () => {
  it('exits 0 against the current plugin repo', () => {
    const r = runValidator(PLUGIN_ROOT);
    expect(r.status).toBe(0);
  });

  it('emits at least 4 PASS lines (one per check)', () => {
    const r = runValidator(PLUGIN_ROOT);
    const passLines = r.stdout.split('\n').filter((l) => l.startsWith('  PASS:'));
    expect(passLines.length).toBeGreaterThanOrEqual(4);
  });

  it('reports 0 failed checks', () => {
    const r = runValidator(PLUGIN_ROOT);
    const match = r.stdout.match(/Results:\s+\d+\s+passed,\s+(\d+)\s+failed/);
    expect(match).not.toBeNull();
    expect(parseInt(match[1], 10)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Check 1: claude ↔ codex event-key parity
// ---------------------------------------------------------------------------

describe('check-hooks-symmetry.mjs — claude/codex extra event in claude only', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when hooks.json has an event that hooks-codex.json does not', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const claude = buildClaudeHooks({ SharedEvent: handler, FakeEvent: handler });
    const codex  = buildClaudeHooks({ SharedEvent: handler });
    writeHooksJsons(dir, { claude, codex });

    const r = runValidator(dir);
    expect(r.status).toBe(1);
  });

  it('FAIL line mentions the extra event name', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const claude = buildClaudeHooks({ SharedEvent: handler, FakeEvent: handler });
    const codex  = buildClaudeHooks({ SharedEvent: handler });
    writeHooksJsons(dir, { claude, codex });

    const r = runValidator(dir);
    expect(r.stdout).toContain('FakeEvent');
    expect(r.stdout).toContain('  FAIL:');
  });
});

describe('check-hooks-symmetry.mjs — codex has extra event not in claude', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when hooks-codex.json has an event missing from hooks.json', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const claude = buildClaudeHooks({ SharedEvent: handler });
    const codex  = buildClaudeHooks({ SharedEvent: handler, ExtraOnCodex: handler });
    writeHooksJsons(dir, { claude, codex });

    const r = runValidator(dir);
    expect(r.status).toBe(1);
  });

  it('FAIL line mentions ExtraOnCodex', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const claude = buildClaudeHooks({ SharedEvent: handler });
    const codex  = buildClaudeHooks({ SharedEvent: handler, ExtraOnCodex: handler });
    writeHooksJsons(dir, { claude, codex });

    const r = runValidator(dir);
    expect(r.stdout).toContain('ExtraOnCodex');
  });
});

describe('check-hooks-symmetry.mjs — claude and codex have identical event sets', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when claude.json and codex.json share the same event keys and same handlers', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SomeEvent: handler });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.status).toBe(0);
  });

  it('PASS line confirms identical event-key sets', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SomeEvent: handler });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.stdout).toContain('  PASS: hooks.json and hooks-codex.json have identical event-key sets');
  });
});

// ---------------------------------------------------------------------------
// Check 2: cursor asymmetries
// ---------------------------------------------------------------------------

describe('check-hooks-symmetry.mjs — cursor missing only documented events', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when cursor is missing only documented events (SessionStart, PostToolUse)', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    // claude+codex have SessionStart and PostToolUse — both in cursorMissingFromMain
    const both = buildClaudeHooks({ SessionStart: handler, PostToolUse: handler });
    // cursor has only Cursor-specific events
    const cursor = buildCursorHooks({ afterFileEdit: handler });
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');
    writeHooksJsons(dir, { claude: both, codex: both, cursor });

    const r = runValidator(dir);
    expect(r.status).toBe(0);
  });

  it('PASS line confirms missing events are documented', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SessionStart: handler, PostToolUse: handler });
    const cursor = buildCursorHooks({ afterFileEdit: handler });
    writeHooksJsons(dir, { claude: both, codex: both, cursor });

    const r = runValidator(dir);
    expect(r.stdout).toContain('  PASS: hooks-cursor.json missing events are all documented');
  });
});

describe('check-hooks-symmetry.mjs — cursor missing an UNDOCUMENTED event', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when cursor is missing an event not in cursorMissingFromMain', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    // BrandNewEvent is NOT in DOCUMENTED_ASYMMETRIES.cursorMissingFromMain
    const both   = buildClaudeHooks({ BrandNewEvent: handler });
    const cursor = buildCursorHooks({ afterFileEdit: handler });
    writeHooksJsons(dir, { claude: both, codex: both, cursor });

    const r = runValidator(dir);
    expect(r.status).toBe(1);
  });

  it('FAIL line mentions UNDOCUMENTED and the missing event name', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both   = buildClaudeHooks({ BrandNewEvent: handler });
    const cursor = buildCursorHooks({ afterFileEdit: handler });
    writeHooksJsons(dir, { claude: both, codex: both, cursor });

    const r = runValidator(dir);
    expect(r.stdout).toContain('UNDOCUMENTED');
    expect(r.stdout).toContain('BrandNewEvent');
  });
});

describe('check-hooks-symmetry.mjs — cursor has UNDOCUMENTED extra event', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when cursor.json has an extra event not in cursorOnly', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    // SharedEvent is in both claude+codex, cursor has SharedEvent (not extra) + WeirdCursorEvent (undocumented extra)
    const both   = buildClaudeHooks({ SharedEvent: handler });
    // WeirdCursorEvent is NOT in DOCUMENTED_ASYMMETRIES.cursorOnly
    const cursor = buildCursorHooks({ SharedEvent: handler, WeirdCursorEvent: handler });
    writeHooksJsons(dir, { claude: both, codex: both, cursor });

    const r = runValidator(dir);
    expect(r.status).toBe(1);
  });

  it('FAIL line mentions UNDOCUMENTED extra and the offending event name', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both   = buildClaudeHooks({ SharedEvent: handler });
    const cursor = buildCursorHooks({ SharedEvent: handler, WeirdCursorEvent: handler });
    writeHooksJsons(dir, { claude: both, codex: both, cursor });

    const r = runValidator(dir);
    expect(r.stdout).toContain('UNDOCUMENTED extra');
    expect(r.stdout).toContain('WeirdCursorEvent');
  });
});

describe('check-hooks-symmetry.mjs — hooks-cursor.json absent', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when hooks-cursor.json is absent (it is optional)', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    // Do not write cursor JSON
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.status).toBe(0);
  });

  it('PASS line reports cursor absent as optional', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.stdout).toContain('  PASS: hooks-cursor.json absent (optional config)');
  });
});

// ---------------------------------------------------------------------------
// Check 3: handler files exist on disk
// ---------------------------------------------------------------------------

describe('check-hooks-symmetry.mjs — referenced handler missing from disk', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when a handler referenced in hooks.json does not exist on disk', () => {
    dir = makeFixtureDir();
    // Write JSON but NOT the handler file
    const both = buildClaudeHooks({ SessionStart: 'missing.mjs' });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.status).toBe(1);
  });

  it('FAIL line mentions the missing handler filename', () => {
    dir = makeFixtureDir();
    const both = buildClaudeHooks({ SessionStart: 'missing.mjs' });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.stdout).toContain('missing.mjs');
    expect(r.stdout).toContain('  FAIL:');
  });
});

describe('check-hooks-symmetry.mjs — all referenced handlers exist on disk', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when all handler files referenced in JSON exist on disk', () => {
    dir = makeFixtureDir();
    const handler = 'on-start.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.status).toBe(0);
  });

  it('PASS line confirms all handler files exist', () => {
    dir = makeFixtureDir();
    const handler = 'on-start.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.stdout).toContain('  PASS: all');
    expect(r.stdout).toContain('handler files exist on disk');
  });
});

// ---------------------------------------------------------------------------
// Check 4: orphan .mjs files (informational PASS)
// ---------------------------------------------------------------------------

describe('check-hooks-symmetry.mjs — orphan .mjs file in hooks/ is informational PASS', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 0 when hooks/ contains an .mjs file not referenced in any JSON', () => {
    dir = makeFixtureDir();
    const handler = 'referenced.mjs';
    const orphan  = 'orphan.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');
    writeFileSync(path.join(dir, 'hooks', orphan), '// orphan stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.status).toBe(0);
  });

  it('PASS line mentions unreferenced files', () => {
    dir = makeFixtureDir();
    const handler = 'referenced.mjs';
    const orphan  = 'orphan.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');
    writeFileSync(path.join(dir, 'hooks', orphan), '// orphan stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.stdout).toContain('  PASS:');
    expect(r.stdout).toContain('unreferenced');
  });
});

// ---------------------------------------------------------------------------
// Malformed / missing JSON files
// ---------------------------------------------------------------------------

describe('check-hooks-symmetry.mjs — malformed hooks.json', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when hooks.json contains invalid JSON', () => {
    dir = makeFixtureDir();
    writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{ not valid json !!');

    const r = runValidator(dir);
    expect(r.status).toBe(1);
  });

  it('FAIL line mentions hooks.json when it is malformed', () => {
    dir = makeFixtureDir();
    writeFileSync(path.join(dir, 'hooks', 'hooks.json'), '{ not valid json !!');

    const r = runValidator(dir);
    expect(r.stdout).toContain('  FAIL: hooks.json:');
  });
});

describe('check-hooks-symmetry.mjs — hooks-codex.json missing entirely', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when hooks-codex.json is absent (it is required)', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    // Write only claude, omit codex
    const claude = buildClaudeHooks({ SessionStart: handler });
    writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify(claude));
    // hooks-codex.json intentionally NOT written

    const r = runValidator(dir);
    expect(r.status).toBe(1);
  });

  it('FAIL line mentions hooks-codex.json when it is missing', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const claude = buildClaudeHooks({ SessionStart: handler });
    writeFileSync(path.join(dir, 'hooks', 'hooks.json'), JSON.stringify(claude));

    const r = runValidator(dir);
    expect(r.stdout).toContain('  FAIL: hooks-codex.json:');
  });
});

describe('check-hooks-symmetry.mjs — malformed hooks-cursor.json', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('exits 1 when hooks-cursor.json exists but contains invalid JSON', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    writeHooksJsons(dir, { claude: both, codex: both });
    // Now overwrite cursor with garbage
    writeFileSync(path.join(dir, 'hooks', 'hooks-cursor.json'), '{ broken !!');

    const r = runValidator(dir);
    expect(r.status).toBe(1);
  });

  it('FAIL line mentions hooks-cursor.json when it is malformed', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    writeHooksJsons(dir, { claude: both, codex: both });
    writeFileSync(path.join(dir, 'hooks', 'hooks-cursor.json'), '{ broken !!');

    const r = runValidator(dir);
    expect(r.stdout).toContain('  FAIL: hooks-cursor.json:');
  });
});

// ---------------------------------------------------------------------------
// Final Results line format
// ---------------------------------------------------------------------------

describe('check-hooks-symmetry.mjs — Results line always present', () => {
  let dir;
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('always emits a Results: N passed, M failed line', () => {
    dir = makeFixtureDir();
    const handler = 'handler.mjs';
    writeFileSync(path.join(dir, 'hooks', handler), '// stub');

    const both = buildClaudeHooks({ SessionStart: handler });
    writeHooksJsons(dir, { claude: both, codex: both });

    const r = runValidator(dir);
    expect(r.stdout).toMatch(/Results: \d+ passed, \d+ failed/);
  });
});
