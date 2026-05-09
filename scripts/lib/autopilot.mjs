/**
 * autopilot.mjs — Thin barrel re-exporting all public autopilot symbols.
 *
 * W1A6 decomposition: the ~418 LOC monolith has been split into four
 * focused submodules under `autopilot/`. This file is now a pure aggregation
 * barrel — all business logic lives in the submodules.
 *
 * Public API (12 exports — all backward-compat):
 *   From autopilot/kill-switches.mjs:
 *     KILL_SWITCHES
 *   From autopilot/flags.mjs:
 *     FLAG_BOUNDS, DEFAULT_PEER_ABORT_THRESHOLD, DEFAULT_JSONL_PATH,
 *     DEFAULT_CARRYOVER_THRESHOLD, parseFlags
 *   From autopilot/telemetry.mjs:
 *     SCHEMA_VERSION, writeAutopilotJsonl, defaultRunId, readHostClass,
 *     finalizeState
 *   From autopilot/loop.mjs:
 *     runLoop
 */

export { KILL_SWITCHES } from './autopilot/kill-switches.mjs';

export {
  FLAG_BOUNDS,
  DEFAULT_PEER_ABORT_THRESHOLD,
  DEFAULT_JSONL_PATH,
  DEFAULT_CARRYOVER_THRESHOLD,
  parseFlags,
} from './autopilot/flags.mjs';

export {
  SCHEMA_VERSION,
  writeAutopilotJsonl,
  defaultRunId,
  readHostClass,
  finalizeState,
} from './autopilot/telemetry.mjs';

export { runLoop } from './autopilot/loop.mjs';
