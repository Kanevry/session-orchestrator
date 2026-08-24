/**
 * tests/setup/host-alias-guard.test.mjs
 *
 * THE BUG THIS CATCHES (TV-001): a lock-taking test appends a fixture hostname
 * to the operator's REAL `~/.config/session-orchestrator/host-aliases.json`,
 * because `recordHostAlias()` fires from inside `buildLock()`. That ledger is
 * read by `hostnamesMatch()` to decide whether a lock belongs to this machine
 * (#1072), so the damage outlives the run and lands outside the repo.
 *
 * The decisive case is the last one: it does not assert on a variable, it calls
 * the PRODUCTION writer `recordHostAlias()` with the guard's value in place and
 * proves the name landed in the tmp file while the real ledger stayed
 * byte-identical.
 *
 * The wiring check asserts on the imported vitest config, not on `process.env`,
 * for the reason measured in `vault-guard.test.mjs`: a `process.env` assertion
 * in THIS file is satisfied by this file's own import of the guard, so it would
 * pass with the `setupFiles` entry deleted. "Built but not wired" is a failure
 * class this repo hits repeatedly (`check-unwired-features.mjs`).
 *
 * Every case passes an ISOLATED `tmpRoot` + `runId`, so no test touches the
 * live guard file its own worker is pointed at.
 *
 * PORTABLE — no hardcoded home paths; `os.homedir()` is read at runtime.
 */

import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  guardHostAliasesFile,
  HOST_ALIAS_GUARD_OPT_OUT,
  HOST_ALIAS_GUARD_PREFIX,
  HOST_ALIAS_GUARD_BASENAME,
} from './host-alias-guard.mjs';
import { recordHostAlias, readHostAliases } from '../../scripts/lib/host-identity.mjs';
import vitestConfig from '../../vitest.config.mjs';

/** The path `_hostAliasesFile()` falls back to when the env var is unset. */
const REAL_LEDGER = path.join(os.homedir(), '.config', 'session-orchestrator', 'host-aliases.json');

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
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'host-alias-guard-spec-'));
  created.push(root);
  return root;
}

