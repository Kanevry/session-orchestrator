/**
 * vault-yaml.mjs — Reader for a repo's `.vault.yaml` registration slug (#1131).
 *
 * A repo registered in the Meta-Vault carries `.vault.yaml` at its root, whose
 * `metadata.slug` is the CANONICAL vault slug for that project — the name of
 * its `01-projects/<slug>/` folder. Until #1131 nothing READ that key: every
 * vault writer derived the slug from the checkout DIRECTORY name instead
 * (`scripts/lib/vault-status/narrative-mirror.mjs` via `subjectToSlug`,
 * `scripts/lib/vault-mirror/namespace.mjs` via `basename(process.cwd())`), so a
 * repo whose directory name differs lexically from its registered slug had its
 * narrative and its learnings/sessions filed under a second, wrong folder — and
 * the loose-slug healer in narrative-mirror (#829) only repairs case and
 * punctuation drift, never a genuinely different name.
 *
 * Exports:
 *   VAULT_YAML_FILE — the basename this module reads
 *   readVaultSlug   — repoRoot → validated `metadata.slug` string, or null
 *
 * Contract: NEVER throws. Absent file, unreadable file, malformed YAML, missing
 * key, non-string value, or a value that fails the repo's slug predicate all
 * return `null`, leaving every caller on its pre-#1131 derivation chain.
 *
 * Import closure is deliberately tiny (`node:fs`, `node:path`, `node:module`,
 * `./vault-mirror/utils.mjs`) — `namespace.mjs` is documented as a leaf-ward
 * module and must stay one.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import { isValidSlug } from './vault-mirror/utils.mjs';

/** Basename of the per-repo vault registration file. */
export const VAULT_YAML_FILE = '.vault.yaml';

// ── Lazy js-yaml resolution ──────────────────────────────────────────────────
//
// Same shape (and same reason) as `getYaml()` in scripts/lib/owner-yaml.mjs:
// a static `import yaml from 'js-yaml'` crashes any consumer running without
// `node_modules`, at MODULE LOAD, where the failure is not catchable. Both
// consumers of this reader are synchronous, so `createRequire` — not
// `await import()` — is the resolution mechanism.

/** @type {null | false | { load: Function }} */
let _yaml = null;
let _yamlWarned = false;

function getYaml() {
  if (_yaml !== null) return _yaml === false ? null : _yaml;
  try {
    _yaml = createRequire(import.meta.url)('js-yaml');
  } catch {
    _yaml = false;
  }
  return _yaml === false ? null : _yaml;
}

/**
 * One-per-process actionable WARN, emitted ONLY when a `.vault.yaml` actually
 * exists and could therefore have changed the resolved slug. A repo without the
 * file loses nothing by the parser being absent, so it stays silent.
 */
function warnYamlMissing() {
  if (_yamlWarned) return;
  _yamlWarned = true;
  process.stderr.write(
    "WARN vault-yaml: 'js-yaml' is not installed — .vault.yaml cannot be parsed; " +
      'the vault slug falls back to the directory-derived name (run \'npm install\' in the plugin directory)\n',
  );
}

/**
 * Read the canonical vault slug declared at `metadata.slug` in
 * `<repoRoot>/.vault.yaml`.
 *
 * The value becomes a FILESYSTEM PATH SEGMENT under the operator's vault, so it
 * is validated with the repo's existing slug predicate ({@link isValidSlug},
 * `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`) rather than trusted. That rejects `/`, `..`,
 * leading dots, whitespace and uppercase — this validation is a trust-boundary
 * control, not hygiene: `.vault.yaml` is repo-supplied data, and a slug such as
 * `../../etc` would otherwise escape the vault root.
 *
 * @param {string} repoRoot - absolute or relative path to the repository root.
 * @returns {string|null} the validated slug, or `null` when it cannot be read.
 */
export function readVaultSlug(repoRoot) {
  if (typeof repoRoot !== 'string' || repoRoot.trim() === '') return null;

  let text;
  try {
    text = readFileSync(path.join(repoRoot, VAULT_YAML_FILE), 'utf8');
  } catch {
    // Absent, unreadable, a directory, … — all "no declared slug".
    return null;
  }

  const yaml = getYaml();
  if (!yaml) {
    warnYamlMissing();
    return null;
  }

  let doc;
  try {
    doc = yaml.load(text);
  } catch {
    // Malformed YAML must never break a vault write.
    return null;
  }

  if (!doc || typeof doc !== 'object') return null;
  const metadata = doc.metadata;
  if (!metadata || typeof metadata !== 'object') return null;

  const slug = metadata.slug;
  return isValidSlug(slug) ? slug : null;
}
