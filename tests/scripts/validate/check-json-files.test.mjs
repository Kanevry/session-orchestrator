/**
 * tests/scripts/validate/check-json-files.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-json-files.mjs.
 *
 * Issue #985 consolidation: each JSON fixture is spawned once and asserts the
 * exit status together with the output that identifies the JSON verdict. The
 * former status/message pairs duplicated the same child-process setup.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/validate/check-json-files.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync(process.execPath, [SCRIPT, pluginRoot], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function makeFixture({ hooks = undefined } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-json-files-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({}));
  if (hooks !== undefined) {
    mkdirSync(path.join(dir, 'hooks'), { recursive: true });
    writeFileSync(path.join(dir, 'hooks', 'hooks.json'), hooks);
  }
  return dir;
}

/**
 * Normalize a CLI run into a hardcoded, table-friendly verdict.
 * The output needle is the observable JSON branch, not merely a no-crash
 * assertion.
 */
function verdict(result, { stdout = [], stderr = [] } = {}) {
  return {
    status: result.status,
    missingStdout: stdout.filter((needle) => !result.stdout.includes(needle)),
    missingStderr: stderr.filter((needle) => !result.stderr.includes(needle)),
  };
}

const JSON_FILE_CASES = [
  {
    name: 'fails when auto-discovered hooks.json is invalid JSON',
    fixture: { hooks: '{ not valid json }' },
    stdout: ['FAIL: hooks file is not valid JSON: ./hooks/hooks.json'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'passes with an explicit skip when no conventional hooks.json exists',
    fixture: {},
    stdout: ['PASS: hooks is not a JSON file or not specified (skipped)', '0 failed'],
    expected: { status: 0, missingStdout: [], missingStderr: [] },
  },
];

describe('check-json-files.mjs — current repo smoke', () => {
  it('reports valid hooks and mcpServers JSON with zero failed checks', () => {
    expect(
      verdict(run(PLUGIN_REPO), {
        stdout: [
          'PASS: hooks file is valid JSON',
          'PASS: mcpServers file is valid JSON',
          'Results:',
          '0 failed',
        ],
      }),
    ).toEqual({ status: 0, missingStdout: [], missingStderr: [] });
  });
});

describe('check-json-files.mjs — missing plugin-root argument', () => {
  it('exits 1 and writes the usage contract to stderr', () => {
    expect(
      verdict(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 15_000 }), {
        stderr: ['Usage: check-json-files.mjs <plugin-root>'],
      }),
    ).toEqual({ status: 1, missingStdout: [], missingStderr: [] });
  });
});

describe('check-json-files.mjs — hooks JSON cases', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it.each(JSON_FILE_CASES)('$name', ({ fixture, stdout, expected }) => {
    dir = makeFixture(fixture);
    expect(verdict(run(dir), { stdout })).toEqual(expected);
  });
});
