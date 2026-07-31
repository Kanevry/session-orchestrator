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
 * Credential safety (#907, CWE-214): every value returned by `resolveRepoSpec`
 * / `resolveRepoHost` has any embedded userinfo credential
 * (`https://user:token@host/...`, the GitLab-CI checkout pattern) stripped at
 * the source, so a credential can never reach a `-R`/`--repo`/`--hostname`
 * argv position (visible via `ps` / `/proc/<pid>/cmdline`). A scp-like SSH
 * login (`git@host:path`) is NOT a credential and is preserved verbatim. The
 * exported `redactUrlCredentials` is the log-line defense-in-depth counterpart
 * for values that bypass the source strip (e.g. a `--repo` override). See
 * `stripUrlCredentials` / `userinfoIsCredential`.
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
 * argv-boundary guard (#872 follow-up, Q3-LOW centralization). A well-formed
 * git remote URL or bare hostname never legitimately contains whitespace or a
 * C0 control character — if a resolved value does, treat it as `undefined`
 * ("could not auto-detect") rather than let it flow into a `-R`/`--repo`/
 * `--hostname` argv position. This is the CENTRAL defense for both
 * `resolveRepoSpec` and `resolveRepoHost`: the ~9 call sites across the repo
 * that do a bare `if (spec) args.push('-R', spec)` do not re-check the value
 * themselves, so they inherit this guard for free by going through either
 * exported function here rather than reading a git remote URL directly.
 */
// eslint-disable-next-line no-control-regex -- deliberate: the argv-boundary guard must catch ALL C0 control characters, not only the \s subset
const UNSAFE_ARGV_CHARS_RE = /[\s\x00-\x1f]/;

/**
 * @param {unknown} value
 * @returns {boolean} true when `value` is a string containing whitespace or a
 *   C0 control character — unsafe to forward as a single argv token.
 */
function isUnsafeForArgv(value) {
  return typeof value === 'string' && UNSAFE_ARGV_CHARS_RE.test(value);
}

/**
 * Embedded-credential guard (#907, CWE-214). A `scheme://userinfo@host/...`
 * remote URL carries its userinfo (`user:password`, or a bare `token`) in the
 * clear. The GitLab-CI checkout pattern
 * `https://gitlab-ci-token:<MASKED>@host/group/project.git` is the canonical
 * source. If that raw URL reaches a `-R`/`--repo` argv position it is visible
 * via `ps` / `/proc/<pid>/cmdline`, and if it reaches a `--verbose` log line
 * it is written to CI job output — either way the credential leaks. The
 * 2026-07-26 argv-boundary guard ({@link UNSAFE_ARGV_CHARS_RE}) does NOT catch
 * this: an embedded credential contains no whitespace or control character.
 *
 * Matches ONLY the `scheme://` URL forms (`https://`, `http://`, `ssh://`,
 * `git+ssh://`, …). The scp-like SSH form `git@host:path` has no `://` and is
 * therefore never matched — a bare SSH login user is not a credential. The
 * userinfo class `[^/\s]+` stops at the first `/`, so an `@` that appears in a
 * PATH (e.g. `.../path@ref`) is never mistaken for userinfo. Because `@` is NOT
 * excluded from the class, a greedy match binds `@` to the LAST `@` before the
 * authority ends — the real userinfo/host separator per RFC 3986 (and how
 * glab/gh parse it). This closes the residual-credential leak where a raw `@`
 * inside the token/password (`user:gl@token@host`, or nested `a:b@c:d@host`)
 * previously left a partial secret after a first-`@`-only match (#907 MED-1).
 */
const URL_WITH_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)([^/\s]+)@/gi;

/**
 * Decide whether a matched `scheme://userinfo@` is a CREDENTIAL (strip/redact)
 * or a legitimate login username (leave untouched).
 *
 * A credential is either:
 *   - any userinfo carrying a password component (`user:pass`, a `:` present) —
 *     for ANY scheme, including `ssh://user:pass@host`; or
 *   - a bare userinfo on an `http`/`https` scheme (`https://token@host`) — HTTPS
 *     git auth passes tokens/PATs through the userinfo slot, so a bare userinfo
 *     there is a token, never a plain username.
 *
 * A bare userinfo on a non-HTTP scheme (`ssh://git@host`) is a login username,
 * NOT a credential — SSH authenticates with keys, never a URL-embedded secret —
 * so it is left untouched, consistent with the scp-like `git@host:path` case.
 *
 * @param {string} scheme e.g. `https://` (includes the trailing `://`)
 * @param {string} userinfo the substring between `scheme` and `@`
 * @returns {boolean}
 */
function userinfoIsCredential(scheme, userinfo) {
  if (userinfo.includes(':')) return true;
  return /^https?:\/\/$/i.test(scheme);
}

/**
 * Strip credential userinfo from a single remote URL, returning the URL with
 * host/path/project-spec EXACTLY preserved. A credential-free URL (and the
 * scp-like `git@host:path` SSH form) is returned BYTE-IDENTICAL — the strip is
 * a no-op unless {@link userinfoIsCredential} classifies the userinfo as a
 * secret. Never throws; a non-string returns unchanged.
 *
 * @param {string} url
 * @returns {string}
 */
export function stripUrlCredentials(url) {
  if (typeof url !== 'string') return url;
  return url.replace(URL_WITH_USERINFO_RE, (match, scheme, userinfo) =>
    userinfoIsCredential(scheme, userinfo) ? scheme : match,
  );
}

/**
 * Defense-in-depth redactor for LOG output: replace any credential userinfo in
 * an arbitrary text string (e.g. a verbose `glab … -R <spec>` line) with a
 * `***` marker, leaving the surrounding text and the URL host/path intact. Used
 * by `scripts/vault-integration-watcher.mjs`'s `verbose()` to cover the
 * `--repo <spec>` override path, which bypasses the source-level strip in
 * {@link resolveRawRemoteUrl}. Never throws; a non-string returns unchanged.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactUrlCredentials(text) {
  if (typeof text !== 'string') return text;
  return text.replace(URL_WITH_USERINFO_RE, (match, scheme, userinfo) =>
    userinfoIsCredential(scheme, userinfo) ? `${scheme}***@` : match,
  );
}

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
 * Credential guard (#907, CWE-214): the raw `git remote get-url` output can
 * be `https://user:token@host/...` (GitLab-CI checkout pattern). The userinfo
 * is stripped HERE, at the single source both `resolveRepoSpec` and
 * `resolveRepoHost` flow through, BEFORE the cross-family host check and
 * before the value can reach any `-R`/`--repo`/`--hostname` argv position —
 * see {@link stripUrlCredentials}. A credential-free URL is unchanged
 * (byte-identical), so #839/#872 behaviour is preserved.
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
    const url = ok ? stripUrlCredentials(stdout.trim()) : '';
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
 * (never emit `-R undefined`). Also returns `undefined` when the resolved
 * spec contains whitespace or a control character — see the module-level
 * argv-boundary guard ({@link isUnsafeForArgv}), which this function applies
 * to the FINAL spec value (post `normalizeGithubSpec`, when applicable).
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
  const spec = vcsResolved === 'github' ? normalizeGithubSpec(url) : url;
  return isUnsafeForArgv(spec) ? undefined : spec;
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
 * Also applies the same argv-boundary guard ({@link isUnsafeForArgv}) to the
 * resolved host before returning it.
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
  const host = url ? (extractHost(url) ?? undefined) : undefined;
  return isUnsafeForArgv(host) ? undefined : host;
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
