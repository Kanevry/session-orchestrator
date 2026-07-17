/**
 * named-baseline-resolver.mjs — Per-context plan-baseline resolution (Issue #819).
 *
 * Cousin of `named-vault-resolver.mjs`. Where the vault resolver matches a repo
 * to a named vault by its git-remote org/repo slug, this resolver matches the
 * current working directory to a named baseline by a local FILESYSTEM directory
 * prefix. Each named baseline is declared in the host-local `owner.yaml` under an
 * optional `baselines:` list. When `baselines:` is absent, every export degrades
 * gracefully to a null-fallback — absent-tolerant, never throws.
 *
 * ── Deliberate divergences from named-vault-resolver ─────────────────────────
 *
 *   - Match key is `path-prefix` (a local directory tree like `~/Projects/private-world`),
 *     NOT `org-prefix` (which matches git-remote slugs). Baseline selection is by
 *     directory tree, so no git calls are needed — this module is pure/synchronous.
 *   - Entry field is `path` (a single directory), replacing vaults' `root` + `suffix`.
 *   - `match` is REQUIRED: a baseline with no `path-prefix` can never be selected, so
 *     it is dropped-and-WARNed rather than kept (vaults keep entries without a match).
 *
 * ── Precedence (implemented by resolveNamedBaseline) ─────────────────────────
 *
 *   The caller (scripts/lib/config.mjs) owns the full plan-baseline-path chain:
 *     1. SO_BASELINE_PATH env  (highest)
 *     2. baselines: match      (this module → {source:'match'})
 *     3. owner.yaml paths.baseline-path (legacy)
 *     4. committed Session Config value
 *
 *   This module implements tier 2 only. As a self-contained, testable contract it
 *   also YIELDS to tier 1: when SO_BASELINE_PATH is set (non-blank), resolveNamedBaseline
 *   returns the null-fallback ({source:null}) so the caller's env tier wins.
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *
 *   parseBaselines(ownerConfig)
 *   matchBaselineForPath(absPath, baselines)
 *   resolveNamedBaseline({ cwd, ownerConfig, env })
 */

import { normalize, sep } from 'node:path';
import { expandTilde } from './common.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** @param {unknown} v */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Tilde-expand + normalize a filesystem path, stripping any trailing separator
 * (but preserving the filesystem root). Used to canonicalise BOTH the target
 * path and each configured prefix before a directory-prefix comparison.
 *
 * @param {unknown} p
 * @returns {string}
 */
