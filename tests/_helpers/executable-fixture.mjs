/**
 * tests/_helpers/executable-fixture.mjs — fake binaries and git hooks WITHOUT
 * launching a freshly written executable.
 *
 * ## The cost this removes (#1489 Pkt 13)
 *
 * On macOS the FIRST exec of a newly written executable — a `#!/bin/sh` stub
 * just written and chmod'ed 0o755 — waits on a system-wide exec-policy check.
 * Measured 2026-10-02: 176–295 ms alone, p50 ~1.9 s / max ~3.5 s with 24 such
 * launches in parallel, against 62 / 135 ms for a symlink to an existing binary.
 * It is the one fixture cost that grows with host-wide contention: a pre-push
 * full gate timed out on `tests/setup/scrub-git-env.test.mjs` for exactly this.
 * Every helper here launches only binaries that already exist (the running node
 * binary, `sh`) and writes the fake's logic into a plain, NON-executable file.
 *
 * ## installNodeCli — a fake CLI found by NAME (on PATH or via a path flag)
 *
 * `<binDir>/<name>` is a symlink to `process.execPath`. Node treats the fake's
 * FIRST argument as its script, resolved against the CALLER's cwd, so with
 * `scripts: { issue: src }` the call `glab issue view 7` runs the plain file
 * `<cwd>/issue` with `process.argv.slice(2) = ['view', '7']`. Each script gets
 * a prelude binding `ARGS` to the full original argv (`['issue', 'view', '7']`)
 * and `fs` to `node:fs`, valid whether node loads the file as CJS or ESM.
 *
 * Limits (BV-004 ceiling), all inherent to the mechanism:
 * - the first argument must be a plain word — node parses a leading option
 *   itself (`claude -p …` is `node --print`), so such a CLI cannot use this;
 * - `<name> --version` is answered by node (prints its own version, exit 0);
 * - the code under test must run the fake with `cwd` as its working directory;
 * - an unknown first word fails with node's MODULE_NOT_FOUND (non-zero exit).
 * Revisit if a call site needs any of these: that needs a production seam
 * (a binary + args override), not a cleverer fake.
 *
 * ## installGitHook — a hook git runs on `<event>`
 *
 * Where the git on PATH supports config-based hooks (`hook.<name>.command`, see
 * `git help config`), the body goes into a plain file run as `sh <file>` — the
 * same interpreter a `#!/usr/bin/env sh` hook gets. Older git (e.g. 2.39 in the
 * Debian CI images) has no such channel, so the fallback writes the classic
 * executable `.git/hooks/<event>`: unchanged behaviour, and those hosts do not
 * carry the macOS cost anyway. Support is PROBED (a hook that must block a
 * commit), never inferred from a version number.
 */

import { chmodSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureGit, fixtureGitSpawn, makeTmpDir, removeTree } from './tmp-fixture.mjs';

const PRELUDE =
  "const ARGS = [process.argv[1].split(/[\\\\/]/).pop(), ...process.argv.slice(2)];\n" +
  "const fs = process.getBuiltinModule('node:fs');\n";

/**
 * Install a fake CLI `name` in `binDir`, its subcommands as plain scripts in `cwd`.
 *
 * @param {string} binDir  existing directory to hold the `name` symlink.
 * @param {string} name    binary name the code under test looks up.
 * @param {string} cwd     working directory the code under test runs the fake in.
 * @param {Record<string, string>} scripts  first-argument word → script source.
 * @returns {string} absolute path of the fake binary (for `--x-bin <path>` flags).
 */
export function installNodeCli(binDir, name, cwd, scripts) {
  const bin = join(binDir, name);
  symlinkSync(process.execPath, bin);
  for (const [word, source] of Object.entries(scripts)) {
    writeFileSync(join(cwd, word), PRELUDE + source);
  }
  return bin;
}

let configHooksSupported;

/** Memoised probe: does the git on PATH run a `hook.<name>.command` hook? */
function gitRunsConfigHooks() {
  if (configHooksSupported !== undefined) return configHooksSupported;
  const dir = makeTmpDir('so-config-hook-probe-');
  try {
    fixtureGit(['init', '-q', dir]);
    fixtureGit(['-C', dir, 'config', 'hook.so-probe.event', 'pre-commit']);
    fixtureGit(['-C', dir, 'config', 'hook.so-probe.command', 'exit 3']);
    const r = fixtureGitSpawn([
      '-C', dir, '-c', 'user.email=probe@example.com', '-c', 'user.name=Probe',
      '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'probe',
    ]);
    configHooksSupported = r.status !== 0;
  } finally {
    removeTree(dir);
  }
  return configHooksSupported;
}

/**
 * Make git run `body` (a POSIX sh script) on `event` in the repo at `repoDir`.
 *
 * @param {string} repoDir  non-bare repository root (contains `.git/`).
 * @param {string} event    hook event, e.g. `'pre-commit'`.
 * @param {string} body     hook script source.
 */
export function installGitHook(repoDir, event, body) {
  const gitDir = join(repoDir, '.git');
  if (gitRunsConfigHooks()) {
    const script = join(gitDir, `so-test-${event}.sh`);
    writeFileSync(script, body);
    fixtureGit(['-C', repoDir, 'config', `hook.so-test-${event}.event`, event]);
    fixtureGit(['-C', repoDir, 'config', `hook.so-test-${event}.command`, `sh '${script.replaceAll("'", "'\\''")}'`]);
    return;
  }
  // Fallback for git without config-based hooks: the fresh executable is the
  // only hook shape that git knows.
  const hook = join(gitDir, 'hooks', event);
  writeFileSync(hook, body);
  chmodSync(hook, 0o755);
}
