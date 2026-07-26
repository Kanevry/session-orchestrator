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
 * Spec format (#872 follow-up): `resolveRepoSpec` returns the RAW remote URL
 * for `vcs: 'gitlab'`, but a NORMALIZED `HOST/OWNER/REPO` string for
 * `vcs: 'github'` — `gh -R`/`--repo` documents only `[HOST/]OWNER/REPO` as
 * its accepted spec shape, unlike `glab -R` which explicitly accepts a full
 * URL. See `resolveRepoSpec`'s own docblock for the full rationale. This
 * module also exports `resolveRepoHost` for the `glab api`/`gh api`
 * call sites, which accept neither `-R` nor a URL — only `--hostname`.
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
 * Normalize a github remote URL (HTTPS or SSH) into the `HOST/OWNER/REPO`
 * shape `gh -R`/`--repo` documents as its accepted spec format. gh does NOT
 * accept a raw remote URL the way `glab -R` does — only `[HOST/]OWNER/REPO`.
 * Strips a trailing `.git` suffix and any trailing slash.
 *
 * Falls back to returning `url` unchanged when it does not match the
 * expected `host/owner/repo` shape (never throws) — a raw URL is still
 * strictly better than omitting `-R` entirely.
 *
 * @param {string} url
 * @returns {string}
 */
function normalizeGithubSpec(url) {
  const httpsMatch = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (httpsMatch) {
    const [, host, owner, repo] = httpsMatch;
    return `${host.toLowerCase()}/${owner}/${repo}`;
  }
  const sshMatch = /^[^@\s]+@([^:\s]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url);
  if (sshMatch) {
    const [, host, owner, repo] = sshMatch;
    return `${host.toLowerCase()}/${owner}/${repo}`;
  }
  return url;
}

/**
 * Resolve the raw remote URL for the requested vcs — shared by
 * `resolveRepoSpec` and `resolveRepoHost` so both apply the identical
 * remote-preference-order + cross-family-guard resolution.
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
function resolveRawRemoteUrl({ repoRoot, vcs = 'gitlab', gitRun = defaultGitRun } = {}) {
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
 * Resolve the glab/gh `-R`/`--repo` host-pinning spec.
 *
 * Format contract differs by vcs, because `glab -R` and `gh -R` accept
 * different spec shapes:
 *   - `vcs: 'gitlab'` (default): the RAW remote URL, verbatim. `glab -R`
 *     explicitly accepts a full URL, and GitLab group namespaces can nest
 *     arbitrarily deep (`group/subgroup/project`), which makes a reliable
 *     `OWNER/REPO` derivation impossible from the URL alone — so the raw URL
 *     is the only unambiguous spec here.
 *   - `vcs: 'github'`: the NORMALIZED `HOST/OWNER/REPO` form (see
 *     `normalizeGithubSpec`). `gh -R`/`--repo` documents ONLY
 *     `[HOST/]OWNER/REPO` as accepted input — a raw URL is not guaranteed to
 *     parse the same way, and GitHub repos are always exactly two path
 *     segments (owner/repo), so the derivation is unambiguous.
 *
 * Returns `undefined` when no matching remote resolves — callers MUST treat
 * this as "could not auto-detect" and omit the `-R`/`--repo` flag entirely
 * (never emit `-R undefined`).
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
  const url = resolveRawRemoteUrl({ repoRoot, vcs: vcsResolved, gitRun });
  if (!url) return undefined;
  return vcsResolved === 'github' ? normalizeGithubSpec(url) : url;
}

/**
 * Resolve the bare hostname of the matching remote, for use with
 * `glab api --hostname`/`gh api --hostname` — the `api` subcommand of both
 * CLIs does NOT accept `-R`/`--repo` (it has no repo concept), only a
 * `--hostname` flag to pin which instance the request targets. This is the
 * host-pinning counterpart to `resolveRepoSpec` for those api-only call
 * sites.
 *
 * Applies the identical remote-preference-order + cross-family-guard
 * resolution as `resolveRepoSpec`, just returning the host instead of the
 * full spec — same contract: `undefined` ⇒ caller omits the flag entirely.
 *
 * @param {{
 *   repoRoot?: string,
 *   vcs?: 'gitlab' | 'github',
 *   gitRun?: (args: string[]) => { ok: boolean, stdout: string, stderr: string }
 * }} [opts]
 * @returns {string|undefined}
 */
export function resolveRepoHost({ repoRoot, vcs, gitRun } = {}) {
  const url = resolveRawRemoteUrl({ repoRoot, vcs, gitRun });
  return url ? (extractHost(url) ?? undefined) : undefined;
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
