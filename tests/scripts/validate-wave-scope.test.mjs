/**
 * tests/scripts/validate-wave-scope.test.mjs
 *
 * Vitest suite for scripts/validate-wave-scope.mjs (issue #270).
 *
 * Covers: happy path, missing required fields, type errors, path traversal,
 * absolute path rejection, gates shape, invalid JSON, stdin vs. file input.
 */

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, '../../scripts/validate-wave-scope.mjs');

function run(input, fileArg) {
  const args = fileArg ? [SCRIPT, fileArg] : [SCRIPT];
  return spawnSync('node', args, {
    input: fileArg ? undefined : input,
    encoding: 'utf8',
  });
}

const VALID = {
  wave: 2,
  role: 'impl-core',
  enforcement: 'warn',
  allowedPaths: ['src/**', 'tests/**'],
  blockedCommands: ['rm -rf', 'git reset --hard'],
};

describe('validate-wave-scope.mjs — happy path', () => {
  it('accepts a valid wave-scope.json from stdin and exits 0', () => {
    const r = run(JSON.stringify(VALID));
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout)).toMatchObject(VALID);
  });

  it('accepts a valid wave-scope.json from a file path and exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vws-'));
    const path = join(dir, 'wave-scope.json');
    writeFileSync(path, JSON.stringify(VALID));
    try {
      const r = run(null, path);
      expect(r.status).toBe(0);
      expect(r.stderr).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts the optional gates field when all values are booleans', () => {
    const r = run(JSON.stringify({ ...VALID, gates: { test: true, lint: false } }));
    expect(r.status).toBe(0);
  });

  it('passes through overly permissive patterns with a stderr WARNING but exits 0', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['**/*'] }));
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/WARNING.*overly permissive/);
  });
});

describe('validate-wave-scope.mjs — invalid JSON', () => {
  it('exits 1 with ERROR on non-JSON input', () => {
    const r = run('not valid json at all');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR: Input is not valid JSON/);
  });
});

describe('validate-wave-scope.mjs — required-field contract', () => {
  it('rejects missing wave', () => {
    const { wave: _wave, ...noWave } = VALID;
    const r = run(JSON.stringify(noWave));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Missing required field: wave/);
  });

  it('rejects non-integer wave', () => {
    const r = run(JSON.stringify({ ...VALID, wave: 1.5 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/wave must be a positive integer/);
  });

  it('rejects zero or negative wave', () => {
    const r = run(JSON.stringify({ ...VALID, wave: 0 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/wave must be a positive integer/);
  });

  it('rejects non-string role', () => {
    const r = run(JSON.stringify({ ...VALID, role: 42 }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/role must be a string/);
  });

  it('rejects enforcement outside strict|warn|off', () => {
    const r = run(JSON.stringify({ ...VALID, enforcement: 'loose' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/enforcement must be one of/);
  });
});

describe('validate-wave-scope.mjs — security checks', () => {
  it('rejects absolute paths in allowedPaths', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['/etc/passwd'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/absolute path/);
  });

  it('rejects path traversal in allowedPaths', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: ['../escape'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/path traversal/);
  });

  it('rejects non-array allowedPaths', () => {
    const r = run(JSON.stringify({ ...VALID, allowedPaths: 'src/**' }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/allowedPaths must be an array/);
  });

  it('rejects missing blockedCommands', () => {
    const { blockedCommands: _bc, ...noBc } = VALID;
    const r = run(JSON.stringify(noBc));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Missing required field: blockedCommands/);
  });
});

describe('validate-wave-scope.mjs — gates shape', () => {
  it('rejects non-boolean gate values', () => {
    const r = run(JSON.stringify({ ...VALID, gates: { test: true, lint: 'no' } }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/gates values must be booleans.*lint/);
  });

  it('rejects gates that is not an object', () => {
    const r = run(JSON.stringify({ ...VALID, gates: ['test'] }));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/gates must be an object/);
  });
});

describe('validate-wave-scope.mjs — file input errors', () => {
  it('exits 1 with ERROR when file path does not exist', () => {
    const r = run(null, '/nonexistent/path/wave-scope.json');
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/ERROR: File not found/);
  });
});

describe('validate-wave-scope.mjs — stdin pipe (shebang/runnable)', () => {
  // .claude/wave-scope.json is a gitignored runtime file; skip when absent.
  const waveScopePath = resolve(__dirname, '../../.claude/wave-scope.json');
  const waveScopeExists = existsSync(waveScopePath);

  it.skipIf(!waveScopeExists)('cat .claude/wave-scope.json | node validate-wave-scope.mjs exits 0', () => {
    // Pipe the real .claude/wave-scope.json from the repo through stdin
    const catResult = spawnSync('cat', [waveScopePath], { encoding: 'utf8' });
    expect(catResult.status).toBe(0);

    // Now pipe that content to the validator via stdin
    const r = spawnSync('node', [SCRIPT], {
      input: catResult.stdout,
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    // Output must be valid JSON matching the source
    const parsed = JSON.parse(r.stdout);
    expect(parsed.wave).toBeTypeOf('number');
    expect(parsed.enforcement).toMatch(/^(strict|warn|off)$/);
  });
});
