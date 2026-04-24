/**
 * wave-sizing.mjs — graduated isolation defaults (issue #194).
 * Learning: coordinator-over-worktree-on-shared-files caused back-to-back regressions.
 */

const VALID_SESSION_TYPES = ['housekeeping', 'feature', 'deep'];
const VALID_COLLISION_RISKS = ['low', 'medium', 'high'];
const VALID_CONFIG_ISOLATIONS = ['auto', 'worktree', 'none'];
const VALID_ENFORCEMENTS = ['strict', 'warn', 'off'];
const VALID_ISOLATIONS = ['worktree', 'none'];

/**
 * Resolve isolation mode for an agent wave dispatch.
 *
 * @param {Object} opts
 * @param {number} opts.agentCount          positive integer
 * @param {string} opts.sessionType         'housekeeping' | 'feature' | 'deep'
 * @param {string} [opts.collisionRisk]     'low' | 'medium' | 'high' — default 'low'
 * @param {string} [opts.configIsolation]   'auto' | 'worktree' | 'none' — default 'auto'
 * @returns {'worktree'|'none'}
 */
export function resolveIsolation({ agentCount, sessionType, collisionRisk = 'low', configIsolation = 'auto' } = {}) {
  if (!Number.isInteger(agentCount) || agentCount < 1) {
    throw new TypeError(`resolveIsolation: agentCount must be a positive integer, got ${agentCount}`);
  }
  if (!VALID_SESSION_TYPES.includes(sessionType)) {
    throw new TypeError(`resolveIsolation: sessionType must be housekeeping|feature|deep, got '${sessionType}'`);
  }
  if (!VALID_COLLISION_RISKS.includes(collisionRisk)) {
    throw new TypeError(`resolveIsolation: collisionRisk must be low|medium|high, got '${collisionRisk}'`);
  }
  if (!VALID_CONFIG_ISOLATIONS.includes(configIsolation)) {
    throw new TypeError(`resolveIsolation: configIsolation must be auto|worktree|none, got '${configIsolation}'`);
  }

  // Hard user overrides — first-match wins
  if (configIsolation === 'worktree') return 'worktree';
  if (configIsolation === 'none') return 'none';

  // Plan-level collision declaration forces isolation even at ≤2 agents
  if (collisionRisk === 'high') return 'worktree';

  // Decision table
  if (agentCount <= 2) return 'none';
  if (agentCount >= 5) return 'worktree';
  // agentCount is 3 or 4
  if (sessionType === 'housekeeping') return 'none';
  return 'worktree'; // feature | deep
}

/**
 * Resolve enforcement mode given isolation.
 *
 * When isolation is 'none', the scope-enforcement hook is the only barrier —
 * auto-promote 'warn' to 'strict'. Explicit 'off' is respected as user opt-out.
 *
 * @param {Object} opts
 * @param {string} opts.isolation          'worktree' | 'none'
 * @param {string} [opts.configEnforcement] 'strict' | 'warn' | 'off' — default 'warn'
 * @returns {'strict'|'warn'|'off'}
 */
export function resolveEnforcement({ isolation, configEnforcement = 'warn' } = {}) {
  if (!VALID_ISOLATIONS.includes(isolation)) {
    throw new TypeError(`resolveEnforcement: isolation must be worktree|none, got '${isolation}'`);
  }
  if (!VALID_ENFORCEMENTS.includes(configEnforcement)) {
    throw new TypeError(`resolveEnforcement: configEnforcement must be strict|warn|off, got '${configEnforcement}'`);
  }

  if (isolation === 'worktree') return configEnforcement;

  // isolation === 'none': auto-promote warn → strict; respect strict and off as-is
  if (configEnforcement === 'warn') return 'strict';
  return configEnforcement;
}
