/**
 * tests/setup/vault-guard.test.mjs
 *
 * THE BUG THIS CATCHES (TV-001): a vault write that leaves the fixture and lands
 * in the operator's REAL vault, because `vault-dir` resolves host-locally and the
 * test only faked the source repo.
 *
 * The decisive test is the resolver one: it does not assert on a variable, it
 * drives the REAL resolver — `parseSessionConfig(md, { hostPaths })` over
 * `scripts/lib/config/host-paths.mjs` — with an owner.yaml loader that points at
 * `~/Projects/vault`, exactly as the host does. Its control case (the same config,
 * the same fake owner.yaml, an UNGUARDED env) resolves to the real vault, so the
 * assertion is proven to discriminate rather than merely to pass.
 *
 * The last is the wiring check, and it asserts on the imported vitest config
 * rather than on `process.env` for a measured reason recorded at its own body: a
 * `process.env` assertion in THIS file is satisfied by this file's own import of
 * the guard, so it passed with the `setupFiles` entry deleted. A guard that
 * exists but is not registered is a failure class this repo has hit repeatedly
 * (`check-unwired-features.mjs`), so the check has to be one the missing
 * registration can actually fail.
 *
 * Every case passes an ISOLATED `tmpRoot` + `runId`, so no test touches the live
 * guard directory its own worker is pointed at.
 *
 * PORTABLE — no hardcoded home paths; `os.homedir()` is read at runtime.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { guardVaultDir, VAULT_GUARD_OPT_OUT, VAULT_GUARD_PREFIX } from './vault-guard.mjs';
import { parseSessionConfig } from '../../scripts/lib/config.mjs';
import { loadHostPaths } from '../../scripts/lib/config/host-paths.mjs';
import vitestConfig from '../../vitest.config.mjs';

/** The path the committed CLAUDE.md and the host owner.yaml both point at. */
const REAL_VAULT = path.join(os.homedir(), 'Projects', 'vault');

