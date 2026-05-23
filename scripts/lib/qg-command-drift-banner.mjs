/**
 * qg-command-drift-banner.mjs — session-start banner probe for *-command drift detection.
 *
 * Detects when CLAUDE.md Session Config `lint-command` / `typecheck-command` /
 * `test-command` values deviate from project defaults. Returns a structured
 * banner object `{severity, message}` (or null for silent no-op), mirroring
 * the contract used by `checkVaultStaleness` and other session-start probes.
 *
 * Used by session-start Phase 4 alongside other freshness/drift probes.
 *
 * Config-read path: this module reads Session Config exclusively via
 * `loadCommandsFromSessionConfig` from `./quality-gate.mjs`. That helper
 * returns a partial object (missing keys are absent — no default substitution),
 * which means absent `*-command` keys cannot trigger spurious drift against
 * `PROJECT_DEFAULTS`. Drift is only reported when a value is explicitly set
 * AND differs from the corresponding `PROJECT_DEFAULTS` entry.
 *
 * Cross-references:
 * - .claude/rules/quality-gates-autofix.md § Session Config Command Injection
 * - scripts/lib/quality-gate.mjs `loadCommandsFromSessionConfig()`
 *
 * @see #525 (Pattern 4 Auto-Fix-Loop residuals)
 * @see #526 (Pattern 4 banner ecosystem coherence)
 */

import { loadCommandsFromSessionConfig } from './quality-gate.mjs';

/**
 * Default *-command values for the session-orchestrator plugin.
 * Source of truth: CLAUDE.md `## Session Config` block as shipped.
 *
 * Override this constant only when the canonical defaults change in CLAUDE.md.
 */
export const PROJECT_DEFAULTS = Object.freeze({
  lint: 'npm run lint',
  typecheck: 'npm run typecheck',
  test: 'npm test',
});

/**
 * Check for *-command drift.
 *
 * Reads Session Config from CLAUDE.md (or AGENTS.md) in `repoRoot` via
 * `loadCommandsFromSessionConfig` and compares any resolved `lint`,
 * `typecheck`, and `test` values against PROJECT_DEFAULTS. Returns null
 * when no drift is detected, or when the config-read returns no recognised
 * `*-command` keys at all (graceful no-op).
 *
 * Important: missing keys do NOT trigger drift. Only explicit overrides
 * that differ from PROJECT_DEFAULTS produce a banner.
 *
 * Marked `async` for backward compatibility with existing callers that
 * `await` the result; internally the helper is synchronous.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — project root (defaults to process.cwd()).
 * @returns {Promise<null | {severity: 'warn', message: string}>}
 */
export async function checkQgCommandDrift(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();

  let cfg;
  try {
    cfg = loadCommandsFromSessionConfig(repoRoot);
  } catch {
    return null; // graceful no-op on config load failure
  }
  if (!cfg || typeof cfg !== 'object') return null;

  const drifts = [];
  for (const [key, defaultVal] of Object.entries(PROJECT_DEFAULTS)) {
    const currentVal = cfg[key];
    // Skip the comparison when the key is absent — missing keys cannot drift.
    if (typeof currentVal !== 'string' || !currentVal.trim()) continue;
    if (currentVal !== defaultVal) {
      drifts.push(`  ${key}-command: "${currentVal}" ← deviates from default "${defaultVal}"`);
    }
  }
  if (drifts.length === 0) return null;

  const message = [
    '⚠ Session Config drift (*-command keys):',
    ...drifts,
    'Verify the overrides are intentional. See .claude/rules/quality-gates-autofix.md § Session Config Command Injection for the RCE-equivalent trust-model.',
  ].join('\n');

  return { severity: 'warn', message };
}
