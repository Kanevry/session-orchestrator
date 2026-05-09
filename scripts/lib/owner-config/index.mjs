/**
 * owner-config/index.mjs — Re-export hub for all 10 public symbols.
 *
 * DAG: constants/error (leaves) → defaults → merge; constants/error → validate → coerce.
 * This hub is the single import target for `scripts/lib/owner-config.mjs` (top wrapper).
 */

export { CURRENT_OWNER_SCHEMA_VERSION, VALID_TONE_STYLES, VALID_OUTPUT_LEVELS, VALID_PREAMBLE_LEVELS, VALID_COMMENTS_LEVELS } from './constants.mjs';
export { OwnerConfigError } from './error.mjs';
export { defaults } from './defaults.mjs';
export { validate } from './validate.mjs';
export { coerce } from './coerce.mjs';
export { merge } from './merge.mjs';
