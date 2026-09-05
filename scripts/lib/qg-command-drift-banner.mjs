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
 * `loadCommandsFromSessionConfigDetailed` from `./quality-gate.mjs`. Its
 * `commands` half is a partial object (missing keys are absent — no default
 * substitution), which means absent `*-command` keys cannot trigger spurious
 * drift against `PROJECT_DEFAULTS`. Drift is only reported when a value is
 * explicitly set AND differs from the corresponding `PROJECT_DEFAULTS` entry.
 *
 * THREE return states (#1031 follow-up), not two — the same contract
 * `ci-status-banner.mjs` established:
 *   - `null`                       — the config was READ and nothing drifts
 *                                    (including "this repo has no Session
 *                                    Config at all").
 *   - `{severity:'warn', message}` — real drift, one line per deviating key.
 *   - `{severity:'warn', message, degraded}` — the config could NOT be read.
 *     Previously this collapsed onto `null`, i.e. onto "no drift" — an
 *     all-clear derived from a measurement that never happened.
 *
 * Cross-references:
 * - .claude/rules/quality-gates-autofix.md § Session Config Command Injection
 * - scripts/lib/quality-gate.mjs `loadCommandsFromSessionConfigDetailed()`
 *
 * @see #525 (Pattern 4 Auto-Fix-Loop residuals)
 * @see #526 (Pattern 4 banner ecosystem coherence)
 */

import { loadCommandsFromSessionConfigDetailed } from './quality-gate.mjs';

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
 * Build the third return state: the config could not be read.
 *
 * Distinct from `null` on purpose — `null` in the banner contract reads as
 * "checked, all clear", which a failed read has not established.
 *
 * @param {string} reason — a `CONFIG_READ_DEGRADED_REASONS` member.
 * @returns {{severity: 'warn', message: string, degraded: string}}
 */
function degradedBanner(reason) {
  return {
    severity: 'warn',
    message: `\u26a0 Session Config command drift could not be checked (${reason})`,
    degraded: reason,
  };
}

/**
 * Check for *-command drift.
 *
 * Reads Session Config from CLAUDE.md (or AGENTS.md) in `repoRoot` via
 * `loadCommandsFromSessionConfigDetailed` and compares any resolved `lint`,
 * `typecheck`, and `test` values against PROJECT_DEFAULTS. Returns null
 * when no drift is detected, or when the config-read returns no recognised
 * `*-command` keys at all (graceful no-op).
 *
 * Important: missing keys do NOT trigger drift. Only explicit overrides
 * that differ from PROJECT_DEFAULTS produce a banner.
 *
 * A FAILED read (`degraded`) is reported rather than silently treated as
 * "no drift" — see the module header. A repo that simply carries no Session
 * Config is NOT a failed read and stays silent.
 *
 * Marked `async` for backward compatibility with existing callers that
 * `await` the result; internally the helper is synchronous.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — project root (defaults to process.cwd()).
 * @returns {Promise<null | {severity: 'warn', message: string, degraded?: string}>}
 */
export async function checkQgCommandDrift(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();

  let detailed;
  try {
    detailed = loadCommandsFromSessionConfigDetailed(repoRoot);
  } catch {
    // The loader is documented never to throw. If it does anyway, that IS a
    // failed read — say so rather than reporting an all-clear.
    return degradedBanner('parse-error');
  }
  if (!detailed || typeof detailed !== 'object') return degradedBanner('parse-error');
  if (typeof detailed.degraded === 'string' && detailed.degraded) {
    return degradedBanner(detailed.degraded);
  }
  const cfg = detailed.commands;
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
