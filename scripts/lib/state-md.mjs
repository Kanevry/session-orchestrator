/**
 * STATE.md helpers (issue #184).
 *
 * Thin barrel — re-exports all 12 public symbols from the split submodules.
 * Implementation lives in scripts/lib/state-md/*.mjs.
 *
 * @see scripts/lib/state-md/yaml-parser.mjs        parseStateMd, serializeStateMd
 * @see scripts/lib/state-md/frontmatter-mutators.mjs touchUpdatedField, updateFrontmatterFields
 * @see scripts/lib/state-md/body-sections.mjs       readCurrentTask, appendDeviation, markExpressPathComplete
 * @see scripts/lib/state-md/mission-status.mjs      parseMissionStatus, writeMissionStatus, setMissionStatus, readMissionStatus
 * @see scripts/lib/state-md/recommendations.mjs     parseRecommendations
 */

export { parseStateMd, serializeStateMd } from './state-md/yaml-parser.mjs';

export { touchUpdatedField, updateFrontmatterFields } from './state-md/frontmatter-mutators.mjs';

export {
  readCurrentTask,
  appendDeviation,
  markExpressPathComplete,
  recordAutoCommit,
} from './state-md/body-sections.mjs';

export {
  parseMissionStatus,
  writeMissionStatus,
  setMissionStatus,
  readMissionStatus,
} from './state-md/mission-status.mjs';

export { parseRecommendations } from './state-md/recommendations.mjs';
