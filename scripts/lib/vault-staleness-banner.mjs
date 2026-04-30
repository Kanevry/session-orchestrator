/**
 * vault-staleness-banner.mjs — #319
 * Reads the latest vault-staleness probe record and classifies a banner
 * severity (warn | alert) for surfacing stale projects in the Meta-Vault.
 *
 * Plain-JS validation — no Zod dependency. Never throws. Never mutates input.
 *
 * Source JSONL schema (one line per probe run):
 *   {timestamp, probe, project_root, vault_dir, scanned_projects,
 *    stale_count, errors, duration_ms,
 *    findings: [{slug, severity, last_sync, delta_hours, flag}, ...]}
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Format a delta_hours number for the banner message.
 * Rounds to 1 decimal; integers render without a trailing ".0".
 *
 * @param {number} hours
 * @returns {string}
 */
function formatDelta(hours) {
  const n = Number(hours);
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 10) / 10;
  // Drop ".0" for whole numbers (e.g. 23.0 -> "23"), keep "140.7"
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * Reads `.orchestrator/metrics/vault-staleness.jsonl` (last record) and
 * computes a banner severity classification. Never throws — graceful no-op
 * on any read error, schema mismatch, or empty/zero-stale state.
 *
 * Severity rules (issue #319):
 *   - file absent / unreadable / malformed / stale_count === 0 → null (silent)
 *   - stale_count > 0 AND maxDelta <= 48 → 'warn'
 *   - stale_count > 0 AND maxDelta  > 48 → 'alert' (cron likely broken)
 *
 * @param {{repoRoot: string}} opts
 * @returns {null | {
 *   severity: 'warn'|'alert',
 *   message: string,
 *   staleCount: number,
 *   maxDeltaHours: number,
 *   timestamp: string,
 * }}
 */
export function checkVaultStaleness({ repoRoot } = {}) {
  try {
    if (!repoRoot || typeof repoRoot !== 'string') return null;

    const jsonlPath = path.join(
      repoRoot,
      '.orchestrator',
      'metrics',
      'vault-staleness.jsonl',
    );

    if (!existsSync(jsonlPath)) return null;

    let raw;
    try {
      raw = readFileSync(jsonlPath, 'utf8');
    } catch {
      return null;
    }

    // Take the last non-empty line.
    const lines = raw.split('\n').filter((l) => l.length > 0);
    if (lines.length === 0) return null;
    const lastLine = lines[lines.length - 1];

    let record;
    try {
      record = JSON.parse(lastLine);
    } catch {
      return null;
    }

    if (!record || typeof record !== 'object') return null;

    const staleCount = record.stale_count;
    if (typeof staleCount !== 'number' || staleCount < 0 || Number.isNaN(staleCount)) {
      return null;
    }

    if (!Array.isArray(record.findings)) return null;

    if (staleCount === 0) return null;

    // Compute max delta_hours across findings; treat undefined/null/NaN as 0.
    let maxDelta = 0;
    for (const finding of record.findings) {
      if (!finding || typeof finding !== 'object') continue;
      const d = Number(finding.delta_hours);
      if (Number.isFinite(d) && d > maxDelta) maxDelta = d;
    }

    const severity = maxDelta > 48 ? 'alert' : 'warn';
    const timestamp = typeof record.timestamp === 'string' ? record.timestamp : 'unknown';
    const deltaStr = formatDelta(maxDelta);

    let message;
    if (severity === 'alert') {
      message =
        `⚠ vault-staleness: ${staleCount} projects stale ` +
        `(max delta: ${deltaStr}h) — Clank-Vault-Sync cron likely broken, ` +
        `see agents/vault#70 fix pattern.`;
    } else {
      message =
        `⚠ vault-staleness: ${staleCount} projects stale ` +
        `(max delta: ${deltaStr}h) — last run ${timestamp}.`;
    }

    return {
      severity,
      message,
      staleCount,
      maxDeltaHours: maxDelta,
      timestamp,
    };
  } catch {
    // Defensive catch-all — banner must never throw.
    return null;
  }
}

/**
 * Convenience renderer: returns the banner message string, or empty string
 * when no banner should be shown. Intended for inline use from SKILL.md
 * snippets (e.g. `node -e "import('./...').then(m => process.stdout.write(m.renderBanner({repoRoot: process.cwd()})))"`).
 *
 * @param {{repoRoot: string}} opts
 * @returns {string}
 */
export function renderBanner({ repoRoot } = {}) {
  const result = checkVaultStaleness({ repoRoot });
  return result ? result.message : '';
}
