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
 * WHAT IT DOES NOT DO (BV-004 ceiling): it scrubs the process environment of the
 * vitest worker. A test that sets these variables ITSELF — deliberately, to
 * exercise a code path — still owns that decision and is unaffected; the scrub
 * runs once at worker start, not per call. It also does nothing for a subprocess
 * that reconstructs the value from elsewhere. Revisit trigger: the first incident
 * where a test writes into the real repo despite this file.
 */

// GIT_DIR / GIT_WORK_TREE / GIT_COMMON_DIR redirect repository resolution
// outright. GIT_INDEX_FILE is set to the RELATIVE '.git/index' by the commit
// family, so it re-resolves against whatever directory a child happens to run in.
// GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES redirect object
// writes. GIT_CONFIG_PARAMETERS carries `-c key=value` overrides into every
// child — it is what made a `git -c core.hooksPath=.husky push` fire this
// repository's real pre-commit hooks inside a throwaway fixture repo.
const REDIRECTING_GIT_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_CONFIG_PARAMETERS',
  'GIT_NAMESPACE',
  'GIT_QUARANTINE_PATH',
];

const scrubbed = [];
for (const name of REDIRECTING_GIT_VARS) {
  if (process.env[name] !== undefined) {
    scrubbed.push(name);
    delete process.env[name];
  }
}

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

export { REDIRECTING_GIT_VARS };
