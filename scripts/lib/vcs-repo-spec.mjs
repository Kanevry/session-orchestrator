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
 * Remote-resolution core (#1039): since the `-R` spec is only ONE of several
 * questions a caller asks about a repo's remotes, the file now carries a shared
 * core below the frozen `-R`/`--hostname` exports — one primitive
 * ({@link listRemotes}, a single `git remote -v` spawn) and three projections
 * ({@link resolvePreferredRemote}, {@link detectVcsFamily},
 * {@link resolveBaselineRange}). Every one of them returns a DISCRIMINATED
 * result carrying a {@link REMOTE_RESOLUTION_REASONS} reason instead of a
 * `T | null`, because `null` folds "no remote configured" onto "the query
 * failed" — a fold that currently scores a fail-open 2/2 in
 * `harness-audit/categories/category6.mjs`. `resolveRepoSpec` /
 * `resolveRepoHost` keep their `string|undefined` contract verbatim and are now
 * thin projections of that core.
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
 * Default git runner: `git <gitArgs>`.
 * Never throws — returns `{ ok:false, stdout:'', stderr, status, code }` on any
 * failure (missing remote, not a git repo, git not on PATH, ...).
 *
 * `status` (process exit code) and `code` (spawn errno, e.g. `'ENOENT'`) were
 * added for {@link listRemotes}'s failure taxonomy: git's own exit codes are
 * the ONLY signal that distinguishes "this is not a git repository" (128) from
 * "git is not installed" (spawn ENOENT) from "there are simply no remotes"
 * (exit 0, empty stdout). Folding those three onto one falsy value is the
 * defect class #1039 was filed against — see {@link REMOTE_RESOLUTION_REASONS}.
 *
 * Both fields are OPTIONAL in the `gitRun` DI contract: an injected test stub
 * that returns only `{ ok, stdout, stderr }` still works, and its failures
 * classify as the generic `'git-error'`.
 *
 * @param {string[]} gitArgs
 * @returns {GitRunResult}
 */
function defaultGitRun(gitArgs) {
  try {
    const stdout = execFileSync('git', gitArgs, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, stdout: String(stdout ?? ''), stderr: '', status: 0 };
  } catch (err) {
    const stderr =
      err && err.stderr ? String(err.stderr) : err && err.message ? String(err.message) : 'unknown error';
    return {
      ok: false,
      stdout: '',
      stderr,
      status: err && typeof err.status === 'number' ? err.status : undefined,
      code: err && typeof err.code === 'string' ? err.code : undefined,
    };
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

/** URI schemes that can name a supported Git remote. */
const REMOTE_URI_PROTOCOLS = new Set(['http:', 'https:', 'ssh:']);

/**
 * Parse a URI-style remote only when it uses one of this module's supported
 * protocols. The `URL` parser makes hostname/port handling consistent between
 * HTTP(S) and URI-style SSH while scp-style SSH stays a separate grammar.
 *
 * @param {string} url
 * @returns {URL|null}
 */
function parseRemoteUri(url) {
  if (typeof url !== 'string' || !/^(?:https?|ssh):\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    return REMOTE_URI_PROTOCOLS.has(parsed.protocol) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Extract the operational host from a git remote URL, handling HTTPS
 * (`https://host/owner/repo.git`), scp-style SSH (`git@host:owner/repo.git`),
 * and URI-style SSH (`ssh://git@host/owner/repo.git`) forms. A non-default
 * URI port is preserved because callers may need it to address a self-hosted
 * instance. Returns `null` for an unrecognized shape (never throws).
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractHost(url) {
  const parsed = parseRemoteUri(url);
  if (parsed !== null) return parsed.host.toLowerCase() || null;
  const sshMatch = /^[^@\s]+@([^:\s]+):/i.exec(url);
  if (sshMatch) return sshMatch[1].toLowerCase();
  return null;
}

/**
 * Extract a bare hostname for VCS-family comparisons. This deliberately drops
 * a URI port: `github.com:443` is still the public GitHub host, while the
 * operational `extractHost()` value retains a non-default self-hosted port.
 *
 * @param {string} url
 * @returns {string|null}
 */
function extractHostname(url) {
  const parsed = parseRemoteUri(url);
  if (parsed !== null) return parsed.hostname.toLowerCase() || null;
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
 * Since #1039 this is a THIN projection of {@link resolvePreferredRemote} and
 * performs no git call of its own. Two reasons the delegation is load-bearing:
 *
 *   1. **One credential-strip source (#907, CWE-214).** The userinfo strip now
 *      lives in {@link listRemotes}, at the single point every remote URL in
 *      this module enters from. A second code path *around* that source would
 *      re-open the leak — which is exactly why this function must not read a
 *      remote URL itself.
 *   2. **One git call instead of N.** The former implementation ran one
 *      `git remote get-url <name>` spawn PER preference entry, on the
 *      session-start hot path. `listRemotes` runs `git remote -v` exactly once.
 *
 * @param {{
 *   repoRoot?: string,
 *   vcs?: 'gitlab' | 'github',
 *   gitRun?: GitRun
 * }} [opts]
 * @returns {string|undefined}
 */
function resolveRawRemoteUrl({ repoRoot, vcs = 'gitlab', gitRun = defaultGitRun } = {}) {
  const vcsResolved = vcs === 'github' ? 'github' : 'gitlab';
  const resolved = resolvePreferredRemote({ repoRoot, vcs: vcsResolved, gitRun });
  return resolved.ok ? resolved.url : undefined;
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
 * **CHANGELOG-worthy behaviour change (#1039, operator-approved.)** This
 * function inherits the SOLE-REMOTE FALLBACK from the shared core (see
 * {@link resolvePreferredRemote}): a repo whose only remote is named something
 * else (`upstream` in a fork, `gl` in a hand-configured clone) now resolves to
 * that remote instead of returning `undefined`. The fallback fires EXCLUSIVELY
 * where `undefined` was returned before — it can never redirect an
 * already-resolving repo to a DIFFERENT target, because the preference order
 * ({@link REMOTE_PREFERENCE}) is still consulted first and is byte-identical to
 * the pre-#1039 list. The cross-family guard applies to the fallback candidate
 * too, so a lone `github.com` remote under `vcs:'gitlab'` still yields
 * `undefined` rather than a spec `glab` is guaranteed to reject.
 *
 * @param {{
 *   repoRoot?: string,
 *   vcs?: 'gitlab' | 'github',
 *   gitRun?: GitRun
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
 * Resolve the operational host of the matching remote, preserving a
 * non-default self-hosted port for `glab api --hostname`/`gh api --hostname`.
 * The `api` subcommand of both CLIs does NOT accept `-R`/`--repo` (it has no
 * repo concept), only `--hostname` to pin which instance the request targets.
 * This is the host-pinning counterpart to `resolveRepoSpec` for those api-only
 * call sites.
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

/** Project-path characters that cannot name a GitLab namespace/project. */
// eslint-disable-next-line no-control-regex -- validate every C0/C1 control before encoding a GitLab API path
const UNSAFE_PROJECT_PATH_CHARS_RE = /[\\\x00-\x1f\x7f-\x9f?#]/;

/**
 * Decode a transport project path exactly once, then validate its canonical
 * namespace/project shape. A percent sign surviving the one decode is rejected
 * because `%252e%252e` is indistinguishable from a literal encoded escape; do
 * not normalize that ambiguity into an API target.
 *
 * @param {string} rawProjectPath
 * @param {{ uriPath: boolean }} opts
 * @returns {string|undefined}
 */
function normalizeGitlabProjectPath(rawProjectPath, { uriPath }) {
  if (typeof rawProjectPath !== 'string') return undefined;

  let projectPath = rawProjectPath;
  if (uriPath) {
    // URI syntax supplies one separator before the path. More than one is a
    // path segment, not syntax to trim away.
    if (!projectPath.startsWith('/') || projectPath.startsWith('//')) return undefined;
    projectPath = projectPath.slice(1);
  }

  if (
    projectPath === '' ||
    projectPath.startsWith('/') ||
    projectPath.endsWith('/') ||
    UNSAFE_PROJECT_PATH_CHARS_RE.test(projectPath)
  ) {
    return undefined;
  }

  let decodedProjectPath;
  try {
    decodedProjectPath = decodeURIComponent(projectPath);
  } catch {
    return undefined;
  }

  if (
    decodedProjectPath.includes('%') ||
    UNSAFE_PROJECT_PATH_CHARS_RE.test(decodedProjectPath) ||
    isUnsafeForArgv(decodedProjectPath)
  ) {
    return undefined;
  }

  const withoutGitSuffix = decodedProjectPath.replace(/\.git$/i, '');
  const segments = withoutGitSuffix.split('/');
  if (
    withoutGitSuffix === '' ||
    withoutGitSuffix.startsWith('/') ||
    withoutGitSuffix.endsWith('/') ||
    segments.length < 2 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    return undefined;
  }

  return withoutGitSuffix;
}

/**
 * Extract an operational GitLab host and the raw (not URL-normalized) project
 * path. URI parsing owns authority/port validation, while the raw path keeps
 * dot and percent-encoded traversal visible to {@link normalizeGitlabProjectPath}
 * before WHATWG URL normalization could erase it.
 *
 * @param {string} url
 * @returns {{ host: string, rawProjectPath: string, uriPath: boolean }|undefined}
 */
function extractGitlabProjectTargetParts(url) {
  const scpMatch = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(url);
  if (scpMatch) {
    return { host: scpMatch[1], rawProjectPath: scpMatch[2], uriPath: false };
  }

  const parsed = parseRemoteUri(url);
  if (
    parsed === null ||
    parsed.search !== '' ||
    parsed.hash !== '' ||
    ((parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      (parsed.username !== '' || parsed.password !== ''))
  ) {
    return undefined;
  }

  // `parsed.pathname` is intentionally NOT used: the URL parser resolves
  // `.`/`..` before this boundary can reject them. The regex reads only the
  // path from an already-parsed, supported URI.
  const rawPathMatch = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(\/[^?#]*)?(?:[?#].*)?$/i.exec(url);
  if (rawPathMatch === null) return undefined;
  return { host: parsed.host, rawProjectPath: rawPathMatch[1] ?? '', uriPath: true };
}

/**
 * Derive the API target for a GitLab project from the same sanitized,
 * preference-selected remote that powers {@link resolveRepoSpec}. GitLab's REST
 * API takes a URL-encoded `namespace/project` path rather than a remote URL or
 * numeric project ID, so this projection removes the ambient project-metadata
 * lookup from callers that need to pin both project and host.
 *
 * Supports HTTPS, scp-style SSH, and `ssh://` remotes. Credential stripping
 * happens upstream in {@link listRemotes}; this helper returns only an
 * operational host (including a non-default self-hosted port) and a once-only
 * encoded project path, never a remote URL or HTTP userinfo. An SSH login such
 * as `git@host` is transport identity, not project-path userinfo.
 *
 * @param {{ repoRoot?: string, gitRun?: GitRun }} [opts]
 * @returns {{ host: string, encodedProjectPath: string }|undefined}
 */
export function resolveGitlabProjectTarget({ repoRoot, gitRun = defaultGitRun } = {}) {
  const url = resolveRawRemoteUrl({ repoRoot, vcs: 'gitlab', gitRun });
  if (!url) return undefined;

  const parts = extractGitlabProjectTargetParts(url);
  if (!parts || isUnsafeForArgv(parts.host)) return undefined;

  const projectPath = normalizeGitlabProjectPath(parts.rawProjectPath, { uriPath: parts.uriPath });
  if (!projectPath) return undefined;

  return {
    host: parts.host.toLowerCase(),
    encodedProjectPath: encodeURIComponent(projectPath),
  };
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

/* ------------------------------------------------------------------------ *
 * #1039 — remote resolution core: one primitive, three projections.
 *
 * Four probes across the repo resolved their git remote as the hard-coded
 * literal `origin` and were therefore BLIND in every repo whose remotes are
 * named `gitlab`/`github` (this repo's own shape: `github` + `origin`). The
 * shared core below replaces that literal.
 *
 * The contract's load-bearing decision is that a resolution result is NEVER
 * `T | null`. `null` folds "no remote is configured" (a legitimate, benign
 * repo state) onto "the query failed" (a broken tool or a non-repo), and that
 * fold is LIVE in this codebase: `scripts/lib/harness-audit/categories/
 * category6.mjs:145-155` awards 2 of 2 points with the message "no github
 * mirror remote configured — skipped" when its `git remote` call returns
 * `null` — which it also does outside a git repo, and when git is not on PATH.
 * A fail-open scoring 100%.
 *
 * So every projection returns a DISCRIMINATED result carrying a reason from
 * {@link REMOTE_RESOLUTION_REASONS}, and {@link isQueryFailure} is the single
 * predicate that separates "I could not ask" from "I asked, the answer is no".
 * ------------------------------------------------------------------------ */

/**
 * Every reason a remote resolution can fail, frozen so consumers can switch on
 * it exhaustively. The list splits into two classes — the split, not the
 * individual strings, is the point:
 *
 *   QUERY FAILURE (the question could not be asked; see {@link isQueryFailure})
 *   - `not-a-git-repo`    git exited 128 — the path is not inside a work tree.
 *   - `git-unavailable`   the spawn failed with ENOENT — git is not on PATH.
 *   - `git-error`         any other non-zero exit, or an injected `gitRun`
 *                         stub that reported failure without an exit code.
 *
 *   ABSENCE (the question was answered; the answer is "no remote for you")
 *   - `no-remotes`        git exited 0 with an empty remote list — a fresh
 *                         `git init`, or a clone-less work tree. BENIGN.
 *   - `no-matching-remote` >= 2 remotes exist and none matches the requested
 *                         preference order. Deliberately NOT a guess: picking
 *                         arbitrarily here means querying the WRONG project
 *                         successfully, which is worse than not querying.
 *   - `unsafe-value`      the chosen remote's name or URL carries whitespace /
 *                         a C0 control character and must not reach an argv
 *                         position ({@link isUnsafeForArgv}).
 *
 * @type {readonly RemoteResolutionReason[]}
 */
export const REMOTE_RESOLUTION_REASONS = Object.freeze([
  'not-a-git-repo',
  'git-unavailable',
  'git-error',
  'no-remotes',
  'no-matching-remote',
  'unsafe-value',
]);

/** @type {ReadonlySet<string>} */
const QUERY_FAILURE_REASONS = new Set(['not-a-git-repo', 'git-unavailable', 'git-error']);

/**
 * `true` when `reason` means the question could not be ASKED (broken tool, no
 * repo), `false` when it means the question was answered in the negative (no
 * remote configured, no match, unsafe value).
 *
 * Consumers MUST branch on this rather than on truthiness: a query failure is a
 * degraded measurement and should be surfaced (WARN / skip-with-reason), while
 * an absence is a real, reportable repo state. Treating them alike is the
 * category6.mjs fail-open documented above.
 *
 * An unknown / absent reason returns `false` — fail-safe toward "this is a real
 * answer", so a future reason added to {@link REMOTE_RESOLUTION_REASONS}
 * without updating this predicate never silently masks a genuine finding as a
 * tooling glitch.
 *
 * @param {RemoteResolutionReason|string|undefined} reason
 * @returns {boolean}
 */
export function isQueryFailure(reason) {
  return typeof reason === 'string' && QUERY_FAILURE_REASONS.has(reason);
}

/**
 * Classify a failed {@link GitRunResult} into a query-failure reason.
 *
 * Named ceiling (BV-004): exit 128 is mapped to `not-a-git-repo` because that
 * is what `git remote -v` returns for "not a git repository", and this module
 * only ever runs read-only remote/ref plumbing where 128 has no other common
 * cause. It is NOT a general git-exit-code taxonomy — revisit if a caller
 * starts routing write commands (`git push`, `git fetch`) through `gitRun`,
 * where 128 also covers auth and network fatals.
 *
 * @param {GitRunResult} res
 * @returns {RemoteResolutionReason}
 */
function classifyGitFailure(res) {
  if (res && res.code === 'ENOENT') return 'git-unavailable';
  if (res && res.status === 128) return 'not-a-git-repo';
  return 'git-error';
}

/**
 * One `git remote -v` output line: `<name>\t<url> (fetch|push)`.
 *
 * `(.*?)` is lazy with an anchored tail, so a URL containing a space (a
 * corrupted `.git/config`, the argv-boundary guard's realistic source) is
 * captured whole rather than truncated at the space. A line that does not match
 * this shape at all is DROPPED — see {@link listRemotes}.
 */
const REMOTE_V_LINE_RE = /^(\S+)\s+(.*?)\s+\((fetch|push)\)$/;

/**
 * THE PRIMITIVE. Enumerate the repo's git remotes in ONE `git remote -v` spawn.
 *
 * Contract:
 *   - `{ ok: true, remotes: [{ name, url }] }` — the list, in git's own output
 *     order (alphabetical by remote name). **`remotes: []` is a VALID `ok:true`
 *     result** and means "this repo has no remotes", never "the query failed".
 *     Conflating the two is the defect this whole module section exists for.
 *   - `{ ok: false, reason, stderr }` — the query itself failed; `reason`
 *     always satisfies {@link isQueryFailure}.
 *
 * Only FETCH URLs are reported, one entry per remote name (first fetch line
 * wins). Push URLs are a separate `remote.<name>.pushurl` concept that no
 * `-R`/`--repo`/baseline-range consumer in this repo wants.
 *
 * Credential safety (#907, CWE-214): every URL passes through
 * {@link stripUrlCredentials} HERE, at the single point remote URLs enter this
 * module. Every other function in the file — including `resolveRepoSpec` and
 * `resolveRepoHost` — reads its URLs from this function's output, so there is
 * exactly ONE strip source and no path around it.
 *
 * Unparseable lines are dropped silently rather than failing the call: git
 * cannot emit them, so their only source is a corrupted config or an embedded
 * newline, and in both cases the remaining well-formed remotes are still the
 * best available answer. A repo whose EVERY line is unparseable therefore
 * reports `no-remotes` (absence), which is correct — nothing usable was found,
 * and git did answer.
 *
 * @param {{ repoRoot?: string, gitRun?: GitRun }} [opts]
 * @returns {{ ok: true, remotes: GitRemote[] }
 *   | { ok: false, reason: RemoteResolutionReason, stderr: string }}
 */
export function listRemotes({ repoRoot, gitRun = defaultGitRun } = {}) {
  const root = repoRoot ?? process.cwd();
  const res = gitRun(['-C', root, 'remote', '-v']) ?? { ok: false, stdout: '', stderr: '' };

  if (!res.ok) {
    return { ok: false, reason: classifyGitFailure(res), stderr: String(res.stderr ?? '') };
  }

  /** @type {GitRemote[]} */
  const remotes = [];
  const seen = new Set();

  for (const rawLine of String(res.stdout ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const match = REMOTE_V_LINE_RE.exec(line);
    if (match === null) continue;
    const [, name, rawUrl, direction] = match;
    if (direction !== 'fetch') continue;
    if (seen.has(name)) continue;
    const url = stripUrlCredentials(rawUrl).trim();
    if (url === '') continue;
    seen.add(name);
    remotes.push({ name, url });
  }

  return { ok: true, remotes };
}

/**
 * Remote-name preference order when NO `vcs` is supplied.
 *
 * **Operator decision (#1039) — deliberately DIFFERENT from
 * {@link REMOTE_PREFERENCE}, do not "fix" the divergence.** The vcs-pinned
 * lists put the platform-named remote first because the caller has already
 * declared which platform it is talking to. The vcs-less order puts `origin`
 * first because its callers (baseline ranges, family detection, vault-note
 * namespacing) derive an IDENTITY from the answer, and identity must not move.
 *
 * Concretely, in THIS repo (`origin` → `…/infrastructure/session-orchestrator`,
 * `github` → `…/Kanevry/session-orchestrator`), a `gitlab`-first order would
 * re-namespace every existing vault note from `infrastructure/…` to
 * `Kanevry/…`. Silent mass-rename of historical notes is not an improvement.
 */
const VCS_LESS_PREFERENCE = Object.freeze(['origin', 'gitlab', 'github']);

/**
 * Pick the one remote a repo-scoped command should target.
 *
 * Resolution, in order:
 *   1. **Preference.** With `vcs` set: `REMOTE_PREFERENCE[vcs]`
 *      (`['<vcs>', 'origin']`, byte-identical to the pre-#1039 list, because
 *      13 production importers of `resolveRepoSpec` inherit their `-R` target
 *      from it — a reordering would silently switch every one of them in a repo
 *      that has both remotes). With `vcs` omitted: {@link VCS_LESS_PREFERENCE}.
 *   2. **Cross-family guard** (only when `vcs` is set): a candidate whose host
 *      is the OTHER platform's well-known public host is SKIPPED and resolution
 *      continues with the next preference entry. Passing `github.com` to
 *      `glab -R` is a guaranteed hard failure — strictly worse than resolving
 *      nothing. Unchanged from #839.
 *   3. **Sole-remote fallback.** Exactly one remote configured and no
 *      preference hit → use it, `via:'sole-remote'`. This is what makes a fork
 *      (`upstream`) or a hand-named clone (`gl`) resolvable at all. The
 *      cross-family guard still applies to this candidate.
 *   4. Otherwise `{ ok:false }` with `no-remotes` (nothing configured) or
 *      `no-matching-remote` (>= 2 remotes, none matched). With two or more
 *      candidates and no preference signal there is no non-arbitrary pick, and
 *      guessing means successfully querying the WRONG project — the failure
 *      mode is a silent wrong answer, not an error. The full `remotes` list
 *      rides along so the caller can surface the ambiguity to the operator.
 *
 * The argv-boundary guard runs AFTER the candidate is chosen, and an unsafe
 * candidate ENDS resolution with `unsafe-value` rather than falling through to
 * the next preference entry — preserving pre-#1039 behaviour, where an unsafe
 * value likewise produced `undefined` and no retry.
 *
 * @param {{ repoRoot?: string, vcs?: 'gitlab'|'github', gitRun?: GitRun }} [opts]
 * @returns {{ ok: true, name: string, url: string, via: 'preference'|'sole-remote' }
 *   | { ok: false, reason: RemoteResolutionReason, remotes?: GitRemote[], stderr?: string }}
 */
export function resolvePreferredRemote({ repoRoot, vcs, gitRun = defaultGitRun } = {}) {
  const listed = listRemotes({ repoRoot, gitRun });
  if (!listed.ok) return { ok: false, reason: listed.reason, stderr: listed.stderr };

  const { remotes } = listed;
  if (remotes.length === 0) return { ok: false, reason: 'no-remotes', remotes };

  const vcsPinned = vcs === 'github' || vcs === 'gitlab' ? vcs : null;
  const order = vcsPinned ? REMOTE_PREFERENCE[vcsPinned] : VCS_LESS_PREFERENCE;
  const wrongFamilyHost = vcsPinned ? WRONG_FAMILY_HOST[vcsPinned] : null;
  const isWrongFamily = (url) => wrongFamilyHost !== null && extractHostname(url) === wrongFamilyHost;

  /** @param {GitRemote} remote @param {'preference'|'sole-remote'} via */
  const accept = (remote, via) =>
    isUnsafeForArgv(remote.url) || isUnsafeForArgv(remote.name)
      ? { ok: false, reason: /** @type {RemoteResolutionReason} */ ('unsafe-value'), remotes }
      : { ok: true, name: remote.name, url: remote.url, via };

  for (const name of order) {
    const candidate = remotes.find((remote) => remote.name === name);
    if (candidate === undefined) continue;
    if (isWrongFamily(candidate.url)) continue;
    return accept(candidate, 'preference');
  }

  if (remotes.length === 1 && !isWrongFamily(remotes[0].url)) {
    return accept(remotes[0], 'sole-remote');
  }

  return { ok: false, reason: 'no-matching-remote', remotes };
}

/**
 * Classify a single remote into a VCS family from its URL host, then its name.
 *
 * Host rule: `github.com` or any `github.*` host → github; `gitlab.com` or any
 * `gitlab.*` host → gitlab. The `github.*` half is what keeps GitHub Enterprise
 * (`github.example.com`) out of the gitlab bucket — a `url.includes('github.com')`
 * test classifies it as gitlab and points `glab` at a GitHub instance.
 *
 * @param {GitRemote} remote
 * @returns {{ family: 'gitlab'|'github', via: 'host-match'|'remote-name' }|null}
 */
function classifyRemoteFamily(remote) {
  const host = extractHostname(remote.url);
  if (host !== null) {
    if (host === 'github.com' || host.startsWith('github.')) return { family: 'github', via: 'host-match' };
    if (host === 'gitlab.com' || host.startsWith('gitlab.')) return { family: 'gitlab', via: 'host-match' };
  }
  if (remote.name === 'github') return { family: 'github', via: 'remote-name' };
  if (remote.name === 'gitlab') return { family: 'gitlab', via: 'remote-name' };
  return null;
}

/**
 * Decide which VCS family a repo belongs to, from its remotes — the projection
 * that replaces "assume gitlab because the config says so".
 *
 * Precedence per remote: URL host, then remote name (see
 * {@link classifyRemoteFamily}). Among classified remotes the representative is
 * picked by {@link VCS_LESS_PREFERENCE}, then by git's own listing order — so
 * in this repo (`github` → github.com, `origin` → gitlab.…) the answer is
 * `gitlab` via `origin`, not `github` via the alphabetically-first remote.
 *
 * When NO remote classifies, `via:'default'` + `vcs:'gitlab'` preserves today's
 * behaviour (every `resolveRepoSpec` caller already defaults to gitlab) —
 * provided a representative remote can be named at all. When it cannot (>= 2
 * unclassifiable remotes), the call fails with `no-matching-remote` rather than
 * inventing one: naming the wrong remote is what #1039 is about.
 *
 * `ambiguous` is `true` when two or more remotes classify into DIFFERENT
 * families — the ordinary GitLab-primary / GitHub-mirror shape. It is a signal
 * for the caller to disclose the choice, not an error: `vcs` is still the
 * preference-ordered answer, and `alternatives` names the remotes that would
 * have said otherwise.
 *
 * @param {{ repoRoot?: string, gitRun?: GitRun }} [opts]
 * @returns {{ ok: true, vcs: 'gitlab'|'github', name: string, url: string,
 *             via: 'host-match'|'remote-name'|'default', ambiguous: boolean,
 *             alternatives: string[] }
 *   | { ok: false, reason: RemoteResolutionReason, remotes?: GitRemote[], stderr?: string }}
 */
export function detectVcsFamily({ repoRoot, gitRun = defaultGitRun } = {}) {
  const listed = listRemotes({ repoRoot, gitRun });
  if (!listed.ok) return { ok: false, reason: listed.reason, stderr: listed.stderr };

  const { remotes } = listed;
  if (remotes.length === 0) return { ok: false, reason: 'no-remotes', remotes };

  const classified = remotes
    .map((remote) => ({ remote, verdict: classifyRemoteFamily(remote) }))
    .filter((entry) => entry.verdict !== null);

  if (classified.length === 0) {
    // No family signal anywhere. Fall back to today's implicit default
    // (gitlab), but only if a representative remote can be NAMED — the
    // preferred-remote resolution below refuses to guess among >= 2.
    const preferred = resolvePreferredRemote({ repoRoot, gitRun });
    if (!preferred.ok) return preferred;
    return {
      ok: true,
      vcs: 'gitlab',
      name: preferred.name,
      url: preferred.url,
      via: 'default',
      ambiguous: false,
      alternatives: [],
    };
  }

  const chosen =
    VCS_LESS_PREFERENCE.map((name) => classified.find((entry) => entry.remote.name === name)).find(
      (entry) => entry !== undefined,
    ) ?? classified[0];

  const alternatives = classified
    .filter((entry) => entry.verdict.family !== chosen.verdict.family)
    .map((entry) => entry.remote.name);

  return {
    ok: true,
    vcs: chosen.verdict.family,
    name: chosen.remote.name,
    url: chosen.remote.url,
    via: chosen.verdict.via,
    ambiguous: alternatives.length > 0,
    alternatives,
  };
}

/**
 * Resolve the three-dot diff range a session-drift / scope measurement should
 * run against — the projection that replaces the hard-coded literal
 * `'origin/main...HEAD'` (live at `scripts/lib/scope-baseline.mjs:519`, which is
 * silently inert in any repo whose remote is not named `origin` or whose default
 * branch is not `main`).
 *
 * Chain, first hit wins:
 *   1. {@link resolvePreferredRemote} (vcs-less) → the remote `R`.
 *   2. `git symbolic-ref --short refs/remotes/<R>/HEAD` → `via:'remote-head'`.
 *      Only populated by an explicit `git remote set-head -a`, so it is the
 *      most authoritative and the least often present.
 *   3. `git rev-parse --verify --quiet refs/remotes/<R>/main`, then `…/master`
 *      → `via:'remote-default-branch'`. Covers the freshly-pushed repo where
 *      nobody ever ran `set-head`.
 *   4. `refs/heads/main`, then `refs/heads/master` → `via:'local-default-branch'`,
 *      gated on `allowLocalFallback` (default `true`). A local branch is a
 *      weaker baseline than a tracking ref — it does not know what the remote
 *      has — so a caller that needs a remote-anchored measurement passes
 *      `allowLocalFallback:false` and gets `no-tracking-ref` instead.
 *   5. `{ ok:false, reason:'no-tracking-ref' }`, or `'unborn-head'` when the
 *      repo has no commit at all (probed only on this path, so the happy path
 *      costs nothing).
 *
 * **No root-commit fallback, by operator decision.** Diffing against the first
 * commit of the repository yields a ratio over the ENTIRE history, which is not
 * a session-drift measurement — it is a number that looks like one. An honest
 * `no-tracking-ref` lets the caller skip with a reason.
 *
 * The range is always three-dot (`<base>...HEAD`, merge-base relative),
 * identical to the semantics of the literal it replaces.
 *
 * @param {{ repoRoot?: string, gitRun?: GitRun, allowLocalFallback?: boolean }} [opts]
 * @returns {{ ok: true, range: string, base: string, remote: string,
 *             via: 'remote-head'|'remote-default-branch'|'local-default-branch' }
 *   | { ok: false, reason: RemoteResolutionReason|'no-tracking-ref'|'unborn-head',
 *       remotes?: GitRemote[], stderr?: string }}
 */
export function resolveBaselineRange({ repoRoot, gitRun = defaultGitRun, allowLocalFallback = true } = {}) {
  const preferred = resolvePreferredRemote({ repoRoot, gitRun });
  if (!preferred.ok) return preferred;

  const root = repoRoot ?? process.cwd();
  const remote = preferred.name;
  const run = (args) => gitRun(['-C', root, ...args]) ?? { ok: false, stdout: '', stderr: '' };
  const done = (base, via) => ({ ok: /** @type {true} */ (true), range: `${base}...HEAD`, base, remote, via });

  const head = run(['symbolic-ref', '--short', `refs/remotes/${remote}/HEAD`]);
  const headRef = head.ok ? head.stdout.trim() : '';
  if (headRef !== '' && !isUnsafeForArgv(headRef)) return done(headRef, 'remote-head');

  for (const branch of ['main', 'master']) {
    const verified = run(['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${branch}`]);
    if (verified.ok && verified.stdout.trim() !== '') return done(`${remote}/${branch}`, 'remote-default-branch');
  }

  if (allowLocalFallback) {
    for (const branch of ['main', 'master']) {
      const verified = run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      if (verified.ok && verified.stdout.trim() !== '') return done(branch, 'local-default-branch');
    }
  }

  const headCommit = run(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const unborn = !headCommit.ok || headCommit.stdout.trim() === '';
  return { ok: false, reason: unborn ? 'unborn-head' : 'no-tracking-ref' };
}

/**
 * @typedef {'not-a-git-repo'|'git-unavailable'|'git-error'|'no-remotes'|'no-matching-remote'|'unsafe-value'} RemoteResolutionReason
 */

/**
 * @typedef {{ name: string, url: string }} GitRemote
 */

/**
 * @typedef {{ ok: boolean, stdout: string, stderr: string, status?: number, code?: string }} GitRunResult
 */

/**
 * Injectable git runner. `status`/`code` are OPTIONAL — a stub that omits them
 * still works; its failures classify as the generic `git-error`.
 * @typedef {(args: string[]) => GitRunResult} GitRun
 */
