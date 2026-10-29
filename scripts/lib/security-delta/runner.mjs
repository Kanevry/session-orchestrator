/**
 * runner.mjs — runs the stage-1 Security-Delta checks under one budget (#1769).
 *
 * The six checks (lockfile, runtime-floor, floating-tag, gitleaks, age-gate,
 * package-floor) run CONCURRENTLY. Each is raced against the total budget: a
 * check that has not settled by `start + budget.totalMs` is reported as
 * `degraded`/`budget` and the run moves on without it — a slow registry or a
 * hung binary must never hold the close. The late promise is abandoned, not
 * cancelled (the checks own their own timeouts; gitleaks is handed the
 * remaining budget as its kill ceiling).
 *
 * The network checks additionally get `deadlineAt = start + budget.networkMs`,
 * after which they start no new request.
 */
import { runAgeGateCheck } from './age-gate.mjs';
import { BUDGET, MODES, deriveStatus, deriveVerdict, makeCheckResult, summarize } from './contract.mjs';
import { runFloatingTagCheck } from './floating-tags.mjs';
import { runGitleaksCheck } from './gitleaks.mjs';
import { runLockfileCheck } from './osv.mjs';
import { runPackageFloorCheck } from './package-floor.mjs';
import { runRuntimeFloorCheck } from './runtime-floor.mjs';

/**
 * @typedef {object} CheckContext
 * @property {string} repoRoot
 * @property {string|null} base
 * @property {string} head
 * @property {number} deadlineAt   epoch ms; network checks start no request after it
 * @property {number} timeoutMs    remaining total budget at start, in ms
 */

/**
 * @typedef {object} CheckSpec
 * @property {string} id                                   one of CHECK_IDS
 * @property {boolean} network                             counts towards `ms.network`
 * @property {(ctx: CheckContext) => Promise<object>} run  returns one CheckResult, never throws
 */

/**
 * The six checks, in CHECK_IDS order: the five stage-1 checks plus the offline
 * `package-floor` register check (#1769 stage 3). @type {ReadonlyArray<CheckSpec>}
 */
export const DEFAULT_CHECKS = Object.freeze([
  { id: 'lockfile', network: true, run: ({ repoRoot, base, head, deadlineAt }) => runLockfileCheck({ repoRoot, base, head, deadlineAt }) },
  {
    id: 'runtime-floor',
    network: true,
    run: ({ repoRoot, base, head, deadlineAt }) => runRuntimeFloorCheck({ repoRoot, base, head, deadlineAt }),
  },
  { id: 'floating-tag', network: false, run: ({ repoRoot, base, head }) => runFloatingTagCheck({ repoRoot, base, head }) },
  {
    id: 'gitleaks',
    network: false,
    run: ({ repoRoot, base, head, timeoutMs }) => runGitleaksCheck({ repoRoot, base, head, timeoutMs }),
  },
  { id: 'age-gate', network: false, run: ({ repoRoot, base, head }) => runAgeGateCheck({ repoRoot, base, head }) },
  { id: 'package-floor', network: false, run: ({ repoRoot, base, head }) => runPackageFloorCheck({ repoRoot, base, head }) },
]);

const LATE = Symbol('late');

/**
 * Race one check against the shared total deadline.
 * @param {CheckSpec} spec
 * @param {CheckContext} ctx
 * @param {number} totalDeadline  epoch ms
 * @param {() => number} now
 * @param {number} start
 * @returns {Promise<object>} CheckResult
 */
async function runOne(spec, ctx, totalDeadline, now, start) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(LATE), Math.max(0, totalDeadline - now()));
    timer.unref?.();
  });
  let outcome;
  try {
    // Promise.resolve().then(): a synchronous throw inside `run` becomes a rejection.
    outcome = await Promise.race([Promise.resolve().then(() => spec.run(ctx)), late]);
  } catch {
    outcome = null;
  } finally {
    clearTimeout(timer);
  }
  const ms = Math.max(0, now() - start);
  if (outcome === LATE) return makeCheckResult({ id: spec.id, status: 'degraded', reason: 'budget', unchecked: 1, ms });
  if (!outcome || typeof outcome !== 'object') {
    return makeCheckResult({ id: spec.id, status: 'degraded', reason: 'internal-error', unchecked: 1, ms });
  }
  return outcome;
}

/**
 * Run the Security-Delta over `base..head`.
 *
 * mode `off` runs nothing and touches no network. A missing `base` is passed
 * through: every check reports `skipped`/`no-range` by itself.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string|null} [opts.base]
 * @param {string} [opts.head]
 * @param {string} [opts.mode]                 one of MODES (default `off`)
 * @param {ReadonlyArray<CheckSpec>} [opts.checks]  injectable for tests
 * @param {() => number} [opts.now]
 * @param {{totalMs:number, networkMs:number}} [opts.budget]
 * @returns {Promise<{schema:1, mode:string, range:string, status:string, verdict:string, checks:object[], totals:ReturnType<typeof summarize>, ms:{total:number, network:number}}>}
 */
export async function runSecurityDelta({
  repoRoot,
  base,
  head,
  mode = 'off',
  checks = DEFAULT_CHECKS,
  now = Date.now,
  budget = BUDGET,
} = {}) {
  if (!MODES.includes(mode)) throw new TypeError(`security-delta: mode must be one of ${MODES.join('|')}, got ${JSON.stringify(mode)}`);
  const range = `${base ?? ''}..${head ?? ''}`;
  const start = now();

  /** @type {object[]} */
  let results = [];
  if (mode !== 'off') {
    const ctx = {
      repoRoot,
      base: base || null,
      head,
      deadlineAt: start + budget.networkMs,
      timeoutMs: budget.totalMs,
    };
    const totalDeadline = start + budget.totalMs;
    const settled = await Promise.allSettled(checks.map((spec) => runOne(spec, ctx, totalDeadline, now, start)));
    results = settled.map((s, i) =>
      s.status === 'fulfilled'
        ? s.value
        : makeCheckResult({ id: checks[i].id, status: 'degraded', reason: 'internal-error', unchecked: 1, ms: Math.max(0, now() - start) }),
    );
  }

  // Ceiling: `ms.network` is the slowest network check's own wall time, not the
  // time spent inside HTTP requests — it over-counts local git/parse work in
  // those checks. Revisit if the network sub-budget needs exact accounting.
  const networkIds = new Set(checks.filter((c) => c.network).map((c) => c.id));
  const network = results.filter((r) => networkIds.has(r.id)).reduce((max, r) => Math.max(max, r.ms), 0);

  return {
    schema: 1,
    mode,
    range,
    status: mode === 'off' ? 'skipped' : deriveStatus(results),
    verdict: deriveVerdict(mode, results),
    checks: results,
    totals: summarize(results),
    ms: { total: Math.max(0, now() - start), network },
  };
}
