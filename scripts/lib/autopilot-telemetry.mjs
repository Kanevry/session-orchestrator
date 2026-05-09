/**
 * autopilot-telemetry.mjs — Backward-compat re-export shim.
 *
 * The telemetry implementation has been relocated to
 * `scripts/lib/autopilot/telemetry.mjs` as part of the W1A6 decomposition.
 * This file is kept as a thin re-export so existing direct importers
 * (e.g. tests/lib/autopilot-telemetry.test.mjs) continue to resolve
 * without modification.
 */

export * from './autopilot/telemetry.mjs';