const created = [];
afterEach(() => {
  while (created.length > 0) {
    try {
      fs.rmSync(created.pop(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/** A throwaway, already-canonical temp root owned by one test. */
function isolatedRoot() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vault-guard-spec-'));
  created.push(root);
  return root;
}

describe('guardVaultDir — the suite never resolves vault-dir to the host vault', () => {
  it('displaces an inherited SO_VAULT_DIR that points at the real vault', () => {
    // bug_caught: an exported SO_VAULT_DIR=~/Projects/vault in the invoking
    // shell. It is the HIGHEST-precedence pointer there is, so nothing further
    // down the chain — not a fixture CLAUDE.md, not a hermetic hostPaths ctx
    // that forwards process.env — can outrank it.
    const tmpRoot = isolatedRoot();
    const env = { SO_VAULT_DIR: REAL_VAULT };

    const result = guardVaultDir(env, { tmpRoot, runId: 'displace' });

    expect(result.applied).toBe(true);
    expect(result.reason).toBe('redirected');
    expect(result.previous).toBe(REAL_VAULT);
    expect(env.SO_VAULT_DIR).toBe(result.vaultDir);
    expect(result.vaultDir).toBe(path.join(tmpRoot, `${VAULT_GUARD_PREFIX}displace`));
    expect(fs.existsSync(result.vaultDir)).toBe(true);
  });

  it('gives every worker of one run the SAME directory, not one per test file', () => {
    // bug_caught: `pool: 'forks'` forks a fresh process per TEST FILE, each
    // re-evaluating the setup file with the PARENT's env — so a mkdtemp-based
    // guard leaves one directory per test file per run (measured: delta 3 over a
    // 3-file run, ~400 over the full suite). The second call below uses a FRESH
    // env object precisely because that is what a new fork sees.
    const tmpRoot = isolatedRoot();

    const first = guardVaultDir({}, { tmpRoot, runId: 'shared' });
    const second = guardVaultDir({}, { tmpRoot, runId: 'shared' });

    expect(first.minted).toBe(true);
    expect(second.minted).toBe(false);
    expect(second.vaultDir).toBe(first.vaultDir);
  });

  it('refuses to reuse a SYMLINK squatting on the derived path, and mints a fresh dir instead', () => {
    // bug_caught: the guard directory name is DERIVED (`<tmp>/<prefix><ppid>`),
    // so it is predictable, and the OS temp root is world-writable. A symlink
    // pre-planted at that path was followed unchecked — every guarded vault
    // write then landed at its target, i.e. wherever the planter chose.
    const tmpRoot = isolatedRoot();
    const target = path.join(tmpRoot, 'attacker-target');
    fs.mkdirSync(target);
    const squatted = path.join(tmpRoot, `${VAULT_GUARD_PREFIX}squat`);
    fs.symlinkSync(target, squatted);

    const result = guardVaultDir({}, { tmpRoot, runId: 'squat' });

    expect(result.applied).toBe(true);
    expect(result.vaultDir).not.toBe(squatted);
    expect(result.minted).toBe(true);
    // A REAL directory, not a link — lstat is the check that can tell.
    expect(fs.lstatSync(result.vaultDir).isDirectory()).toBe(true);
    expect(fs.lstatSync(result.vaultDir).isSymbolicLink()).toBe(false);
    // And nothing was written through the planted link.
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('refuses to reuse a plain FILE at the derived path', () => {
    const tmpRoot = isolatedRoot();
    fs.writeFileSync(path.join(tmpRoot, `${VAULT_GUARD_PREFIX}file`), 'not a directory');

    const result = guardVaultDir({}, { tmpRoot, runId: 'file' });

    expect(result.applied).toBe(true);
    expect(fs.lstatSync(result.vaultDir).isDirectory()).toBe(true);
  });

  it('leaves the env untouched when a caller opts out explicitly', () => {
    // bug_caught: the opposite failure — a guard with no escape hatch, which
    // forces the one legitimate case (deliberately exercising the real vault
    // path) to disable the whole setup file instead of one variable.
    const env = { SO_VAULT_DIR: REAL_VAULT, [VAULT_GUARD_OPT_OUT]: '1' };

    const result = guardVaultDir(env, { tmpRoot: isolatedRoot(), runId: 'opt-out' });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('opt-out');
    expect(env.SO_VAULT_DIR).toBe(REAL_VAULT);
  });

  it('outranks an owner.yaml vault-dir in the REAL resolver — control resolves to the host vault', () => {
    // bug_caught: the whole point. owner.yaml (tier 2) beats the committed
    // CLAUDE.md value (tier 3), so a fixture repo whose CLAUDE.md names a tmp
    // vault STILL resolves to the host's real vault unless something occupies
    // tier 1. This drives the production resolver, not a re-implementation.
    const ownerLoader = () => ({ config: { paths: { 'vault-dir': REAL_VAULT } } });
    const configMd =
      '# Repo\n\n## Session Config\n\nvault-integration:\n' +
      `  enabled: true\n  vault-dir: ${REAL_VAULT}\n  mode: warn\n`;

    // Control: nothing in tier 1 → the host's owner.yaml wins and the resolved
    // destination IS the operator's vault.
    const control = parseSessionConfig(configMd, {
      hostPaths: loadHostPaths({ env: {}, ownerLoader }),
    });
    expect(control['vault-integration']['vault-dir']).toBe(REAL_VAULT);

    // Guarded: the same config, the same owner.yaml, one variable set.
    const env = {};
    const result = guardVaultDir(env, { tmpRoot: isolatedRoot(), runId: 'resolver' });
    const guarded = parseSessionConfig(configMd, {
      hostPaths: loadHostPaths({ env, ownerLoader }),
    });

    expect(guarded['vault-integration']['vault-dir']).toBe(result.vaultDir);
    expect(guarded['vault-integration']['vault-dir']).not.toBe(REAL_VAULT);
  });

  it('is WIRED: vitest.config.mjs registers it as a setupFile', () => {
    // bug_caught: the guard exists but nothing loads it — the "built but not
    // wired" class (check-unwired-features.mjs). Only the files listed here run
    // for EVERY test file; a guard outside that list protects only the tests
    // that happen to import it, which is the discipline it exists to replace.
    //
    // MEASURED, and the reason this assertion is on the config and not on
    // `process.env`: the process.env form was written first and PASSED with the
    // setupFiles entry deleted (`Tests 4 passed`, EXIT=0), because THIS file
    // imports ./vault-guard.mjs and that import re-runs the module-level call.
    // An assertion its own test file satisfies cannot fail — assert-nothing,
    // per testing.md. This one goes red the moment the entry is removed.
    expect(vitestConfig.test.setupFiles).toContain('./tests/setup/vault-guard.mjs');
  });
});
