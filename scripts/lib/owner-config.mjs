/**
 * owner-config.mjs — Owner Persona schema + validator (Issue #174, Sub-Epic #161).
 *
 * Thin re-export wrapper. All logic lives in `./owner-config/` submodules:
 *   constants.mjs  — frozen enum arrays + schema version
 *   error.mjs      — OwnerConfigError class
 *   defaults.mjs   — defaults() factory
 *   validate.mjs   — validate() + 7 section helpers
 *   coerce.mjs     — coerce() strict-mode wrapper
 *   merge.mjs      — merge() deep-merge
 *   index.mjs      — re-export hub (aggregates all 10 public symbols)
 *
 * For the full schema contract and module DAG see `./owner-config/index.mjs`.
 * The loader (which does touch the disk) lives in `owner-config-loader.mjs`.
 */

export {
  CURRENT_OWNER_SCHEMA_VERSION,
  VALID_TONE_STYLES,
  VALID_OUTPUT_LEVELS,
  VALID_PREAMBLE_LEVELS,
  VALID_COMMENTS_LEVELS,
  OwnerConfigError,
  defaults,
  validate,
  coerce,
  merge,
} from './owner-config/index.mjs';
