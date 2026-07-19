/**
 * tests/scripts/validate-plugin.test.mjs
 *
 * Vitest suite for scripts/validate-plugin.mjs (issue #218).
 *
 * The script is a pass-through orchestrator that shells out to check-*.sh
 * sub-scripts in scripts/lib/validate/. Tests verify: exit codes, output
 * shape, and basic failure modes. All tests are hermetic — no network, no
 * git server dependency beyond the local repo.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../scripts/validate-plugin.mjs');
const CHECK_CODEX_PLUGIN = resolve(__dirname, '../../scripts/lib/validate/check-codex-plugin.mjs');
const REPO_ROOT = resolve(__dirname, '../../');
const EXPECTED_CODEX_VERSION = JSON.parse(
  readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'),
).version;

/**
 * Run scripts/validate-plugin.mjs with the given argument list.
 *
 * @param {string[]} args
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function run(args = []) {
  return spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Happy path — current repo plugin
// ---------------------------------------------------------------------------

describe('validate-plugin.mjs — current repo plugin', () => {
  // Spawn once per describe — the heavy validator forks ~21 grandchild
  // processes; re-spawning per it() flakes under loaded-runner contention.
  let r;
  beforeAll(() => {
    r = run([REPO_ROOT]);
  });

  it('exits 0 when run against the current repo plugin', () => {
    expect(r.status).toBe(0);
  });

  it('reports "Results:" summary line on stdout', () => {
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Results:');
  });

  it('reports at least 18 passed checks', () => {
    expect(r.status).toBe(0);
    // "Results: 19 passed, 0 failed" — extract the number
    const match = r.stdout.match(/Results:\s+(\d+)\s+passed/);
    expect(match).not.toBeNull();
    const passedCount = parseInt(match[1], 10);
    expect(passedCount).toBeGreaterThanOrEqual(18);
  });

  it('reports 0 failed checks', () => {
    expect(r.status).toBe(0);
    const match = r.stdout.match(/(\d+)\s+failed/);
    expect(match).not.toBeNull();
    const failedCount = parseInt(match[1], 10);
    expect(failedCount).toBe(0);
  });

  it('passes check-plugin-json gate (plugin.json exists and valid)', () => {
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS: plugin.json exists');
    expect(r.stdout).toContain('PASS: plugin.json is valid JSON');
  });

  it('output includes PASS lines for agent frontmatter', () => {
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('PASS:');
    // At least one agent frontmatter pass line
    expect(r.stdout).toMatch(/PASS:.*\.md:.*frontmatter/);
  });

  it('emits a closing separator line (=== block)', () => {
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('===========================================');
  });
});

// ---------------------------------------------------------------------------
// Plugin root argument — missing plugin.json → exit 1
// ---------------------------------------------------------------------------

describe('validate-plugin.mjs — missing plugin.json', () => {
  it('exits 1 when plugin-root directory has no .claude-plugin/plugin.json', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-missing-'));
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports a FAIL line about plugin.json not found', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-missing-'));
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('FAIL: plugin.json not found');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('still emits a Results: summary even on early-abort failure', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-missing-'));
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('Results:');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid plugin.json — missing required 'name' field → exit 1
// ---------------------------------------------------------------------------

describe('validate-plugin.mjs — invalid plugin.json', () => {
  it('exits 1 when plugin.json is missing the required name field', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-bad-'));
    const pluginDir = join(tmpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    // Valid JSON but missing the required 'name' field
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ version: '1.0.0', description: 'no name here' }),
    );
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('reports FAIL for missing name field in plugin.json', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-bad-'));
    const pluginDir = join(tmpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ version: '1.0.0', description: 'no name here' }),
    );
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('FAIL:');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when plugin.json contains invalid JSON', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-badjson-'));
    const pluginDir = join(tmpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(join(pluginDir, 'plugin.json'), '{ not valid json }');
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('exits 1 when plugin.json has a non-kebab-case name', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'vp-badname-'));
    const pluginDir = join(tmpDir, '.claude-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({ name: 'My Plugin Name!', version: '1.0.0' }),
    );
    try {
      const r = run([tmpDir]);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('FAIL:');
      expect(r.stdout).toContain('kebab-case');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Nonexistent plugin root
// ---------------------------------------------------------------------------

describe('validate-plugin.mjs — nonexistent plugin root', () => {
  // Spawn once per describe — both it()s use identical args.
  let r;
  beforeAll(() => {
    r = run(['/nonexistent/path/to/plugin']);
  });

  it('exits 1 when the plugin-root path does not exist', () => {
    expect(r.status).toBe(1);
  });

  it('reports FAIL: plugin.json not found for a nonexistent root', () => {
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('FAIL: plugin.json not found');
  });
});

// ---------------------------------------------------------------------------
// check-codex-plugin.mjs — canonical contract reporter
// ---------------------------------------------------------------------------

function runCodexContractCheck(pluginRoot) {
  return spawnSync('node', [CHECK_CODEX_PLUGIN, pluginRoot], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 10_000,
  });
}

const REQUIRED_CODEX_EVENTS = [
  'SessionStart',
  'PreToolUse',
  'PostToolUse',
  'SubagentStart',
  'SubagentStop',
  'Stop',
];

function codexWrapper(handler) {
  return `SO_PLATFORM=codex CODEX_PLUGIN_ROOT="${'${PLUGIN_ROOT}'}" sh "${'${PLUGIN_ROOT}'}/hooks/run-node.sh" "${'${PLUGIN_ROOT}'}/hooks/${handler}"`;
}

function makeCodexContractFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vp-codex-contract-'));
  for (const directory of ['.codex-plugin', 'skills', 'hooks', 'assets']) {
    mkdirSync(join(root, directory), { recursive: true });
  }

  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: EXPECTED_CODEX_VERSION }));
  writeFileSync(join(root, '.mcp.json'), '{"mcpServers":{}}');
  writeFileSync(join(root, 'assets', 'icon.svg'), '<svg/>');
  writeFileSync(join(root, 'hooks', 'run-node.sh'), '#!/bin/sh\n');
  writeFileSync(join(root, 'hooks', 'on-session-start.mjs'), '// fixture\n');
  writeFileSync(join(root, 'hooks', 'on-stop.mjs'), '// fixture\n');

  writeFileSync(
    join(root, '.codex-plugin', 'plugin.json'),
    JSON.stringify({
      name: 'session-orchestrator',
      version: `${EXPECTED_CODEX_VERSION}+codex.20260717175716`,
      description: 'Fixture Codex plugin',
      keywords: ['codex'],
      skills: './skills/',
      hooks: './hooks/hooks-codex.json',
      mcpServers: './.mcp.json',
      interface: {
        displayName: 'Session Orchestrator',
        composerIcon: './assets/icon.svg',
      },
    }),
  );

  const hooks = Object.fromEntries(REQUIRED_CODEX_EVENTS.map((event) => [event, []]));
  hooks.SessionStart = [
    {
      matcher: 'startup|resume|clear|compact',
      hooks: [
        {
          type: 'command',
          command: `echo '🎯 Session Orchestrator v${EXPECTED_CODEX_VERSION} — /session [housekeeping|feature|deep] | /plan [new|feature|retro] | /discovery [scope] | /evolve [analyze|review|list]'`,
        },
        { type: 'command', command: codexWrapper('on-session-start.mjs') },
      ],
    },
  ];
  hooks.Stop = [
    { matcher: '', hooks: [{ type: 'command', command: codexWrapper('on-stop.mjs') }] },
  ];
  writeFileSync(
    join(root, 'hooks', 'hooks-codex.json'),
    JSON.stringify({ description: 'Fixture Codex hooks', hooks }),
  );

  return root;
}

function mutateCodexManifest(root, mutate) {
  const manifestPath = join(root, '.codex-plugin', 'plugin.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  mutate(manifest);
  writeFileSync(manifestPath, JSON.stringify(manifest));
}

describe('check-codex-plugin.mjs — canonical contract', () => {
  let r;
  beforeAll(() => {
    r = runCodexContractCheck(REPO_ROOT);
  });

  it('exits 0 against the current repository', () => {
    expect(r.status).toBe(0);
  });

  it('reports the canonical manifest and hooks contract as passing', () => {
    expect(r.stdout).toContain(
      'PASS: .codex-plugin/plugin.json and hooks/hooks-codex.json satisfy the Codex contract',
    );
    expect(r.stdout).toContain('Results: 1 passed, 0 failed');
  });
});

describe('check-codex-plugin.mjs — composerIcon contract mutations', () => {
  it('rejects a missing composerIcon field', () => {
    const root = makeCodexContractFixture();
    try {
      mutateCodexManifest(root, (manifest) => delete manifest.interface.composerIcon);
      const r = runCodexContractCheck(root);

      expect(r.status).toBe(1);
      expect(r.stdout).toContain('[required] $.manifest.interface.composerIcon');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects a missing composerIcon file', () => {
    const root = makeCodexContractFixture();
    try {
      mutateCodexManifest(root, (manifest) => {
        manifest.interface.composerIcon = './assets/missing.svg';
      });
      const r = runCodexContractCheck(root);

      expect(r.status).toBe(1);
      expect(r.stdout).toContain('[exists] $.manifest.interface.composerIcon');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects composerIcon content that is not SVG', () => {
    const root = makeCodexContractFixture();
    try {
      writeFileSync(join(root, 'assets', 'icon.svg'), 'not svg content');
      const r = runCodexContractCheck(root);

      expect(r.status).toBe(1);
      expect(r.stdout).toContain('[svg-content] $.manifest.interface.composerIcon');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ['a direct SVG root', '  <svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['an XML declaration', '\n<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
  ])('accepts %s after trimming', (_case, content) => {
    const root = makeCodexContractFixture();
    try {
      writeFileSync(join(root, 'assets', 'icon.svg'), content);
      const r = runCodexContractCheck(root);

      expect(r.status).toBe(0);
      expect(r.stdout).toContain('Results: 1 passed, 0 failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