describe('guardHostAliasesFile — the suite never writes the operator’s alias ledger', () => {
  it('redirects an UNSET SO_HOST_ALIASES_FILE away from the real ledger', () => {
    // bug_caught: the default. Unset is exactly the state in which
    // _hostAliasesFile() resolves to ~/.config/session-orchestrator, so a suite
    // that inherits a clean env is the one that writes there.
    const tmpRoot = isolatedRoot();
    const env = {};

    const result = guardHostAliasesFile(env, { tmpRoot, runId: 'unset' });

    expect(result.applied).toBe(true);
    expect(result.reason).toBe('unset');
    expect(result.previous).toBeUndefined();
    expect(env.SO_HOST_ALIASES_FILE).toBe(result.aliasFile);
    expect(result.aliasFile).toBe(
      path.join(tmpRoot, `${HOST_ALIAS_GUARD_PREFIX}unset`, HOST_ALIAS_GUARD_BASENAME),
    );
    expect(result.aliasFile).not.toBe(REAL_LEDGER);
    expect(fs.existsSync(path.dirname(result.aliasFile))).toBe(true);
  });

  it('gives every worker of one run the SAME file, not one per test file', () => {
    // bug_caught: `pool: 'forks'` forks a fresh process per TEST FILE, each
    // re-evaluating the setup file with the PARENT's env — so a mkdtemp-based
    // guard leaves one directory per test file per run (~400 over the full
    // suite). The second call uses a FRESH env object, which is what a new fork
    // actually sees.
    const tmpRoot = isolatedRoot();

    const first = guardHostAliasesFile({}, { tmpRoot, runId: 'shared' });
    const second = guardHostAliasesFile({}, { tmpRoot, runId: 'shared' });

    expect(first.minted).toBe(true);
    expect(second.minted).toBe(false);
    expect(second.aliasFile).toBe(first.aliasFile);
  });

  it('refuses to reuse a SYMLINK squatting on the derived path, and mints a fresh dir instead', () => {
    // bug_caught: the directory name is DERIVED (`<tmp>/<prefix><ppid>`) and the
    // OS temp root is world-writable, so a pre-planted symlink was followed
    // unchecked — and what gets written through it is `recordHostAlias()`'s
    // ledger, the file `hostnamesMatch()` consults to decide whether a lock
    // belongs to THIS machine.
    const tmpRoot = isolatedRoot();
    const target = path.join(tmpRoot, 'attacker-target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(tmpRoot, `${HOST_ALIAS_GUARD_PREFIX}squat`));

    const result = guardHostAliasesFile({}, { tmpRoot, runId: 'squat' });

    expect(result.applied).toBe(true);
    expect(result.minted).toBe(true);
    expect(path.dirname(result.aliasFile)).not.toBe(path.join(tmpRoot, `${HOST_ALIAS_GUARD_PREFIX}squat`));
    expect(fs.lstatSync(path.dirname(result.aliasFile)).isSymbolicLink()).toBe(false);
    expect(fs.lstatSync(path.dirname(result.aliasFile)).isDirectory()).toBe(true);
    expect(fs.readdirSync(target)).toEqual([]);
  });

  it('refuses to reuse a plain FILE at the derived path', () => {
    const tmpRoot = isolatedRoot();
    fs.writeFileSync(path.join(tmpRoot, `${HOST_ALIAS_GUARD_PREFIX}file`), 'not a directory');

    const result = guardHostAliasesFile({}, { tmpRoot, runId: 'file' });

    expect(result.applied).toBe(true);
    expect(fs.lstatSync(path.dirname(result.aliasFile)).isDirectory()).toBe(true);
  });

  it('keeps a value the caller already set — the two suites that redirect per-test', () => {
    // bug_caught: clobbering tests/lib/host-identity.test.mjs and
    // tests/lib/session-lock.test.mjs, which assign their own fixture path and
    // restore the previous value afterwards. Unlike SO_VAULT_DIR there is no
    // lower tier to outrank here: an inherited value is already a redirection
    // AWAY from the real ledger, since the real ledger is the UNSET case.
    const own = path.join(isolatedRoot(), 'caller-owned.json');
    const env = { SO_HOST_ALIASES_FILE: own };

    const result = guardHostAliasesFile(env, { tmpRoot: isolatedRoot(), runId: 'inherited' });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('inherited');
    expect(env.SO_HOST_ALIASES_FILE).toBe(own);
  });

  it('leaves the env untouched when a caller opts out explicitly', () => {
    // bug_caught: the opposite failure — a guard with no escape hatch forces
    // the one legitimate case (deliberately exercising the real ledger) to
    // disable the whole setup file instead of one variable.
    const env = { [HOST_ALIAS_GUARD_OPT_OUT]: '1' };

    const result = guardHostAliasesFile(env, { tmpRoot: isolatedRoot(), runId: 'opt-out' });

    expect(result.applied).toBe(false);
    expect(result.reason).toBe('opt-out');
    expect(env.SO_HOST_ALIASES_FILE).toBeUndefined();
  });

  it('recordHostAlias writes the guarded tmp file and leaves the real ledger byte-identical', () => {
    // bug_caught: THE one. recordHostAlias() fires inside buildLock(), so every
    // acquire()/forceAcquire() in the suite appends to whatever
    // _hostAliasesFile() resolves to. This drives the production writer, not a
    // re-implementation, and pins BOTH halves: the fixture name lands in the
    // tmp file AND the operator's ledger is unchanged.
    const before = fs.existsSync(REAL_LEDGER) ? fs.readFileSync(REAL_LEDGER, 'utf8') : null;
    const fixtureName = `so-guard-fixture-${randomUUID()}`;

    const env = {};
    const result = guardHostAliasesFile(env, { tmpRoot: isolatedRoot(), runId: 'writer' });

    const restore = process.env.SO_HOST_ALIASES_FILE;
    process.env.SO_HOST_ALIASES_FILE = env.SO_HOST_ALIASES_FILE;
    try {
      const ledger = recordHostAlias(fixtureName);
      expect(ledger).toContain(fixtureName);
      expect(readHostAliases()).toContain(fixtureName);
    } finally {
      if (restore === undefined) delete process.env.SO_HOST_ALIASES_FILE;
      else process.env.SO_HOST_ALIASES_FILE = restore;
    }

    expect(JSON.parse(fs.readFileSync(result.aliasFile, 'utf8'))).toContain(fixtureName);

    const after = fs.existsSync(REAL_LEDGER) ? fs.readFileSync(REAL_LEDGER, 'utf8') : null;
    expect(after).toBe(before);
  });

  it('is WIRED: vitest.config.mjs registers it as a setupFile', () => {
    // bug_caught: the guard exists but nothing loads it — the "built but not
    // wired" class (check-unwired-features.mjs). Only files listed here run for
    // EVERY test file; a guard outside that list protects only the tests that
    // happen to import it, which is the discipline it exists to replace.
    expect(vitestConfig.test.setupFiles).toContain('./tests/setup/host-alias-guard.mjs');
  });
});
