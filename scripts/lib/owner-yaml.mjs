/**
 * owner-yaml.mjs — owner.yaml schema, validator, parser, writer (Issue #161, D1).
 *
 * Implements the public Owner Persona Layer API: schema validation, disk I/O,
 * and sensible defaults. Intentionally separate from `owner-config.mjs` (which
 * ships the richer D2-era schema with schema-version, metadata, and extended
 * fields). This module targets the simpler D1 surface defined in the #161 epic.
 *
 * ── Schema (schema-version: 1) ───────────────────────────────────────────────
 *
 *   owner:
 *     name: string                           (required, non-empty)
 *     language: 'de' | 'en'                  (required)
 *   tone:
 *     style: 'direct' | 'neutral' | 'friendly'  (required)
 *     tonality: string                           (optional, free text)
 *   efficiency:
 *     output-level: 'lite' | 'full' | 'ultra'   (required)
 *     preamble: 'minimal' | 'verbose'            (required)
 *   hardware-sharing:
 *     enabled: boolean                           (required)
 *     hash-salt: string                          (required when enabled=true)
 *   paths:                  (optional; host-local path overrides — #653)
 *     vault-dir: string          ('' = no override; mirrors Session Config vault-integration.vault-dir)
 *     baseline-path: string      ('' = no override; maps to Session Config plan-baseline-path / projects-baseline)
 *     namespace-map-path: string ('' = no override; #725 D5 — points at a host-local JSON
 *                                  { "real-slug": "pseudonym-slug" } map that vault-mirror uses to
 *                                  give owner-leaky repos stable pseudonyms instead of collapsing
 *                                  them all to 'redacted-repo'. Never committed; env SO_NAMESPACE_MAP overrides.)
 *     confidential-names-file: string ('' = no override; #728a — points at a host-local FLAT JSON
 *                                  array-of-strings ["customer-name", "private-repo", …] the
 *                                  owner-leakage scanner's CP11 rule matches against tracked files.
 *                                  The names live in the referenced file ONLY — NEVER inline in
 *                                  owner.yaml. Never committed; env SO_CONFIDENTIAL_NAMES_FILE overrides.)
 *   dispatcher:             (optional; host-local cross-repo dispatcher autonomy override — #679)
 *     autonomy: string      ('' = no override; resolver enum off | advisory | autonomous-gated;
 *                            precedence env SO_DISPATCHER_AUTONOMY > this > committed > off)
 *
 * ── Exports ───────────────────────────────────────────────────────────────────
 *
 *   resolvePrivateConfigDir({env}?) — THE host-private config dir resolver (#1223)
 *   resolveOwnerYamlPath(env?) — owner.yaml path, resolved at CALL time (#1223)
 *   validateOwnerSections(obj) — pure validation, no I/O; bucketed per section (#820)
 *   validateOwnerConfig(obj)   — pure validation, no I/O; thin wrapper over validateOwnerSections
 *   loadOwnerConfig({path?})   — reads file; per-section tolerance for OPTIONAL
 *                                sections (paths/dispatcher/vaults/baselines) — #820
 *   writeOwnerConfig(config, {path?}) — validates, writes YAML, creates dir
 *   getDefaults()              — returns sensible default config object
 *
 * ── Zero bare-specifier imports (GH#62/#63, GitLab #1230) ────────────────────
 *
 * `js-yaml` is resolved LAZILY inside {@link loadOwnerConfig} / {@link
 * writeOwnerConfig} (see {@link getYaml}), never at module load. Importing this
 * module therefore costs `node:fs` + `node:path` + `node:module` and nothing
 * else, which is what keeps it safe on the hook import graph: before this
 * change, `import yaml from 'js-yaml'` at the top of this file crashed FOUR
 * hooks with `ERR_MODULE_NOT_FOUND` for anyone whose `node_modules` was absent
 * (on-session-start, on-session-end, post-edit-validate,
 * skill-invocation-telemetry — measured 2026-09-06 over a `hooks/` + `scripts/`
 * copy with no `node_modules`, 4 of 27 hooks rc=1).
 *
 * When the package cannot be resolved both entry points DEGRADE rather than
 * throw: they return their normal shape plus `reason: 'yaml-parser-missing'`
 * (`source: 'defaults'` / `written: false`) and emit ONE rate-limited stderr
 * WARN naming `npm install` as the fix.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { resolvePrivateConfigDir } from './config/private-config-dir.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Basename of the owner persona config file. */
