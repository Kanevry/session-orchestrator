/**
 * named-vault-resolver.mjs — Walk-up named-vault resolution (Issue #700 Part 2).
 *
 * Generalises single-vault resolution to N named vaults. Each named vault is
 * declared in the host-local `owner.yaml` under an optional `vaults:` list.
 * When `vaults:` is absent, all exports degrade gracefully to byte-identical
 * single-vault behaviour — absent-tolerant, never throws.
 *
 * ── Design ───────────────────────────────────────────────────────────────────
 *
 * Precedence for resolveNamedVault():
 *   1. explicit vaultName arg (--vault-name CLI / Session Config vault-name)
 *   2. walk-up org-prefix match against ownerConfig.vaults[].match.org-prefix
 *   3. single-vault fallback → {source:'fallback'} (byte-identical to today)
 *
 * IO is fully injectable (existsSync, realpathSync, env, gitRemote) so every
 * branch is unit-testable without touching disk or git.
 *
 * ── Remote resolution (#1039) ────────────────────────────────────────────────
 *
 * The default `gitRemote` reads the repo's remote through the shared core in
 * `vcs-repo-spec.mjs` ({@link resolvePreferredRemote}), VCS-LESS. Two properties
 * of that call are load-bearing here and must not be "tidied":
 *
 *   1. **`vcs` is deliberately omitted.** This module needs a URL, not a
 *      platform family, and the vcs-less preference order is `origin` first.
 *      That order is what keeps the derived slug STABLE: in a repo carrying both
 *      `origin` (→ `<group>/<repo>`) and `gitlab`/`github` mirrors under other
 *      namespaces, a `gitlab`-first order would re-namespace — i.e. silently
 *      RENAME — every vault note already written under the origin namespace.
 *   2. **Absence and query-failure are kept apart.** The former
 *      `git remote get-url origin` implementation returned `''` for *both* "no
 *      remote configured" and "git blew up / this is not a repo", and a falsy
 *      URL skips the walk-up entirely. The vault then resolved to the
 *      single-vault fallback with no trace of why — one `source:'fallback'`
 *      label covering a benign repo state and a broken measurement. The
 *      fallback result now carries an optional `remoteError` (a
 *      `REMOTE_RESOLUTION_REASONS` value) so the two are separable BY VALUE, and
 *      only a query failure ({@link isQueryFailure}) WARNs — an absence is
 *      normal and stays silent.
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *
 *   parseNamedVaults(ownerConfig)
 *   canonicalSuffixesFromVaults(vaults, envOverride)
 *   matchVaultForRepo(repoSlug, vaults)
 *   resolveCanonicalSuffixes({ ownerConfig, env })
 *   findRepoRoot(cwd, { existsSync, realpathSync })
 *   resolveNamedVault({ vaultName, cwd, ownerConfig, env, gitRemote, existsSync, realpathSync })
 */

import { join, dirname } from 'node:path';
import { existsSync as nodeExistsSync, realpathSync as nodeRealpathSync } from 'node:fs';
import { resolvePreferredRemote, isQueryFailure } from './vcs-repo-spec.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Default canonical suffix — mirrors vault-mirror.mjs _resolveCanonicalSuffix
 * @internal
 */
const DEFAULT_SUFFIX = '/agents/vault';

// ---------------------------------------------------------------------------
// parseNamedVaults — PURE
// ---------------------------------------------------------------------------

/**
 * Extract and validate the `vaults:` list from a raw ownerConfig object.
 *
 * Drop-and-WARN on malformed entries; never throw. Returns [] when the
 * section is absent or empty — this is the backward-compat no-op path.
 *
 * Each valid entry: { name: string, suffix: string, root: string, match?: { 'org-prefix'?: string } }
 *
 * @param {object|undefined} ownerConfig — raw parsed owner.yaml (NOT merged with defaults)
 * @returns {Array<{name:string, suffix:string, root:string, match:{'org-prefix'?:string}}>}
 */
