/**
 * vcs-repo-spec.mjs — resolve a glab/gh `-R`/`--repo` host-pinning spec from
 * the local git remotes (#839).
 *
 * Why this exists: a bare `glab`/`gh` spawn (no shell wrapper, no `-R`) falls
 * back to the ambient `GITLAB_HOST`/`GH_HOST` env var to pick a host. On a
 * multi-GitLab-instance host that can resolve to the WRONG instance and fail
 * silently — the root cause of #839.
 *
 * Injecting `GITLAB_HOST` into the spawn env is NOT the fix — it was tested
 * live and FAILS whenever `~/.ssh/config` maps the GitLab hostname to a
 * `HostName` IP alias: glab then reports "none of the git remotes configured
 * for this repository correspond to the GITLAB_HOST environment variable"
 * because the remote it sees is the IP, not the hostname. The only mechanism
 * verified to survive that mismatch is passing the raw remote URL (or a
 * HOST/OWNER/REPO spec) via `-R`/`--repo`.
 *
 * Preference order:
 *   - vcs === 'github': remote `github` → `origin`
 *   - vcs === 'gitlab' (default): remote `gitlab` → `origin`
 *
 * Returns `undefined` when no matching remote resolves — callers MUST treat
 * this as "could not auto-detect" and omit the `-R`/`--repo` flag entirely
 * (never emit `-R undefined`).
 *
 * Lifted out of `scripts/archive-closed-prds.mjs::defaultGlabRepo` (that
 * script's docblock described this exact problem months before #839 was
 * filed) into a shared `scripts/lib/` module so
 * `scripts/lib/issue-close-strip-labels.mjs` and
 * `scripts/lib/spiral-carryover.mjs` can reuse the same, single
 * implementation instead of each re-deriving it.
 */

import { execFileSync } from 'node:child_process';

/**
 * Default git-remote runner: `git -C <repoRoot> remote get-url <name>`.
 * Never throws — returns `{ ok:false, stdout:'', stderr }` on any failure
 * (missing remote, not a git repo, git not on PATH, ...).
 *
 * @param {string[]} gitArgs
 * @returns {{ ok: boolean, stdout: string, stderr: string }}
 */
function defaultGitRun(gitArgs) {
  try {
    const stdout = execFileSync('git', gitArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: '' };
  } catch (err) {
    const stderr =
      err && err.stderr ? String(err.stderr) : err && err.message ? String(err.message) : 'unknown error';
    return { ok: false, stdout: '', stderr };
  }
}

/** Remote-name preference order, per VCS. */
const REMOTE_PREFERENCE = {
  gitlab: ['gitlab', 'origin'],
  github: ['github', 'origin'],
};

/**
 * The OTHER platform's well-known public host, per requested vcs — the one
 * case a resolved remote URL can be PROVEN to belong to the wrong VCS family
 * without any repo-specific host configuration (self-hosted GitLab/GitHub
 * Enterprise instances can live at ANY domain, so this deliberately checks
 * only the unambiguous public-host case, not a general host allow-list).
 */
const WRONG_FAMILY_HOST = {
  gitlab: 'github.com',
  github: 'gitlab.com',
};

/**
 * Extract the bare hostname from a git remote URL, handling both the HTTPS
 * (`https://host/owner/repo.git`) and SSH (`git@host:owner/repo.git`) forms.
 * Returns `null` for an unrecognized shape (never throws).
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractHost(url) {
  const httpsMatch = /^https?:\/\/([^/]+)/i.exec(url);
  if (httpsMatch) return httpsMatch[1].toLowerCase();
  const sshMatch = /^[^@\s]+@([^:\s]+):/i.exec(url);
  if (sshMatch) return sshMatch[1].toLowerCase();
  return null;
}

/**
 * Resolve the raw remote URL to pass as a glab/gh `-R`/`--repo` spec.
 *
 * Cross-family guard (#839 follow-up): a candidate URL whose host is the
 * OTHER platform's well-known public host (`github.com` under vcs:'gitlab',
 * `gitlab.com` under vcs:'github') is skipped rather than returned — passing
 * it to `glab`/`gh -R` would be a guaranteed hard failure, strictly worse
 * than the ambient-resolution fallback #839 replaced. This is a narrow,
 * unambiguous check only; it does not attempt to validate self-hosted
 * domains, which cannot be distinguished from a URL string alone.
 *
 * @param {{
 *   repoRoot?: string,
 *   vcs?: 'gitlab' | 'github',
 *   gitRun?: (args: string[]) => { ok: boolean, stdout: string, stderr: string }
 * }} [opts]
 * @returns {string|undefined}
 */
export function resolveRepoSpec({ repoRoot, vcs = 'gitlab', gitRun = defaultGitRun } = {}) {
  const vcsResolved = vcs === 'github' ? 'github' : 'gitlab';
  const root = repoRoot ?? process.cwd();
  const wrongFamilyHost = WRONG_FAMILY_HOST[vcsResolved];

  for (const remote of REMOTE_PREFERENCE[vcsResolved]) {
    const { ok, stdout } = gitRun(['-C', root, 'remote', 'get-url', remote]);
    const url = ok ? stdout.trim() : '';
    if (!url) continue;
    if (extractHost(url) === wrongFamilyHost) continue;
    return url;
  }
  return undefined;
}

/**
 * @deprecated Back-compat alias for `archive-closed-prds.mjs`'s original
 * `defaultGlabRepo(repoRoot, gitRunFn)` positional signature (gitlab-only).
 * New callers should use `resolveRepoSpec`.
 *
 * @param {string} repoRoot
 * @param {(args: string[]) => { ok: boolean, stdout: string, stderr: string }} gitRunFn
 * @returns {string|undefined}
 */
export function defaultGlabRepo(repoRoot, gitRunFn) {
  return resolveRepoSpec({ repoRoot, vcs: 'gitlab', gitRun: gitRunFn });
}
