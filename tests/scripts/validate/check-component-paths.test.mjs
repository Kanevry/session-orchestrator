/**
 * tests/scripts/validate/check-component-paths.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-component-paths.mjs.
 *
 * Issue #985 consolidation: every synthetic plugin is spawned once and its
 * status is asserted with the diagnostic for the component-path branch under
 * test. The former status/message pairs were duplicate executions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/validate/check-component-paths.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync(process.execPath, [SCRIPT, pluginRoot], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function makeFixture({ pluginJson = JSON.stringify({}), components = [] } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-component-paths-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), pluginJson);

  for (const relativePath of components) {
    const absolutePath = path.join(dir, relativePath);
    if (relativePath.endsWith('.json')) {
      mkdirSync(path.dirname(absolutePath), { recursive: true });
      writeFileSync(absolutePath, '{}');
    } else {
      mkdirSync(absolutePath, { recursive: true });
    }
  }

  return dir;
}

/**
 * Normalize a CLI run into a hardcoded, table-friendly verdict.
 * Required output needles keep a status-only smoke test from passing when the
 * validator exits cleanly without reporting the component branch.
 */
function verdict(result, { stdout = [], stderr = [] } = {}) {
  return {
    status: result.status,
    missingStdout: stdout.filter((needle) => !result.stdout.includes(needle)),
    missingStderr: stderr.filter((needle) => !result.stderr.includes(needle)),
  };
}

const ALL_CONVENTIONAL_COMPONENTS = ['commands', 'agents', 'hooks/hooks.json', '.mcp.json'];
const REQUIRED_COMPONENTS_WITHOUT_COMMANDS = ['agents', 'hooks/hooks.json', '.mcp.json'];

const COMPONENT_PATH_CASES = [
  {
    name: 'auto-discovers an explicitly absent commands path at its conventional location',
    fixture: {
      pluginJson: JSON.stringify({}),
      components: ALL_CONVENTIONAL_COMPONENTS,
    },
    stdout: ['PASS: commands auto-discovered at: ./commands', '0 failed'],
    expected: { status: 0, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'fails when a required conventional commands directory is absent',
    fixture: { pluginJson: JSON.stringify({}), components: REQUIRED_COMPONENTS_WITHOUT_COMMANDS },
    stdout: ['FAIL: commands not found at conventional location: ./commands'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'fails when an explicit commands path does not exist on disk',
    fixture: {
      pluginJson: JSON.stringify({ commands: './my-commands' }),
      components: REQUIRED_COMPONENTS_WITHOUT_COMMANDS,
    },
    stdout: ['FAIL: commands path does not exist: ./my-commands'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
];

describe('check-component-paths.mjs — current repo smoke', () => {
  it('reports all four conventional component paths and zero failed checks', () => {
    expect(
      verdict(run(PLUGIN_REPO), {
        stdout: [
          'PASS: commands auto-discovered at: ./commands',
          'PASS: agents auto-discovered at: ./agents',
          'PASS: hooks auto-discovered at: ./hooks/hooks.json',
          'PASS: mcpServers auto-discovered at: ./.mcp.json',
          'Results:',
          '0 failed',
        ],
      }),
    ).toEqual({ status: 0, missingStdout: [], missingStderr: [] });
  });
});

describe('check-component-paths.mjs — missing plugin-root argument', () => {
  it('exits 1 and writes the usage contract to stderr', () => {
    expect(
      verdict(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 15_000 }), {
        stderr: ['Usage: check-component-paths.mjs <plugin-root>'],
      }),
    ).toEqual({ status: 1, missingStdout: [], missingStderr: [] });
  });
});

describe('check-component-paths.mjs — component path cases', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it.each(COMPONENT_PATH_CASES)('$name', ({ fixture, stdout, expected }) => {
    dir = makeFixture(fixture);
    expect(verdict(run(dir), { stdout })).toEqual(expected);
  });
});
