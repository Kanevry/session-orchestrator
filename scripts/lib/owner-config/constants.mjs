/**
 * owner-config/constants.mjs — Schema constants for the owner persona config.
 *
 * Leaf module. No imports. All exported arrays are frozen so consumers cannot
 * accidentally mutate the canonical enum sets.
 */

/** Current owner-config schema version. New writes are stamped with this. */
export const CURRENT_OWNER_SCHEMA_VERSION = 1;

/** Valid values for tone.style. */
export const VALID_TONE_STYLES = Object.freeze(['direct', 'neutral', 'friendly']);

/** Valid values for efficiency.output-level. */
export const VALID_OUTPUT_LEVELS = Object.freeze(['lite', 'full', 'ultra']);

/** Valid values for efficiency.preamble. */
export const VALID_PREAMBLE_LEVELS = Object.freeze(['minimal', 'verbose']);

/** Valid values for efficiency.comments-in-code. */
export const VALID_COMMENTS_LEVELS = Object.freeze(['minimal', 'full']);