function _normalizePath(p) {
  const expanded = expandTilde(String(p ?? ''));
  const normalized = normalize(expanded);
  if (normalized.length > 1 && normalized.endsWith(sep)) {
    return normalized.slice(0, -1);
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// parseBaselines — PURE
// ---------------------------------------------------------------------------

/**
 * Extract and validate the `baselines:` list from a raw ownerConfig object.
 *
 * Drop-and-WARN on malformed entries; never throw. Returns [] when the section
 * is absent, null, or empty — the backward-compat no-op path.
 *
 * Each valid entry: { name: string, path: string, match: { 'path-prefix': string } }
 *
 * @param {object|undefined} ownerConfig — raw parsed owner.yaml (NOT merged with defaults)
 * @returns {Array<{name:string, path:string, match:{'path-prefix':string}}>}
 */
export function parseBaselines(ownerConfig) {
  const raw = ownerConfig?.baselines;

  // Absent or explicit null/empty → no-op
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw) && raw.length === 0) return [];

  if (!Array.isArray(raw)) {
    process.stderr.write(
      'WARN named-baseline-resolver: owner.yaml baselines: must be an array; ignoring\n',
    );
    return [];
  }

  const result = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!isPlainObject(entry)) {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml baselines[${i}] is not an object; dropping\n`,
      );
      continue;
    }

    const { name, path: entryPath, match } = entry;

    if (typeof name !== 'string' || name.trim() === '') {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml baselines[${i}].name must be a non-empty string; dropping entry\n`,
      );
      continue;
    }
    if (typeof entryPath !== 'string' || entryPath.trim() === '') {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml baselines[${i}].path must be a non-empty string; dropping entry\n`,
      );
      continue;
    }

    // match is REQUIRED (unlike vaults) — a baseline with no path-prefix can
    // never be selected, so it is dropped rather than kept.
    if (!isPlainObject(match)) {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml baselines[${i}].match must be an object; dropping entry\n`,
      );
      continue;
    }
    const pathPrefix = match['path-prefix'];
    if (typeof pathPrefix !== 'string' || pathPrefix.trim() === '') {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml baselines[${i}].match.path-prefix must be a non-empty string; dropping entry\n`,
      );
      continue;
    }

    result.push({
      name: name.trim(),
      path: entryPath.trim(),
      match: { 'path-prefix': pathPrefix.trim() },
    });
  }

  return result;
}

// ---------------------------------------------------------------------------
// matchBaselineForPath — PURE
// ---------------------------------------------------------------------------

/**
 * Find the first named baseline whose `match.path-prefix` is a directory-prefix
 * of the given absolute path. Both the path and each prefix are tilde-expanded
 * and path-normalized before comparison.
 *
 * A prefix matches when the target path IS the prefix, or starts with
 * `prefix + path.sep` (so `/a/b` matches `/a/b` and `/a/b/c`, but NOT `/a/bc`).
 *
 * First-match-wins. On an ambiguous multi-match, emits a WARN (never throws) and
 * returns the first match.
 *
 * @param {string} absPath — the working directory to classify
 * @param {Array<{name:string, path:string, match:{'path-prefix':string}}>} baselines
 * @returns {{name:string, path:string, match:{'path-prefix':string}}|null}
 */
export function matchBaselineForPath(absPath, baselines) {
  if (!absPath || !Array.isArray(baselines) || baselines.length === 0) return null;

  const target = _normalizePath(absPath);
  const matched = [];

  for (const b of baselines) {
    const prefixRaw = b?.match?.['path-prefix'];
    if (typeof prefixRaw !== 'string' || prefixRaw.trim() === '') continue;
    const prefix = _normalizePath(prefixRaw);
    if (target === prefix || target.startsWith(`${prefix}${sep}`)) {
      matched.push(b);
    }
  }

  if (matched.length > 1) {
    process.stderr.write(
      `WARN named-baseline-resolver: multiple baselines match path "${absPath}": ${matched
        .map((b) => b.name)
        .join(', ')}; using first match "${matched[0].name}"\n`,
    );
  }

  return matched.length > 0 ? matched[0] : null;
}

// ---------------------------------------------------------------------------
// resolveNamedBaseline — main resolution entry point (tier 2)
// ---------------------------------------------------------------------------

/**
 * Resolve the `baselines:` match tier for a given cwd.
 *
 * Returns:
 *   { path, name, source:'match' } when a baseline directory-prefix matches cwd.
 *   { path:null, name:null, source:null } (the null-fallback) otherwise — including
 *   when SO_BASELINE_PATH env is set (this tier yields to the higher env tier the
 *   caller owns), when no `baselines:` are configured, or when nothing matches.
 *
 * Pure + synchronous — no git calls, no disk reads. Never throws.
 *
 * @param {{
 *   cwd?: string,
 *   ownerConfig?: object,
 *   env?: Record<string, string|undefined>,
 * }} [opts]
 * @returns {{ path: string|null, name: string|null, source: 'match'|null }}
 */
export function resolveNamedBaseline({
  cwd = process.cwd(),
  ownerConfig,
  env = process.env,
} = {}) {
  // Yield to the higher-precedence env tier the caller owns (SO_BASELINE_PATH).
  const envVal = env?.SO_BASELINE_PATH;
  if (typeof envVal === 'string' && envVal.trim() !== '') {
    return { path: null, name: null, source: null };
  }

  const baselines = parseBaselines(ownerConfig);
  const matched = baselines.length > 0 ? matchBaselineForPath(cwd, baselines) : null;
  if (matched !== null) {
    return { path: matched.path, name: matched.name, source: 'match' };
  }

  return { path: null, name: null, source: null };
}
