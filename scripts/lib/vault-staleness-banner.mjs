/**
 * vault-staleness-banner.mjs — #319, record-age gate #1159
 * Reads the latest vault-staleness probe record and classifies a banner
 * severity (warn | alert | info) for surfacing stale projects in the
 * Meta-Vault.
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Max age (in days) of the last probe record before its stale-project
 * findings are demoted from a warn/alert to a 'probe-stale' info result
 * (#1159). The vault-sync bridge runs hourly, but the probe itself only
 * runs per `/discovery` invocation or at session-end — so a week with no
 * new record means the PROBE has stopped running, not that the projects it
 * last saw are still stale today. A 47-day-old record was otherwise
 * re-reported as a current finding on every session start.
 */
export const MAX_RECORD_AGE_DAYS = 7;

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
 * Severity rules (issue #319, record-age gate #1159):
 *   - file absent / unreadable / malformed / stale_count === 0 → null (silent)
 *   - stale_count > 0 AND record.timestamp older than MAX_RECORD_AGE_DAYS
 *     → {severity: 'info', kind: 'probe-stale', ...} (the probe stopped
 *     running; the recorded findings are not a current finding)
 *   - stale_count > 0 AND missing/unparsable timestamp AND maxDelta <= 48
 *     → 'warn' (unchanged pre-#1159 behaviour)
 *   - stale_count > 0 AND missing/unparsable timestamp AND maxDelta  > 48
 *     → 'alert' (cron likely broken; unchanged pre-#1159 behaviour)
 *   - stale_count > 0 AND record.timestamp within MAX_RECORD_AGE_DAYS AND
 *     maxDelta <= 48 → 'warn'
 *   - stale_count > 0 AND record.timestamp within MAX_RECORD_AGE_DAYS AND
 *     maxDelta  > 48 → 'alert' (cron likely broken)
 *
 * @param {{repoRoot: string, now?: number}} opts `now` is an optional clock
 *   seam (epoch ms, defaults to `Date.now()`) so callers can test the
 *   age gate deterministically without global fake timers.
 * @returns {null | {
 *   severity: 'warn'|'alert',
 *   message: string,
 *   staleCount: number,
 *   maxDeltaHours: number,
 *   timestamp: string,
 * } | {
 *   severity: 'info',
 *   kind: 'probe-stale',
 *   message: string,
 *   ageDays: number,
 *   timestamp: string,
 * }}
 */
export function checkVaultStaleness({ repoRoot, now = Date.now() } = {}) {
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

    // Record-age gate (#1159): a parseable timestamp older than
    // MAX_RECORD_AGE_DAYS means the PROBE has not run since, not that the
    // projects it last saw are still stale — demote to an 'info' result
    // instead of re-reporting a warn/alert every session. A missing or
    // unparsable timestamp falls through to today's behaviour unchanged.
    const rawTimestamp = record.timestamp;
    const parsedMs = typeof rawTimestamp === 'string' ? Date.parse(rawTimestamp) : NaN;
    if (Number.isFinite(parsedMs)) {
      const ageDays = Math.floor((now - parsedMs) / MS_PER_DAY);
      if (ageDays > MAX_RECORD_AGE_DAYS) {
        return {
          severity: 'info',
          kind: 'probe-stale',
          message:
            `⚠ vault-staleness: last probe record is ${ageDays} days old ` +
            `(${rawTimestamp}) — the probe has not run since; the recorded ` +
            `${staleCount} stale projects are NOT a current finding.`,
          ageDays,
          timestamp: rawTimestamp,
        };
      }
    }

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
        `(max delta: ${deltaStr}h) — Vault-Sync cron likely broken; ` +
        `verify the cron source and the last-success timestamp.`;
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
