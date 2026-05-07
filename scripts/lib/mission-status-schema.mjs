/**
 * Mission-Status Enum + Transition Validator (issue #340).
 *
 * Pure ESM, no I/O, no external dependencies. All functions are deterministic.
 *
 * Five-state lifecycle for wave-plan items:
 *
 *   brainstormed → validated → in-dev → testing → completed
 *
 * Rollbacks to `brainstormed` are permitted from any state (user can reset scope).
 * Idempotent self-transitions are always allowed.
 * All other transitions are rejected.
 */

/**
 * Canonical ordered list of valid mission-status values.
 *
 * @type {readonly string[]}
 */
export const MISSION_STATUS_VALUES = Object.freeze([
  'brainstormed',
  'validated',
  'in-dev',
  'testing',
  'completed',
]);

/**
 * Allowed forward transitions (excluding self-transitions and rollback to
 * 'brainstormed', which are handled separately in isValidMissionStatusTransition).
 *
 * @type {ReadonlyMap<string, string>}
 */
const FORWARD_TRANSITIONS = new Map([
  ['brainstormed', 'validated'],
  ['validated', 'in-dev'],
  ['in-dev', 'testing'],
  ['testing', 'completed'],
]);

/**
 * Returns true when `value` is one of the five canonical status strings.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isValidMissionStatus(value) {
  return typeof value === 'string' && MISSION_STATUS_VALUES.includes(value);
}

/**
 * Returns true when the transition from `from` → `to` is permitted.
 *
 * Allowed transitions:
 *   - Forward: brainstormed→validated, validated→in-dev, in-dev→testing, testing→completed
 *   - Idempotent: any state → itself
 *   - Rollback: any state → brainstormed
 *
 * All other transitions return false.
 *
 * @param {string} from - current status value
 * @param {string} to   - target status value
 * @returns {boolean}
 */
export function isValidMissionStatusTransition(from, to) {
  if (!isValidMissionStatus(from) || !isValidMissionStatus(to)) return false;
  // Idempotent self-transition
  if (from === to) return true;
  // Rollback to brainstormed from any state
  if (to === 'brainstormed') return true;
  // Forward transition
  return FORWARD_TRANSITIONS.get(from) === to;
}

/**
 * Validates a mission-status entry object.
 *
 * Expected shape:
 *   { id: string, task: string, wave: number, status: <MISSION_STATUS_VALUES> }
 *
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateMissionStatusEntry(obj) {
  const errors = [];
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['entry must be a non-null, non-array object'] };
  }
  const entry = /** @type {Record<string, unknown>} */ (obj);

  // id — non-empty string
  if (typeof entry.id !== 'string' || entry.id.trim() === '') {
    errors.push('id must be a non-empty string');
  }

  // task — non-empty string
  if (typeof entry.task !== 'string' || entry.task.trim() === '') {
    errors.push('task must be a non-empty string');
  }

  // wave — integer >= 1
  if (!Number.isInteger(entry.wave) || /** @type {number} */ (entry.wave) < 1) {
    errors.push('wave must be a positive integer');
  }

  // status — one of MISSION_STATUS_VALUES
  if (!isValidMissionStatus(entry.status)) {
    errors.push(
      `status must be one of [${MISSION_STATUS_VALUES.join(', ')}], got: ${JSON.stringify(entry.status)}`,
    );
  }

  return { ok: errors.length === 0, errors };
}