const OWNER_YAML_FILE = 'owner.yaml';

// ---------------------------------------------------------------------------
// Lazy js-yaml resolution (GH#62/#63, GitLab #1230)
// ---------------------------------------------------------------------------

/**
 * Memoised `js-yaml` module, or `false` once resolution has failed.
 * `null` = not yet attempted.
 * @type {null | false | { load: Function, dump: Function }}
 */
let _yaml = null;

/** Guards the one-per-process stderr WARN below. */
let _yamlWarned = false;

/**
 * Resolve `js-yaml` at CALL time instead of at import time (GH#62/#63).
 *
 * WHY `createRequire` and not `await import('js-yaml')`: every caller of
 * {@link loadOwnerConfig} consumes it SYNCHRONOUSLY. Measured 2026-09-06 with
 * `rg -n --glob '!tests/**' 'loadOwnerConfig\(' scripts hooks skills` (minus
 * this file and the unrelated async homonym in `owner-config-loader.mjs`):
 * 9 call sites — 8 in code, 1 in `skills/session-start/SKILL.md:1113` — and
 * `rg 'await\s+loadOwnerConfig'` over the same scope returns ZERO. Eight read
 * `loadOwnerConfig().config` (`hooks/on-session-start.mjs:639`,
 * `hooks/skill-invocation-telemetry.mjs:155`, `scripts/telemetry.mjs:81,130`,
 * `scripts/vault-mirror.mjs:444`, `scripts/lib/telemetry/sync.mjs:202,269`,
 * and the SKILL.md snippet); the ninth destructures the same sync return
 * (`scripts/lib/soul-resolve.mjs:123`). `writeOwnerConfig` is likewise sync at
 * its single call site, `scripts/lib/owner-interview.mjs:228`.
 *
 * Making either loader async would be a breaking change to all of them; a lazy
 * `require()` keeps the sync contract and only fails at CALL time — where the
 * failure is catchable — instead of at module load, where it is not.
 *
 * Same shape as the `getPicomatch()` pattern in `scripts/lib/rule-loader.mjs`
 * and `scripts/lib/validate-vendored-rules.mjs`.
 *
 * @returns {{ load: Function, dump: Function } | null} the module, or `null`
 *   when `node_modules` is absent / the package cannot be resolved.
 */
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
 * Emit the one-per-process actionable WARN for a missing `js-yaml`. Kept to a
 * SINGLE line and rate-limited to once per process, mirroring the GH#63
 * degradation contract `hooks/on-stop.mjs` already satisfies: a missing package
 * must never be louder than the fix it asks for.
 */
function warnYamlMissing() {
  if (_yamlWarned) return;
  _yamlWarned = true;
  console.warn(
    "WARN owner-yaml: 'js-yaml' is not installed — owner.yaml cannot be parsed or written; " +
      "using defaults. Run 'npm install' in the plugin directory to restore it.",
  );
}

/**
 * Re-export of the single host-private-config-dir resolver (#1223).
 *
 * The implementation lives in the ZERO-IMPORT leaf
 * `scripts/lib/config/private-config-dir.mjs`, NOT here: `host-identity.mjs`
 * sits on `hooks/on-stop.mjs`'s import subgraph (via `session-lock.mjs`), and
 * this module statically imports `js-yaml`. While the resolver lived here,
 * importing it from `host-identity.mjs` dragged `js-yaml` onto THAT subgraph and
 * broke the GH#63 "degrade gracefully without node_modules" contract
 * (`ERR_MODULE_NOT_FOUND` in `tests/hooks/on-stop.test.mjs`).
 *
 * As of GitLab #1230 (2026-09-06) THIS module is no longer a bare-specifier node
 * on that graph either: the `js-yaml` import it used to carry statically is now
 * lazy (see {@link getYaml}), so the four hooks that reach this file —
 * on-session-start, on-session-end, post-edit-validate,
 * skill-invocation-telemetry — load without `node_modules` instead of dying with
 * ERR_MODULE_NOT_FOUND. Keep it that way: any NEW static bare import added here
 * re-breaks all four at once, in a file whose own unit tests would never notice
 * (the repo always has `node_modules`).
 *
 * NOTE for `tests/husky/pre-commit-owner-leakage.test.mjs`: that test copies
 * the CP11 import chain FILE BY FILE into a tmp repo, so the leaf below is on
 * its copied-file list. Any FURTHER repo-local import added here needs the same
 * treatment.
 */
