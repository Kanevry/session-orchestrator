/**
 * Wiring tests for skills/vault-sync/validator.sh (#1070).
 *
 * Nameable bugs: (a) the dependency probe reports `setup-required` although
 * zod/yaml resolve from the root package — every /close would skip the vault
 * gate; (b) a plugin path containing a quote turns the exit-2 envelope into
 * invalid JSON, so session-end's `jq -r .reason` reads nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { removeTree } from '../_helpers/tmp-fixture.mjs';
import { posixShell } from '../_helpers/posix-shell.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const VALIDATOR_SH = join(REPO_ROOT, 'skills', 'vault-sync', 'validator.sh');

const dirs = [];
afterEach(() => {
  while (dirs.length) removeTree(dirs.pop());
});

function run(script, vaultDir) {
  return spawnSync(posixShell('bash'), [script, vaultDir, '--mode', 'warn'], { encoding: 'utf8' });
}

describe('validator.sh dependency readiness', () => {
  it('runs the validator when zod/yaml resolve from the root package', () => {
    const vault = mkdtempSync(join(tmpdir(), 'vs-sh-vault-'));
    dirs.push(vault);
    const r = run(VALIDATOR_SH, vault);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).status).not.toBe('infra-error');
  });

  it('exits 2 with a valid setup-required envelope when deps are missing, even with quotes and a space in the path', () => {
    const root = mkdtempSync(join(tmpdir(), 'vs-sh-nodeps-'));
    dirs.push(root);
    // `"` is illegal in a Windows file name (SO#1613); the single quote — the
    // character that breaks single-quoted shell words — and the space stay.
    const dirName = process.platform === 'win32' ? 'plug in\'s dir' : 'plug"in\'s dir';
    const skillDir = join(root, dirName, 'skills', 'vault-sync');
    mkdirSync(skillDir, { recursive: true });
    for (const f of ['validator.sh', 'validator.mjs']) {
      copyFileSync(join(REPO_ROOT, 'skills', 'vault-sync', f), join(skillDir, f));
    }
    const r = run(join(skillDir, 'validator.sh'), root);
    expect(r.status).toBe(2);
    const envelope = JSON.parse(r.stderr.trim().split('\n').pop());
    expect(envelope).toMatchObject({ status: 'infra-error', reason: 'setup-required' });
    expect(envelope.setup).toContain('npm ci');
    // The setup hint must survive shell parsing for any path the plugin lives in.
    expect(spawnSync(posixShell('bash'), ['-n', '-c', envelope.setup]).status).toBe(0);
  });
});
