/**
 * tests/_helpers/tmp-fixture.mjs — one place for the three things every git
 * fixture in this suite gets wrong on a loaded host.
 *
 * ## The measured incident (2026-09-06)
 *
 * The full suite was red 1–2 tests per run, never the same test twice — the
 * signature of a race, not a defect. `GIT_TRACE=1` on a bare fixture commit
 * (git 2.55.0) printed the cause verbatim:
 *
 *     trace: run_command: git maintenance run --auto --quiet --detach
 *
 * Three trace lines, one DETACHED grandchild. `execFileSync` returns when the
 * `git commit` child exits; the detached `git maintenance` keeps writing into
 * `<fixture>/.git` (reflog expiry, loose-object gc, commit-graph) for an
 * unbounded time afterwards. The test's `afterEach` then runs a bare
 * `rmSync(dir, { recursive: true, force: true })` against a directory that a
 * live process is still creating files in, and the removal fails with
 * `ENOTEMPTY` — which surfaces as a failing test in whichever file happened to
 * be scheduled when the host was busy. Measured that day in
 * `tests/scripts/validate/check-guard-requires-parity.test.mjs:71`; a different
 * file had failed the same way in the previous run.
 *
 * ## Why BOTH halves are needed
 *
 * {@link fixtureGit} removes the WRITER: `maintenance.auto=false` and
 * `gc.auto=0` stop git from spawning the detached maintenance child at all, and
 * `core.fsmonitor=false` stops a long-lived file-system-monitor daemon from
 * being started against a directory that is about to be deleted. That is the
 * root cause and it is closed at the source.
 *
 * {@link removeTree} covers what config cannot reach: a grandchild that a
 * previous, not-yet-converted call site already started; a process killed
 * mid-write; and — on macOS — Spotlight/`mds` indexing a freshly written tree,
 * plus the `.DS_Store` a Finder window can drop into it. `maxRetries: 5` with
 * `retryDelay: 50` is Node's own back-off for exactly `ENOTEMPTY`/`EBUSY`.
 * Neither half subsumes the other: config alone still loses to a foreign
 * writer, retry alone still loses to a maintenance run that outlives the
 * back-off window.
 *
 * ## Ceiling (BV-004)
 *
 * The retry back-off is bounded — Node retries with a linearly increasing delay
 * capped by `retryDelay`, so roughly 250 ms in total. A child that holds the
 * fixture directory open LONGER than that is not covered and will still throw
 * `ENOTEMPTY`. Revisit trigger: the first `ENOTEMPTY` observed in a test that
 * already routes its cleanup through `removeTree`. The answer then is not a
 * bigger number — it is finding the writer that config did not stop, the same
 * way the 2026-09-06 one was found (`GIT_TRACE=1`).
 *
 * ## Relationship to tests/setup/scrub-git-env.mjs
 *
 * That file is the worker-wide half: it strips inherited `GIT_*` variables once,
 * before any test runs, so no call site has to remember. This file is the
 * per-call half: it pins the config channel POSITIVELY (`-c` flags, and
 * `GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` pointed at `/dev/null`) so a fixture
 * cannot pick up the developer's own `~/.gitconfig` — an `[maintenance] auto`
 * or a `core.hooksPath` there would otherwise reopen the hole the `-c` flags
 * close. Both are needed; neither is a substitute for the other.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The `-c` flags that stop git from spawning a detached background writer.
 * Prepended to every argv so they apply to the invocation regardless of which
 * subcommand follows.
 */
const NO_BACKGROUND_WRITER = Object.freeze([
  '-c',
  'maintenance.auto=false',
  '-c',
  'gc.auto=0',
  '-c',
  'core.fsmonitor=false',
]);

/**
 * The config-isolation environment. `/dev/null` is a readable empty file on
 * every platform this suite runs on, so git parses it as an empty config
 * rather than erroring; `GIT_CONFIG_NOSYSTEM=1` closes the system-config
 * channel a second way, because it is honoured by git versions that predate
 * `GIT_CONFIG_SYSTEM`.
 */
function isolationEnv(extra) {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    ...extra,
  };
}

/**
 * Run a fixture `git` command with the background writer disabled and the
 * global/system config channels closed. Throws on a non-zero exit, exactly like
 * the `execFileSync` calls it replaces.
 *
 * @param {string[]} args     git argv WITHOUT the leading `git`.
 * @param {string} [cwd]      working directory for the child. Omit only when
 *                            the argv itself names the target (`-C <dir>`, or a
 *                            path argument to `git init`).
 * @param {object} [opts]     extra `execFileSync` options; `opts.env` is MERGED
 *                            over the isolation environment, never replacing it.
 * @returns {string} stdout, decoded as utf8 unless `opts.encoding` says otherwise.
 */
export function fixtureGit(args, cwd, opts = {}) {
  const { env, ...rest } = opts;
  return execFileSync('git', [...NO_BACKGROUND_WRITER, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
    env: isolationEnv(env),
    ...rest,
  });
}

/**
 * The `spawnSync` sibling of {@link fixtureGit}, for the call sites whose
 * SUBJECT is a git command that is expected to fail (a blocked commit, a
 * rejected push). Those tests assert on `result.status`/`result.stderr`, so
 * converting them to the throwing form would change what they assert — this
 * keeps the assertions byte-identical while still applying the same config and
 * environment isolation.
 *
 * @param {string[]} args
 * @param {string} [cwd]
 * @param {object} [opts]
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
export function fixtureGitSpawn(args, cwd, opts = {}) {
  const { env, ...rest } = opts;
  return spawnSync('git', [...NO_BACKGROUND_WRITER, ...args], {
    ...(cwd === undefined ? {} : { cwd }),
    encoding: 'utf8',
    env: isolationEnv(env),
    ...rest,
  });
}

/**
 * Remove a fixture tree, retrying the bounded back-off described in the module
 * header. Use everywhere a test deletes a directory it created.
 *
 * @param {string} p  absolute path to remove.
 */
export function removeTree(p) {
  rmSync(p, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

/**
 * `mkdtempSync` under the REAL temp directory. On macOS `os.tmpdir()` returns
 * `/var/folders/...`, a symlink into `/private/var/folders/...`, and git —
 * along with anything else that resolves a path — reports the resolved form. A
 * test that compares a path it constructed against a path a tool reported then
 * fails on the prefix alone. Resolving once here removes that whole class.
 *
 * @param {string} prefix  mkdtemp prefix, e.g. `'so-fixture-'`.
 * @returns {string} the created directory, already realpath-resolved.
 */
export function makeTmpDir(prefix) {
  return mkdtempSync(join(realpathSync(tmpdir()), prefix));
}
