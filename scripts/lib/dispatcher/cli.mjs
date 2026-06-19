/**
 * cli.mjs — autopilot dispatcher front-door (Epic #673 P3, issue #678).
 *
 * JSON-first orchestration that wires the Wave-2 dispatcher primitives into a
 * single read path and a scriptable atomic-claim path:
 *
 *   enumerateCandidates → freeCandidates → rankCandidates → recommendation
 *
 * This is the front-door for the `dispatcher` skill (coordinator prose lives in
 * `skills/dispatcher/SKILL.md`). The default read path is NON-MUTATING: it scans
 * the confinement root, resolves free/busy per repo, and ranks the free ones.
 * The atomic claim (the only mutating operation) is exposed separately via
 * {@link claimRepo} so it is explicit, scriptable, and Wave-4-testable.
 *
 * Design contract (PRD §2 P3, §4; .claude/rules/cli-design.md):
 *  - JSON-first: every invocation supports `--json` (machine-parseable stdout).
 *  - Data → stdout, diagnostics/warnings → stderr. Never mixed.
 *  - Exit codes: 0 success · 1 user/input error · 2 system error.
 *  - `--dry-run` = explicit non-mutating rank (the default read path is already
 *    non-mutating; the flag documents intent and is reserved for parity with the
 *    skill's read/claim split).
 *  - `runDispatch` / `claimRepo` are testable orchestration fns — all I/O flows
 *    through injectable `deps` so Wave-4 tests are deterministic.
 *  - Importing the module never executes `main` (import.meta.url guard).
 *
 * Plain Node ESM. Named exports. Stdlib + Wave-2 dispatcher modules only.
 */

import { parseArgs } from 'node:util';

import { warn } from '../common.mjs';
import { acquire } from '../session-lock.mjs';
import { enumerateCandidates, freeCandidates } from './enumerate.mjs';
import { rankCandidates } from './rank.mjs';

const VERSION = '1.0.0';

const USAGE = `dispatcher — cross-repo autopilot front-door (Epic #673, issue #678)

Enumerates candidate repos below the confinement root, resolves free/busy from
each repo's session.lock lease, and ranks the FREE ones so you can pick the most
worthwhile to work on next. The read path is non-mutating; the atomic claim is a
separate, explicit step (see the dispatcher skill).

USAGE
  node scripts/lib/dispatcher/cli.mjs [options]

OPTIONS
  --json               Emit the full result as a single JSON object to stdout.
  --dry-run            Explicit non-mutating rank (the default read path is
                       already non-mutating; this documents intent).
  --repo <name>        Filter the human-readable output to a single repoName.
                       (Does not change ranking — informational only.)
  --start-dir <path>   Override the scan root (defaults to the confinement root).
  --help               Print this help and exit 0.
  --version            Print the version and exit 0.

OUTPUT
  Default (human): a readable table of free candidates, the top recommendation,
  and any warnings (warnings to stderr).
  --json: JSON.stringify({ candidates, free, ranked, warnings, recommended }).

EXIT CODES
  0  success
  1  user/input error (e.g. bad --start-dir)
  2  system error (unexpected failure)
`;

/**
 * Run the non-mutating dispatch read path: enumerate → filter free → rank.
 *
 * Wires the three Wave-2 primitives into one serialisable result. The only I/O
 * is performed by the injected `deps` (forwarded verbatim to
 * `enumerateCandidates` and `rankCandidates`), so this fn is deterministic under
 * stubbed deps.
 *
 * @param {object} [opts]
 * @param {string} [opts.startDir] — scan root; defaults to the confinement root.
 * @param {number} [opts.now] — clock seam in ms; forwarded to both stages.
 * @param {object} [opts.deps] — DI seam forwarded to enumerate + rank.
 * @returns {Promise<{
 *   candidates: import('./enumerate.mjs').Candidate[],
 *   free: import('./enumerate.mjs').Candidate[],
 *   ranked: Awaited<ReturnType<typeof rankCandidates>>['ranked'],
 *   warnings: string[],
 *   recommended: (Awaited<ReturnType<typeof rankCandidates>>['ranked'][number]) | null,
 * }>}
 */
export async function runDispatch({ startDir, now, deps } = {}) {
  const candidates = await enumerateCandidates({ startDir, now, deps });
  const free = freeCandidates(candidates);
  const { ranked, warnings } = await rankCandidates(free, { now, deps });
  const recommended = ranked.length > 0 ? ranked[0] : null;
  return { candidates, free, ranked, warnings, recommended };
}

