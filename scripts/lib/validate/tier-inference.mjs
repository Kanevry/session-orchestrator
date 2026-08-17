/**
 * tier-inference.mjs — Sandbox-tier vocabulary + inference helpers (issue #418).
 *
 * Four tiers (ordered from most-restricted to most-permissive):
 *   read-only        — only observes the repo; no writes, no network
 *   repo-write       — may create or modify files (Edit, Write)
 *   network-allowed  — may make outbound network calls (future use)
 *   dangerous        — may run destructive shell commands (future use)
 *
 * Backward-compat: agents without a `sandbox-tier:` field in frontmatter
 * infer their tier from their declared tools list.  The validator emits
 * WARN (not FAIL) when the field is absent, so existing agents continue
 * to work during migration.
 */

/**
 * Canonical ordered tier enum.
 *
 * @type {string[]}
 */
export const TIER_ENUM = ['read-only', 'repo-write', 'network-allowed', 'dangerous'];

// Tools that signal write capability.
const WRITE_TOOLS = new Set(['Edit', 'Write']);

// Tools that are acceptable in the read-only tier (Bash is fine — fine-grained
// Bash control lives in hooks/pre-bash-destructive-guard.mjs, NOT here).
//
// SendMessage / ListAgents are pure agent-to-coordinator communication surfaces
// with no filesystem write path, so they do not lift an agent out of read-only
// (#1049, PRD § 2 A5). Without them here, every read-only agent that opts into
// SendMessage silently infers `repo-write` and trips validateTierConsistency.
const READ_ONLY_TOOLS = new Set([
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'Skill',
  'SendMessage',
  'ListAgents',
]);

/**
 * Normalise one raw frontmatter tool entry to its lookup key.
 *
 * Single source of truth for the "Skill(...)" → "Skill" collapse: both
 * inferTierFromTools and validateTierConsistency's detail text must agree on
 * what a tool entry IS, or the error message names offenders the inference
 * never objected to.
 *
 * @param {unknown} t - raw entry from the frontmatter tools array
 * @returns {string} lookup key
 */
function normaliseTool(t) {
  if (typeof t !== 'string') return String(t);
  return t.startsWith('Skill(') ? 'Skill' : t.trim();
}

/**
 * Infer the sandbox tier from a parsed tools array.
 *
 * The inference is intentionally conservative:
 *   - Any Edit or Write entry → repo-write
 *   - All entries are read-only-compatible → read-only
 *   - Anything else (unknown tool, empty array) → repo-write (safe default)
 *
 * Skill(...) entries (e.g. "Skill(session-orchestrator:*)") are normalised
 * to "Skill" before lookup so they match READ_ONLY_TOOLS.
 *
 * @param {string[]} toolsArray - array of tool name strings from frontmatter
 * @returns {string} one of the values in TIER_ENUM
 */
export function inferTierFromTools(toolsArray) {
  if (!Array.isArray(toolsArray) || toolsArray.length === 0) {
    return 'repo-write'; // safe default
  }

  // Normalise "Skill(...)" → "Skill"
  const normalised = toolsArray.map(normaliseTool);

  // Any write tool → repo-write
  for (const t of normalised) {
    if (WRITE_TOOLS.has(t)) return 'repo-write';
  }

  // If every tool is in the read-only-compatible set → read-only
  const allReadOnly = normalised.every((t) => READ_ONLY_TOOLS.has(t));
  if (allReadOnly) return 'read-only';

  // Unknown tool encountered — safe default
  return 'repo-write';
}

/**
 * Validate that a declared sandbox-tier is consistent with the agent's tools.
 *
 * @param {{
 *   declared: string,
 *   inferred: string,
 *   tools?: string[]
 * }} params
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateTierConsistency({ declared, inferred, tools }) {
  // 1. Declared value must be in the enum.
  if (!TIER_ENUM.includes(declared)) {
    return {
      ok: false,
      error: `sandbox-tier "${declared}" is not a valid tier; must be one of: ${TIER_ENUM.join(', ')}`,
    };
  }

  // 2. Read-only agent must not have write tools.
  if (declared === 'read-only' && inferred !== 'read-only') {
    // Name EVERY tool responsible for the verdict, not only the write tools.
    // inferTierFromTools falls through to `repo-write` for any UNRECOGNISED
    // tool too, and filtering the detail text on WRITE_TOOLS alone reported
    // "tools suggest repo-write" with no culprit named in exactly that case
    // (#1049). Normalised via the same helper the inference uses, so a
    // "Skill(...)" entry is never listed as an offender.
    const offenders = Array.isArray(tools)
      ? [
          ...new Set(
            tools
              .map(normaliseTool)
              .filter((t) => WRITE_TOOLS.has(t) || !READ_ONLY_TOOLS.has(t)),
          ),
        ]
      : [];
    const detail = offenders.length > 0 ? ` (tools include: ${offenders.join(', ')})` : '';
    return {
      ok: false,
      error: `agent declares sandbox-tier "read-only" but tools suggest "${inferred}"${detail}`,
    };
  }

  return { ok: true };
}
