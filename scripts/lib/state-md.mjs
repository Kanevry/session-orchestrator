/**
 * STATE.md helpers (issue #184).
 *
 * Thin barrel — re-exports every public symbol of the split submodules.
 * Implementation lives in scripts/lib/state-md/*.mjs.
 *
 * @see scripts/lib/state-md/yaml-parser.mjs        parseStateMd, serializeStateMd
 * @see scripts/lib/state-md/frontmatter-mutators.mjs touchUpdatedField, updateFrontmatterFields
 * @see scripts/lib/state-md/body-sections.mjs       readCurrentTask, appendDeviation, markExpressPathComplete, appendWhatNotToRetry, readWhatNotToRetry, readOpenQuestions, appendOpenQuestion, markOpenQuestionAnswered
 * @see scripts/lib/state-md/mission-status.mjs      parseMissionStatus, parseMissionStatusStrict, MISSION_STATUS_VALUES, writeMissionStatus, setMissionStatus, readMissionStatus, recoverFrontmatterMissionStatusDetailed
 * @see scripts/lib/state-md/recommendations.mjs     parseRecommendations
 */

export { parseStateMd, serializeStateMd } from './state-md/yaml-parser.mjs';

export {
  touchUpdatedField,
  updateFrontmatterFields,
  resolveStateMdPath,
  writeStateMd,
  updateFrontmatterFieldsOnDisk,
  touchUpdatedFieldOnDisk,
} from './state-md/frontmatter-mutators.mjs';

export {
  readCurrentTask,
  appendDeviation,
  markExpressPathComplete,
  recordAutoCommit,
  appendDeviationOnDisk,
  recordAutoCommitOnDisk,
  markExpressPathCompleteOnDisk,
  appendWhatNotToRetry,
  readWhatNotToRetry,
  appendWhatNotToRetryOnDisk,
  readOpenQuestions,
  appendOpenQuestion,
  markOpenQuestionAnswered,
  appendOpenQuestionOnDisk,
  markOpenQuestionAnsweredOnDisk,
  MAX_OPEN_QUESTIONS_STORED,
} from './state-md/body-sections.mjs';

export {
  parseMissionStatus,
  // The strict reader and the status vocabulary are part of the same public
  // surface as `parseMissionStatus` (#1111) — a consumer that imports from this
  // barrel (the documented entry point) reached neither until this re-export
  // landed: a static `import { parseMissionStatusStrict } from '.../state-md.mjs'`
  // failed at link time, and the `await import()` form — the one hooks and
  // lazy loaders use — yielded `undefined` and failed only at the call.
  parseMissionStatusStrict,
  MISSION_STATUS_VALUES,
  writeMissionStatus,
  setMissionStatus,
  readMissionStatus,
  writeMissionStatusOnDisk,
  setMissionStatusOnDisk,
  recoverFrontmatterMissionStatusDetailed,
} from './state-md/mission-status.mjs';

export { parseRecommendations } from './state-md/recommendations.mjs';
