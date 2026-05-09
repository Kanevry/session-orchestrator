/**
 * owner-config/defaults.mjs — Canonical default-filled owner config factory.
 *
 * Imports constants only. Leaf in the dependency sense (no circular deps).
 * Returns the fully-default-filled config with `owner.name` and
 * `owner.language` intentionally left blank — those are required from the user;
 * the bootstrap interview (D2) fills them in.
 */

import { CURRENT_OWNER_SCHEMA_VERSION } from './constants.mjs';

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
