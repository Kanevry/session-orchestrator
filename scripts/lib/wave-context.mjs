/**
 * Wave-context helpers — single source of truth for the
 * agent-context env-var contract documented in
 * CLAUDE.md (or AGENTS.md on Codex CLI) "Critical Gotchas"
 * + .claude/rules/parallel-sessions.md.
 *
 * The `SO_WAVE_AGENT` env-var is set to '1' by the wave-executor
 * harness when dispatching subagents. Agents check this guard before
 * calling memory.propose() — coordinator-thread invocations must NOT
 * succeed (use /evolve instead). See #548 A4.
 *
 * Strict equality semantics (=== '1') are intentional: leading
 * whitespace, trailing newline, '01', 'true', '0', undefined, and
 * empty string all return false. This matches the documented contract
 * in scripts/memory-propose.mjs Step 2b and the regression tests in
 * tests/scripts/memory-propose.test.mjs Section E.
 */

export const WAVE_AGENT_ENV_VAR = 'SO_WAVE_AGENT';
export const WAVE_AGENT_ENV_VALUE = '1';

/**
 * @returns {boolean} true iff this process is running as a dispatched
 *   wave-agent (i.e., SO_WAVE_AGENT === '1', strict equality — leading
 *   whitespace, trailing newline, '01', etc. all return false).
 */
export function isWaveAgentContext() {
  return process.env[WAVE_AGENT_ENV_VAR] === WAVE_AGENT_ENV_VALUE;
}
