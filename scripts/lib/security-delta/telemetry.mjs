/**
 * telemetry.mjs — the `orchestrator.security.delta` event (#1769, stage 1).
 *
 * The payload carries COUNTS ONLY. `events.jsonl` may be POSTed to a webhook,
 * so no package name, version, file path, advisory id, fingerprint or check
 * `reason` ever enters it — reasons are short machine words today, but they
 * are free-form strings in the contract, so they stay out by construction.
 */
import { emitEvent } from '../events.mjs';
import { SECURITY_DELTA_EVENT } from './contract.mjs';

const count = (n) => (Number.isInteger(n) && n >= 0 ? n : 0);

/**
 * Copy a `{ key: count }` map, keeping only integer counts.
 * The keys come from the closed SEVERITY / FINDING_CLASS enums in contract.mjs.
 * @param {Record<string, number>|undefined} map
 * @returns {Record<string, number>}
 */
function countMap(map) {
  return Object.fromEntries(Object.entries(map ?? {}).map(([k, v]) => [k, count(v)]));
}

/**
 * Build the counts-only telemetry payload from a runner Result.
 *
 * @param {Awaited<ReturnType<typeof import('./runner.mjs').runSecurityDelta>>} result
 * @returns {object}
 */
export function buildDeltaEventPayload(result) {
  const checks = {};
  for (const c of result.checks ?? []) {
    checks[c.id] = {
      status: c.status,
      checked: count(c.checked),
      unchecked: count(c.unchecked),
      findings: Array.isArray(c.findings) ? c.findings.length : 0,
      ms: Math.round(Number(c.ms) || 0),
    };
  }
  const totals = result.totals ?? {};
  return {
    mode: result.mode,
    status: result.status,
    verdict: result.verdict,
    checks,
    findings_total: count(totals.findings),
    introduced_total: count(totals.introduced),
    blocking_total: count(totals.blocking),
    by_class: countMap(totals.byClass),
    by_severity: countMap(totals.bySeverity),
    ms_total: Math.round(Number(result.ms?.total) || 0),
    ms_network: Math.round(Number(result.ms?.network) || 0),
    budget_exceeded: (result.checks ?? []).some((c) => c.status === 'degraded' && c.reason === 'budget'),
  };
}

/**
 * Append the event to `<repoRoot>/.orchestrator/metrics/events.jsonl`.
 * Never throws: telemetry must not fail the run; a failure is one stderr WARN.
 *
 * @param {object} result  runner Result
 * @param {{repoRoot: string}} opts
 * @returns {Promise<boolean>} true when the emit returned without error
 */
export async function emitDeltaEvent(result, { repoRoot } = {}) {
  try {
    await emitEvent(SECURITY_DELTA_EVENT, buildDeltaEventPayload(result), { repoRoot });
    return true;
  } catch (err) {
    process.stderr.write(`security-delta: WARN: event emission failed: ${err instanceof Error ? err.message : String(err)}\n`);
    return false;
  }
}
