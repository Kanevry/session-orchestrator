/**
 * exclusivity-matrix.mjs — Classify orchestrator skill modes into exclusivity classes.
 *
 * Pure ESM, no imports required. Stateless pure functions only.
 *
 * Exclusivity classes control whether a session mode may run concurrently with
 * other active sessions in the same working directory:
 *  - "exclusive"   — must hold the session lock alone (e.g., housekeeping)
 *  - "parallel-ok" — may coexist with other parallel-ok sessions
 *  - "always-ok"   — lightweight; always allowed regardless of active sessions
 *
 * Used by:
 *  - parallel-aware-preamble (W3-P3, #574) — inject concurrency guardrail text
 *  - acquire() integration (P1.2, #570) — enforce lock semantics at session-start
 *
 * Stable contract: the list of modes per class is documented in
 * `skills/_shared/state-ownership.md` (PRD §3.A line 195).
 * Do NOT add or move modes without coordinating with that document.
 */

// ---------------------------------------------------------------------------
// EXCLUSIVITY_MATRIX
// ---------------------------------------------------------------------------

/**
 * Static, frozen mapping from exclusivity class → mode names.
 *
 * All inner arrays are also frozen to prevent mutation. Any attempt to push,
 * splice, or reassign will throw a TypeError in strict mode (and silently fail
 * in sloppy mode after Object.freeze — prefer strict mode callers).
 *
 * @type {{ exclusive: readonly string[], "parallel-ok": readonly string[], "always-ok": readonly string[] }}
 */
export const EXCLUSIVITY_MATRIX = Object.freeze({
  exclusive: Object.freeze(['bootstrap', 'housekeeping', 'memory-cleanup']),
  'parallel-ok': Object.freeze(['deep', 'feature']),
  'always-ok': Object.freeze(['discovery', 'evolve', 'plan', 'repo-audit', 'portfolio']),
});

// ---------------------------------------------------------------------------
// classifyMode
// ---------------------------------------------------------------------------

/**
 * Classify a skill mode name into its exclusivity class.
 *
 * Lookup is case-sensitive; all documented modes are lowercase. Whitespace is
 * trimmed defensively before the lookup so callers do not need to pre-strip.
 *
 * @param {string} modeName - The skill mode name to classify (e.g. "deep").
 * @returns {"exclusive" | "parallel-ok" | "always-ok"} The exclusivity class.
 * @throws {Error} If `modeName` (after trimming) is not a recognised mode.
 *
 * @example
 * classifyMode('deep')          // → "parallel-ok"
 * classifyMode('housekeeping')  // → "exclusive"
 * classifyMode('discovery')     // → "always-ok"
 */
export function classifyMode(modeName) {
  const name = String(modeName).trim();

  for (const [cls, modes] of Object.entries(EXCLUSIVITY_MATRIX)) {
    if (modes.includes(name)) return cls;
  }

  const known = Object.values(EXCLUSIVITY_MATRIX).flat().join(', ');
  throw new Error(`classifyMode: unknown mode "${name}". Known modes: ${known}`);
}
