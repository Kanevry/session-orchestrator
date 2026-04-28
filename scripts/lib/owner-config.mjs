/**
 * owner-config.mjs — Owner Persona schema + validator (Issue #174, Sub-Epic #161).
 *
 * Pure module: no I/O, no filesystem access. Validates and normalizes the
 * owner.yaml document that lives at `~/.config/session-orchestrator/owner.yaml`
 * (per-user, never per-repo, never committed). The loader (which does touch
 * the disk) lives in `owner-config-loader.mjs`.
 *
 * ── CANONICAL SCHEMA (schema-version: 1) ─────────────────────────────────
 *
 *   schema-version: 1                       (required, integer == 1)
 *   owner:
 *     name: string                          (required, 1-100 chars)
 *     email-hash: string|null               (optional, hex sha256 = 64 chars)
 *     language: string                      (required, ISO-639-1: "de", "en", ...)
 *   tone:
 *     style: "direct"|"neutral"|"friendly"  (default: "neutral")
 *     tonality: string|null                 (optional, free-form, max 200 chars)
 *   efficiency:
 *     output-level: "lite"|"full"|"ultra"   (default: "full")
 *     preamble: "minimal"|"verbose"         (default: "minimal")
 *     comments-in-code: "minimal"|"full"    (default: "minimal")
 *   hardware-sharing:
 *     enabled: boolean                      (default: false; consent gate, set by D4/C4)
 *     hash-salt: string|null                (optional, 32-byte hex = 64 chars)
 *   defaults:
 *     preferred-test-command: string|null   (optional, max 200 chars)
 *     preferred-editor: string|null         (optional, max 50 chars)
 *   metadata:
 *     created_at: string|null               (optional, ISO 8601 UTC)
 *     updated_at: string|null               (optional, ISO 8601 UTC)
 *
 * ── CONTRACT SUMMARY ─────────────────────────────────────────────────────
 *
 *   validate(rawObj) → {ok, value, errors}
 *     Never throws. Returns ok=true with the normalized (default-filled)
 *     value when the input passes the schema gate, otherwise ok=false with
 *     a non-empty `errors` array. Unknown top-level sections are dropped
 *     (closed contract; baseline propagation in D4 must round-trip).
 *
 *   coerce(rawObj) → value | throws OwnerConfigError
 *     Strict-mode wrapper around validate() for tests and CLI entrypoints.
 *
 *   defaults() → value
 *     Returns the fully-default-filled config (with `owner.name` and
 *     `owner.language` left blank — those are required from the user; the
 *     interview in D2 fills them in).
 *
 *   merge(base, override) → value
 *     Deep merge of two configs. `override` wins on every leaf key. Used
 *     by D3 runtime-merge (`soul.md` template + owner prefs + per-session
 *     overrides). Always returns a full default-filled value; either input
 *     may be partial.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current owner-config schema version. New writes are stamped with this. */
export const CURRENT_OWNER_SCHEMA_VERSION = 1;

export const VALID_TONE_STYLES = Object.freeze(['direct', 'neutral', 'friendly']);
export const VALID_OUTPUT_LEVELS = Object.freeze(['lite', 'full', 'ultra']);
export const VALID_PREAMBLE_LEVELS = Object.freeze(['minimal', 'verbose']);
export const VALID_COMMENTS_LEVELS = Object.freeze(['minimal', 'full']);

