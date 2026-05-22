/**
 * qg-command-drift-banner.mjs — session-start banner probe for *-command drift detection.
 *
 * Detects when CLAUDE.md Session Config `lint-command` / `typecheck-command` /
 * `test-command` values deviate from project defaults. Returns a single banner
 * string (or null for silent no-op).
 *
 * Used by session-start Phase 4 alongside other freshness/drift probes.
 *
 * Cross-references:
 * - .claude/rules/quality-gates-autofix.md § Session Config Command Injection
 * - scripts/lib/quality-gate.mjs `loadCommandsFromSessionConfig()` (non-exported)
 *
 * @see #525 (Pattern 4 Auto-Fix-Loop residuals)
 */

import { readConfigFile, parseSessionConfig } from './config.mjs';

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
 * Reads Session Config from CLAUDE.md (or AGENTS.md) in `repoRoot` and
 * compares the resolved `lint-command`, `typecheck-command`, and `test-command`
 * values against PROJECT_DEFAULTS. Returns null when no drift or when config
 * load fails (graceful no-op).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — project root (defaults to process.cwd()).
 * @returns {Promise<string|null>} — banner string when drift detected, null when no drift.
 */
export async function checkQgCommandDrift(opts = {}) {
  const repoRoot = opts.repoRoot ?? process.cwd();

  let cfg;
  try {
    const mdContent = await readConfigFile(repoRoot);
    cfg = parseSessionConfig(mdContent);
  } catch {
    return null; // graceful no-op on config load failure
  }
  if (!cfg || typeof cfg !== 'object') return null;

  const current = {
    lint: cfg['lint-command'],
    typecheck: cfg['typecheck-command'],
    test: cfg['test-command'],
  };

  const drifts = [];
  for (const [key, defaultVal] of Object.entries(PROJECT_DEFAULTS)) {
    const currentVal = current[key];
    if (typeof currentVal === 'string' && currentVal.trim() && currentVal !== defaultVal) {
      drifts.push(`  ${key}-command: "${currentVal}" ← deviates from default "${defaultVal}"`);
    }
  }
  if (drifts.length === 0) return null;

  return [
    '⚠ Session Config drift (*-command keys):',
    ...drifts,
    'Verify the overrides are intentional. See .claude/rules/quality-gates-autofix.md § Session Config Command Injection for the RCE-equivalent trust-model.',
  ].join('\n');
}
