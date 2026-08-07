/**
 * tests/scripts/validate/check-plugin-json.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-plugin-json.mjs.
 *
 * Issue #985 consolidation: each fixture is spawned once and its exit status
 * is asserted together with the diagnostic that identifies the validator
 * verdict. The old suite spawned the same fixture separately for status,
 * message, and summary assertions.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/validate/check-plugin-json.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync(process.execPath, [SCRIPT, pluginRoot], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function makeFixture(pluginJson) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-plugin-json-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  if (pluginJson !== undefined) {
    writeFileSync(path.join(dir, '.claude-plugin', 'plugin.json'), pluginJson);
  }
  return dir;
}

/**
 * Normalize a CLI run into a hardcoded, table-friendly verdict.
 * `missingStdout` and `missingStderr` make a test fail when the validator
 * returns the right status but loses its identifying diagnostic.
 */
function verdict(result, { stdout = [], stderr = [] } = {}) {
  return {
    status: result.status,
    missingStdout: stdout.filter((needle) => !result.stdout.includes(needle)),
    missingStderr: stderr.filter((needle) => !result.stderr.includes(needle)),
  };
}

const PLUGIN_JSON_CASES = [
  {
    name: 'fails with a summary when plugin.json is absent',
    pluginJson: undefined,
    stdout: ['FAIL: plugin.json not found', 'Results:'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'fails when plugin.json is invalid JSON',
    pluginJson: '{ not valid json }',
    stdout: ['FAIL: plugin.json is not valid JSON'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'fails when the required name field is missing',
    pluginJson: JSON.stringify({ version: '1.0.0', description: 'no name' }),
    stdout: ["FAIL: required field 'name' is missing"],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'fails when name is not kebab-case',
    pluginJson: JSON.stringify({ name: 'Foo_Bar', version: '1.0.0' }),
    stdout: ['FAIL: name is not kebab-case: Foo_Bar'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'fails when version does not match semver',
    pluginJson: JSON.stringify({ name: 'my-plugin', version: 'abc' }),
    stdout: ['FAIL: version does not match semver: abc'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
];

describe('check-plugin-json.mjs — current repo smoke', () => {
  it('reports the plugin.json checks and zero failed checks', () => {
    expect(
      verdict(run(PLUGIN_REPO), {
        stdout: [
          'PASS: plugin.json exists',
          'PASS: plugin.json is valid JSON',
          'Results:',
          '0 failed',
        ],
      }),
    ).toEqual({ status: 0, missingStdout: [], missingStderr: [] });
  });
});

describe('check-plugin-json.mjs — missing plugin-root argument', () => {
  it('exits 1 and writes the usage contract to stderr', () => {
    expect(
      verdict(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 15_000 }), {
        stderr: ['Usage: check-plugin-json.mjs <plugin-root>'],
      }),
    ).toEqual({ status: 1, missingStdout: [], missingStderr: [] });
  });
});

describe('check-plugin-json.mjs — plugin.json verdict cases', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it.each(PLUGIN_JSON_CASES)('$name', ({ pluginJson, stdout, expected }) => {
    dir = makeFixture(pluginJson);
    expect(verdict(run(dir), { stdout })).toEqual(expected);
  });
});
