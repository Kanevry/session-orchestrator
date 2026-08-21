/**
 * Integration tests for scripts/materialize-wave-scope.mjs.
 *
 * The CLI is the canonical writer for both scope declaration shapes. Each test
 * runs it against a temporary state directory; no live control state is read.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeWaveScope } from '../../scripts/materialize-wave-scope.mjs';
import { writeJsonAtomicSync } from '../../scripts/lib/io.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/materialize-wave-scope.mjs');
const VALID_SCOPES = [
  { id: 'W7-I1', files: ['scripts/alpha.mjs', 'tests/scripts/alpha.test.mjs'] },
  { id: 'coordinator', files: ['skills/wave-executor/wave-loop.md'] },
];

const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeStateDir() {
  const stateDir = mkdtempSync(join(tmpdir(), 'materialize-wave-scope-'));
  tempDirs.push(stateDir);
  return stateDir;
}

function runCli({ stateDir, wave = 7, scopes = VALID_SCOPES, args = [] }) {
  const result = spawnSync(process.execPath, [SCRIPT, '--state-dir', stateDir, '--wave', String(wave), ...args], {
    input: JSON.stringify(scopes),
    encoding: 'utf8',
    cwd: REPO_ROOT,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function aggregatePath(stateDir, wave = 7) {
  return join(stateDir, 'filescopes', `wave-${wave}.scopes.json`);
}

function agentPath(stateDir, id, wave = 7) {
  return join(stateDir, 'filescopes', `wave-${wave}`, `${id}.json`);
}

describe('materialize-wave-scope.mjs — canonical two-shape materialization', () => {
  it('writes bare per-agent arrays and an order-preserving aggregate including coordinator', () => {
    const stateDir = makeStateDir();

    const result = runCli({ stateDir });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(`${aggregatePath(stateDir)}\n`);
    expect(JSON.parse(readFileSync(agentPath(stateDir, 'W7-I1'), 'utf8'))).toEqual([
      'scripts/alpha.mjs',
      'tests/scripts/alpha.test.mjs',
    ]);
    expect(JSON.parse(readFileSync(agentPath(stateDir, 'coordinator'), 'utf8'))).toEqual([
      'skills/wave-executor/wave-loop.md',
    ]);
    expect(JSON.parse(readFileSync(aggregatePath(stateDir), 'utf8'))).toEqual(VALID_SCOPES);
  });

  it('emits machine-readable paths with --json', () => {
    const stateDir = makeStateDir();

    const result = runCli({ stateDir, args: ['--json'] });

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      aggregatePath: aggregatePath(stateDir),
      perAgentPaths: [agentPath(stateDir, 'W7-I1'), agentPath(stateDir, 'coordinator')],
    });
  });

  it('rejects malformed declarations before creating any scope file', () => {
    const stateDir = makeStateDir();

    const result = runCli({
      stateDir,
      scopes: [
        { id: 'W7-I1', files: ['scripts/alpha.mjs'] },
        { id: 'w7-i1', files: ['scripts/beta.mjs'] },
      ],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/duplicate id/i);
    expect(existsSync(join(stateDir, 'filescopes'))).toBe(false);
  });

  it('rejects a declaration array with no coordinator before creating scope files', () => {
    const stateDir = makeStateDir();
    const result = runCli({
      stateDir,
      scopes: [{ id: 'W7-I1', files: ['scripts/alpha.mjs'] }],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/exactly one coordinator/i);
    expect(existsSync(join(stateDir, 'filescopes'))).toBe(false);
  });

  it('rejects Coordinator before it can write a non-canonical scope file', () => {
    const stateDir = makeStateDir();
    const result = runCli({
      stateDir,
      scopes: [
        { id: 'W7-I1', files: ['scripts/alpha.mjs'] },
        { id: 'Coordinator', files: ['skills/wave-executor/wave-loop.md'] },
      ],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/id.*coordinator.*lowercase/i);
    expect(existsSync(join(stateDir, 'filescopes'))).toBe(false);
  });

  it('rejects an unsafe id before it becomes an output filename', () => {
    const result = runCli({
      stateDir: makeStateDir(),
      scopes: [{ id: '../escape', files: ['scripts/alpha.mjs'] }],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/unsafe id/i);
  });

  it('rejects path traversal in a declared scope before any write', () => {
    const stateDir = makeStateDir();
    const result = runCli({
      stateDir,
      scopes: [{ id: 'coordinator', files: ['../escape.mjs'] }],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/path traversal/i);
    expect(existsSync(join(stateDir, 'filescopes'))).toBe(false);
  });

  it('rejects a non-positive wave number as input', () => {
    const result = runCli({ stateDir: makeStateDir(), wave: 0 });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/positive integer/i);
  });

  it('rejects a state directory containing a newline as input', () => {
    const stateDir = makeStateDir();
    const result = runCli({ stateDir: `${stateDir}\nnext` });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/state-dir/i);
  });

  it('does not publish an aggregate when an injected per-agent writer fails', () => {
    const stateDir = makeStateDir();
    const writers = [
      (target, data, options) => writeJsonAtomicSync(target, data, options),
      () => ({ ok: false, reason: 'fs-error', error: 'injected failure' }),
    ];

    expect(() => materializeWaveScope(VALID_SCOPES, {
      stateDir,
      wave: 7,
      writeJson: (...args) => writers.shift()(...args),
    })).toThrow(/cannot write per-agent declaration/);
    expect(existsSync(agentPath(stateDir, 'W7-I1'))).toBe(true);
    expect(existsSync(agentPath(stateDir, 'coordinator'))).toBe(false);
    expect(existsSync(aggregatePath(stateDir))).toBe(false);
  });

  it('invalidates an old aggregate before a rematerialized per-agent write fails', () => {
    const stateDir = makeStateDir();
    const nextScopes = [
      { id: 'W7-I1', files: ['scripts/replaced.mjs'] },
      { id: 'coordinator', files: ['skills/replaced.md'] },
    ];
    const writers = [
      (target, data, options) => writeJsonAtomicSync(target, data, options),
      () => ({ ok: false, reason: 'fs-error', error: 'injected failure' }),
    ];

    materializeWaveScope(VALID_SCOPES, { stateDir, wave: 7 });

    expect(() => materializeWaveScope(nextScopes, {
      stateDir,
      wave: 7,
      writeJson: (...args) => writers.shift()(...args),
    })).toThrow(/cannot write per-agent declaration/);
    expect(JSON.parse(readFileSync(agentPath(stateDir, 'W7-I1'), 'utf8'))).toEqual(['scripts/replaced.mjs']);
    expect(existsSync(aggregatePath(stateDir))).toBe(false);

    const validation = spawnSync(
      process.execPath,
      [resolve(REPO_ROOT, 'scripts/validate-wave-scope.mjs'), '--assert-disjoint', aggregatePath(stateDir), '--union', aggregatePath(stateDir)],
      {
        input: JSON.stringify({
          wave: 7,
          role: 'Quality',
          enforcement: 'warn',
          allowedPaths: [],
          blockedCommands: [],
        }),
        encoding: 'utf8',
        cwd: REPO_ROOT,
      },
    );

    expect(validation.status).toBe(2);
    expect(validation.stderr).toMatch(/cannot read/i);
  });

  it('returns exit 2 without per-agent writes when aggregate invalidation fails', () => {
    const stateDir = makeStateDir();
    mkdirSync(aggregatePath(stateDir), { recursive: true });

    const result = runCli({ stateDir });

    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/cannot invalidate aggregate declaration/i);
    expect(existsSync(agentPath(stateDir, 'W7-I1'))).toBe(false);
  });

  it('materializes a sidecar that the real disjointness check rejects before union', () => {
    const stateDir = makeStateDir();
    const collidingScopes = [
      { id: 'W7-I1', files: ['scripts/alpha.mjs'] },
      { id: 'coordinator', files: ['scripts/alpha.mjs'] },
    ];
    const materialized = runCli({ stateDir, scopes: collidingScopes });
    const sidecar = aggregatePath(stateDir);
    const manifest = JSON.stringify({
      wave: 7,
      role: 'Quality',
      enforcement: 'warn',
      allowedPaths: [],
      blockedCommands: [],
    });
    const validation = spawnSync(
      process.execPath,
      [resolve(REPO_ROOT, 'scripts/validate-wave-scope.mjs'), '--assert-disjoint', sidecar, '--union', sidecar],
      { input: manifest, encoding: 'utf8', cwd: REPO_ROOT },
    );

    expect(materialized.code).toBe(0);
    expect(validation.status).toBe(1);
    expect(validation.stdout).toBe('');
    expect(validation.stderr).toMatch(/wave scope collision/);
  });

  it('materializes a sidecar that the real union query consumes for a disjoint wave', () => {
    const stateDir = makeStateDir();
    const materialized = runCli({ stateDir });
    const sidecar = aggregatePath(stateDir);
    const manifest = JSON.stringify({
      wave: 7,
      role: 'Quality',
      enforcement: 'warn',
      allowedPaths: [],
      blockedCommands: [],
    });
    const union = spawnSync(
      process.execPath,
      [resolve(REPO_ROOT, 'scripts/validate-wave-scope.mjs'), '--assert-disjoint', sidecar, '--union', sidecar],
      { input: manifest, encoding: 'utf8', cwd: REPO_ROOT },
    );

    expect(materialized.code).toBe(0);
    expect(union.status).toBe(0);
    expect(JSON.parse(union.stdout)).toEqual([
      'scripts/alpha.mjs',
      'tests/scripts/alpha.test.mjs',
      'skills/wave-executor/wave-loop.md',
    ]);
  });

  it('returns exit 1 for missing CLI input and prints comprehensive help', () => {
    const missingArgs = spawnSync(process.execPath, [SCRIPT], { input: '[]', encoding: 'utf8', cwd: REPO_ROOT });
    const help = spawnSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8', cwd: REPO_ROOT });

    expect(missingArgs.status).toBe(1);
    expect(missingArgs.stderr).toMatch(/--state-dir.*required/i);
    expect(help.status).toBe(0);
    expect(help.stdout).toMatch(/--state-dir/);
    expect(help.stdout).toMatch(/--wave/);
    expect(help.stdout).toMatch(/Exit codes/);
  });
});
