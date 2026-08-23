/**
 * session-start-probes.mjs — the mechanical runner for the Phase 4 probe family.
 *
 * ## Why this module exists
 *
 * `skills/session-start/SKILL.md` § Phase 4 names 18 measurement probes, each
 * with a module path and an entry function. Measured 2026-08-23 at `4f6404e`,
 * NONE of them had a mechanical caller:
 *
 * ```
 * $ grep -c "session-start-probes\|checkSessionsStaleness\|checkProjectHygiene" \
 *     hooks/*.mjs .husky/* package.json .gitlab-ci.yml
 * 0
 * ```
 *
 * The only caller was prose in a SKILL.md — i.e. an LLM had to remember to run
 * eighteen probes by hand, every session. And whether it ever did was itself
 * unobservable: 336 recorded session starts carried no probe event of any kind.
 * That is `.claude/rules/host-resources.md` § HR-105 ("a rule you cannot
 * falsify is not a rule") applied to a whole probe family, and the repo-memory
 * "built-but-not-wired" class in its purest form.
 *
 * This runner is the wiring: it invokes the probes, collects their banner lines
 * into the caller's single-envelope buffer, and writes ONE
 * `orchestrator.probes.completed` telemetry record per run so the next question
 * — "did they run, and what did they find?" — is answerable from the ledger
 * rather than from memory.
 *
 * ## Contract
 *
 * - **Fail-open, always.** A probe that throws, hangs, or is missing from the
 *   install produces an `outcome`, never an exception. `runSessionStartProbes`
 *   has no rejecting path; a caller needs no try/catch (the hook keeps one
 *   anyway as defence-in-depth).
 * - **Budget-bounded.** The whole run shares one deadline (`PROBE_BUDGET_MS`).
 *   See the ceiling note on that constant for what the bound can and cannot do.
 * - **Absent is not zero.** A probe that did not run is recorded with the
 *   reason it did not (`skipped` + `reason`), never silently omitted and never
 *   folded into a clean count.
 *
 * @module scripts/lib/session-start-probes
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { emitEvent } from './events.mjs';

/**
 * Resolve a sibling module to an absolute `file:` URL.
 *
 * A bare relative specifier (`'./ci-status-banner.mjs'`) resolves against the
 * module doing the `import()`, so the registry would only be importable from
 * THIS file — any other consumer, a test included, would resolve every entry
 * against its own directory and see eighteen phantom "module-absent" skips that
 * look exactly like a stale plugin install. Pinning the specifier to this
 * module's directory makes `PROBES` self-contained.
 *
 * @param {string} rel — path relative to `scripts/lib/`
 * @returns {string}
 */
const local = (rel) => pathToFileURL(path.join(import.meta.dirname, rel)).href;

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/**
 * Wall-clock ceiling for the ENTIRE probe run, in milliseconds.
 *
 * Derived from measurement, not aspiration:
 *   - `hooks/hooks.json` gives the whole SessionStart hook `timeout: 5` (5s).
 *     Everything below is carved out of that, not out of nothing.
 *   - The pre-existing work in the same hook already spends a measured ~845 ms
 *     median on `backfillOnSessionStart` alone, plus git, registry and the
 *     resource probe.
 *   - Measured 2026-08-23 against this repo (the largest in the fleet), one
 *     `runSessionStartProbes` call per process, five runs:
 *     **855 / 916 / 968 / 1063 / 1104 ms** — median 968 ms, dominated by
 *     `project-hygiene` and `tests-src-ratio`, the two probes that shell out.
 *
 * 2000 ms is ~2x the measured median here and still leaves the hook well over
 * half its 5s envelope. Note the headroom is real but not generous, and this is
 * the WORST repo in the fleet by design — see the revisit trigger below, which
 * this repo already sits just underneath rather than comfortably below.
 *
 * NAMED CEILING (BV-004): the deadline is enforced at `await` points. A probe
 * that blocks the event loop *synchronously* (several do — `project-hygiene`
 * and `tests-src-ratio` shell out with `execFileSync`) cannot be preempted by a
 * timer that cannot run; such a probe is reported with its TRUE `durationMs`
 * and can overrun this budget. The bound is therefore hard for async/network
 * probes and advisory for synchronous ones.
 *
 * READING `durationMs`: probes are launched together, so a probe's individual
 * `durationMs` includes time spent waiting for a SIBLING synchronous probe to
 * release the event loop. Measured 2026-08-23 here, `loop-readiness` reports
 * ~513 ms under parallel launch and 0.5 ms in isolation. Only the run-level
 * `duration_ms` is an isolated cost; per-probe figures rank contention, not
 * work.
 *
 * REVISIT TRIGGER: if `duration_ms` in `orchestrator.probes.completed` exceeds
 * half this budget at the median across a repo's recorded starts, or if any
 * single probe's `durationMs` regularly exceeds `PROBE_BUDGET_MS`, move the
 * slow probes off the hook's critical path (a detached child process writing
 * its banner for the NEXT start) rather than raising this number.
 */
