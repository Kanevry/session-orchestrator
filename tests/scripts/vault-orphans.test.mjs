/**
 * tests/scripts/vault-orphans.test.mjs
 *
 * CLI contract of scripts/vault-orphans.mjs (#1563): exit codes and the JSON
 * shape session-end Phase 3.7e consumes. Every run passes --vault-dir AND sets
 * SO_VAULT_DIR to a tmp dir, because vault-dir resolves host-locally and would
 * otherwise reach the real vault. The script is addressed relative to this
 * file, never via process.cwd().
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/vault-orphans.mjs', import.meta.url));

let tmp;

beforeEach(() => {
  tmp = makeTmpDir('so-vault-orphans-cli-');
});

afterEach(() => {
  removeTree(tmp);
});

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: tmp,
    encoding: 'utf8',
    env: { ...process.env, SO_VAULT_DIR: tmp },
  });
}

describe('vault-orphans CLI', () => {
  // Bug caught: the JSON the close procedure parses drifting from the module
  // result, or a measured run exiting non-zero.
  it('prints the module result as JSON and exits 0 for a measured vault', () => {
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    fixtureGit(['init', '-q'], vault);
    const since = new Date(Date.now() - 60_000).toISOString();
    writeFileSync(join(vault, 'audit.md'), '# audit\n');

    const r = run(['--json', '--vault-dir', vault, '--since', since]);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out).toMatchObject({ status: 'ok', total: 1, truncated: false, untracked: 1 });
    expect(out.candidates).toEqual([{ path: 'audit.md', mtimeMs: expect.any(Number) }]);
  });

  // Bugs caught: "could not measure" exiting 0 like a clean run; a malformed
  // --since parsed to NaN, which matches no mtime and reads as "nothing found".
  it('exits 2 when it cannot measure and 1 on a malformed --since', () => {
    const notRepo = run(['--json', '--vault-dir', tmp, '--since', '2026-10-11T08:00:00.000Z']);
    expect(notRepo.status).toBe(2);
    expect(JSON.parse(notRepo.stdout)).toMatchObject({ status: 'unavailable', candidates: [] });

    const badSince = run(['--json', '--vault-dir', tmp, '--since', 'yesterday']);
    expect(badSince.status).toBe(1);
    expect(badSince.stdout).toBe('');
  });
});
