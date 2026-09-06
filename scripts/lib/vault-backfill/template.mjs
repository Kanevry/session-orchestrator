/**
 * template.mjs — Canonical .vault.yaml template renderer for vault-backfill.
 *
 * Reads the template once from a projects-baseline checkout; subsequent calls
 * use the cache. The checkout is optional — see docs/baseline.md.
 * Part of scripts/vault-backfill.mjs (Issue #241).
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveHostPath } from '../config/host-paths.mjs';

/** Path of the template RELATIVE to a projects-baseline checkout root. */
const TEMPLATE_REL_PATH = 'templates/shared/.vault.yaml.template';

/** This file lives at `<repoRoot>/scripts/lib/vault-backfill/`. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Candidate projects-baseline checkout roots. The baseline is optional and
 * private (`docs/baseline.md`), so no host-specific directory name may be
 * committed here.
 *
 * Two tiers, and the split is load-bearing:
 *
 *   EXPLICIT — `PROJECTS_BASELINE_DIR`, else `SO_BASELINE_PATH` / `owner.yaml`
 *   `paths.baseline-path`. When the operator has SAID where the baseline is,
 *   that answer is used ALONE. Probing past a wrong explicit value would resolve
 *   a DIFFERENT baseline than the one named and report success — silently using
 *   a corpus nobody asked for is worse than the abort, and it would hide the
 *   typo forever.
 *
 *   CONVENTION — the sibling checkout `scripts/sync-vault-schema.mjs` already
 *   uses, then the legacy `~/Projects` default this module shipped with. These
 *   are guesses, so probing among them is exactly right.
 *
 * @returns {string[]} never empty
 */
function baselineCandidates() {
  const envDir = (process.env.PROJECTS_BASELINE_DIR || '').trim();
  if (envDir) return [envDir];
  const hostDir = resolveHostPath('baseline-path', null);
  if (typeof hostDir === 'string' && hostDir.trim() !== '') return [hostDir.trim()];
  return [
    resolve(REPO_ROOT, '..', 'projects-baseline'),
    resolve(homedir(), 'Projects/projects-baseline'),
  ];
}

/**
 * Resolved absolute path of the canonical template.
 *
 * Import-time resolution is retained deliberately: the export is a plain string
 * that `scripts/vault-backfill.mjs` and the tests both read directly. Ceiling:
 * at most two `existsSync` calls at import. When no candidate exists the FIRST
 * candidate is exported anyway, so `loadTemplate`'s die message names the path
 * the operator most likely meant rather than `undefined`.
 */
export const TEMPLATE_PATH = (() => {
  const candidates = baselineCandidates();
  for (const base of candidates) {
    const candidate = resolve(base, TEMPLATE_REL_PATH);
    if (existsSync(candidate)) return candidate;
  }
  return resolve(candidates[0], TEMPLATE_REL_PATH);
})();

const TODAY = new Date().toISOString().slice(0, 10);

let _templateContent = null;

/**
 * Load and cache the canonical template. Calls dieFn(2, ...) if missing.
 */
export function loadTemplate(dieFn) {
  if (_templateContent !== null) return _templateContent;

  if (!existsSync(TEMPLATE_PATH)) {
    dieFn(
      2,
      `canonical template not found at ${TEMPLATE_PATH} — ` +
        `the projects-baseline checkout is optional and private (see docs/baseline.md). ` +
        `Point at it with owner.yaml \`paths.baseline-path\` (host-local, never committed), ` +
        `the SO_BASELINE_PATH env var, or PROJECTS_BASELINE_DIR; a sibling checkout at ` +
        `../projects-baseline is picked up automatically.`,
    );
  }

  try {
    _templateContent = readFileSync(TEMPLATE_PATH, 'utf8');
  } catch (err) {
    dieFn(2, `cannot read template at ${TEMPLATE_PATH}: ${err.message}`);
  }

  return _templateContent;
}

