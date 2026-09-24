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
 * ── Other sections (agents/vault#319) ────────────────────────────────────────
 *
 *   The same directory-prefix match serves any owner.yaml list of the shape
 *   `{ path, match: { path-prefix } }`. `section` picks the list and `envKey` the
 *   env var this tier yields to. The live second consumer is `vault-dirs:`
 *   (section 'vault-dirs', envKey 'SO_VAULT_DIR'), driven by
 *   `resolveVaultDir` in scripts/lib/config/host-paths.mjs. `name` is required
 *   only for `baselines:` (the #819 contract); elsewhere it is optional and
 *   defaults to `path`, which is what the ambiguity WARN then names.
 *
 * ── Exports ──────────────────────────────────────────────────────────────────
 *
 *   parseBaselines(ownerConfig, section?)
 *   matchBaselineForPath(absPath, baselines, section?)
 *   resolveNamedBaseline({ cwd, ownerConfig, env, section?, envKey? })
 */

import { normalize, sep } from 'node:path';
import { expandTilde } from './common.mjs';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Sections whose entries MUST carry a `name` (the #819 baselines contract). */
const NAME_REQUIRED_SECTIONS = new Set(['baselines']);

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
 * Extract and validate a directory-prefix list (default `baselines:`) from a raw
 * ownerConfig object.
 *
 * Drop-and-WARN on malformed entries; never throw. Returns [] when the section
 * is absent, null, or empty — the backward-compat no-op path. Every WARN names
 * the section it came from.
 *
 * Each valid entry: { name: string, path: string, match: { 'path-prefix': string } }.
 * `name` is required for `baselines`; for other sections an absent name falls
 * back to `path` (a present-but-blank or non-string name is still dropped).
 *
 * @param {object|undefined} ownerConfig — raw parsed owner.yaml (NOT merged with defaults)
 * @param {string} [section='baselines'] — owner.yaml list to read (e.g. 'vault-dirs')
 * @returns {Array<{name:string, path:string, match:{'path-prefix':string}}>}
 */
export function parseBaselines(ownerConfig, section = 'baselines') {
  const raw = ownerConfig?.[section];

  // Absent or explicit null/empty → no-op
  if (raw === undefined || raw === null) return [];
  if (Array.isArray(raw) && raw.length === 0) return [];

  if (!Array.isArray(raw)) {
    process.stderr.write(
      `WARN named-baseline-resolver: owner.yaml ${section}: must be an array; ignoring\n`,
    );
    return [];
  }

  const nameRequired = NAME_REQUIRED_SECTIONS.has(section);
  const result = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (!isPlainObject(entry)) {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml ${section}[${i}] is not an object; dropping\n`,
      );
      continue;
    }

    const { name, path: entryPath, match } = entry;

    const nameAbsent = name === undefined || name === null;
    if ((nameRequired || !nameAbsent) && (typeof name !== 'string' || name.trim() === '')) {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml ${section}[${i}].name must be a non-empty string; dropping entry\n`,
      );
      continue;
    }
    if (typeof entryPath !== 'string' || entryPath.trim() === '') {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml ${section}[${i}].path must be a non-empty string; dropping entry\n`,
      );
      continue;
    }

    // match is REQUIRED (unlike vaults) — an entry with no path-prefix can
    // never be selected, so it is dropped rather than kept.
    if (!isPlainObject(match)) {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml ${section}[${i}].match must be an object; dropping entry\n`,
      );
      continue;
    }
    const pathPrefix = match['path-prefix'];
    if (typeof pathPrefix !== 'string' || pathPrefix.trim() === '') {
      process.stderr.write(
        `WARN named-baseline-resolver: owner.yaml ${section}[${i}].match.path-prefix must be a non-empty string; dropping entry\n`,
      );
      continue;
    }

    result.push({
      name: nameAbsent ? entryPath.trim() : name.trim(),
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
 * @param {string} [section='baselines'] — owner.yaml list name, used only in the WARN
 * @returns {{name:string, path:string, match:{'path-prefix':string}}|null}
 */
export function matchBaselineForPath(absPath, baselines, section = 'baselines') {
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
      `WARN named-baseline-resolver: multiple ${section} match path "${absPath}": ${matched
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
 * Resolve the directory-prefix match tier (default `baselines:`) for a given cwd.
 *
 * Returns:
 *   { path, name, source:'match' } when an entry's directory-prefix matches cwd.
 *   { path:null, name:null, source:null } (the null-fallback) otherwise — including
 *   when `env[envKey]` is set (this tier yields to the higher env tier the caller
 *   owns), when the section is not configured, or when nothing matches.
 *
 * Pure + synchronous — no git calls, no disk reads. Never throws.
 *
 * @param {{
 *   cwd?: string,
 *   ownerConfig?: object,
 *   env?: Record<string, string|undefined>,
 *   section?: string,
 *   envKey?: string,
 * }} [opts] — `section` defaults to 'baselines', `envKey` to 'SO_BASELINE_PATH'
 * @returns {{ path: string|null, name: string|null, source: 'match'|null }}
 */
export function resolveNamedBaseline({
  cwd = process.cwd(),
  ownerConfig,
  env = process.env,
  section = 'baselines',
  envKey = 'SO_BASELINE_PATH',
} = {}) {
  // Yield to the higher-precedence env tier the caller owns.
  const envVal = env?.[envKey];
  if (typeof envVal === 'string' && envVal.trim() !== '') {
    return { path: null, name: null, source: null };
  }

  const entries = parseBaselines(ownerConfig, section);
  const matched = entries.length > 0 ? matchBaselineForPath(cwd, entries, section) : null;
  if (matched !== null) {
    return { path: matched.path, name: matched.name, source: 'match' };
  }

  return { path: null, name: null, source: null };
}