/**
 * Atomic, scriptable repo claim. Thin wrapper over `acquire(...)` from
 * session-lock.mjs — returns its result VERBATIM so callers (the skill prose,
 * Wave-4 tests) can branch on the exact `{ ok, reason, ... }` contract.
 *
 * On `ok:false` (race lost / busy — reasons: active, stale-pid-alive,
 * stale-pid-dead, fs-error, ...) the dispatcher must exclude that repo and
 * re-rank the remaining free candidates. On `ok:true` the claim is held and the
 * coordinator may launch the chosen entry command.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot] — absolute path to the repo to claim.
 * @param {string} [opts.sessionId] — claiming session id.
 * @param {string} [opts.mode] — session mode (drives exclusivity classification).
 * @param {number} [opts.ttlHours] — lease TTL in hours (defaults inside acquire).
 * @param {string} [opts.semanticSessionId] — optional semantic id for the lease.
 * @param {object} [opts.deps] — DI seam: `deps.acquire` overrides the real acquire.
 * @returns {{ ok: true, lock: object } | { ok: false, reason: string }}
 */
export function claimRepo({ repoRoot, sessionId, mode, ttlHours, semanticSessionId, deps } = {}) {
  const acquireFn = (deps && typeof deps.acquire === 'function') ? deps.acquire : acquire;
  return acquireFn({ repoRoot, sessionId, mode, ttlHours, semanticSessionId });
}

/**
 * Render the human-readable (non-JSON) report for a dispatch result.
 * Pure string builder — no I/O. The caller decides stdout vs stderr.
 *
 * @param {Awaited<ReturnType<typeof runDispatch>>} result
 * @param {{ repo?: string }} [opts] — `repo` filters the free table to one name.
 * @returns {string}
 */
function renderHuman(result, { repo } = {}) {
  const { free, ranked, recommended } = result;
  const lines = [];

  lines.push('Dispatcher — free candidate repos');
  lines.push('');

  const shown = repo
    ? ranked.filter((r) => r.candidate?.repoName === repo)
    : ranked;

  if (shown.length === 0) {
    if (repo) {
      lines.push(`(no free candidate named "${repo}")`);
    } else if (free.length === 0) {
      lines.push('(no free candidates — all repos busy)');
    } else {
      lines.push('(no ranked candidates)');
    }
    return lines.join('\n');
  }

  // Compact table: rank · repoName · score · staleDays · ci · priority.
  lines.push('  #  repo                              score   staleD  ci       priority');
  lines.push('  -  --------------------------------  ------  ------  -------  --------');
  shown.forEach((row, i) => {
    const name = (row.candidate?.repoName ?? '<unknown>').padEnd(32).slice(0, 32);
    const score = row.score.toFixed(2).padStart(6);
    const stale = Math.round(row.signals?.staleDays ?? 0).toString().padStart(6);
    const ci = String(row.signals?.readiness?.ciStatus ?? 'n/a').padEnd(7).slice(0, 7);
    const prio = row.signals?.priority
      ? `c${row.signals.priority.criticalCount}/h${row.signals.priority.highCount}`
      : 'n/a';
    lines.push(`  ${String(i + 1).padStart(1)}  ${name}  ${score}  ${stale}  ${ci}  ${prio}`);
  });

  lines.push('');
  if (recommended) {
    lines.push(
      `Recommendation: ${recommended.candidate?.repoName ?? '<unknown>'} ` +
      `(score ${recommended.score.toFixed(2)}) → ${recommended.candidate?.repoRoot ?? ''}`,
    );
  } else {
    lines.push('Recommendation: (none — no free candidates)');
  }

  return lines.join('\n');
}

/**
 * CLI entrypoint. Parses flags, runs the read path, and writes either JSON or a
 * human-readable report. Returns the process exit code (does NOT call exit so it
 * is unit-testable; the import.meta guard below maps the return to process.exit).
 *
 * @param {string[]} argv — process.argv.slice(2).
 * @returns {Promise<number>} exit code (0 success · 1 input error · 2 system error)
 */
export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        json: { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        repo: { type: 'string' },
        'start-dir': { type: 'string' },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    process.stderr.write(`ERROR: ${err.message}\n\n${USAGE}`);
    return 1;
  }

  const { values } = parsed;

  if (values.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  // Validate --start-dir as a user/input concern (exit 1 on bad input).
  let startDir;
  if (values['start-dir'] !== undefined) {
    if (typeof values['start-dir'] !== 'string' || values['start-dir'].length === 0) {
      process.stderr.write('ERROR: --start-dir requires a non-empty path\n');
      return 1;
    }
    startDir = values['start-dir'];
  }

  let result;
  try {
    result = await runDispatch({ startDir });
  } catch (err) {
    // Unexpected failure in the read path = system error (exit 2). The Wave-2
    // primitives are no-throw by contract, so reaching here is exceptional.
    process.stderr.write(`ERROR: dispatch failed: ${err?.message ?? err}\n`);
    return 2;
  }

  // Warnings always go to stderr (diagnostics, never mixed with data on stdout).
  for (const w of result.warnings ?? []) warn(w);

  if (values.json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  }

  process.stdout.write(`${renderHuman(result, { repo: values.repo })}\n`);
  return 0;
}

// Run main only when executed directly, never on import.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`ERROR: ${err?.stack ?? err}\n`);
      process.exit(2);
    });
}