export const PROBE_BUDGET_MS = 2000;

/** Sentinel resolved by the deadline race; never leaks to a caller. */
const TIMED_OUT = Symbol('probe-timeout');

// ---------------------------------------------------------------------------
// Probe registry
// ---------------------------------------------------------------------------

/**
 * The Phase 4 probe family, in the order `skills/session-start/SKILL.md`
 * introduces them (banner order is registry order, never completion order, so
 * a run is reproducible).
 *
 * Census (2026-08-23, `skills/session-start/SKILL.md` lines 693-835):
 *   sed -n '693,835p' skills/session-start/SKILL.md \
 *     | grep -oE 'via `(await )?check[A-Za-z]+'   # -> 16
 * plus two probes the prose introduces with different phrasing —
 * `checkBootstrapLockFreshness` ("invoke the bootstrap-lock-freshness probe")
 * and `checkVaultStaleness` ("read the most recent line via …") — for 18.
 *
 * Each entry:
 *   - `id`         stable telemetry id (also the banner-ordering key)
 *   - `spec`       absolute `file:` URL to import (see {@link local})
 *   - `fn`         exported entry function name
 *   - `network`    true when the probe spawns a VCS CLI that talks to a remote
 *   - `args`       builds the probe's options object from the run context
 *   - `precondition` optional; returns a skip-reason string to skip the probe
 *   - `render`     optional; maps a result to a banner line. Default:
 *                  `result.message` when severity is warn/alert.
 */