const NAME_MAX = 100;
const TONALITY_MAX = 200;
const TEST_COMMAND_MAX = 200;
const EDITOR_MAX = 50;
const HEX64_RE = /^[a-f0-9]{64}$/i;
const ISO_639_1_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class OwnerConfigError extends Error {
  /**
   * @param {string} message
   * @param {string[]} [errors]
   */
  constructor(message, errors = []) {
    super(message);
    this.name = 'OwnerConfigError';
    this.errors = errors;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyString(v, max) {
  return typeof v === 'string' && v.length > 0 && (max === undefined || v.length <= max);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Returns the canonical default-filled owner config. `owner.name` and
 * `owner.language` are intentionally empty — those are user-required fields
 * the bootstrap interview (D2) fills in. The `defaults()` shape is what
 * `merge()` uses as its base when callers pass partial overrides.
 *
 * @returns {object}
 */
export function defaults() {
  return {
    'schema-version': CURRENT_OWNER_SCHEMA_VERSION,
    owner: {
      name: '',
      'email-hash': null,
      language: '',
    },
    tone: {
      style: 'neutral',
      tonality: null,
    },
    efficiency: {
      'output-level': 'full',
      preamble: 'minimal',
      'comments-in-code': 'minimal',
    },
    'hardware-sharing': {
      enabled: false,
      'hash-salt': null,
    },
    defaults: {
      'preferred-test-command': null,
      'preferred-editor': null,
    },
    metadata: {
      created_at: null,
      updated_at: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a raw owner config object. Defensive — never throws. Returns
 * `{ok, value, errors}` where `value` is the normalized (default-filled)
 * config when ok=true. When ok=false, `value` is null and `errors` is a
 * non-empty array of human-readable messages.
 *
 * @param {unknown} raw
 * @returns {{ok: boolean, value: object|null, errors: string[]}}
 */
export function validate(raw) {
  const errors = [];

  if (!isPlainObject(raw)) {
    return { ok: false, value: null, errors: ['owner config must be an object'] };
  }

  // schema-version (required, must be 1)
  const schemaVersion = raw['schema-version'];
  if (schemaVersion === undefined || schemaVersion === null) {
    errors.push('schema-version is required');
  } else if (schemaVersion !== CURRENT_OWNER_SCHEMA_VERSION) {
    errors.push(
      `schema-version must be ${CURRENT_OWNER_SCHEMA_VERSION}, got: ${JSON.stringify(schemaVersion)}`
    );
  }

  // owner (required)
  const owner = raw.owner;
  const ownerOut = { name: '', 'email-hash': null, language: '' };
  if (!isPlainObject(owner)) {
    errors.push('owner must be an object');
  } else {
    if (!isNonEmptyString(owner.name, NAME_MAX)) {
      errors.push(`owner.name must be a non-empty string (max ${NAME_MAX} chars)`);
    } else {
      ownerOut.name = owner.name;
    }

    if (owner['email-hash'] !== undefined && owner['email-hash'] !== null) {
      if (typeof owner['email-hash'] !== 'string' || !HEX64_RE.test(owner['email-hash'])) {
        errors.push('owner.email-hash must be a 64-char hex string (sha256) or null');
      } else {
        ownerOut['email-hash'] = owner['email-hash'].toLowerCase();
      }
    }

    if (!isNonEmptyString(owner.language, 10) || !ISO_639_1_RE.test(owner.language)) {
      errors.push('owner.language must be an ISO-639-1 code (e.g. "de", "en", "en-US")');
    } else {
      ownerOut.language = owner.language;
    }
  }

  // tone (optional; defaults applied)
  const toneOut = { style: 'neutral', tonality: null };
  if (raw.tone !== undefined) {
    if (!isPlainObject(raw.tone)) {
      errors.push('tone must be an object');
    } else {
      if (raw.tone.style !== undefined) {
        if (!VALID_TONE_STYLES.includes(raw.tone.style)) {
          errors.push(`tone.style must be one of ${VALID_TONE_STYLES.join('|')}, got: ${raw.tone.style}`);
        } else {
          toneOut.style = raw.tone.style;
        }
      }
      if (raw.tone.tonality !== undefined && raw.tone.tonality !== null) {
        if (typeof raw.tone.tonality !== 'string' || raw.tone.tonality.length > TONALITY_MAX) {
          errors.push(`tone.tonality must be a string (max ${TONALITY_MAX} chars) or null`);
        } else {
          toneOut.tonality = raw.tone.tonality;
        }
      }
    }
  }

  // efficiency (optional; defaults applied)
  const efficiencyOut = {
    'output-level': 'full',
    preamble: 'minimal',
    'comments-in-code': 'minimal',
  };
  if (raw.efficiency !== undefined) {
    if (!isPlainObject(raw.efficiency)) {
      errors.push('efficiency must be an object');
    } else {
      if (raw.efficiency['output-level'] !== undefined) {
        if (!VALID_OUTPUT_LEVELS.includes(raw.efficiency['output-level'])) {
          errors.push(
            `efficiency.output-level must be one of ${VALID_OUTPUT_LEVELS.join('|')}, got: ${raw.efficiency['output-level']}`
          );
        } else {
          efficiencyOut['output-level'] = raw.efficiency['output-level'];
        }
      }
      if (raw.efficiency.preamble !== undefined) {
        if (!VALID_PREAMBLE_LEVELS.includes(raw.efficiency.preamble)) {
          errors.push(
            `efficiency.preamble must be one of ${VALID_PREAMBLE_LEVELS.join('|')}, got: ${raw.efficiency.preamble}`
          );
        } else {
          efficiencyOut.preamble = raw.efficiency.preamble;
        }
      }
      if (raw.efficiency['comments-in-code'] !== undefined) {
        if (!VALID_COMMENTS_LEVELS.includes(raw.efficiency['comments-in-code'])) {
          errors.push(
            `efficiency.comments-in-code must be one of ${VALID_COMMENTS_LEVELS.join('|')}, got: ${raw.efficiency['comments-in-code']}`
          );
        } else {
          efficiencyOut['comments-in-code'] = raw.efficiency['comments-in-code'];
        }
      }
    }
  }

  // hardware-sharing (optional; defaults applied)
  const hwOut = { enabled: false, 'hash-salt': null };
  if (raw['hardware-sharing'] !== undefined) {
    const hw = raw['hardware-sharing'];
    if (!isPlainObject(hw)) {
      errors.push('hardware-sharing must be an object');
    } else {
      if (hw.enabled !== undefined) {
        if (typeof hw.enabled !== 'boolean') {
          errors.push(`hardware-sharing.enabled must be boolean, got: ${typeof hw.enabled}`);
        } else {
          hwOut.enabled = hw.enabled;
        }
      }
      if (hw['hash-salt'] !== undefined && hw['hash-salt'] !== null) {
        if (typeof hw['hash-salt'] !== 'string' || !HEX64_RE.test(hw['hash-salt'])) {
          errors.push('hardware-sharing.hash-salt must be a 64-char hex string (32 bytes) or null');
        } else {
          hwOut['hash-salt'] = hw['hash-salt'].toLowerCase();
        }
      }
      // Privacy contract: enabled=true requires hash-salt to be set.
      if (hwOut.enabled && hwOut['hash-salt'] === null) {
        errors.push('hardware-sharing.enabled=true requires hash-salt to be set (D4 consent contract)');
      }
    }
  }

  // defaults (optional)
  const defaultsOut = { 'preferred-test-command': null, 'preferred-editor': null };
  if (raw.defaults !== undefined) {
    if (!isPlainObject(raw.defaults)) {
      errors.push('defaults must be an object');
    } else {
      if (raw.defaults['preferred-test-command'] !== undefined && raw.defaults['preferred-test-command'] !== null) {
        if (
          typeof raw.defaults['preferred-test-command'] !== 'string' ||
          raw.defaults['preferred-test-command'].length > TEST_COMMAND_MAX
        ) {
          errors.push(`defaults.preferred-test-command must be a string (max ${TEST_COMMAND_MAX} chars) or null`);
        } else {
          defaultsOut['preferred-test-command'] = raw.defaults['preferred-test-command'];
        }
      }
      if (raw.defaults['preferred-editor'] !== undefined && raw.defaults['preferred-editor'] !== null) {
        if (
          typeof raw.defaults['preferred-editor'] !== 'string' ||
          raw.defaults['preferred-editor'].length > EDITOR_MAX
        ) {
          errors.push(`defaults.preferred-editor must be a string (max ${EDITOR_MAX} chars) or null`);
        } else {
          defaultsOut['preferred-editor'] = raw.defaults['preferred-editor'];
        }
      }
    }
  }

  // metadata (optional, auto-managed by writer)
  const metadataOut = { created_at: null, updated_at: null };
  if (raw.metadata !== undefined) {
    if (!isPlainObject(raw.metadata)) {
      errors.push('metadata must be an object');
    } else {
      if (raw.metadata.created_at !== undefined && raw.metadata.created_at !== null) {
        if (typeof raw.metadata.created_at !== 'string' || Number.isNaN(Date.parse(raw.metadata.created_at))) {
          errors.push('metadata.created_at must be an ISO 8601 timestamp string or null');
        } else {
          metadataOut.created_at = raw.metadata.created_at;
        }
      }
      if (raw.metadata.updated_at !== undefined && raw.metadata.updated_at !== null) {
        if (typeof raw.metadata.updated_at !== 'string' || Number.isNaN(Date.parse(raw.metadata.updated_at))) {
          errors.push('metadata.updated_at must be an ISO 8601 timestamp string or null');
        } else {
          metadataOut.updated_at = raw.metadata.updated_at;
        }
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, value: null, errors };
  }

  return {
    ok: true,
    errors: [],
    value: {
      'schema-version': CURRENT_OWNER_SCHEMA_VERSION,
      owner: ownerOut,
      tone: toneOut,
      efficiency: efficiencyOut,
      'hardware-sharing': hwOut,
      defaults: defaultsOut,
      metadata: metadataOut,
    },
  };
}

/**
 * Strict-mode wrapper around validate(). Returns the normalized value when
 * the input passes the gate, otherwise throws OwnerConfigError with the
 * full error list attached as `.errors`. Convenient for CLI entrypoints
 * and tests that want to assert on success without inspecting `ok`.
 *
 * @param {unknown} raw
 * @returns {object}
 */
export function coerce(raw) {
  const result = validate(raw);
  if (!result.ok) {
    throw new OwnerConfigError(
      `owner config validation failed (${result.errors.length} error${result.errors.length === 1 ? '' : 's'})`,
      result.errors
    );
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Deep merge two owner configs. `override` values win on every leaf key
 * where they are defined (i.e. not undefined). The returned value is a
 * full default-filled config — either input may be partial.
 *
 * Used by D3 (`soul.md` runtime-merge) and D4 (baseline-propagation +
 * per-session override). The merge is one level deep on each top-level
 * section (owner, tone, efficiency, hardware-sharing, defaults, metadata)
 * because the schema has no nested object leaves beyond that.
 *
 * @param {object|null|undefined} base
 * @param {object|null|undefined} override
 * @returns {object}
 */
export function merge(base, override) {
  const baseSafe = isPlainObject(base) ? base : {};
  const overSafe = isPlainObject(override) ? override : {};
  const def = defaults();

  const sections = ['owner', 'tone', 'efficiency', 'hardware-sharing', 'defaults', 'metadata'];
  const out = {
    'schema-version': CURRENT_OWNER_SCHEMA_VERSION,
  };

  for (const section of sections) {
    const baseSection = isPlainObject(baseSafe[section]) ? baseSafe[section] : {};
    const overSection = isPlainObject(overSafe[section]) ? overSafe[section] : {};
    out[section] = { ...def[section], ...baseSection };
    for (const [k, v] of Object.entries(overSection)) {
      if (v !== undefined) {
        out[section][k] = v;
      }
    }
  }

  return out;
}