export function parseNamedVaults(ownerConfig) {
  const raw = ownerConfig?.vaults;

  // Absent or explicit null/empty → no-op
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw) && raw.length === 0) return [];

  if (!Array.isArray(raw)) {
    process.stderr.write(
      'WARN named-vault-resolver: owner.yaml vaults: must be an array; ignoring\n',
    );
    return [];
  }

  const result = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!isPlainObject(entry)) {
      process.stderr.write(
        `WARN named-vault-resolver: owner.yaml vaults[${i}] is not an object; dropping\n`,
      );
      continue;
    }

    const { name, suffix, root, match } = entry;

    if (typeof name !== 'string' || name.trim() === '') {
      process.stderr.write(
        `WARN named-vault-resolver: owner.yaml vaults[${i}].name must be a non-empty string; dropping entry\n`,
      );
      continue;
    }
    if (typeof suffix !== 'string' || suffix.trim() === '') {
      process.stderr.write(
        `WARN named-vault-resolver: owner.yaml vaults[${i}].suffix must be a non-empty string; dropping entry\n`,
      );
      continue;
    }
    if (typeof root !== 'string' || root.trim() === '') {
      process.stderr.write(
        `WARN named-vault-resolver: owner.yaml vaults[${i}].root must be a non-empty string; dropping entry\n`,
      );
      continue;
    }

    // match is optional; if present, validate it
    let matchObj = {};
    if (match !== undefined && match !== null) {
      if (!isPlainObject(match)) {
        process.stderr.write(
          `WARN named-vault-resolver: owner.yaml vaults[${i}].match must be an object; ignoring match field\n`,
        );
      } else {
        const orgPrefix = match['org-prefix'];
        if (orgPrefix !== undefined && typeof orgPrefix !== 'string') {
          process.stderr.write(
            `WARN named-vault-resolver: owner.yaml vaults[${i}].match.org-prefix must be a string; ignoring\n`,
          );
        } else {
          matchObj = { 'org-prefix': orgPrefix };
        }
      }
    }

    result.push({
      name: name.trim(),
      suffix: suffix.trim(),
      root: root.trim(),
      match: matchObj,
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// canonicalSuffixesFromVaults — PURE
// ---------------------------------------------------------------------------

/**
 * Build the array of canonical suffixes used in the .some() guard.
 *
 * When `vaults` is empty AND `envOverride` is absent/blank → returns
 * ['/agents/vault'] — byte-identical to the pre-#700 single-suffix path.
 *
 * When `envOverride` is set (non-blank) → returns [envOverride.trim()] always,
 * mirroring the original VAULT_MIRROR_CANONICAL_SUFFIX env-wins behaviour.
 *
 * When `vaults` is non-empty AND no env override → returns the suffix from
 * each named vault entry.
 *
 * @param {Array<{suffix:string}>} vaults — result of parseNamedVaults()
 * @param {string|undefined} [envOverride] — process.env.VAULT_MIRROR_CANONICAL_SUFFIX
 * @returns {string[]}
 */
export function canonicalSuffixesFromVaults(vaults, envOverride) {
  // Env override always wins (mirrors _resolveCanonicalSuffix)
  if (typeof envOverride === 'string' && envOverride.trim() !== '') {
    return [envOverride.trim()];
  }

  // Named vaults present → collect their suffixes
  if (vaults.length > 0) {
    return vaults.map((v) => v.suffix);
  }

  // Fallback: single-vault default
  return [DEFAULT_SUFFIX];
}

// ---------------------------------------------------------------------------
// matchVaultForRepo — PURE
// ---------------------------------------------------------------------------

/**
 * Find the first named vault whose `match.org-prefix` is a prefix of the given
 * repoSlug (format: `org/repo-name` as returned by deriveRepo()).
 *
 * Returns the matching vault entry or null when no match found or when the
 * entry has no match.org-prefix defined.
 *
 * First-match-wins; caller is responsible for WARN on ambiguity if needed.
 *
 * @param {string} repoSlug — e.g. 'bernhard-group/foo'
 * @param {Array<{name:string, suffix:string, root:string, match:{'org-prefix'?:string}}>} vaults
 * @returns {{name:string, suffix:string, root:string, match:object}|null}
 */
export function matchVaultForRepo(repoSlug, vaults) {
  if (!repoSlug || vaults.length === 0) return null;

  const slug = String(repoSlug);
  const matched = [];

  for (const v of vaults) {
    const orgPrefix = v.match?.['org-prefix'];
    if (typeof orgPrefix !== 'string' || orgPrefix.trim() === '') continue;

    // Match: repoSlug starts with the org-prefix
    if (slug === orgPrefix || slug.startsWith(`${orgPrefix}/`) || slug.startsWith(`${orgPrefix}-`)) {
      matched.push(v);
    }
  }

  if (matched.length > 1) {
    process.stderr.write(
      `WARN named-vault-resolver: multiple named vaults match repo "${repoSlug}": ${matched.map((v) => v.name).join(', ')}; using first match "${matched[0].name}"\n`,
    );
  }

  return matched.length > 0 ? matched[0] : null;
}

// ---------------------------------------------------------------------------
// resolveCanonicalSuffixes — thin wrapper (ownerConfig injectable)
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical suffix array for the vault-mirror guard.
 *
 * Caller is expected to pass ownerConfig (loaded from disk by the caller).
 * vault-mirror.mjs loads it via loadOwnerConfig() before calling this.
 * When ownerConfig is not provided (undefined), falls back to single-vault
 * default — byte-identical to pre-#700 behaviour.
 *
 * @param {{ ownerConfig?: object, env?: Record<string, string|undefined> }} [opts]
 * @returns {string[]}
 */
export function resolveCanonicalSuffixes({ ownerConfig, env = process.env } = {}) {
  const vaults = parseNamedVaults(ownerConfig);
  return canonicalSuffixesFromVaults(vaults, env?.VAULT_MIRROR_CANONICAL_SUFFIX);
}

// ---------------------------------------------------------------------------
// findRepoRoot — injectable IO
// ---------------------------------------------------------------------------

/**
 * Walk up from `cwd` (after resolving symlinks) to locate the nearest `.git`
 * directory, handling worktree `.git` files (same idiom as workspace.mjs L62-96).
 *
 * Stops at filesystem root. Returns null (never throws) when no `.git` found.
 *
 * @param {string} [cwd]
 * @param {{ existsSync?: Function, realpathSync?: Function }} [io]
 * @returns {string|null} absolute path of the repo root, or null
 */
export function findRepoRoot(cwd = process.cwd(), { existsSync = nodeExistsSync, realpathSync = nodeRealpathSync } = {}) {
  let start;
  try {
    start = realpathSync(cwd);
  } catch {
    start = cwd;
  }

  let p = start;
  let levels = 0;
  while (levels < 20) {
    const gitEntry = join(p, '.git');
    if (existsSync(gitEntry)) {
      // Symlink / worktree file vs real directory handled at call site —
      // for the purposes of finding the root, the directory containing .git is enough
      return p;
    }
    const parent = dirname(p);
    if (parent === p) break; // filesystem root
    p = parent;
    levels++;
  }

  return null;
}

// ---------------------------------------------------------------------------
// resolveNamedVault — main resolution entry point
// ---------------------------------------------------------------------------

/**
 * Resolve the named vault to use for a given cwd / explicit override.
 *
 * Precedence:
 *   1. explicit vaultName → {source:'explicit'} — skips cwd/git entirely
 *   2. walk-up org-prefix match against vaults[].match.org-prefix
 *      using the git remote of the repo found at cwd → {source:'walkup'}
 *   3. single-vault fallback → {source:'fallback'}
 *
 * Injectable IO (existsSync, realpathSync, gitRemote) for full unit-testability.
 * `gitRemote(repoRoot)` is called ONLY in the walk-up path — injecting a
 * stub that throws proves the explicit path never calls it.
 *
 * `gitRemote` keeps its `(repoRoot) => string` contract verbatim; the optional
 * second argument is an OUT-parameter the default implementation uses to report
 * WHY it returned `''`. A one-arg stub ignores it and classifies as
 * `'no-remotes'` on `''` / `'git-error'` on a throw — so every pre-existing
 * injection still works unchanged.
 *
 * `gitRun` is injected into the DEFAULT `gitRemote` only, and is ignored when
 * `gitRemote` is supplied (the caller has replaced the thing that would use it).
 * It exists so the default remote-resolution path — preference order, reason
 * propagation — is testable at all; a `gitRemote` stub answers that question
 * before the code under test runs and can only ever confirm itself.
 *
 * `remoteError` is present ONLY on a `source:'fallback'` result that was reached
 * because the remote query produced nothing; it is absent when the fallback was
 * reached for any other reason (no vaults configured, no repo root, the repo IS
 * a vault, no org-prefix match). Additive — pre-#1039 readers see the identical
 * four fields.
 *
 * @param {{
 *   vaultName?: string|null,
 *   cwd?: string,
 *   ownerConfig?: object,
 *   env?: Record<string, string|undefined>,
 *   gitRemote?: (repoRoot: string, out?: {reason?: string}) => string,
 *   gitRun?: (args: string[]) => {ok: boolean, stdout: string, stderr: string, status?: number, code?: string},
 *   existsSync?: Function,
 *   realpathSync?: Function,
 * }} [opts]
 * @returns {{
 *   root: string|null,
 *   suffix: string,
 *   name: string|null,
 *   source: 'explicit'|'walkup'|'fallback',
 *   remoteError?: string
 * }}
 */
export function resolveNamedVault({
  vaultName = null,
  cwd = process.cwd(),
  ownerConfig,
  env = process.env,
  gitRemote,
  gitRun,
  existsSync = nodeExistsSync,
  realpathSync = nodeRealpathSync,
} = {}) {
  const vaults = parseNamedVaults(ownerConfig);
  const readRemote =
    typeof gitRemote === 'function' ? gitRemote : (root, out) => _defaultGitRemote(root, out, gitRun);

  // ── Path 1: explicit vault-name ──────────────────────────────────────────
  const trimmedName = typeof vaultName === 'string' ? vaultName.trim() : '';
  if (trimmedName) {
    // Look up by name in the vaults list
    const entry = vaults.find((v) => v.name === trimmedName) ?? null;
    return {
      root: entry?.root ?? null,
      suffix: entry?.suffix ?? _resolveEnvSuffix(env) ?? DEFAULT_SUFFIX,
      name: trimmedName,
      source: 'explicit',
    };
  }

  // ── Path 2: walk-up org-prefix match ────────────────────────────────────
  /** @type {string|undefined} — set ONLY when the remote query is why we fall through */
  let remoteError;

  if (vaults.length > 0) {
    const repoRoot = findRepoRoot(cwd, { existsSync, realpathSync });
    if (repoRoot !== null) {
      // Resolve the repo's preferred remote (vcs-less → origin-first; see the
      // module docblock for why that order must not move).
      /** @type {{reason?: string, stderr?: string}} */
      const remoteOut = {};
      let remoteUrl;
      try {
        remoteUrl = readRemote(repoRoot, remoteOut);
      } catch (err) {
        // A throwing gitRemote could not answer the question — that is a query
        // failure, never "this repo has no remote".
        remoteUrl = '';
        remoteOut.reason = 'git-error';
        remoteOut.stderr = err instanceof Error ? err.message : String(err);
      }

      if (!remoteUrl) {
        // Falsy URL: keep the REASON instead of collapsing it into a bare
        // `source:'fallback'`. A one-arg stub that reported nothing means the
        // benign "no remote configured" case.
        remoteError = remoteOut.reason ?? 'no-remotes';
        if (isQueryFailure(remoteError)) {
          const detail = remoteOut.stderr ? `: ${String(remoteOut.stderr).trim()}` : '';
          process.stderr.write(
            `WARN named-vault-resolver: could not read the git remote of "${repoRoot}" (${remoteError})${detail}; falling back to the single-vault default\n`,
          );
        }
      } else {
        // Derive org/repo from the remote URL (strip suffix/.git/scheme)
        const repoSlug = _deriveSlugFromRemote(remoteUrl);

        // Guard: if this repo IS one of the vaults, skip (don't self-mirror)
        const canonicalSuffixes = canonicalSuffixesFromVaults(vaults, env?.VAULT_MIRROR_CANONICAL_SUFFIX);
        const normalized = _normalizeRemoteUrl(remoteUrl);
        if (canonicalSuffixes.some((s) => normalized.endsWith(s))) {
          // This is the vault itself — fall through to fallback
        } else {
          const match = matchVaultForRepo(repoSlug, vaults);
          if (match !== null) {
            return {
              root: match.root,
              suffix: match.suffix,
              name: match.name,
              source: 'walkup',
            };
          }
        }
      }
    }
  }

  // ── Path 3: single-vault fallback ────────────────────────────────────────
  // `remoteError` is spread in only when set, so a fallback reached for any
  // other reason keeps the exact pre-#1039 four-field shape.
  return {
    root: null,
    suffix: _resolveEnvSuffix(env) ?? DEFAULT_SUFFIX,
    name: null,
    source: 'fallback',
    ...(remoteError === undefined ? {} : { remoteError }),
  };
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Resolve the env-var suffix override (mirrors _resolveCanonicalSuffix).
 * Returns null when the env var is absent/blank.
 * @param {Record<string, string|undefined>} env
 * @returns {string|null}
 */
function _resolveEnvSuffix(env) {
  const v = env?.VAULT_MIRROR_CANONICAL_SUFFIX;
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

/**
 * Normalize a git remote URL to host/path tail (mirrors vault-mirror.mjs _normalizeRemote).
 * @param {string} url
 * @returns {string}
 */
function _normalizeRemoteUrl(url) {
  return String(url ?? '')
    .trim()
    .replace(/\.git$/, '')
    .replace(/^git@([^:]+):/, '$1/')
    .replace(/^[a-z]+:\/\//, '')
    .replace(/\/+$/, '');
}

/**
 * Derive an org/repo slug from a git remote URL.
 * e.g. 'git@github.com:my-org/my-repo.git' → 'my-org/my-repo'
 * @param {string} url
 * @returns {string}
 */
function _deriveSlugFromRemote(url) {
  const normalized = _normalizeRemoteUrl(url);
  // normalized is now 'host/path/to/repo' — take the last two segments
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return normalized;
}

/**
 * Default gitRemote implementation (#1039).
 *
 * Delegates to the shared {@link resolvePreferredRemote} core VCS-LESS, which
 * makes this resolver work in the repos the old hard-coded
 * `git remote get-url origin` was blind in — a repo whose remotes are named
 * `gitlab`/`github`, a fork whose sole remote is `upstream`. The vcs-less
 * preference order still tries `origin` FIRST, so the slug derived for a repo
 * that has an `origin` is byte-identical to the pre-#1039 value.
 *
 * Return type stays `string` (the `gitRemote` DI contract depends on it). The
 * failure reason travels through the optional `out` OUT-parameter instead:
 * folding it into the return value would have meant changing that contract for
 * every injected stub.
 *
 * @param {string} repoRoot
 * @param {{reason?: string, stderr?: string}} [out] — populated with the
 *   {@link REMOTE_RESOLUTION_REASONS} reason when the resolution failed
 * @param {Function} [gitRun] — injectable git runner; `undefined` uses the real one
 * @returns {string} the remote URL, or `''` when none resolved
 */
function _defaultGitRemote(repoRoot, out, gitRun) {
  // `vcs` deliberately omitted — see the module docblock (origin-first order).
  const resolved = resolvePreferredRemote({ repoRoot, gitRun });
  if (resolved.ok) return resolved.url;
  if (isPlainObject(out)) {
    out.reason = resolved.reason;
    if (resolved.stderr) out.stderr = resolved.stderr;
  }
  return '';
}
