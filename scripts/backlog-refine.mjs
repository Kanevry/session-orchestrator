#!/usr/bin/env node
/**
 * backlog-refine.mjs — read-only backlog checker (#2094).
 *
 * Contract: docs/backlog-refinement.md § CLI. Reads open and recently closed
 * issues, evaluates them, prints a report. Never writes to the tracker.
 *
 * Exit codes:
 *   0  report produced (with or without findings)
 *   1  usage error (bad flag, bad number, unresolvable or GitHub target)
 *   2  tracker unreadable — no report is printed
 */

import { writeFileSync } from 'node:fs';

import { isMainModule } from './lib/is-main-module.mjs';
import { emitEvent } from './lib/events.mjs';
import { fetchBacklog, fetchRelatedMrs, resolveTarget, targetDirectory } from './lib/backlog-refine/fetch.mjs';
import { readConfiguredVcs } from './lib/vcs-repo-spec.mjs';
import { BACKLOG_REFINE_EVENT } from './lib/backlog-refine/event.mjs';

const EVENT_TYPE = BACKLOG_REFINE_EVENT;

const USAGE = `backlog-refine — read-only backlog checker (GitLab)

USAGE
  node scripts/backlog-refine.mjs [--repo <path|group/name>] [--host <host>]
       [--closed-days 30] [--max-mr-lookups 50] [--json | --markdown] [--out <file>] [--no-event]

FLAGS
  --repo <path|group/name>  Checkout directory or GitLab project path (default: current checkout).
  --host <host>             GitLab host for a group/name target (default: host of the current checkout).
  --closed-days <n>         Window for recently closed issues, positive integer (default 30).
  --max-mr-lookups <n>      Max related-MR lookups for status:review issues (default 50).
  --json                    Print the report object as JSON.
  --markdown                Print the report as Markdown (default).
  --out <file>              Write the output to <file> instead of stdout.
  --no-event                Do not emit ${EVENT_TYPE}.
  -h, --help                Show this help and exit.

EXIT CODES
  0  report produced   1  usage error   2  tracker unreadable (no report)
`;

/**
 * Parse argv. Returns `{ error }` on a usage error.
 *
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const opts = {
    repo: null,
    host: null,
    closedDays: 30,
    maxMrLookups: 50,
    format: null,
    out: null,
    event: true,
    help: false,
  };
  const value = (i, flag) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { error: `${flag} requires a value` };
    return { v };
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-h':
      case '--help':
        opts.help = true;
        break;
      case '--json':
      case '--markdown': {
        const f = arg.slice(2);
        if (opts.format !== null && opts.format !== f) return { error: '--json and --markdown are mutually exclusive' };
        opts.format = f;
        break;
      }
      case '--no-event':
        opts.event = false;
        break;
      case '--repo':
      case '--host':
      case '--out': {
        const r = value(i, arg);
        if (r.error) return r;
        opts[arg.slice(2)] = r.v;
        i++;
        break;
      }
      case '--closed-days':
      case '--max-mr-lookups': {
        const r = value(i, arg);
        if (r.error) return r;
        const n = /^\d+$/.test(r.v) ? Number(r.v) : NaN;
        const min = arg === '--closed-days' ? 1 : 0;
        if (!Number.isSafeInteger(n) || n < min) {
          return { error: `${arg} must be a ${min === 1 ? 'positive' : 'non-negative'} integer, got "${r.v}"` };
        }
        if (arg === '--closed-days') opts.closedDays = n;
        else opts.maxMrLookups = n;
        i++;
        break;
      }
      default:
        return { error: `unknown argument: ${arg}` };
    }
  }
  return { opts };
}

/** Lazy load so `--help` works and tests can inject the pure modules. */
async function loadPure() {
  const [criteria, report] = await Promise.all([
    import('./lib/backlog-refine/criteria.mjs'),
    import('./lib/backlog-refine/report.mjs'),
  ]);
  return {
    selectMrLookups: criteria.selectMrLookups,
    evaluateBacklog: criteria.evaluateBacklog,
    buildReport: report.buildReport,
    renderMarkdown: report.renderMarkdown,
  };
}

/**
 * CLI entry. All I/O is injectable for tests.
 *
 * @param {string[]} argv
 * @param {{
 *   cwd?: string, now?: () => Date,
 *   stdout?: { write: (s: string) => unknown }, stderr?: { write: (s: string) => unknown },
 *   resolveTarget?: typeof resolveTarget, fetchBacklog?: typeof fetchBacklog,
 *   fetchRelatedMrs?: typeof fetchRelatedMrs, emit?: (type: string, payload: object) => Promise<void>,
 *   writeFile?: (file: string, data: string) => void,
 *   selectMrLookups?: Function, evaluateBacklog?: Function, buildReport?: Function, renderMarkdown?: Function,
 * }} [deps]
 * @returns {Promise<{ exitCode: number }>}
 */