export { resolvePrivateConfigDir };

/**
 * Resolve the owner.yaml path at CALL time via the single private-config-dir
 * resolver {@link resolvePrivateConfigDir} (#1223). Honours
 * `SO_CONFIG_HOME` > `XDG_CONFIG_HOME` > homedir, each trimmed.
 *
 * @param {Record<string, string|undefined>} [env] — env source (default `process.env`)
 * @returns {string} absolute path to owner.yaml
 */
export function resolveOwnerYamlPath(env = process.env) {
  return join(resolvePrivateConfigDir({ env }), OWNER_YAML_FILE);
}

const VALID_LANGUAGES = /** @type {const} */ (['de', 'en']);
const VALID_TONE_STYLES = /** @type {const} */ (['direct', 'neutral', 'friendly']);
const VALID_OUTPUT_LEVELS = /** @type {const} */ (['lite', 'full', 'ultra']);
const VALID_PREAMBLE_LEVELS = /** @type {const} */ (['minimal', 'verbose']);

/**
 * REQUIRED sections (#820) — an invalid entry here keeps the legacy
 * whole-file-discard behaviour of `loadOwnerConfig` unchanged.
 */
const REQUIRED_SECTIONS = /** @type {const} */ (['owner', 'tone', 'efficiency', 'hardware-sharing']);

/**
 * OPTIONAL object sections (#820) — a malformed entry is replaced by its
 * `getDefaults()` value and reported via `droppedSections` + a stderr WARN,
 * but does NOT discard the rest of the file.
 */
const OPTIONAL_OBJECT_SECTIONS = /** @type {const} */ (['paths', 'dispatcher']);

/**
 * OPTIONAL list sections (#820) — malformed entries are passed through
 * UNTOUCHED (their consumers run a lenient parse-at-point-of-use pass —
 * `parseNamedVaults`/`parseBaselines` — that already drops bad entries with
 * its own WARN). Surfaced here only via `sectionWarnings`, never dropped.
 */
const OPTIONAL_LIST_SECTIONS = /** @type {const} */ (['vaults', 'baselines']);

