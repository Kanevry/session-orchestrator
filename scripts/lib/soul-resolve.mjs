/**
 * soul-resolve.mjs — Template resolver for soul.md files (Issue #176, D3).
 *
 * Resolves `{{slot}}` placeholders in soul.md templates using owner persona
 * config loaded via `owner-yaml.mjs` (D1). Pure at the `resolveSoul` level;
 * `loadAndResolveSoul` performs disk I/O.
 *
 * ── NO RUNTIME CALLER — read this before assuming a soul.md is resolved ──────
 *
 * Nothing in `scripts/`, `hooks/`, or any skill body calls either export. Skill
 * bodies instruct the coordinator to read soul.md DIRECTLY, so whatever is in
 * the file on disk is what the coordinator sees — an unsubstituted `{{slot}}`
 * reaches the model verbatim and instructs nothing. `skills/session-start/soul.md`
 * is therefore authored pre-resolved: it carries no slots, and the operator's
 * `efficiency.output-level` selects one of its literal `### output-level: <value>`
 * blocks (see that file's § Output Levels; the skill body performs the lookup).
 * Slots that remain in other soul.md files are inert for the same reason.
 * Do not add a slot to a soul.md expecting substitution — wire a caller first.
 *
 * ── Slot syntax ──────────────────────────────────────────────────────────────
 *
 *   {{owner.language}}          → 'de' | 'en'
 *   {{tone.style}}              → 'direct' | 'neutral' | 'friendly'
 *   {{efficiency.output-level}} → 'lite' | 'full' | 'ultra'
 *   {{efficiency.preamble}}     → 'minimal' | 'verbose'
 *
 * ── Resolution rules ─────────────────────────────────────────────────────────
 *
 *   - Known slot path present in ownerConfig  → replaced with the value
 *   - Known slot path missing in ownerConfig  → replaced with default (silent)
 *   - Unknown slot path                       → left as-is; warning added to result
 *
 * ── Exports ───────────────────────────────────────────────────────────────────
 *
 *   resolveSoul(templateContent, ownerConfig)    → { resolved: string, warnings: string[] }
 *   loadAndResolveSoul(soulPath, opts?)          → { resolved: string, warnings: string[], source: string }
 */

import { readFileSync } from 'node:fs';
import { loadOwnerConfig, getDefaults } from './owner-yaml.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Look up a dot-notation path such as "efficiency.output-level" in a nested
 * object. Returns `undefined` if any segment is missing.
 *
 * @param {object} obj
 * @param {string} dotPath
 * @returns {unknown}
 */
function getByPath(obj, dotPath) {
  const segments = dotPath.split('.');
  let cursor = obj;
  for (const seg of segments) {
    if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
      return undefined;
    }
    cursor = cursor[seg];
  }
  return cursor;
}

/**
 * Set of slot paths explicitly documented / known by this module.
 * Any slot NOT in this set is considered unknown and left in place with a warning.
 */
const KNOWN_SLOTS = new Set([
  'owner.language',
  'tone.style',
  'efficiency.output-level',
  'efficiency.preamble',
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve `{{slot}}` placeholders in `templateContent` using `ownerConfig`.
 *
 * Pure function — no I/O, no side-effects.
 *
 * @param {string} templateContent  Raw soul.md template text.
 * @param {object} ownerConfig      Owner persona config (from loadOwnerConfig or getDefaults).
 * @returns {{ resolved: string, warnings: string[] }}
 */
export function resolveSoul(templateContent, ownerConfig) {
  const defaults = getDefaults();
  const warnings = [];

  const resolved = templateContent.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, path) => {
    if (!KNOWN_SLOTS.has(path)) {
      warnings.push(`Unknown slot path: {{${path}}} — left in place`);
      return `{{${path}}}`;
    }

    // Try ownerConfig first, then fall back to defaults
    let value = getByPath(ownerConfig, path);
    if (value === undefined || value === null || value === '') {
      value = getByPath(defaults, path);
    }

    return String(value ?? '');
  });

  return { resolved, warnings };
}

/**
 * Read a soul.md template from `soulPath`, load owner config (from
 * `ownerConfigPath` or the default location), and return the resolved content.
 *
 * @param {string} soulPath                    Absolute path to the soul.md template.
 * @param {{ ownerConfigPath?: string }} [opts]
 * @returns {{ resolved: string, warnings: string[], source: 'file'|'defaults'|'partial' }}
 */
export function loadAndResolveSoul(soulPath, opts = {}) {
  const templateContent = readFileSync(soulPath, 'utf8');

  const { config, source } = loadOwnerConfig(
    opts.ownerConfigPath ? { path: opts.ownerConfigPath } : {},
  );

  const { resolved, warnings } = resolveSoul(templateContent, config);

  return { resolved, warnings, source };
}
