/**
 * Mode-selector constants (W1A2 split, issue #358).
 *
 * Leaf module — no imports from other mode-selector submodules.
 * Pure data: DEFAULT_MODE, ALL_MODES, TIER_MODE_MAP.
 */

/** @type {'feature'} */
export const DEFAULT_MODE = 'feature';

/** All valid mode values — mirrors VALID_MODES in recommendations-v0.mjs. */
export const ALL_MODES = Object.freeze([
  'housekeeping',
  'feature',
  'deep',
  'discovery',
  'evolve',
  'plan-retro',
]);

/**
 * Bootstrap tier → preferred mode alignment map.
 * @type {Readonly<Record<string, string>>}
 */
export const TIER_MODE_MAP = Object.freeze({
  fast: 'housekeeping',
  standard: 'feature',
  deep: 'deep',
});
