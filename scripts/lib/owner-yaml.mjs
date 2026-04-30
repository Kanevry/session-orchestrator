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
 *
 * ── Exports ───────────────────────────────────────────────────────────────────
 *
 *   OWNER_YAML_PATH          — default file path on disk
 *   validateOwnerConfig(obj) — pure validation, no I/O
 *   loadOwnerConfig({path?}) — reads file, returns defaults if missing/invalid
 *   writeOwnerConfig(config, {path?}) — validates, writes YAML, creates dir
 *   getDefaults()            — returns sensible default config object
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path for the owner persona config file. */
export const OWNER_YAML_PATH = join(homedir(), '.config', 'session-orchestrator', 'owner.yaml');

const VALID_LANGUAGES = /** @type {const} */ (['de', 'en']);
const VALID_TONE_STYLES = /** @type {const} */ (['direct', 'neutral', 'friendly']);
const VALID_OUTPUT_LEVELS = /** @type {const} */ (['lite', 'full', 'ultra']);
const VALID_PREAMBLE_LEVELS = /** @type {const} */ (['minimal', 'verbose']);

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
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw owner config object. Pure function — never throws, never reads
 * or writes any file.
 *
 * @param {unknown} obj
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateOwnerConfig(obj) {
  const errors = [];

  if (!isPlainObject(obj)) {
    return { valid: false, errors: ['config must be a plain object'] };
  }

  // ── owner ──────────────────────────────────────────────────────────────────
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

  // ── tone ───────────────────────────────────────────────────────────────────
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

  // ── efficiency ─────────────────────────────────────────────────────────────
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

  // ── hardware-sharing ───────────────────────────────────────────────────────
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

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/**
 * Load owner.yaml from disk. Returns defaults when the file is absent or
 * contains invalid content, populating `errors` in the latter case.
 *
 * Defensive — never throws.
 *
 * @param {{ path?: string }} [opts]
 * @returns {{ config: object, source: 'file'|'defaults', errors: string[] }}
 */
export function loadOwnerConfig(opts = {}) {
  const filePath = opts.path ?? OWNER_YAML_PATH;

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
      errors: [`failed to read owner.yaml: ${err.message}`],
    };
  }

  let parsed;
  try {
    parsed = yaml.load(raw);
  } catch (err) {
    return {
      config: getDefaults(),
      source: 'defaults',
      errors: [`YAML parse error: ${err.message}`],
    };
  }

  if (!isPlainObject(parsed)) {
    return {
      config: getDefaults(),
      source: 'defaults',
      errors: ['owner.yaml must contain a YAML mapping at the top level'],
    };
  }

  const validation = validateOwnerConfig(parsed);
  if (!validation.valid) {
    return {
      config: getDefaults(),
      source: 'defaults',
      errors: validation.errors,
    };
  }

  return { config: parsed, source: 'file', errors: [] };
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
 * @param {object} config
 * @param {{ path?: string }} [opts]
 * @returns {{ written: boolean, errors: string[] }}
 */
export function writeOwnerConfig(config, opts = {}) {
  const filePath = opts.path ?? OWNER_YAML_PATH;

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
