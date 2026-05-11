// scripts/autopilot-multi.mjs
//
// `autopilot --multi-story` CLI entrypoint. Orchestrates N parallel issue
// pipelines using worktree isolation. v1 thin-slice: apply mode runtime loop
// wired in by W3 P5-Orchestration-Glue agent.
//
// References:
//   - docs/prd/2026-05-07-autopilot-phase-d.md (PRD, status: shaped)
//   - scripts/lib/autopilot/dep-graph.mjs (NEW, parallel-built by C2 agent)
//   - scripts/lib/autopilot/worktree-pipeline.mjs (NEW, parallel-built by C3 agent)
//   - scripts/lib/autopilot/multi-killswitch.mjs (NEW, parallel-built by C4 agent)
//
// CLI guard at bottom — top-level main() never runs on import (deep-2 #368).

import { parseArgs } from 'node:util';
import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

const execFile = promisify(execFileCb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HELP_TEXT = `autopilot-multi — Phase D --multi-story orchestrator (v3.6 scaffold)

USAGE:
  autopilot-multi [OPTIONS]

OPTIONS:
  --max-stories <N>           Max parallel story loops (1..10, default: 3)
  --max-hours <H>             Wall-clock budget in hours (0.5..24, default: 8)
  --inactivity-timeout <S>    Seconds without completion → stop (60..3600, default: 300)
  --draft-mr <policy>         off | on-loop-start | on-green  (default: off)
  --stall-seconds <S>         Per-loop STALL_TIMEOUT threshold (60..3600, default: 600)
  --dry-run                   Emit plan only, do not execute (default: true)
  --apply                     Execute the plan (mutex with --dry-run)
  --json                      Machine-readable output to stdout
  --verbose                   Diagnostic output to stderr
  -h, --help                  Show this help and exit
  --version                   Print version and exit

EXIT CODES:
  0  Success
  1  User error (bad flags)
  2  System error (libs/binaries/probe failed)
`;

const FLAGS = {
  'max-stories':        { type: 'string',  default: '3'   },
  'max-hours':          { type: 'string',  default: '8'   },
  'inactivity-timeout': { type: 'string',  default: '300' },
  'draft-mr':           { type: 'string',  default: 'off' },
  'stall-seconds':      { type: 'string',  default: '600' },
  'dry-run':            { type: 'boolean', default: true  },
  'apply':              { type: 'boolean', default: false },
  'json':               { type: 'boolean', default: false },
  'verbose':            { type: 'boolean', default: false },
  'help':               { type: 'boolean', default: false, short: 'h' },
  'version':            { type: 'boolean', default: false },
};

const VALID_DRAFT_MR_POLICIES = new Set(['off', 'on-loop-start', 'on-green']);

// ---------------------------------------------------------------------------
// parseFlags — parses + validates argv, returns typed flags object
// ---------------------------------------------------------------------------

/**
 * Parse and validate CLI flags.
 *
 * @param {string[]} argv
 * @returns {{
 *   maxStories: number,
 *   maxHours: number,
 *   inactivityTimeoutMs: number,
 *   draftMrPolicy: string,
 *   stallTimeoutSeconds: number,
 *   dryRun: boolean,
 *   apply: boolean,
 *   json: boolean,
 *   verbose: boolean,
 *   help: boolean,
 *   version: boolean,
 * }}
 */
export function parseFlags(argv) {
  const { values } = parseArgs({ args: argv, options: FLAGS, allowPositionals: false });

  // Mutex: --dry-run and --apply cannot both be explicitly set to true.
  // Since --dry-run defaults to true, treat apply=true + the user explicitly
  // also passing --dry-run as a mutex violation.
  if (values['apply'] && values['dry-run'] && argv.includes('--dry-run')) {
    throw new UserError('--dry-run and --apply are mutually exclusive; pick one.');
  }

  // Resolve safe default: if neither --apply nor explicit --dry-run, dry-run wins.
  const apply = /** @type {boolean} */ (values['apply']);
  // When apply is true and --dry-run was not explicitly passed, disable dry-run.
  const dryRun = apply ? false : /** @type {boolean} */ (values['dry-run']);

  // max-stories: int, clamp [1, 10]
  const rawMaxStories = parseInt(/** @type {string} */ (values['max-stories']), 10);
  if (isNaN(rawMaxStories)) {
    throw new UserError(`--max-stories must be an integer, got: ${values['max-stories']}`);
  }
  const maxStories = Math.max(1, Math.min(10, rawMaxStories));

  // max-hours: float, clamp [0.5, 24]
  const rawMaxHours = parseFloat(/** @type {string} */ (values['max-hours']));
  if (isNaN(rawMaxHours)) {
    throw new UserError(`--max-hours must be a number, got: ${values['max-hours']}`);
  }
  const maxHours = Math.max(0.5, Math.min(24, rawMaxHours));

  // inactivity-timeout: int seconds, clamp [60, 3600]
  const rawInactivity = parseInt(/** @type {string} */ (values['inactivity-timeout']), 10);
  if (isNaN(rawInactivity)) {
    throw new UserError(`--inactivity-timeout must be an integer, got: ${values['inactivity-timeout']}`);
  }
  const inactivityTimeoutMs = Math.max(60, Math.min(3600, rawInactivity)) * 1000;

  // draft-mr: validate against allowed set
  const draftMrPolicy = /** @type {string} */ (values['draft-mr']);
  if (!VALID_DRAFT_MR_POLICIES.has(draftMrPolicy)) {
    throw new UserError(
      `--draft-mr must be one of: off, on-loop-start, on-green. Got: "${draftMrPolicy}"`
    );
  }

  // stall-seconds: int, clamp [60, 3600]
  const rawStall = parseInt(/** @type {string} */ (values['stall-seconds']), 10);
  if (isNaN(rawStall)) {
    throw new UserError(`--stall-seconds must be an integer, got: ${values['stall-seconds']}`);
  }
  const stallTimeoutSeconds = Math.max(60, Math.min(3600, rawStall));

  return {
    maxStories,
    maxHours,
    inactivityTimeoutMs,
    draftMrPolicy,
    stallTimeoutSeconds,
    dryRun,
    apply,
    json:    /** @type {boolean} */ (values['json']),
    verbose: /** @type {boolean} */ (values['verbose']),
    help:    /** @type {boolean} */ (values['help']),
    version: /** @type {boolean} */ (values['version']),
  };
}

// ---------------------------------------------------------------------------
// buildOrchestratorState — compose plan snapshot from flags + probe + issues
// ---------------------------------------------------------------------------

/**
 * Build a serialisable orchestrator state / plan object.
 *
 * @param {{
 *   maxStories: number,
 *   maxHours: number,
 *   inactivityTimeoutMs: number,
 *   draftMrPolicy: string,
 *   stallTimeoutSeconds: number,
 *   dryRun: boolean,
 *   apply: boolean,
 *   json: boolean,
 *   verbose: boolean,
 * }} flags
 * @param {object|null} snapshot   Resource-probe snapshot (null in dry-run without probe)
 * @param {Array<{iid: number, title: string, blocks: number[], blockedBy: number[], labels: string[]}>} issues
 * @param {string} [parentRunId]   Unique run-id for this orchestrator session
 * @returns {{
 *   concurrencyCap: number,
 *   totalIssues: number,
 *   readyIssues: number,
 *   executionPlan: Array<{iid: number, title: string}>,
 *   flags: object,
 *   issues: Array<{iid: number, title: string, blocks: number[], blockedBy: number[], labels: string[]}>,
 *   parentRunId: string,
 * }}
 */
export function buildOrchestratorState(flags, snapshot, issues, parentRunId = '') {
  // If a snapshot is available and has a cap, use it; otherwise fall back to maxStories.
  const snapshotCap = snapshot && typeof snapshot.cpuCores === 'number'
    ? snapshot.cpuCores
    : flags.maxStories;
  const concurrencyCap = Math.min(flags.maxStories, snapshotCap);

  const executionPlan = issues
    .slice(0, concurrencyCap)
    .map(({ iid, title }) => ({ iid, title }));

  return {
    concurrencyCap,
    totalIssues: issues.length,
    readyIssues: issues.length,
    executionPlan,
    issues,
    parentRunId,
    flags: {
      maxStories:           flags.maxStories,
      maxHours:             flags.maxHours,
      inactivityTimeoutMs:  flags.inactivityTimeoutMs,
      draftMrPolicy:        flags.draftMrPolicy,
      stallTimeoutSeconds:  flags.stallTimeoutSeconds,
      dryRun:               flags.dryRun,
      apply:                flags.apply,
    },
  };
}

// ---------------------------------------------------------------------------
// Apply-mode helpers
// ---------------------------------------------------------------------------

/**
 * Extract issue relation refs (blocks / blocked_by) from a raw glab issue
 * object. The glab issue list JSON does not embed these fields by default —
 * they are left as [] for v1.
 *
 * @param {object} _issue  Raw glab issue object
 * @param {string} _field  Relation field name ('blocks' | 'blocked_by')
 * @returns {number[]}
 */
// TODO Phase D.2: query relations via glab api (e.g. glab api
//   projects/:id/issues/:iid/links) to populate blocks/blocked_by.
function extractRefs(_issue, _field) {
  return [];
}

/**
 * Fetch the ready-backlog from GitLab via `glab issue list`.
 * Uses execFile (shell: false) per SEC-014 / cli-design rules.
 *
 * @param {Function} execFileFn  Promisified execFile
 * @returns {Promise<Array<{iid: number, title: string, blocks: number[], blockedBy: number[], labels: string[]}>>}
 */
async function fetchReadyBacklog(execFileFn) {
  const { stdout } = await execFileFn(
    'glab',
    ['issue', 'list', '--label', 'status:ready', '--per-page', '50', '--output', 'json'],
    { shell: false, timeout: 30_000 },
  );
  const issues = JSON.parse(stdout);
  return issues.map((i) => ({
    iid:       i.iid ?? i.id,
    title:     i.title ?? '',
    blocks:    extractRefs(i, 'blocks'),      // best-effort; default to []
    blockedBy: extractRefs(i, 'blocked_by'),  // best-effort; default to []
    labels:    i.labels?.map((l) => l.name ?? l) ?? [],
  }));
}

/**
 * Summarise a completed apply run into a canonical result envelope.
 *
 * @param {import('./lib/autopilot/multi-killswitch.mjs').LoopRegistration[]} allLoops
 * @param {string} reason
 * @param {number} startMs
 * @param {{ kill: string, detail: string }|null} [killDetail]
 * @returns {{ success: boolean, data: object }}
 */
function finalize(allLoops, reason, startMs, killDetail = null) {
  const terminalReasons = new Set([
    'first-kill-switch',
    'spiral',
    'cohort-abort',
    'spawn-error',
    STALE_SUBAGENT_MIN,
  ]);
  return {
    success: !terminalReasons.has(reason),
    data: {
      reason,
      loopCount:   allLoops.length,
      completed:   allLoops.filter((l) => l.status === 'complete').length,
      failed:      allLoops.filter((l) => l.status === 'failed').length,
      elapsedMs:   Date.now() - startMs,
      killDetail:  killDetail ?? null,
    },
  };
}

/** Sentinel import — resolved lazily in runApplyLoop. Kept at module scope to
 *  allow finalize() to reference STALE_SUBAGENT_MIN without a forward-ref issue. */
let STALE_SUBAGENT_MIN = 'stale-subagent-min';

/**
 * Core apply-mode orchestration loop.
 *
 * Iteratively spawns up to N concurrent worktree-pipelines, polls completions,
 * evaluates cross-loop kill-switches, and returns a canonical result envelope
 * when work is exhausted or a stop condition fires.
 *
 * @param {{ issues: Array<object>, parentRunId: string, flags: object }} state
 * @param {{ depGraph: object, wtPipeline: object, mkLib: object, probe: object }} libs
 * @param {object} [opts]
 * @returns {Promise<{ success: boolean, data: object }>}
 */
async function runApplyLoop(state, libs, _opts) {
  const { depGraph, wtPipeline, mkLib, probe } = libs;
  const { flags } = state;

  // Patch module-level sentinel with the actual export from the loaded lib.
  STALE_SUBAGENT_MIN = mkLib.STALE_SUBAGENT_MIN ?? 'stale-subagent-min';

  const startMs     = Date.now();
  const maxMs       = flags.maxHours * 3600 * 1000;

  // Early exit when there is nothing to process.
  if (!state.issues || state.issues.length === 0) {
    return finalize([], 'backlog-empty', startMs);
  }

  // Build graph and tracking state.
  const graph      = depGraph.buildGraph(state.issues);
  /** @type {Map<string, { promise: Promise<object>, registration: object }>} */
  const inFlight   = new Map();    // loopId → { promise, registration }
  /** @type {Set<number>} */
  const completed  = new Set();
  /** @type {object[]} */
  const allLoops   = [];           // LoopRegistration[]
  let lastCompletionAt = startMs;

  // TODO Phase D.2: implement real cross-loop dependency commit-waiting.
  //   Currently all issues are treated as independent (blocks/blockedBy are []
  //   for v1). When commit-based deps land, nextReady() will need to check
  //   whether the blocker's commit is present on the target branch before
  //   yielding the blocked issue.

  while (true) {
    // 1. Stop condition check.
    const activeLoopRegs = Array.from(inFlight.values()).map((v) => v.registration);
    const readyBacklog   = depGraph.nextReady(graph, new Set(inFlight.keys().map((id) => {
      const reg = inFlight.get(id)?.registration;
      return reg?.issueIid;
    }).filter((x) => x !== null && x !== undefined)), completed);

    const orchState = {
      activeLoops:      activeLoopRegs,
      readyBacklog,
      lastCompletionAt,
    };

    const stopDecision = mkLib.shouldStopOrchestrator(orchState, {
      inactivityTimeoutMs: flags.inactivityTimeoutMs,
    });
    if (stopDecision.stop) {
      return finalize(allLoops, stopDecision.reason, startMs);
    }

    if (Date.now() - startMs > maxMs) {
      return finalize(allLoops, 'max-hours', startMs);
    }

    // 2. Per-iteration resource probe + cohort kill-switch check.
    let snapshot = null;
    try {
      snapshot = await probe.probe();
    } catch {
      // Resource probe failure is non-fatal — continue with maxStories cap.
    }

    const recommendedCap  = snapshot ? mkLib.calculateConcurrencyCap(snapshot) : flags.maxStories;
    const effectiveCap    = Math.min(flags.maxStories, recommendedCap);

    const crossKill = mkLib.evaluateMultiKillSwitches(allLoops, {
      staleSubagentMinSeconds: flags.stallTimeoutSeconds,
    });
    if (crossKill !== null) {
      return finalize(allLoops, crossKill.kill, startMs, crossKill);
    }

    // 3. Spawn loops up to cap.
    const spawnableBacklog = [...readyBacklog];
    while (inFlight.size < effectiveCap && spawnableBacklog.length > 0) {
      const issue      = spawnableBacklog.shift();
      const loopId     = `loop-${issue.iid}-${Date.now()}`;
      /** @type {object} */
      const registration = {
        loopId,
        pid:                 process.pid, // best-effort; loops are in-process for v1
        parentRunId:         state.parentRunId,
        issueIid:            issue.iid,
        status:              'running',
        killSwitch:          null,
        spiralRecoveryCount: 0,
        startedAt:           Date.now(),
        lastActivityAt:      Date.now(),
      };
      allLoops.push(registration);

      const promise = wtPipeline.runStoryPipeline({
        issueIid:       issue.iid,
        issueTitle:     issue.title,
        branchName:     `issue-${issue.iid}`,
        parentRunId:    state.parentRunId,
        repoRoot:       process.cwd(),
        draftMrPolicy:  flags.draftMrPolicy,
        // TODO Phase D.2: on-green MR-draft trigger — loop result does not
        //   yet signal "first green test"; wire once runStoryPipeline
        //   propagates a firstGreenAt timestamp in StoryResult.
      }).then((result) => {
        registration.status      = result.killSwitch ? 'failed' : 'complete';
        registration.killSwitch  = result.killSwitch ?? null;
        completed.add(issue.iid);
        lastCompletionAt = Date.now();
        return result;
      }).catch((err) => {
        registration.status             = 'failed';
        registration.killSwitch         = 'spawn-error';
        registration.killSwitchDetail   = err.message;
        completed.add(issue.iid);
        lastCompletionAt = Date.now();
        return { error: err.message };
      });

      inFlight.set(loopId, { promise, registration });
    }

    // 4. Cohort abort decision for newly-failed loops.
    for (const [, { registration }] of inFlight.entries()) {
      if (registration.status === 'failed' && registration.killSwitch) {
        const cohortDecision = mkLib.decideCohortAction(allLoops, registration.loopId);
        if (cohortDecision.action === 'cohort-abort') {
          // TODO Phase D.2: send real SIGTERM to in-process promises.
          //   In v1 loops are in-process Promises; enforcement is logged only.
          //   Full SIGTERM requires spawning each pipeline in a child process
          //   with a dedicated pid, tracked on LoopRegistration.pid.
          process.stderr.write(
            `[autopilot-multi] cohort-abort triggered by loop ${registration.loopId}: ${cohortDecision.reason}\n`,
          );
          return finalize(allLoops, 'cohort-abort', startMs, { kill: 'cohort-abort', detail: cohortDecision.reason });
        }
      }
    }

    // 5. Wait for next completion (Promise.race) OR settle after 5 s tick.
    if (inFlight.size > 0) {
      await Promise.race([
        Promise.race(Array.from(inFlight.values()).map((v) => v.promise.then(() => null))),
        new Promise((r) => setTimeout(r, 5000)),
      ]);
      // Sweep completed / failed entries.
      for (const [id, { registration }] of inFlight.entries()) {
        if (registration.status === 'complete' || registration.status === 'failed') {
          inFlight.delete(id);
        }
      }
    } else if (readyBacklog.length === 0) {
      // No active, no ready — backlog-empty stop condition fires on the next tick.
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Typed user-error (exit 1). */
class UserError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UserError';
  }
}

/**
 * Write a canonical JSON envelope to stdout.
 *
 * @param {boolean} success
 * @param {object|null} data
 * @param {{code: string, message: string}|null} error
 */
function writeJsonEnvelope(success, data, error) {
  const envelope = success
    ? { success: true, data }
    : { success: false, error };
  process.stdout.write(JSON.stringify(envelope) + '\n');
}

/**
 * Emit a diagnostic line to stderr (only when verbose or always for warnings).
 *
 * @param {string} message
 * @param {boolean} [verbose]
 * @param {boolean} [force]   If true, always emit regardless of verbose flag.
 */
function diag(message, verbose, force = false) {
  if (verbose || force) {
    process.stderr.write(`[autopilot-multi] ${message}\n`);
  }
}

// ---------------------------------------------------------------------------
// main — primary entrypoint
// ---------------------------------------------------------------------------

/**
 * CLI main function. Does NOT execute on import — see CLI guard below.
 *
 * @param {string[]} argv
 * @param {object}  [opts]          Dependency-injection seam for tests.
 * @param {Function} [opts.exit]    Override process.exit (for testing).
 * @returns {Promise<void>}
 */
export async function main(argv = process.argv.slice(2), opts = {}) {
  const exitFn = opts.exit ?? process.exit;

  // Unique run-id for this orchestrator session — passed to each child loop.
  const parentRunId = `multi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // -------------------------------------------------------------------------
  // 1. Parse flags
  // -------------------------------------------------------------------------
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (err instanceof UserError) {
      process.stderr.write(`autopilot-multi: ${err.message}\n`);
      exitFn(1);
      return;
    }
    process.stderr.write(`autopilot-multi: flag parse error: ${err.message}\n`);
    exitFn(1);
    return;
  }

  // -------------------------------------------------------------------------
  // 2. --help
  // -------------------------------------------------------------------------
  if (flags.help) {
    process.stdout.write(HELP_TEXT);
    exitFn(0);
    return;
  }

  // -------------------------------------------------------------------------
  // 3. --version
  // -------------------------------------------------------------------------
  if (flags.version) {
    try {
      const pkgPath = path.join(import.meta.dirname, '..', 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      process.stdout.write(`${pkg.version}\n`);
    } catch {
      process.stderr.write('autopilot-multi: could not read package.json version\n');
      exitFn(2);
      return;
    }
    exitFn(0);
    return;
  }

  // -------------------------------------------------------------------------
  // 4. Dynamic-import sibling libs (graceful degradation)
  // -------------------------------------------------------------------------
  let buildGraph, nextReady, calculateConcurrencyCap, probe;
  let depGraphMod, mkLibMod, wtPipelineMod, resourceProbeMod;

  try {
    depGraphMod      = await import('./lib/autopilot/dep-graph.mjs');
    mkLibMod       = await import('./lib/autopilot/multi-killswitch.mjs');
    wtPipelineMod    = await import('./lib/autopilot/worktree-pipeline.mjs');
    resourceProbeMod = await import('./lib/resource-probe.mjs');

    buildGraph              = depGraphMod.buildGraph;
    nextReady               = depGraphMod.nextReady;
    calculateConcurrencyCap = mkLibMod.calculateConcurrencyCap;
    probe                   = resourceProbeMod.probe;
  } catch {
    const msg = 'multi-story libs not yet shipped; this is the v3.6 CLI scaffold';
    process.stderr.write(`autopilot-multi: ${msg}\n`);
    if (flags.json) {
      writeJsonEnvelope(false, null, { code: 'LIBS_NOT_AVAILABLE', message: msg });
    }
    exitFn(2);
    return;
  }

  // -------------------------------------------------------------------------
  // 5. Resource probe + concurrency cap advisory
  // -------------------------------------------------------------------------
  let snapshot = null;
  try {
    snapshot = await probe();
  } catch (err) {
    process.stderr.write(
      `autopilot-multi: resource-probe failed: ${err.message}; continuing without snapshot\n`
    );
  }

  const recommendedCap = snapshot ? calculateConcurrencyCap(snapshot) : flags.maxStories;

  if (flags.maxStories > recommendedCap && !flags.apply) {
    process.stderr.write(
      `autopilot-multi: WARN requested N=${flags.maxStories} but resource-probe recommends` +
      ` N=${recommendedCap}; pass --apply to override\n`
    );
  }

  diag(
    `resource-probe snapshot received; recommendedCap=${recommendedCap}`,
    flags.verbose
  );

  // -------------------------------------------------------------------------
  // 6. Build issue backlog
  // -------------------------------------------------------------------------
  let issues;

  if (flags.dryRun) {
    // Dry-run: synthesize a stub backlog so plan output is always available.
    issues = [{ iid: 999, title: 'dry-run-stub', blocks: [], blockedBy: [], labels: ['status:ready'] }];
    diag('dry-run mode — using synthetic issue stub instead of calling glab', flags.verbose, true);
  } else {
    // Apply path: fetch real issues via glab (execFile, shell: false — SEC-014).
    try {
      issues = await fetchReadyBacklog(execFile);
    } catch (err) {
      const msg = `glab issue list failed: ${err.message}`;
      process.stderr.write(`autopilot-multi: ${msg}\n`);
      if (flags.json) {
        writeJsonEnvelope(false, null, { code: 'GLAB_FAILED', message: msg });
      }
      exitFn(2);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // 7. Build dep-graph + initial schedulable set
  // -------------------------------------------------------------------------
  const graph       = buildGraph(issues);
  const initialSet  = nextReady(graph, new Set(), new Set());

  diag(
    `dep-graph built; total=${issues.length} ready=${initialSet.length ?? initialSet.size ?? 0}`,
    flags.verbose
  );

  // -------------------------------------------------------------------------
  // 8. Dry-run path (default): emit orchestration plan
  // -------------------------------------------------------------------------
  if (flags.dryRun) {
    const plan = buildOrchestratorState(flags, snapshot, issues, parentRunId);

    if (flags.json) {
      writeJsonEnvelope(true, { plan });
    } else {
      process.stdout.write('autopilot-multi — dry-run orchestration plan\n');
      process.stdout.write(`  concurrencyCap : ${plan.concurrencyCap}\n`);
      process.stdout.write(`  totalIssues    : ${plan.totalIssues}\n`);
      process.stdout.write(`  readyIssues    : ${plan.readyIssues}\n`);
      process.stdout.write(`  executionPlan  :\n`);
      for (const item of plan.executionPlan) {
        process.stdout.write(`    #${item.iid} ${item.title}\n`);
      }
      process.stdout.write('\nPass --apply to execute.\n');
    }

    exitFn(0);
    return;
  }

  // -------------------------------------------------------------------------
  // 9. Apply path: run the multi-story orchestration loop
  // -------------------------------------------------------------------------
  const state = buildOrchestratorState(flags, snapshot, issues, parentRunId);
  const libs  = {
    depGraph:   depGraphMod,
    wtPipeline: wtPipelineMod,
    mkLib:    mkLibMod,
    probe:      resourceProbeMod,
  };

  const result = await runApplyLoop(state, libs, opts);

  if (flags.json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(
      `Multi-story apply complete: ${result.data.reason}` +
      ` — ${result.data.completed}/${result.data.loopCount} loops succeeded`,
    );
  }

  exitFn(result.success ? 0 : 2);
}

// ---------------------------------------------------------------------------
// CLI guard — prevents top-level execution on import (deep-2 #368)
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((err) => {
    console.error('autopilot-multi failed:', err.message);
    process.exit(2);
  });
}