export const PROBES = [
  {
    id: 'bootstrap-lock-freshness',
    spec: local('./bootstrap-lock-freshness.mjs'),
    fn: 'checkBootstrapLockFreshness',
    network: false,
    // SKILL.md gates this one on the lock's existence: without a lock the probe
    // returns a hard `alert` ("bootstrap.lock missing") that is not a finding
    // about THIS repo but about it never having been bootstrapped.
    precondition: ({ repoRoot }) =>
      existsSync(path.join(repoRoot, '.orchestrator', 'bootstrap.lock'))
        ? null
        : 'no-bootstrap-lock',
    args: ({ repoRoot }) => ({ repoRoot, currentPluginVersion: pluginVersion() }),
  },
  {
    id: 'vault-staleness',
    spec: local('./vault-staleness-banner.mjs'),
    fn: 'checkVaultStaleness',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'ci-status',
    spec: local('./ci-status-banner.mjs'),
    fn: 'checkCiStatus',
    network: true,
    args: ({ repoRoot }) => ({ repoRoot }),
    // Bespoke shape: `{status, ok, details, …}` with no `message` field. The
    // banner text is prescribed by SKILL.md § Phase 4.
    render: (r) => {
      if (!r || typeof r !== 'object') return null;
      if (r.status === 'red') {
        const pid = r.details?.currentPipelineId ?? '?';
        const green = r.lastGreen
          ? ` — last green: #${r.lastGreen.pipelineId} (commit ${String(r.lastGreen.sha ?? '').slice(0, 7)}, ${r.redCount} pipelines ago)`
          : '';
        const job = r.failingJobName ? ` Failing job: ${r.failingJobName}` : '';
        return `🚨 CI RED on HEAD (pipeline #${pid})${green}.${job}`;
      }
      if (r.status === 'green' && Array.isArray(r.allowFailureJobs) && r.allowFailureJobs.length > 0) {
        const names = r.allowFailureJobs.map((j) => j?.name ?? String(j)).join(', ');
        return `⚠ CI green on HEAD, but ${r.allowFailureJobs.length} allow_failure job(s) FAILED: ${names}. A pipeline reports success regardless of these.`;
      }
      return null;
    },
    // `status: 'red'` is an alert even though the probe publishes no severity.
    severityOf: (r) => (r?.status === 'red' ? 'alert' : r?.status === 'green' && r?.allowFailureJobs ? 'warn' : 'ok'),
  },
  {
    id: 'qg-command-drift',
    spec: local('./qg-command-drift-banner.mjs'),
    fn: 'checkQgCommandDrift',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'peer-cards-staleness',
    spec: local('./peer-cards/staleness-banner.mjs'),
    fn: 'checkPeerCardsStaleness',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'loop-readiness',
    spec: local('./loop-readiness-banner.mjs'),
    fn: 'checkLoopReadiness',
    network: false,
    args: ({ repoRoot, env }) => ({ repoRoot, env }),
  },
  {
    id: 'instruction-budget',
    spec: local('./instruction-budget-guard.mjs'),
    fn: 'checkInstructionBudget',
    network: false,
    // This probe counts the always-on directive corpus under `.claude/rules/`.
    // Without that directory there is no corpus and the probe returns `null`
    // anyway — but it reaches that `null` through `rule-loader.loadApplicableRules`,
    // which writes `[rule-loader] Cannot read rulesDir …` to STDERR three times
    // per call on the way. Two pinned tests in
    // `tests/hooks/on-session-start.test.mjs` assert this hook writes NOTHING to
    // stderr, and they are right to: a SessionStart hook's stderr is operator-
    // visible noise. Skipping on the absent directory keeps the same answer
    // without the noise, and records WHY it was skipped instead of reporting a
    // clean corpus that was never measured.
    precondition: ({ repoRoot }) =>
      existsSync(path.join(repoRoot, '.claude', 'rules')) ? null : 'no-rules-dir',
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'reconcile-nudge',
    spec: local('./reconcile-nudge-banner.mjs'),
    fn: 'checkReconcileNudge',
    network: false,
    args: ({ repoRoot, config }) => ({ repoRoot, config }),
  },
  {
    id: 'sessions-staleness',
    spec: local('./sessions-staleness-banner.mjs'),
    fn: 'checkSessionsStaleness',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'sessions-integrity',
    spec: local('./sessions-integrity-banner.mjs'),
    fn: 'checkSessionsIntegrity',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'owner-config',
    spec: local('./owner-config-banner.mjs'),
    fn: 'checkOwnerConfig',
    network: false,
    // Host-wide `owner.yaml`, deliberately NOT repo-scoped — no repoRoot arg.
    args: () => ({}),
  },
  {
    id: 'moc-staleness',
    spec: local('./moc-staleness-banner.mjs'),
    fn: 'checkMocStaleness',
    network: false,
    args: ({ repoRoot, config }) => ({ repoRoot, config }),
  },
  {
    id: 'context-coverage',
    spec: local('./context-coverage-banner.mjs'),
    fn: 'checkContextCoverage',
    network: false,
    args: ({ repoRoot, config }) => ({ repoRoot, config }),
  },
  {
    id: 'claude-md-budget-lint',
    spec: local('./claude-md-budget-lint.mjs'),
    fn: 'checkClaudeMdBudgetLint',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'tests-src-ratio',
    spec: local('./tests-src-ratio.mjs'),
    fn: 'checkTestsSrcRatio',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'project-hygiene',
    spec: local('./project-hygiene.mjs'),
    fn: 'checkProjectHygiene',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'mirror-issues',
    spec: local('./mirror-issues-banner.mjs'),
    fn: 'checkMirrorIssues',
    network: true,
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    id: 'git-config-drift',
    spec: local('./git-config-drift.mjs'),
    fn: 'checkGitConfigDrift',
    network: false,
    args: ({ repoRoot, env }) => ({ repoRoot, env }),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The installed plugin's own version, for `bootstrap-lock-freshness`'s
 * version-drift comparison. Read from THIS plugin's package.json (two levels up
 * from `scripts/lib/`), never from the target repo — the probe compares the
 * lock's recorded plugin version against the plugin that is running now.
 *
 * @returns {string|undefined} — undefined when unreadable (the probe then
 *   reports `current=unknown` rather than a fabricated version).
 */
function pluginVersion() {
  try {
    const pkg = path.resolve(import.meta.dirname, '..', '..', 'package.json');
    const parsed = JSON.parse(readFileSync(pkg, 'utf8'));
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Race `promise` against a deadline.
 *
 * The loser is neutralised (`.catch`) before the race so a late rejection can
 * never surface as an unhandled rejection and kill an exit-0 hook.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms — remaining budget; `<= 0` times out immediately.
 * @returns {Promise<T|symbol>} — resolves to {@link TIMED_OUT} on expiry.
 */
async function withDeadline(promise, ms) {
  const settled = promise.catch((err) => ({ __probeError: err }));
  if (ms <= 0) return TIMED_OUT;
  let timer;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
    // Never hold the event loop open for the timer alone.
    if (typeof timer?.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([settled, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Normalise a probe result's severity.
 *
 * `null` is the family's universal "clean, say nothing" return. Everything else
 * is judged by its `severity` field — including the THREE-state probes
 * (`mirror-issues`, `git-config-drift`, `ci-status`) whose `degraded` result
 * means "state unknown" and must NEVER be read as clean.
 *
 * @param {*} result
 * @param {{severityOf?: (r: *) => string}} probe
 * @returns {'ok'|'warn'|'alert'}
 */
function severityOf(result, probe) {
  if (typeof probe.severityOf === 'function') {
    const s = probe.severityOf(result);
    return s === 'alert' || s === 'warn' ? s : 'ok';
  }
  if (result === null || result === undefined) return 'ok';
  const s = result.severity;
  if (s === 'alert') return 'alert';
  if (s === 'warn') return 'warn';
  return 'ok';
}

/**
 * Default banner renderer: the probe's own `message`, but only when it actually
 * found something. A probe that returns `{severity: 'ok'|'info'}` is silent.
 *
 * @param {*} result
 * @param {string} severity
 * @returns {string|null}
 */
function defaultRender(result, severity) {
  if (severity === 'ok') return null;
  const msg = result?.message;
  return typeof msg === 'string' && msg.length > 0 ? msg : null;
}

/**
 * Load Session Config for the repo, fail-open to `{}`.
 * @param {string} repoRoot
 * @returns {Promise<object>}
 */
async function loadConfig(repoRoot) {
  try {
    const { readConfigFile, parseSessionConfig } = await import('./config.mjs');
    return parseSessionConfig(await readConfigFile(repoRoot)) ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Run the Phase 4 probe family and record the run.
 *
 * Never rejects and never throws: every failure mode of every probe is folded
 * into that probe's `outcome`.
 *
 * @param {object} [opts]
 * @param {string} opts.repoRoot — repo the probes measure AND the repo whose
 *   `.orchestrator/metrics/events.jsonl` receives the telemetry record. Pinning
 *   this is what keeps a test out of the real ledger.
 * @param {object} [opts.config] — parsed Session Config; loaded from `repoRoot`
 *   when omitted.
 * @param {object} [opts.env=process.env] — environment passed to env-reading
 *   probes and consulted for `SO_PROBES_INCLUDE_NETWORK`.
 * @param {number} [opts.timeoutMs=PROBE_BUDGET_MS] — wall-clock budget.
 * @param {object} [deps] — test seams.
 * @param {Array<object>} [deps.probes=PROBES] — probe registry override.
 * @param {(type: string, payload: object, opts: object) => Promise<void>} [deps.emit=emitEvent]
 * @returns {Promise<{bannerLines: string[], results: Array<{id: string, outcome: string, severity?: string, durationMs: number, reason?: string}>, event: object|null}>}
 */
export async function runSessionStartProbes(opts = {}, deps = {}) {
  const started = Date.now();
  const {
    repoRoot,
    env = process.env,
    timeoutMs = PROBE_BUDGET_MS,
  } = opts;
  const probes = Array.isArray(deps.probes) ? deps.probes : PROBES;
  const emit = typeof deps.emit === 'function' ? deps.emit : emitEvent;

  // No repoRoot means every repo-scoped probe would measure the wrong tree and
  // the event would land in whatever `SO_PROJECT_DIR` happens to resolve to.
  // Refusing here is the fail-open answer: report nothing, write nothing.
  if (!repoRoot || typeof repoRoot !== 'string') {
    return { bannerLines: [], results: [], event: null };
  }

  const config = opts.config ?? (await loadConfig(repoRoot));

  // Network probes: excluded by default, and the exclusion is RECORDED.
  //
  // `ci-status` and `mirror-issues` spawn `glab`/`gh` against a remote with an
  // 8s CLI timeout of their own — a single one can exceed the hook's entire 5s
  // `hooks.json` budget. Measured warm here on 2026-08-23: 520 ms and 498 ms,
  // and that is the BEST case (warm CLI, live network, authenticated). Paying
  // that on every session start of every repo buys a signal the operator can
  // get on demand from `/session`, so the default is off.
  //
  // What is NOT acceptable is dropping them silently — that reproduces the
  // exact defect this module repairs. They appear in every run's telemetry as
  // `outcome: 'skipped'`, `reason: 'network-probe-opt-in'`, so "were they run?"
  // stays an answerable question.
  const includeNetwork = env?.SO_PROBES_INCLUDE_NETWORK === '1';

  const ctx = { repoRoot, config, env };
  const deadline = started + Math.max(0, Number(timeoutMs) || 0);

  /** @type {Map<string, object>} */
  const byId = new Map();

  await Promise.all(
    probes.map(async (probe) => {
      const t0 = Date.now();
      const record = (outcome, extra = {}) => {
        byId.set(probe.id, {
          id: probe.id,
          outcome,
          durationMs: Date.now() - t0,
          ...extra,
        });
      };

      if (probe.network && !includeNetwork) {
        record('skipped', { reason: 'network-probe-opt-in' });
        return;
      }

      let skipReason;
      try {
        skipReason = typeof probe.precondition === 'function' ? probe.precondition(ctx) : null;
      } catch {
        // A precondition that throws is a defect in the precondition, not a
        // finding about the repo — treat it as "cannot decide", run nothing.
        record('error', { reason: 'precondition-threw' });
        return;
      }
      if (typeof skipReason === 'string' && skipReason.length > 0) {
        record('skipped', { reason: skipReason });
        return;
      }

      // The whole invocation — import included — is inside the race, because a
      // pre-#369-style absent module and a hung probe are both "did not
      // deliver" and both must resolve to an outcome rather than to a throw.
      const invocation = (async () => {
        const mod = await import(probe.spec);
        const fn = mod?.[probe.fn];
        if (typeof fn !== 'function') {
          return { __probeError: new Error(`export ${probe.fn} missing`), __absent: true };
        }
        return { __probeResult: await fn(probe.args(ctx)) };
      })();

      const raced = await withDeadline(invocation, deadline - Date.now());

      if (raced === TIMED_OUT) {
        record('timeout', { reason: 'budget-exceeded' });
        return;
      }
      if (raced && raced.__probeError) {
        // A missing module is the documented "pre-#N plugin install" case:
        // SKILL.md says skip silently. Made visible as a skip, not an error.
        if (raced.__absent || raced.__probeError?.code === 'ERR_MODULE_NOT_FOUND') {
          record('skipped', { reason: 'module-absent' });
        } else {
          record('error', { reason: String(raced.__probeError?.message ?? raced.__probeError).slice(0, 200) });
        }
        return;
      }

      const result = raced?.__probeResult;
      const severity = severityOf(result, probe);
      const line = typeof probe.render === 'function'
        ? probe.render(result)
        : defaultRender(result, severity);
      record(severity === 'ok' ? 'ran-clean' : severity === 'warn' ? 'ran-warn' : 'ran-alert', {
        severity,
        ...(line ? { line } : {}),
      });
    }),
  );

  // Registry order, never completion order — a run must be reproducible.
  const results = [];
  const bannerLines = [];
  for (const probe of probes) {
    const r = byId.get(probe.id);
    if (!r) continue;
    if (r.line) bannerLines.push(r.line);
    const { line: _line, ...rest } = r;
    results.push(rest);
  }

  const count = (pred) => results.filter(pred).length;
  const ran = count((r) => r.outcome.startsWith('ran-'));
  const warned = count((r) => r.outcome === 'ran-warn' || r.outcome === 'ran-alert');
  const skipped = count((r) => r.outcome === 'skipped');
  const errored = count((r) => r.outcome === 'error');
  const timedOut = count((r) => r.outcome === 'timeout');

  // One aggregate line, and only when something actually failed to deliver — a
  // banner that fires on every start teaches the operator to ignore banners
  // (`.claude/rules/host-resources.md` § HR-101).
  if (errored + timedOut > 0) {
    const parts = [];
    if (errored > 0) parts.push(`${errored} errored`);
    if (timedOut > 0) parts.push(`${timedOut} timed out`);
    bannerLines.push(
      `⚠ session-start probes: ${parts.join(', ')} — see orchestrator.probes.completed in .orchestrator/metrics/events.jsonl.`,
    );
  }

  const event = {
    total: probes.length,
    ran,
    warned,
    skipped,
    errored,
    timed_out: timedOut,
    duration_ms: Date.now() - started,
    // `reason` travels. Dropping it here was the module's own rule broken at its
    // own boundary: `module-absent` is the ONE skip reason that means a probe is
    // permanently dead, and without it the ledger cannot tell that apart from
    // `network-probe-opt-in`, which is the intended default. "Measured, then
    // discarded" is worse than "not measured" — the value existed.
    probes: results.map((r) => ({
      id: r.id,
      outcome: r.outcome,
      ...(typeof r.reason === 'string' && r.reason.length > 0 ? { reason: r.reason } : {}),
    })),
  };

  // Telemetry is best-effort like every other side effect here: a ledger that
  // cannot be written must not cost the operator his banners.
  try {
    await emit('orchestrator.probes.completed', event, { repoRoot });
  } catch { /* never block the caller */ }

  return { bannerLines, results, event };
}
