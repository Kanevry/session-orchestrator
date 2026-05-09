/**
 * owner-config/validate.mjs — Pure schema validator for the owner persona config.
 * Never throws — returns {ok, value, errors}. Unknown top-level sections dropped.
 */

import {
  CURRENT_OWNER_SCHEMA_VERSION,
  VALID_TONE_STYLES,
  VALID_OUTPUT_LEVELS,
  VALID_PREAMBLE_LEVELS,
  VALID_COMMENTS_LEVELS,
} from './constants.mjs';

// Internal constants
const NAME_MAX = 100;
const TONALITY_MAX = 200;
const TEST_COMMAND_MAX = 200;
const EDITOR_MAX = 50;
const HEX64_RE = /^[a-f0-9]{64}$/i;
const ISO_639_1_RE = /^[a-z]{2}(-[A-Z]{2})?$/;

// Private helpers
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = (v, max) => typeof v === 'string' && v.length > 0 && (max === undefined || v.length <= max);

// Section validators (module-private)
function _validateSchemaVersionSection(raw, errors) {
  const schemaVersion = raw['schema-version'];
  if (schemaVersion === undefined || schemaVersion === null) {
    errors.push('schema-version is required');
  } else if (schemaVersion !== CURRENT_OWNER_SCHEMA_VERSION) {
    errors.push(
      `schema-version must be ${CURRENT_OWNER_SCHEMA_VERSION}, got: ${JSON.stringify(schemaVersion)}`
    );
  }
}

function _validateOwnerSection(raw, errors, ownerOut) {
  const owner = raw.owner;
  if (!isPlainObject(owner)) {
    errors.push('owner must be an object');
    return;
  }
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

function _validateToneSection(raw, errors, toneOut) {
  if (raw.tone === undefined) return;
  if (!isPlainObject(raw.tone)) {
    errors.push('tone must be an object');
    return;
  }
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

function _validateEfficiencySection(raw, errors, efficiencyOut) {
  if (raw.efficiency === undefined) return;
  if (!isPlainObject(raw.efficiency)) {
    errors.push('efficiency must be an object');
    return;
  }
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

function _validateHardwareSharingSection(raw, errors, hwOut) {
  if (raw['hardware-sharing'] === undefined) return;
  const hw = raw['hardware-sharing'];
  if (!isPlainObject(hw)) {
    errors.push('hardware-sharing must be an object');
    return;
  }
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

function _validateDefaultsSection(raw, errors, defaultsOut) {
  if (raw.defaults === undefined) return;
  if (!isPlainObject(raw.defaults)) {
    errors.push('defaults must be an object');
    return;
  }
  const ptc = raw.defaults['preferred-test-command'];
  if (ptc !== undefined && ptc !== null) {
    if (typeof ptc !== 'string' || ptc.length > TEST_COMMAND_MAX) {
      errors.push(`defaults.preferred-test-command must be a string (max ${TEST_COMMAND_MAX} chars) or null`);
    } else {
      defaultsOut['preferred-test-command'] = ptc;
    }
  }
  const pe = raw.defaults['preferred-editor'];
  if (pe !== undefined && pe !== null) {
    if (typeof pe !== 'string' || pe.length > EDITOR_MAX) {
      errors.push(`defaults.preferred-editor must be a string (max ${EDITOR_MAX} chars) or null`);
    } else {
      defaultsOut['preferred-editor'] = pe;
    }
  }
}

function _validateMetadataSection(raw, errors, metadataOut) {
  if (raw.metadata === undefined) return;
  if (!isPlainObject(raw.metadata)) {
    errors.push('metadata must be an object');
    return;
  }
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

// Public API

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
  _validateSchemaVersionSection(raw, errors);

  // owner (required)
  const ownerOut = { name: '', 'email-hash': null, language: '' };
  _validateOwnerSection(raw, errors, ownerOut);

  // tone (optional; defaults applied)
  const toneOut = { style: 'neutral', tonality: null };
  _validateToneSection(raw, errors, toneOut);

  // efficiency (optional; defaults applied)
  const efficiencyOut = {
    'output-level': 'full',
    preamble: 'minimal',
    'comments-in-code': 'minimal',
  };
  _validateEfficiencySection(raw, errors, efficiencyOut);

  // hardware-sharing (optional; defaults applied)
  const hwOut = { enabled: false, 'hash-salt': null };
  _validateHardwareSharingSection(raw, errors, hwOut);

  // defaults (optional)
  const defaultsOut = { 'preferred-test-command': null, 'preferred-editor': null };
  _validateDefaultsSection(raw, errors, defaultsOut);

  // metadata (optional, auto-managed by writer)
  const metadataOut = { created_at: null, updated_at: null };
  _validateMetadataSection(raw, errors, metadataOut);

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