/** Canonical validation-order — MUST match the pre-#820 inline validation order. */
const SECTION_ORDER = /** @type {const} */ ([
  ...REQUIRED_SECTIONS,
  ...OPTIONAL_OBJECT_SECTIONS,
  ...OPTIONAL_LIST_SECTIONS,
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Returns the sensible default owner config. `owner.name` is left as an empty
 * string — callers (e.g. D2 bootstrap) must fill it in from user input.
 *
 * @returns {object}
 */
export function getDefaults() {
  return {
    owner: {
      name: '',
      language: 'en',
    },
    tone: {
      style: 'neutral',
      tonality: '',
    },
    efficiency: {
      'output-level': 'full',
      preamble: 'minimal',
    },
    'hardware-sharing': {
      enabled: false,
      'hash-salt': '',
    },
    paths: {
      'vault-dir': '',
      'baseline-path': '',
      'namespace-map-path': '',
      'confidential-names-file': '',
    },
    dispatcher: {
      autonomy: '',
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw owner config object, bucketed per top-level section (#820).
 * Pure function — never throws, never reads or writes any file. Reuses the
 * EXACT validation rules `validateOwnerConfig` has always applied; only the
 * bucketing is new, so error message text and (within a section) ordering
 * are unchanged.
 *
 * @param {unknown} obj
 * @returns {{ sections: Record<string, { valid: boolean, errors: string[] }>, errors: string[] }}
 */
export function validateOwnerSections(obj) {
  if (!isPlainObject(obj)) {
    return { sections: {}, errors: ['config must be a plain object'] };
  }

  const sections = {};

  // ── owner ──────────────────────────────────────────────────────────────────
  {
    const errors = [];
    const owner = obj.owner;
    if (!isPlainObject(owner)) {
      errors.push('owner must be an object');
    } else {
      if (typeof owner.name !== 'string' || owner.name.trim().length === 0) {
        errors.push('owner.name is required and must be a non-empty string');
      }
      if (!VALID_LANGUAGES.includes(owner.language)) {
        errors.push(
          `owner.language must be one of ${VALID_LANGUAGES.join(', ')}, got: ${JSON.stringify(owner.language)}`,
        );
      }
    }
    sections.owner = { valid: errors.length === 0, errors };
  }

  // ── tone ───────────────────────────────────────────────────────────────────
  {
    const errors = [];
    const tone = obj.tone;
    if (!isPlainObject(tone)) {
      errors.push('tone must be an object');
    } else {
      if (!VALID_TONE_STYLES.includes(tone.style)) {
        errors.push(
          `tone.style must be one of ${VALID_TONE_STYLES.join(', ')}, got: ${JSON.stringify(tone.style)}`,
        );
      }
      // tonality is optional; if present must be a string
      if (tone.tonality !== undefined && tone.tonality !== null && typeof tone.tonality !== 'string') {
        errors.push('tone.tonality must be a string or absent');
      }
    }
    sections.tone = { valid: errors.length === 0, errors };
  }

  // ── efficiency ─────────────────────────────────────────────────────────────
  {
    const errors = [];
    const efficiency = obj.efficiency;
    if (!isPlainObject(efficiency)) {
      errors.push('efficiency must be an object');
    } else {
      if (!VALID_OUTPUT_LEVELS.includes(efficiency['output-level'])) {
        errors.push(
          `efficiency.output-level must be one of ${VALID_OUTPUT_LEVELS.join(', ')}, got: ${JSON.stringify(efficiency['output-level'])}`,
        );
      }
      if (!VALID_PREAMBLE_LEVELS.includes(efficiency.preamble)) {
        errors.push(
          `efficiency.preamble must be one of ${VALID_PREAMBLE_LEVELS.join(', ')}, got: ${JSON.stringify(efficiency.preamble)}`,
        );
      }
    }
    sections.efficiency = { valid: errors.length === 0, errors };
  }

  // ── hardware-sharing ───────────────────────────────────────────────────────
  {
    const errors = [];
    const hw = obj['hardware-sharing'];
    if (!isPlainObject(hw)) {
      errors.push('hardware-sharing must be an object');
    } else {
      if (typeof hw.enabled !== 'boolean') {
        errors.push(`hardware-sharing.enabled must be a boolean, got: ${typeof hw.enabled}`);
      }
      // hash-salt is required when enabled=true
      if (hw.enabled === true) {
        if (typeof hw['hash-salt'] !== 'string' || hw['hash-salt'].length === 0) {
          errors.push('hardware-sharing.hash-salt is required (non-empty string) when hardware-sharing.enabled is true');
        }
      }
      // if present and non-empty, must be a string
      if (
        hw['hash-salt'] !== undefined &&
        hw['hash-salt'] !== null &&
        hw['hash-salt'] !== '' &&
        typeof hw['hash-salt'] !== 'string'
      ) {
        errors.push('hardware-sharing.hash-salt must be a string');
      }
    }
    sections['hardware-sharing'] = { valid: errors.length === 0, errors };
  }

  // ── paths (optional; host-local path overrides — #653) ───────────────────────
  {
    const errors = [];
    const paths = obj.paths;
    if (paths !== undefined && paths !== null) {
      if (!isPlainObject(paths)) {
        errors.push('paths must be an object when present');
      } else {
        for (const key of ['vault-dir', 'baseline-path', 'namespace-map-path', 'confidential-names-file']) {
          const v = paths[key];
          if (v !== undefined && v !== null && typeof v !== 'string') {
            errors.push(`paths.${key} must be a string`);
          }
        }
      }
    }
    sections.paths = { valid: errors.length === 0, errors };
  }

  // ── dispatcher (optional; host-local dispatcher autonomy override — #679) ─────
  // Loose validation only (mirrors `paths`): the resolver enum-validates the
  // value (resolveDispatcherAutonomy in config/dispatcher-autonomy.mjs), so an
  // invalid string here falls through to the next precedence tier rather than
  // failing the whole owner.yaml load.
  {
    const errors = [];
    const dispatcher = obj.dispatcher;
    if (dispatcher !== undefined && dispatcher !== null) {
      if (!isPlainObject(dispatcher)) {
        errors.push('dispatcher must be an object when present');
      } else if (
        dispatcher.autonomy !== undefined &&
        dispatcher.autonomy !== null &&
        typeof dispatcher.autonomy !== 'string'
      ) {
        errors.push('dispatcher.autonomy must be a string');
      }
    }
    sections.dispatcher = { valid: errors.length === 0, errors };
  }

  // ── vaults (optional; N named vaults for walk-up resolution — #700) ──────────
  // Drop-and-WARN on malformed entries is handled by parseNamedVaults() in
  // named-vault-resolver.mjs. Here we only validate the container shape to
  // prevent clearly invalid config from passing silently.
  // Absent or null → backward-compat no-op (no validation errors).
  {
    const errors = [];
    const vaults = obj.vaults;
    if (vaults !== undefined && vaults !== null) {
      if (!Array.isArray(vaults)) {
        errors.push('vaults must be an array when present');
      } else {
        for (let i = 0; i < vaults.length; i++) {
          const entry = vaults[i];
          if (entry === null || entry === undefined) {
            errors.push(`vaults[${i}] must not be null`);
            continue;
          }
          if (!isPlainObject(entry)) {
            errors.push(`vaults[${i}] must be an object`);
            continue;
          }
          // Required string fields: name, suffix, root
          for (const field of ['name', 'suffix', 'root']) {
            if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
              errors.push(`vaults[${i}].${field} must be a non-empty string`);
            }
          }
          // Optional match sub-object
          if (entry.match !== undefined && entry.match !== null) {
            if (!isPlainObject(entry.match)) {
              errors.push(`vaults[${i}].match must be an object when present`);
            } else if (
              entry.match['org-prefix'] !== undefined &&
              typeof entry.match['org-prefix'] !== 'string'
            ) {
              errors.push(`vaults[${i}].match.org-prefix must be a string`);
            }
          }
        }
      }
    }
    sections.vaults = { valid: errors.length === 0, errors };
  }

  // ── baselines (optional; N named plan-baselines for per-context resolution — #819) ──
  // Cousin of vaults: above. Drop-and-WARN on malformed entries is handled by
  // parseBaselines() in named-baseline-resolver.mjs; here we validate the container
  // + entry shape to prevent clearly invalid config from passing silently.
  // Divergences from vaults: the match key is `path-prefix` (a local FILESYSTEM
  // directory tree, not a git-remote org slug), `path` replaces root+suffix, and
  // `match` is REQUIRED (a baseline with no path-prefix can never be selected).
  // Absent or null → backward-compat no-op (no validation errors).
  {
    const errors = [];
    const baselines = obj.baselines;
    if (baselines !== undefined && baselines !== null) {
      if (!Array.isArray(baselines)) {
        errors.push('baselines must be an array when present');
      } else {
        for (let i = 0; i < baselines.length; i++) {
          const entry = baselines[i];
          if (entry === null || entry === undefined) {
            errors.push(`baselines[${i}] must not be null`);
            continue;
          }
          if (!isPlainObject(entry)) {
            errors.push(`baselines[${i}] must be an object`);
            continue;
          }
          // Required string fields: name, path
          for (const field of ['name', 'path']) {
            if (typeof entry[field] !== 'string' || entry[field].trim() === '') {
              errors.push(`baselines[${i}].${field} must be a non-empty string`);
            }
          }
          // Required match sub-object with a non-empty path-prefix string.
          if (!isPlainObject(entry.match)) {
            errors.push(`baselines[${i}].match must be an object`);
          } else if (
            typeof entry.match['path-prefix'] !== 'string' ||
            entry.match['path-prefix'].trim() === ''
          ) {
            errors.push(`baselines[${i}].match.path-prefix must be a non-empty string`);
          }
        }
      }
    }
    sections.baselines = { valid: errors.length === 0, errors };
  }

  const errors = SECTION_ORDER.flatMap((name) => sections[name].errors);
  return { sections, errors };
}

/**
 * Validate a raw owner config object. Pure function — never throws, never reads
 * or writes any file. Thin wrapper over `validateOwnerSections` (#820) —
 * preserves the original `{ valid, errors }` contract unchanged.
 *
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateOwnerConfig(obj) {
  const { errors } = validateOwnerSections(obj);
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load owner.yaml from disk. Returns defaults when the file is absent or
 * contains invalid content, populating `errors` in the latter case.
 *
 * Per-section tolerance (#820): an invalid REQUIRED section (owner, tone,
 * efficiency, hardware-sharing) still discards the whole file (legacy
 * behaviour, unchanged). An invalid OPTIONAL object section (paths,
 * dispatcher) is instead replaced by its default value — the rest of the
 * file survives, `source` becomes `'partial'`, and the drop is reported via
 * `droppedSections` + a stderr WARN. OPTIONAL list sections (vaults,
 * baselines) are passed through UNTOUCHED even when strict-invalid — their
 * consumers already run a lenient parse-at-point-of-use pass — and are
 * surfaced only via `sectionWarnings` (never dropped, never counted towards
 * `'partial'`).
 *
 * MERGE RULE for the whole-file discard (GitLab #1244). The discard returns
 * `getDefaults()` — but a VALID optional object section is merged back on top
 * of its default (`{...defaults[name], ...parsed[name]}`), key by key. `source`
 * stays `'defaults'` and `errors` still carries every required-section error,
 * so no existing caller's branch changes; what changes is that a host-local
 * path the operator DID declare correctly is no longer thrown away because an
 * unrelated section (e.g. `tone:`) is malformed. That silent loss was a
 * fail-OPEN path for the owner-leakage scanner's CP11 rule: a partial
 * owner.yaml carrying only `owner:` + `paths.confidential-names-file:` made the
 * scanner report PASS while matching nothing. An INVALID optional section is
 * still replaced by its default and is now reported via `droppedSections` on
 * this branch too (previously only on the required-valid branch), so a consumer
 * can tell "not configured" from "configured but unusable".
 *
 * Defensive — never throws.
 *
 * When `js-yaml` cannot be resolved (no `node_modules`), returns defaults with
 * `source: 'defaults'`, `reason: 'yaml-parser-missing'` and one explanatory
 * entry in `errors` — never throws, never crashes the importing hook (GH#62/#63).
 * When the file exists but cannot be turned into an object at all (unreadable,
 * YAML syntax error, non-mapping top level) the same shape is returned with
 * `reason: 'unparseable'`: in that state NOTHING about the file's contents is
 * knowable, which is the distinction CP11 needs in order to fail CLOSED rather
 * than assume "nothing configured".
 *
 * @param {{ path?: string }} [opts]
 * @returns {{
 *   config: object,
 *   source: 'file'|'defaults'|'partial',
 *   errors: string[],
 *   reason?: 'yaml-parser-missing'|'unparseable',
 *   droppedSections?: Array<{ section: string, errors: string[] }>,
 *   sectionWarnings?: Array<{ section: string, errors: string[] }>,
 * }}
 */
export function loadOwnerConfig(opts = {}) {
  const filePath = opts.path ?? resolveOwnerYamlPath();

  if (!existsSync(filePath)) {
    return { config: getDefaults(), source: 'defaults', errors: [] };
  }

  let raw;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      config: getDefaults(),
      source: 'defaults',
      reason: 'unparseable',
      errors: [`failed to read owner.yaml: ${err.message}`],
    };
  }

  const yaml = getYaml();
  if (!yaml) {
    warnYamlMissing();
    return {
      config: getDefaults(),
      source: 'defaults',
      reason: 'yaml-parser-missing',
      errors: [
        "yaml-parser-missing: 'js-yaml' is not installed, so owner.yaml could not be parsed (run 'npm install' in the plugin directory)",
      ],
    };
  }

  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      config: getDefaults(),
      source: 'defaults',
      reason: 'unparseable',
      errors: [`YAML parse error: ${err.message}`],
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      config: getDefaults(),
      source: 'defaults',
      reason: 'unparseable',
      errors: ['owner.yaml must contain a YAML mapping at the top level'],
    };
  }

  const { sections, errors: allErrors } = validateOwnerSections(parsed);

  // Any REQUIRED section invalid → whole-file discard (#820), EXCEPT that a
  // VALID optional object section is merged back onto its default (#1244 — see
  // the MERGE RULE in the JSDoc above). `source` stays 'defaults' and `errors`
  // is unchanged, so every existing caller branch is untouched; only the
  // discarded-but-valid `paths:`/`dispatcher:` keys survive, which is what stops
  // CP11 from going silently inert on a partial owner.yaml.
  const requiredInvalid = REQUIRED_SECTIONS.some((name) => !sections[name]?.valid);
  if (requiredInvalid) {
    const discardConfig = getDefaults();
    const discardDropped = [];
    for (const name of OPTIONAL_OBJECT_SECTIONS) {
      const sec = sections[name];
      if (sec?.valid && isPlainObject(parsed[name])) {
        discardConfig[name] = { ...discardConfig[name], ...parsed[name] };
      } else if (sec && !sec.valid) {
        // Present but malformed — already replaced by its default above. Report
        // it so a consumer can distinguish "not configured" from "unusable".
        discardDropped.push({ section: name, errors: sec.errors });
      }
    }
    const discardResult = { config: discardConfig, source: 'defaults', errors: allErrors };
    if (discardDropped.length > 0) discardResult.droppedSections = discardDropped;
    return discardResult;
  }

  // All REQUIRED sections valid — tolerate malformed OPTIONAL sections instead
  // of discarding the whole file (#820).
  const defaults = getDefaults();
  const config = { ...parsed };
  const droppedSections = [];
  const sectionWarnings = [];

  for (const name of OPTIONAL_OBJECT_SECTIONS) {
    const sec = sections[name];
    if (sec && !sec.valid) {
      config[name] = defaults[name];
      droppedSections.push({ section: name, errors: sec.errors });
      const firstError = sec.errors[0] ?? 'invalid section';
      console.warn(
        `WARN owner-yaml: dropping owner.yaml section "${name}" (${firstError}); using defaults`,
      );
    }
  }

  for (const name of OPTIONAL_LIST_SECTIONS) {
    const sec = sections[name];
    if (sec && !sec.valid) {
      // Raw pass-through — deliberate defense-in-depth; parseNamedVaults()/
      // parseBaselines() run their own lenient drop-and-WARN at point-of-use.
      sectionWarnings.push({ section: name, errors: sec.errors });
      const firstError = sec.errors[0] ?? 'invalid entries';
      console.warn(
        `WARN owner-yaml: owner.yaml section "${name}" has invalid entries (${firstError}); ` +
          'lenient consumers will drop bad entries at point-of-use',
      );
    }
  }

  const result = {
    config,
    source: droppedSections.length > 0 ? 'partial' : 'file',
    errors: allErrors,
  };
  if (droppedSections.length > 0) result.droppedSections = droppedSections;
  if (sectionWarnings.length > 0) result.sectionWarnings = sectionWarnings;
  return result;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/**
 * Validate `config` and write it as YAML to disk. Creates parent directories
 * if they do not exist. Validates before writing — returns errors without
 * touching the filesystem when validation fails.
 *
 * Synchronous. Defensive — never throws.
 *
 * When `js-yaml` cannot be resolved (no `node_modules`), returns
 * `{ written: false, reason: 'yaml-parser-missing', errors: [...] }` — the file
 * is left untouched rather than half-written (GH#62/#63).
 *
 * @param {object} config
 * @param {{ path?: string }} [opts]
 * @returns {{ written: boolean, errors: string[], reason?: 'yaml-parser-missing' }}
 */
export function writeOwnerConfig(config, opts = {}) {
  const filePath = opts.path ?? resolveOwnerYamlPath();

  const validation = validateOwnerConfig(config);
  if (!validation.valid) {
    return { written: false, errors: validation.errors };
  }

  const dir = dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    return {
      written: false,
      errors: [`failed to create directory ${dir}: ${err.message}`],
    };
  }

  const yaml = getYaml();
  if (!yaml) {
    warnYamlMissing();
    return {
      written: false,
      reason: 'yaml-parser-missing',
      errors: [
        "yaml-parser-missing: 'js-yaml' is not installed, so owner.yaml could not be written (run 'npm install' in the plugin directory)",
      ],
    };
  }

  let yamlStr;
  try {
    yamlStr = yaml.dump(config, { lineWidth: 120, noRefs: true });
  } catch (err) {
    return { written: false, errors: [`failed to serialise config to YAML: ${err.message}`] };
  }

  try {
    writeFileSync(filePath, yamlStr, 'utf8');
  } catch (err) {
    return { written: false, errors: [`failed to write owner.yaml: ${err.message}`] };
  }

  return { written: true, errors: [] };
}
