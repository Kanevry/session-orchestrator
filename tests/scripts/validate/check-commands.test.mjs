/**
 * tests/scripts/validate/check-commands.test.mjs
 *
 * Integration tests for scripts/lib/validate/check-commands.mjs.
 *
 * Issue #985 consolidation: shared CLI fixtures are table-driven and each row
 * spawns the checker once. Status-only tests were merged with the diagnostic
 * that identifies the accepted or rejected validator branch.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/lib/validate/check-commands.mjs',
);
const PLUGIN_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function run(pluginRoot) {
  return spawnSync(process.execPath, [SCRIPT, pluginRoot], {
    encoding: 'utf8',
    timeout: 15_000,
  });
}

function makeFixture({ commandFiles = null, extraFiles = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-commands-'));
  mkdirSync(path.join(dir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    path.join(dir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'test-plugin', version: '1.0.0' }),
  );

  if (commandFiles !== null) {
    mkdirSync(path.join(dir, 'commands'), { recursive: true });
    for (const [filename, frontmatter] of commandFiles) {
      writeFileSync(
        path.join(dir, 'commands', filename),
        `---\n${frontmatter}\n---\n# Command body\n`,
      );
    }
  }

  for (const [relativePath, content] of Object.entries(extraFiles)) {
    const absolutePath = path.join(dir, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }

  return dir;
}

/**
 * Normalize a CLI run into a hardcoded, table-friendly verdict.
 * `missingStdout` and `missingStderr` ensure a status assertion cannot pass
 * without the output that identifies the validator branch under test.
 */
function verdict(result, { stdout = [], stderr = [] } = {}) {
  return {
    status: result.status,
    missingStdout: stdout.filter((needle) => !result.stdout.includes(needle)),
    missingStderr: stderr.filter((needle) => !result.stderr.includes(needle)),
  };
}

const COMMAND_DIRECTORY_CASES = [
  {
    name: 'fails when the commands directory is absent',
    fixture: {},
    stdout: ['FAIL: commands directory not found at conventional location: ./commands'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'fails when the commands directory has no files',
    fixture: { commandFiles: [] },
    stdout: ['FAIL: commands directory is empty (no .md files)'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
  {
    name: 'ignores non-Markdown files when deciding whether commands exist',
    fixture: { extraFiles: { 'commands/README.txt': 'not a command file' } },
    stdout: ['FAIL: commands directory is empty (no .md files)'],
    expected: { status: 1, missingStdout: [], missingStderr: [] },
  },
];

const ACCEPTED_ARGUMENT_HINT_CASES = [
  {
    name: 'accepts a quoted argument-hint string',
    commandFiles: [['quoted.md', 'description: Quoted hint\nargument-hint: "[mode: deep]"']],
  },
  {
    name: 'keeps a date-like argument-hint as a string under CORE_SCHEMA',
    commandFiles: [['core-schema.md', 'description: Date-like hint\nargument-hint: 2026-01-01']],
  },
  {
    name: 'accepts an empty argument-hint string',
    commandFiles: [['empty.md', 'description: Empty hint\nargument-hint: ""']],
  },
  {
    name: 'accepts frontmatter that omits argument-hint',
    commandFiles: [['omitted.md', 'description: Optional hint omitted']],
  },
];

const REJECTED_ARGUMENT_HINT_CASES = [
  {
    name: 'rejects an argument-hint array',
    commandFiles: [['array-argument.md', 'description: Invalid array\nargument-hint: [one, two]']],
    stdout: ['FAIL: array-argument.md: argument-hint must be a string'],
  },
  {
    name: 'rejects malformed YAML with the filename and parser error',
    commandFiles: [['malformed-command.md', 'description: Broken YAML\nargument-hint: [unterminated']],
    stdout: [
      'FAIL: malformed-command.md: invalid YAML frontmatter:',
      'unexpected end of the stream within a flow collection',
    ],
  },
  {
    name: 'rejects null argument-hint values',
    commandFiles: [['null-argument.md', 'description: Null hint\nargument-hint: null']],
    stdout: ['FAIL: null-argument.md: argument-hint must be a string'],
  },
  {
    name: 'rejects object argument-hint values',
    commandFiles: [['object-argument.md', 'description: Object hint\nargument-hint:\n  mode: deep']],
    stdout: ['FAIL: object-argument.md: argument-hint must be a string'],
  },
  {
    name: 'rejects numeric argument-hint values',
    commandFiles: [['number-argument.md', 'description: Number hint\nargument-hint: 42']],
    stdout: ['FAIL: number-argument.md: argument-hint must be a string'],
  },
  {
    name: 'rejects boolean argument-hint values',
    commandFiles: [['boolean-argument.md', 'description: Boolean hint\nargument-hint: true']],
    stdout: ['FAIL: boolean-argument.md: argument-hint must be a string'],
  },
  {
    name: 'rejects a non-mapping frontmatter root',
    commandFiles: [['sequence-root.md', '- first\n- second']],
    stdout: ['FAIL: sequence-root.md: YAML frontmatter must be a non-null mapping/object'],
  },
];

describe('check-commands.mjs — current repo smoke', () => {
  it('reports a command-file PASS and zero failed checks', () => {
    expect(
      verdict(run(PLUGIN_REPO), {
        stdout: ['PASS: commands directory contains', '.md files', 'Results:', '0 failed'],
      }),
    ).toEqual({ status: 0, missingStdout: [], missingStderr: [] });
  });
});

describe('check-commands.mjs — missing plugin-root argument', () => {
  it('exits 1 and writes the usage contract to stderr', () => {
    expect(
      verdict(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', timeout: 15_000 }), {
        stderr: ['Usage: check-commands.mjs <plugin-root>'],
      }),
    ).toEqual({ status: 1, missingStdout: [], missingStderr: [] });
  });
});

describe('check-commands.mjs — commands directory cases', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it.each(COMMAND_DIRECTORY_CASES)('$name', ({ fixture, stdout, expected }) => {
    dir = makeFixture(fixture);
    expect(verdict(run(dir), { stdout })).toEqual(expected);
  });

  it('accepts a valid Markdown command and reports the directory contract', () => {
    dir = makeFixture({ commandFiles: [['session.md', 'description: Session command']] });
    expect(
      verdict(run(dir), {
        stdout: ['PASS: commands directory contains', '.md files', 'Results:', '0 failed'],
      }),
    ).toEqual({ status: 0, missingStdout: [], missingStderr: [] });
  });
});

describe('check-commands.mjs — accepted argument-hint frontmatter', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it.each(ACCEPTED_ARGUMENT_HINT_CASES)('$name', ({ commandFiles }) => {
    dir = makeFixture({ commandFiles });
    expect(
      verdict(run(dir), {
        stdout: ['PASS: commands directory contains', '.md files', 'Results:', '0 failed'],
      }),
    ).toEqual({ status: 0, missingStdout: [], missingStderr: [] });
  });
});

describe('check-commands.mjs — rejected argument-hint frontmatter', () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it.each(REJECTED_ARGUMENT_HINT_CASES)('$name', ({ commandFiles, stdout }) => {
    dir = makeFixture({ commandFiles });
    expect(verdict(run(dir), { stdout })).toEqual({
      status: 1,
      missingStdout: [],
      missingStderr: [],
    });
  });
});