/**
 * Convert a kebab-case slug to a human-readable Title Case name.
 * e.g. "auth-service" → "Auth Service"
 */
export function slugToHumanName(slug) {
  return slug
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Derive a kebab-case slug from a repo path (last segment).
 */
export function pathToSlug(repoPath) {
  const last = repoPath.split('/').filter(Boolean).pop() ?? repoPath;
  return last
    .toLowerCase()
    .replace(/[._]/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Produce a safe YAML 1.2 scalar for a user-supplied string value.
 *
 * Uses JSON.stringify (YAML 1.2 is a superset of JSON) which:
 *   - wraps the value in double quotes
 *   - escapes newlines (\n), carriage returns (\r), tabs (\t), backslashes, and double quotes
 *
 * This prevents YAML injection via embedded newlines or special characters
 * in externally-sourced fields such as `owner` (GitLab API) and `gitlabPath`
 * (manifest file). CWE-1336 / Issue #247.
 *
 * @param {string} value
 * @returns {string} — a JSON-encoded double-quoted YAML scalar, e.g. "alice"
 */
export function yamlScalar(value) {
  return JSON.stringify(String(value));
}

/**
 * Render .vault.yaml content from the canonical template.
 *
 * Substitutions:
 *   {{PROJECT_NAME}} → humanName   (metadata.name, summary placeholder)
 *   metadata.slug    → slug         (overwrite the {{PROJECT_NAME}} echo on slug field)
 *   tier             → manifest tier
 *   owner            → fetched owner  [sanitised via yamlScalar]
 *   {{GITLAB_GROUP}}/{{PROJECT_NAME}} → full gitlab path_with_namespace  [sanitised via yamlScalar]
 *
 * @param {{ humanName: string, slug: string, tier: string, gitlabPath: string, owner: string }} opts
 * @param {string} templateContent - loaded template string
 * @returns {string}
 */
export function renderTemplate({ humanName, slug, tier, gitlabPath, owner }, templateContent) {
  let out =
    `# Generated by scripts/vault-backfill.mjs on ${TODAY} — review and update before committing.\n` +
    templateContent;

  // {{PROJECT_NAME}} → humanName (appears in metadata.name, summary)
  // humanName is derived from a manifest-validated slug ([a-z0-9-]) so it only
  // contains word characters and spaces — no YAML-special characters.
  out = out.replace(/\{\{PROJECT_NAME\}\}/g, humanName);

  // metadata.slug line: after PROJECT_NAME substitution it reads slug: "humanName" — fix to actual slug
  // slug is validated to /^[a-z0-9]+(?:-[a-z0-9]+)*$/ by validateManifest — safe to embed bare.
  out = out.replace(/^(\s*slug:\s*)"[^"]*"(.*)$/m, `$1"${slug}"$2`);

  // tier: active → tier: <manifest tier>
  // tier is a closed enum (top|active|archived) — safe to embed bare.
  out = out.replace(/^(\s*tier:\s*)active(.*)$/m, `$1${tier}$2`);

  // owner field — value comes from GitLab API (externally controlled).
  // Use yamlScalar() to produce a quoted scalar, preventing newline injection (CWE-1336, #247).
  // The template has a bare unquoted owner value (e.g. `owner: bernhard`);
  // the regex replaces only the bare value token, preserving any trailing comment.
  out = out.replace(/^(\s*owner:\s*)\S+(.*)$/m, `$1${yamlScalar(owner)}$2`);

  // spec.links.gitlab — template uses {{GITLAB_GROUP}}/{{PROJECT_NAME}};
  // after PROJECT_NAME substitution the token reads {{GITLAB_GROUP}}/humanName, still inside "...".
  // gitlabPath comes from the manifest `path` field which is not validated for YAML-special chars.
  // Replace the whole "..." quoted token with yamlScalar(gitlabPath) to prevent injection (#247).
  out = out.replace(/"?\{\{GITLAB_GROUP\}\}\/[^\n"]*"?/g, yamlScalar(gitlabPath));

  return out;
}