export async function main(argv, deps = {}) {
  const {
    cwd = process.cwd(),
    now = () => new Date(),
    stdout = process.stdout,
    stderr = process.stderr,
    emit = emitEvent,
    writeFile = (file, data) => writeFileSync(file, data, 'utf8'),
  } = deps;
  const resolve = deps.resolveTarget ?? resolveTarget;
  const fetchIssues = deps.fetchBacklog ?? fetchBacklog;
  const fetchMrs = deps.fetchRelatedMrs ?? fetchRelatedMrs;
  const fail = (code, msg) => {
    stderr.write(`backlog-refine: ${msg}\n`);
    return { exitCode: code };
  };

  const parsed = parseArgs(Array.isArray(argv) ? argv : []);
  if (parsed.error) return fail(1, `${parsed.error}\nRun with --help for usage.`);
  const { opts } = parsed;
  if (opts.help) {
    stdout.write(USAGE);
    return { exitCode: 0 };
  }

  // The checkout's own `vcs:` decides between remotes of both families — the
  // same input the maintenance-due probe uses, so the two never disagree.
  const readVcs = deps.readConfiguredVcs ?? readConfiguredVcs;
  const preferVcs = await readVcs(targetDirectory({ repo: opts.repo, cwd }));
  const target = resolve({ repo: opts.repo, host: opts.host, cwd, preferVcs });
  if (!target.ok) return fail(1, `cannot resolve target: ${target.reason}`);

  const pure = deps.evaluateBacklog && deps.buildReport && deps.renderMarkdown && deps.selectMrLookups
    ? deps
    : { ...(await loadPure()), ...stripUndefined(deps) };

  const at = now();
  const backlog = fetchIssues({ target, closedDays: opts.closedDays, now: at });
  if (!backlog.ok) return fail(2, `tracker unreadable: ${backlog.reason}`);

  const lookups = pure.selectMrLookups({ open: backlog.open, max: opts.maxMrLookups });
  const relatedMrs = lookups.iids.length > 0 ? fetchMrs({ target, iids: lookups.iids }) : new Map();
  const evaluation = pure.evaluateBacklog({
    open: backlog.open,
    closed: backlog.closed,
    relatedMrs,
    mrLookupCapped: lookups.capped,
    now: at,
    closedDays: opts.closedDays,
  });
  const report = pure.buildReport({ target, evaluation, measuredAt: at.toISOString(), closedDays: opts.closedDays });
  const output = opts.format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : pure.renderMarkdown(report);

  if (opts.out) {
    try {
      writeFile(opts.out, output);
    } catch (err) {
      return fail(2, `cannot write ${opts.out}: ${err?.code ?? err?.message ?? 'error'}`);
    }
    stderr.write(`backlog-refine: wrote ${opts.out}\n`);
  } else {
    stdout.write(output);
  }

  if (opts.event && isCurrentCheckout(opts, target, resolve, cwd, await readVcs(cwd))) {
    const findings = Array.isArray(evaluation?.findings) ? evaluation.findings : [];
    try {
      await emit(EVENT_TYPE, {
        open: backlog.open.length,
        findings_warn: findings.filter((f) => f?.severity === 'warn').length,
        findings_info: findings.filter((f) => f?.severity === 'info').length,
      });
    } catch (err) {
      stderr.write(`backlog-refine: event not emitted: ${err?.message ?? err}\n`);
    }
  }
  return { exitCode: 0 };
}

/** @param {object} o */
function stripUndefined(o) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/**
 * True when the target is the project of the checkout at `cwd`.
 */
function isCurrentCheckout(opts, target, resolve, cwd, preferVcs) {
  if (opts.repo === null && opts.host === null) return true;
  const here = resolve({ cwd, preferVcs });
  return (
    here.ok === true &&
    here.host.toLowerCase() === target.host.toLowerCase() &&
    here.projectPath.toLowerCase() === target.projectPath.toLowerCase()
  );
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2))
    // exitCode, not exit(): stdout on a macOS pipe is async and would be cut off.
    .then((r) => {
      process.exitCode = r.exitCode;
    })
    .catch((err) => {
      process.stderr.write(`backlog-refine: unexpected error: ${err?.stack ?? err}\n`);
      process.exitCode = 2;
    });
}
