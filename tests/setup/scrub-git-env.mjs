/**
 * tests/setup/scrub-git-env.mjs — vitest `setupFiles` entry.
 *
 * THE BUG THIS CATCHES (TV-001): a test that spawns git writes into the REAL
 * repository instead of its own fixture, because git's repo-pointing environment
 * outranks BOTH `cwd:` and `-C <path>`.
 *
 * This is not hypothetical. On 2026-08-19 a coordinator diagnostic exported
 * GIT_DIR at this repository and ran the suite. Measured consequences in the real
 * .git: HEAD went detached, three fixture commits landed on it, and `.git/config`
 * gained a fixture remote plus the fixture's `user.email`/`user.name` — which then
 * authored two commits that reached both the GitLab origin and the public GitHub
 * mirror. Recovery of the refs was metadata-only; the authorship could not be
 * rewritten at all, because both `main` branches refuse force-pushes.
 *
 * WHY A TARGET IS NOT ENOUGH — this is the part that is easy to get wrong.
 * The two call sites that caused the damage were already correct by every
 * conventional standard:
 *
 *     spawnSync('git', ['remote', 'add', 'gitlab', url], { cwd: vault });
 *
 * A correct `cwd`, and it still wrote to the real repo. Measured, including the
 * positional form that looks safest of all:
 *
 *     ( cd "$T" && GIT_DIR="$T/gd/.git" git init -q "$T/target" )
 *     target has .git?  no          GIT_DIR path became repo?  yes
 *
 * So the static census in scripts/lib/validate/check-test-git-config-target.mjs
 * (which finds untargeted git calls) is a real but DIFFERENT subclass. It reports
 * `gitDirInheritable: 150` precisely because it cannot close this half. This file
 * is that half: remove the variables once, before any test runs, so no individual
 * call site has to remember.
 *
 * ## Why a NAMESPACE SWEEP and not a name list
 *
 * The first version of this file was a name list, and it shipped with a hole of
 * exactly the shape it existed to close. It named `GIT_CONFIG_PARAMETERS` — the
 * `-c key=value` channel — but not `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` /
 * `GIT_CONFIG_VALUE_n`, the ENUMERATED form of the same channel. Neither gates
 * the other. Measured 2026-08-19 in a throwaway /tmp repo, after importing this
 * module: `GIT_CONFIG_PARAMETERS` was gone, `GIT_CONFIG_COUNT=1` /
 * `KEY_0=core.hooksPath` / `VALUE_0=<dir>` were all still set, and `git commit`
 * fired the foreign hook. The identical commit with the variables removed did
 * not fire it. Same door, different handle.
 *
 * `hooks/_lib/guard-source-loader.mjs` hit this class first and solved it with an
 * ALLOWLIST child env (`GIT_ENV_ALLOWLIST`), noting in its own comment that the
 * denylist it replaced had missed `GIT_CONFIG_PARAMETERS`, `GIT_CEILING_DIRECTORIES`
 * and the `GIT_TRACE*` family. That form is not available here and the difference
 * is structural, not a matter of taste: it builds the environment for ONE
 * `execFileSync` git child, where `env:` REPLACES the child environment wholesale
 * and six keys suffice. This file mutates the environment of the vitest WORKER,
 * whose children are node, npm and every process the suite spawns — an allowlist
 * there would have to enumerate PATH, HOME, NODE_*, npm_*, VITEST_*, TMPDIR, CI
 * and whatever any single test legitimately reads, and the first omission is a
 * broken suite rather than a closed hole.
 *
 * The available middle form is an allowlist scoped to the `GIT_` NAMESPACE:
 * sweep every `GIT_*` variable, keep a short set that is justified name by name
 * below. Git's repository, index, object-store and config channels are all
 * `GIT_*` by construction, so a channel a future git release adds is closed
 * before anyone here has heard of it — which is the property the name list could
 * never have.
 */

/**
 * The kept `GIT_*` names. Every entry answers WHO, WHEN or HOW; none answers
 * WHICH REPOSITORY or WHICH CONFIG, and that axis is the only one that can send
 * a fixture's git call into the invoking repo.
 *
 * - `GIT_AUTHOR_*` / `GIT_COMMITTER_*` — identity and dates. They change the
 *   attribution of a fixture commit, never its destination. Every use in this
 *   suite sets them explicitly per spawn (tests/lib/worktree.test.mjs,
 *   tests/integration/snapshot-recovery.test.mjs, and ~10 more), so sweeping
 *   them would close nothing and could only surprise a test that read one.
 * - `GIT_EDITOR` — measured, not hygiene. Claude Code exports `GIT_EDITOR=true`
 *   so git never blocks on an editor, and `EDITOR` is empty in that environment.
 *   Delete it and git falls back to `vi`: any git call wanting an editor HANGS
 *   the worker until the test timeout. Keeping it removes a hang class and
 *   closes nothing.
 * - `GIT_ASKPASS` / `GIT_SSH` / `GIT_SSH_COMMAND` / `GIT_TERMINAL_PROMPT` —
 *   credential and transport plumbing, same trade: removing them converts an
 *   auth prompt into a hang for no gain in isolation.
 * - `GIT_EXEC_PATH` — where git's OWN helper programs live, not where a
 *   repository lives. Measured 2026-08-19 by dumping the environment inside a
 *   real pre-push hook in a throwaway /tmp repo: git exports exactly
 *   `GIT_EDITOR`, `GIT_EXEC_PATH` and `GIT_PREFIX`, so this is a name the suite
 *   really can inherit when it runs under `.husky/pre-push`. Dropping it makes a
 *   child git fall back to its compiled-in libexec — wrong on a relocated or
 *   portable install, and it can name no repository and inject no config.
 */
const GIT_ENV_KEEP = Object.freeze([
  'GIT_EXEC_PATH',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
  'GIT_EDITOR',
  'GIT_ASKPASS',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_TERMINAL_PROMPT',
]);

const KEEP = new Set(GIT_ENV_KEEP);

/**
 * Remove every `GIT_*` variable from `env` except {@link GIT_ENV_KEEP}.
 *
 * Exported as a function over an explicit `env` so the behaviour is testable
 * without a second worker: the module-level call below is the only one that
 * touches `process.env`.
 *
 * WHAT IT DOES NOT DO (BV-004 ceiling): it scrubs the process environment of the
 * vitest worker ONCE, at worker start. A test that sets these variables ITSELF —
 * deliberately, to exercise a code path — still owns that decision and is
 * unaffected; the scrub is not per call. It also does nothing for a subprocess
 * that reconstructs a value from elsewhere (a `git -c` on the command line, a
 * config file), and nothing for a redirection channel git may one day expose
 * OUTSIDE the `GIT_` namespace. Revisit trigger: the first incident where a test
 * writes into the real repo despite this file.
 *
 * @param {Record<string, string|undefined>} env  environment object to mutate.
 * @returns {string[]} the names actually removed, in encounter order.
 */
export function scrubGitEnv(env) {
  const removed = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith('GIT_')) continue;
    if (KEEP.has(name)) continue;
    removed.push(name);
    delete env[name];
  }
  return removed;
}

const scrubbed = scrubGitEnv(process.env);

// Loud, once per worker, and only when something was actually removed. Silence
// here would reproduce the original failure mode: the contamination hid for two
// hours because nothing said it was there.
if (scrubbed.length > 0) {
  process.stderr.write(
    `[scrub-git-env] removed ${scrubbed.join(', ')} from the test environment — ` +
      'these outrank cwd and -C, so a fixture git call would have written into the ' +
      'invoking repository (2026-08-19 incident class).\n',
  );
}

export { GIT_ENV_KEEP };
