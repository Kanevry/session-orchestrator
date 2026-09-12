/**
 * session-start-probes.mjs — the mechanical runner for the Phase 4 probe family.
 *
 * ## Why this module exists
 *
 * `skills/session-start/SKILL.md` § Phase 4 names 19 measurement probes, each
 * with a module path and an entry function (re-measured 2026-09-11 — see the
 * registry Census below; the family stood at 18 when this module was written
 * on 2026-08-23 and one probe was registered since without updating this
 * count, the exact drift this header now warns readers not to repeat).
 * Measured 2026-08-23 at `4f6404e`, NONE of them had a mechanical caller:
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
 * - **Budget-bounded.** Each probe gets `PROBE_BUDGET_MS` of its OWN work time.
 *   See the ceiling note on that constant for what the bound can and cannot do.
 * - **Absent is not zero.** A probe that did not run is recorded with the
 *   reason it did not (`skipped` + `reason`), never silently omitted and never
 *   folded into a clean count.
 *
 * @module scripts/lib/session-start-probes
 */

import { execFileSync } from 'node:child_process';
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

/** Fallback hint when nothing cheaper than an on-demand CLI call is available. */
const CI_UNKNOWN_HINT_DEFAULT = 'run `glab ci status` on demand';

/**
 * `ci-status` "no data for HEAD" reasons after which the last PUSHED commit is
 * worth asking about: GitLab's `no-pipeline-for-head-sha` and GitHub's
 * `no-check-runs-for-head` (both emitted by `checkCiStatus`).
 */
const PUSHED_FOLLOW_UP_REASONS = new Set(['no-pipeline-for-head-sha', 'no-check-runs-for-head']);

/**
 * Full SHAs for `refs`, in order, from ONE `git rev-parse` — or `null` when
 * any ref does not resolve (no upstream, detached HEAD, not a git repo, git
 * missing). Full, not short: `checkCiStatus({ sha })` matches against GitLab's
 * full pipeline SHAs and refuses anything shorter.
 *
 * NAMED CEILING (BV-004): one `git rev-parse` with a 2s timeout, run only on
 * the {@link PUSHED_FOLLOW_UP_REASONS} branch — i.e. only when the `ci-status`
 * probe already ran (network opt-in) and already found no data for HEAD.
 *
 * @param {string|undefined} repoRoot
 * @param {string[]} refs
 * @returns {string[]|null}
 */
function revParseShas(repoRoot, refs) {
  if (!repoRoot || typeof repoRoot !== 'string') return null;
  try {
    const out = execFileSync('git', ['rev-parse', ...refs], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const shas = String(out).trim().split('\n').map((s) => s.trim());
    const valid = shas.length === refs.length
      && shas.every((s) => /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s));
    return valid ? shas : null;
  } catch {
    // Every failure means "no cheap pushed-SHA hint", never an error worth
    // surfacing here.
    return null;
  }
}

/**
 * Full SHA of the last PUSHED commit (`@{upstream}`), or `null`.
 *
 * @param {string|undefined} repoRoot
 * @returns {string|null}
 */
function lastPushedSha(repoRoot) {
  return revParseShas(repoRoot, ['@{upstream}'])?.[0] ?? null;
}

/**
 * `ci-status` follow-up (#1332): when HEAD has no CI data, ask for the verdict
 * of the last PUSHED commit — the commit whose pipeline can actually be red
 * while HEAD reads "unknown".
 *
 * NAMED CEILING (BV-004): at most one `git rev-parse` plus ONE extra CLI round
 * trip (`checkCiStatus({ sha })`), only on a {@link PUSHED_FOLLOW_UP_REASONS}
 * reading, and only behind the existing network opt-in
 * (`SO_PROBES_INCLUDE_NETWORK=1` — without it the whole `ci-status` probe is
 * `skipped: network-probe-opt-in` and this never runs). It runs INSIDE the
 * probe's budget race and gets only what is left of that budget; if it
 * overruns or throws, the runner keeps the HEAD reading it was given (see
 * `runSessionStartProbes`). REVISIT TRIGGER: if `follow_up: 'budget-exceeded'`
 * shows up regularly in `orchestrator.probes.completed`, cache the verdict per
 * pushed SHA instead of re-asking.
 *
 * The CLI round trip is skipped when the pushed commit IS HEAD on GitLab: its
 * HEAD reading was taken for the local HEAD SHA, so the re-query would ask the
 * identical question. Not on GitHub: `checkCiStatus` asks the API for the
 * literal ref `HEAD`, which GitHub resolves to the REMOTE default branch, not
 * the local HEAD — there the pushed SHA is a different question even when it
 * equals local HEAD.
 *
 * @param {*} result   The HEAD reading from `checkCiStatus`
 * @param {{repoRoot?: string}} ctx
 * @param {(extra: object) => Promise<*>} requery  Re-invokes the probe with extra options
 * @returns {Promise<*>}
 */
async function ciPushedFollowUp(result, ctx, requery) {
  const reason = result?.details?.reason;
  if (result?.status !== 'unknown' || !PUSHED_FOLLOW_UP_REASONS.has(reason)) {
    return result;
  }
  // One spawn for both: an unresolvable `@{upstream}` fails the whole call,
  // which is exactly the "no upstream" answer.
  const shas = revParseShas(ctx?.repoRoot, ['HEAD', '@{upstream}']);
  // `pushed.sha: null` records "no upstream" so the renderer does not ask git again.
  if (!shas) return { ...result, pushed: { sha: null } };
  const [head, sha] = shas;
  if (reason === 'no-pipeline-for-head-sha' && sha === head) {
    return { ...result, pushed: { sha, sameAsHead: true } };
  }
  let verdict;
  try {
    verdict = await requery({ sha });
  } catch {
    // checkCiStatus never throws; a failure here only loses the verdict detail.
    verdict = null;
  }
  return { ...result, pushed: { sha, verdict } };
}

/**
 * `CI <status> (#<pipeline>)` for a pushed-SHA verdict, or `null` when there
 * is no readable verdict (the caller then falls back to the command hint).
 *
 * @param {*} v  A `checkCiStatus` result
 * @returns {string|null}
 */
function pushedVerdictText(v) {
  if (!v || typeof v !== 'object') return null;
  if (v.degraded) return `CI state unknown (${v.degraded})`;
  if (typeof v.status !== 'string') return null;
  const pid = v.details?.currentPipelineId;
  const parts = [];
  if (pid !== null && pid !== undefined) parts.push(`#${pid}`);
  if (v.status === 'unknown' && v.details?.reason) parts.push(v.details.reason);
  return `CI ${v.status}${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`;
}

/**
 * Hint text for a `status: 'unknown'` ci-status reading.
 *
 * @param {object} result   The probe result (possibly carrying `pushed` from
 *   {@link ciPushedFollowUp})
 * @param {{repoRoot?: string}} [ctx]
 * @returns {string}
 */
function ciUnknownHint(result, ctx) {
  if (!PUSHED_FOLLOW_UP_REASONS.has(result?.details?.reason)) return CI_UNKNOWN_HINT_DEFAULT;
  // The GitHub reason names the gh CLI; a glab command there would be wrong.
  const gh = result.details.cliUsed === 'gh';
  const onDemand = gh ? 'run `gh run list` on demand' : CI_UNKNOWN_HINT_DEFAULT;
  const pushed = result.pushed && typeof result.pushed === 'object' ? result.pushed : null;
  // The follow-up already resolved the SHA (or its absence) — never re-ask git.
  // Without `pushed` (follow-up overran or threw) this is the only git call.
  const sha = pushed ? pushed.sha : lastPushedSha(ctx?.repoRoot);
  if (!sha) return onDemand;
  const short = sha.slice(0, 8);
  if (pushed?.sameAsHead) return `last pushed: ${short} = HEAD — ${onDemand}`;
  const verdict = pushedVerdictText(pushed?.verdict);
  if (verdict) return `last pushed: ${short} — ${verdict}`;
  const check = gh ? `gh run list --commit ${sha}` : `glab ci status --ref ${short}`;
  return `last pushed: ${short} (pipeline not checked; run \`${check}\`)`;
}

/**
 * "Green, but allow_failure jobs failed" — the ONE predicate both the
 * `ci-status` renderer and its `severityOf` use (#1333). Two predicates once
 * disagreed: `severityOf` read truthiness, so `allowFailureJobs: []` scored
 * `warn` while the renderer printed nothing.
 *
 * @param {*} r
 * @returns {boolean}
 */
function hasFailedAllowFailureJobs(r) {
  return Array.isArray(r?.allowFailureJobs) && r.allowFailureJobs.length > 0;
}

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
 * NAMED CEILING (BV-004): the budget is denominated in a probe's OWN work time
 * (wall-clock elapsed minus the time a synchronous sibling held the event loop
 * — see {@link startLoopBlockedMeter}), and it is PER PROBE, not one shared
 * wall deadline. A probe that blocks the loop *synchronously* (several do —
 * `project-hygiene` and `tests-src-ratio` shell out with `execFileSync`) still
 * cannot be preempted by a timer that cannot run, so it is reported with its
 * true cost and can overrun this budget. The bound is therefore hard for
 * async/network probes and advisory for synchronous ones — but it no longer
 * charges the async ones for the synchronous ones' time.
 *
 * READING `durationMs` vs `workMs`: probes are launched together, so a probe's
 * individual `durationMs` includes time spent waiting for a SIBLING
 * synchronous probe to release the event loop. Measured 2026-09-11 here, all
 * 17 non-network probes reported `durationMs` ≈ 5.8 s while their isolated
 * costs ranged 0.5–3519 ms. `durationMs` ranks contention; `workMs` — the
 * field the `timeout` verdict is computed from, and the one persisted as
 * `work_ms` — ranks work.
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

/**
 * Event-loop-lag sampling interval for {@link startLoopBlockedMeter}.
 *
 * NAMED CEILING (BV-004): 20 ms is ~50 wakeups/s, negligible next to the
 * run's own hundreds of ms, and fine-grained enough that a block shorter than
 * one sample is also shorter than anything the budget cares about. REVISIT
 * TRIGGER: if a probe's own work ever needs to be bounded below ~100 ms, this
 * sampling floor becomes the measurement error and needs `perf_hooks`
 * `monitorEventLoopDelay` instead.
 */
const LOOP_BLOCKED_SAMPLE_MS = 20;

/**
 * Measure how long the event loop was monopolised by SYNCHRONOUS work.
 *
 * Why this exists (measured 2026-09-11 against this repo, `PROBES` run in
 * parallel): `project-hygiene` (3519 ms) and `tests-src-ratio` (314 ms) shell
 * out with `execFileSync` and cannot be preempted. Every probe's wall-clock
 * `durationMs` therefore read ~5.8 s while its own work was 0.5–66 ms, and the
 * only two probes reported as `timeout` were the two that YIELD to the event
 * loop mid-work (`peer-cards-staleness`, 7 ms; `maintenance-due`, 40 ms) — a
 * probe whose work is synchronous wins its own race in a microtask before the
 * long-expired macrotask timer can run. The old instrument therefore graded
 * ASYNCHRONY, not cost: the two cheapest preemptible probes took the blame for
 * the two most expensive non-preemptible ones (`.claude/rules/host-resources.md`
 * § HR-103 — check the unit before the threshold; § HR-106 — report what the
 * rule judged).
 *
 * A timer scheduled every {@link LOOP_BLOCKED_SAMPLE_MS} that fires late by
 * `d` proves the loop was unavailable for `d`. Summing that lateness gives the
 * blocked time, which is subtracted from a probe's wall-clock elapsed to yield
 * its OWN cost — the quantity `PROBE_BUDGET_MS` was always meant to bound.
 *
 * NAMED CEILING (BV-004): the meter knows THAT the loop was blocked, never BY
 * WHOM — so the blocker's own blocking time is subtracted from its own
 * `workMs` too. Measured 2026-09-11 here: `project-hygiene`, the ~1–3.5 s
 * `execFileSync` blocker, reports `workMs` ≈ 9 ms. Read `workMs` as EXACT for a
 * preemptible probe and as a LOWER BOUND for a synchronous one — which is
 * coherent with what the budget can do (a non-preemptible probe was never
 * boundable), but it means `workMs` must never be used to rank the synchronous
 * probes against each other. REVISIT TRIGGER: if a synchronous probe ever has
 * to be held to a budget, attribute the gap to the probe that caused it
 * (`async_hooks`, or run the shell-outs in a worker) rather than re-tuning this
 * subtraction. Isolated per-probe cost, for now, is measured by running one
 * probe per process.
 *
 * @returns {{ read: () => number, stop: () => void }}
 */
function startLoopBlockedMeter() {
  let blockedMs = 0;
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    blockedMs += Math.max(0, now - last - LOOP_BLOCKED_SAMPLE_MS);
    last = now;
  }, LOOP_BLOCKED_SAMPLE_MS);
  if (typeof timer?.unref === 'function') timer.unref();
  return {
    // The in-progress gap counts too: after a long block the interval callback
    // may not have run yet when a probe callback asks.
    read: () => blockedMs + Math.max(0, Date.now() - last - LOOP_BLOCKED_SAMPLE_MS),
    stop: () => clearInterval(timer),
  };
}

// ---------------------------------------------------------------------------
// Probe registry
// ---------------------------------------------------------------------------

/**
 * The Phase 4 probe family, in the order `skills/session-start/SKILL.md`
 * introduces them (banner order is registry order, never completion order, so
 * a run is reproducible).
 *
 * Census (2026-09-11, `skills/session-start/references/phase-4-ssot-environment-check.md`
 * — the #1157 SKILL.md-size split extracted Phase 4's procedure out of
 * `SKILL.md` itself, so the original 2026-08-23 citation of SKILL.md lines
 * 693-835 no longer resolves; re-run the census against the reference file):
 *   grep -oE 'via `(await )?check[A-Za-z]+' \
 *     skills/session-start/references/phase-4-ssot-environment-check.md   # -> 17
 * plus two probes the prose introduces with different phrasing —
 * `checkBootstrapLockFreshness` ("invoke the bootstrap-lock-freshness probe")
 * and `checkVaultStaleness` ("read the most recent line via …") — for 19.
 * (Prior census, 2026-08-23 at `4f6404e`: 16 + 2 = 18 — one probe was
 * registered since without a matching update here. This count is deliberately
 * NOT pinned by an exact-equality test against `PROBES.length` — the registry
 * is exactly the "dynamically-grown artifact set" `.claude/rules/testing.md`
 * § Dynamic Artifact Counts bans exact-count assertions for, and a regex over
 * this prose paragraph would break on every rewording rather than on drift
 * that matters. Re-run the grep above by hand whenever a probe is added or
 * removed, so this comment and `skills/session-start/SKILL.md` § Phase 4
 * stay in sync with each other.)
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
 *   - `followUp`   optional; `async (result, ctx, requery) => result'` run
 *                  INSIDE the budget race after the entry function, where
 *                  `requery(extra)` re-invokes it with `{...args, ...extra}`.
 *                  If it throws or overruns the budget, the entry function's
 *                  result stands (recorded `followUp: 'threw'|'budget-exceeded'`).
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
    // No custom severityOf needed (#1159 single-vocabulary fix, N3 in the
    // #1158/#1159 review): the probe's THIRD shape — `{severity:'warn',
    // kind:'probe-stale'}` when its last record is older than
    // MAX_RECORD_AGE_DAYS — now carries `severity: 'warn'` directly, so the
    // module-level default severityOf() below (which reads `result.severity`
    // verbatim) already renders it. The registry previously remapped a
    // distinct `severity: 'info'` value by hand; that second vocabulary is
    // gone from the source, so the remap is gone here too. See
    // vault-staleness-banner.mjs's header for the "one vocabulary, not two"
    // rationale.
  },
  {
    id: 'telemetry-flush-health',
    spec: local('./telemetry-flush-health-banner.mjs'),
    fn: 'checkTelemetryFlushHealth',
    network: false,
    args: ({ repoRoot }) => ({ repoRoot }),
    // No custom render/severityOf: the probe returns `{severity:'warn',
    // message}` — exactly the shape the module-level defaults below read. It
    // reports the LAST `orchestrator.telemetry.flush` record when that record
    // is a `sandbox:*` refusal (#1255); the refusal reached the ledger and
    // nothing else before this entry existed.
  },
  {
    id: 'ci-status',
    spec: local('./ci-status-banner.mjs'),
    fn: 'checkCiStatus',
    network: true,
    args: ({ repoRoot }) => ({ repoRoot }),
    // #1332: on `no-pipeline-for-head-sha` / `no-check-runs-for-head`, query
    // the last PUSHED commit's verdict via `checkCiStatus({ sha })` — see the
    // ceiling on the function.
    followUp: ciPushedFollowUp,
    // Bespoke shape: `{status, ok, details, …}` with no `message` field. The
    // banner text is prescribed by SKILL.md § Phase 4.
    //
    // The degraded branch is NOT decoration (#1031): this entry overrides BOTH
    // `render` and `severityOf`, so the module-level defaults that already
    // handle a `{severity:'warn', message, degraded}` result never run for this
    // probe. Without these two lines a degraded ci-status result scored `'ok'`
    // and rendered nothing — "could not read" displayed exactly like "green",
    // which is the confusion the probe's own migration removed one layer down.
    render: (r, ctx) => {
      if (!r || typeof r !== 'object') return null;
      if (r.degraded) return typeof r.message === 'string' && r.message ? r.message : null;
      // `status: 'unknown'` is the SAME collapse one level over: HEAD carries
      // no pipeline (the normal state of a working session with local commits),
      // so the probe cannot say anything about CI — while the last PUSHED
      // commit may be red. Measured 2026-09-12: HEAD had 2 unpushed commits,
      // origin/main's pipeline #9301 was red, and session-start printed
      // nothing. Silence there reads as green; it is not.
      if (r.status === 'unknown') {
        const reason = r.details?.reason ?? 'reason unrecorded';
        // #1337: a RED pushed commit is an alert, and the banner says what the
        // rule judges (HR-106) — same 🚨 as a red HEAD.
        const mark = r.pushed?.verdict?.status === 'red' ? '🚨' : '⚠';
        return `${mark} ci-status: CI status for HEAD could not be determined (${reason}) — ${ciUnknownHint(r, ctx)}`;
      }
      if (r.status === 'red') {
        const pid = r.details?.currentPipelineId ?? '?';
        const green = r.lastGreen
          ? ` — last green: #${r.lastGreen.pipelineId} (commit ${String(r.lastGreen.sha ?? '').slice(0, 7)}, ${r.redCount} pipelines ago)`
          : '';
        const job = r.failingJobName ? ` Failing job: ${r.failingJobName}` : '';
        return `🚨 CI RED on HEAD (pipeline #${pid})${green}.${job}`;
      }
      if (r.status === 'green' && hasFailedAllowFailureJobs(r)) {
        const names = r.allowFailureJobs.map((j) => j?.name ?? String(j)).join(', ');
        return `⚠ CI green on HEAD, but ${r.allowFailureJobs.length} allow_failure job(s) FAILED: ${names}. A pipeline reports success regardless of these.`;
      }
      return null;
    },
    // `status: 'red'` is an alert even though the probe publishes no severity.
    // A degraded result is a finding, never clean — same rule as the generic
    // path in `severityOf()` below.
    severityOf: (r) => {
      // `null` is a COMPLETE answer — "this repo has no CI" — and stays clean.
      // Every other non-green status is "state not determined", never `ok`
      // (HR-105: a probe that scores an undeterminable state as clean is an
      // instrument that cannot report the thing it exists to report).
      if (!r || typeof r !== 'object') return 'ok';
      if (r.degraded) return 'warn';
      if (r.status === 'red') return 'alert';
      if (r.status === 'green') return hasFailedAllowFailureJobs(r) ? 'warn' : 'ok';
      // #1337: HEAD undetermined but the pushed commit's pipeline is red —
      // the code on origin is broken, so this is an alert, not a warning.
      if (r.pushed?.verdict?.status === 'red') return 'alert';
      return 'warn';
    },
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
    // No precondition (#1132): this probe counts the always-on directive
    // corpus under `.claude/rules/`, and a repo without that directory has an
    // empty corpus — a legitimate measured answer, not a declined measurement.
    // A `no-rules-dir` precondition used to sit here purely to dodge a stderr
    // side-effect in `rule-loader.loadApplicableRules`; that side-effect is now
    // category-gated at its source, so the precondition suppressed nothing and
    // cost a misleading `skipped: 'no-rules-dir'` record.
    args: ({ repoRoot }) => ({ repoRoot }),
  },
  {
    // Replaces the former `reconcile-nudge` entry AND the two session-end
    // nudges (3.6.5 auto-dream, 3.6.7 auto-dialectic): one reading of the whole
    // maintenance loop, at the one moment the operator can act on it. The
    // reconcile signal is not lost — `maintenance-due-banner.mjs` calls
    // `computeReconcileNudge` wholesale as its S3, so `reconcile-nudge-banner.mjs`
    // remains a live dependency, just no longer its own registry entry (a
    // second entry would double-report the same finding).
    id: 'maintenance-due',
    spec: local('./maintenance-due-banner.mjs'),
    fn: 'checkMaintenanceDue',
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
 * Race `promise` against a budget denominated in the probe's OWN work time —
 * wall-clock elapsed MINUS the time a synchronous sibling held the event loop
 * (see {@link startLoopBlockedMeter} for why that subtraction is the whole
 * point).
 *
 * The loser is neutralised (`.catch`) before the race so a late rejection can
 * never surface as an unhandled rejection and kill an exit-0 hook.
 *
 * Two properties worth stating, because both were live defects:
 *
 *  - **A delivered result is never discarded.** When the budget really is
 *    exhausted, the already-settled promise still wins: "measured, then thrown
 *    away" is worse than not measuring (the module's own rule, stated at the
 *    telemetry boundary below). Only a probe that has produced nothing is a
 *    `timeout`.
 *  - **Termination.** The re-arm loop only repeats while blocked time is
 *    accruing, i.e. while some sibling monopolises the loop. Siblings are
 *    finite and synchronous, so the loop cannot spin forever; once they
 *    release, work time advances and the budget binds normally.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} budgetMs — the probe's own-work budget; `<= 0` times out.
 * @param {{ read: () => number }} meter — loop-blocked meter.
 * @returns {Promise<{ raced: T|symbol, workMs: number }>}
 */
async function withWorkDeadline(promise, budgetMs, meter) {
  let done = false;
  /** @type {unknown} */
  let value;
  const settled = promise.catch((err) => ({ __probeError: err })).then((v) => {
    done = true;
    value = v;
    return v;
  });

  const t0 = Date.now();
  const blocked0 = meter.read();
  const workElapsed = () => Date.now() - t0 - (meter.read() - blocked0);

  for (;;) {
    const remaining = budgetMs - workElapsed();
    if (remaining <= 0) {
      // Budget exhausted — but a probe that already delivered is not a timeout.
      return { raced: done ? value : TIMED_OUT, workMs: workElapsed() };
    }
    let timer;
    const expiry = new Promise((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), remaining);
      // Never hold the event loop open for the timer alone.
      if (typeof timer?.unref === 'function') timer.unref();
    });
    let raced;
    try {
      raced = await Promise.race([settled, expiry]);
    } finally {
      clearTimeout(timer);
    }
    if (raced !== TIMED_OUT) return { raced, workMs: workElapsed() };
    // The timer fired, but it may have fired LATE because the loop was blocked.
    // Recheck against work time; re-arm for whatever budget is genuinely left.
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
  return s === 'alert' || s === 'warn' ? s : 'ok';
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
  // Per-probe, denominated in the probe's own work time — NOT a shared
  // wall-clock deadline. A shared wall deadline charged every probe for its
  // siblings' non-preemptible `execFileSync` calls; see
  // {@link startLoopBlockedMeter}.
  const budgetMs = Math.max(0, Number(timeoutMs) || 0);
  const meter = startLoopBlockedMeter();

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

      // The entry function's result once it has returned, for probes with a
      // `followUp`. The follow-up is optional enrichment: when it throws or
      // overruns, the probe still DELIVERED, and "a probe that already
      // delivered is not a timeout" (withWorkDeadline) applies to it too.
      /** @type {{__probeResult: *}|null} */
      let delivered = null;
      /** @type {'threw'|'budget-exceeded'|undefined} */
      let followUpFailure;

      // The whole invocation — import included — is inside the race, because a
      // pre-#369-style absent module and a hung probe are both "did not
      // deliver" and both must resolve to an outcome rather than to a throw.
      const invocation = (async () => {
        const mod = await import(probe.spec);
        const fn = mod?.[probe.fn];
        if (typeof fn !== 'function') {
          return { __probeError: new Error(`export ${probe.fn} missing`), __absent: true };
        }
        const first = await fn(probe.args(ctx));
        if (typeof probe.followUp !== 'function') return { __probeResult: first };
        delivered = { __probeResult: first };
        // Optional second step (#1332, `ci-status` only today), inside this
        // race so it spends the SAME per-probe budget — NAMED CEILING (BV-004):
        // it gets exactly what the entry function left of `budgetMs`, with no
        // second timer and no margin, because the fallback is decided AFTER
        // the race below: a timeout with `delivered` set is `delivered`.
        try {
          return {
            __probeResult: await probe.followUp(first, ctx, (extra) => fn({ ...probe.args(ctx), ...extra })),
          };
        } catch {
          followUpFailure = 'threw';
          return delivered;
        }
      })();

      const deadline = await withWorkDeadline(invocation, budgetMs, meter);
      const { workMs } = deadline;
      let { raced } = deadline;
      if (raced === TIMED_OUT && delivered) {
        // The follow-up is what ran out of budget, not the probe. Its pending
        // promise is abandoned exactly as a hung probe's would be.
        raced = delivered;
        followUpFailure = 'budget-exceeded';
      }

      if (raced === TIMED_OUT) {
        record('timeout', { reason: 'budget-exceeded', workMs });
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
      // `ctx` (repoRoot/config/env) is passed as a SECOND argument so a
      // renderer can name a repo-local fact the probe result does not carry
      // (the `ci-status` unknown branch names the last pushed SHA). Every
      // existing renderer takes one parameter and ignores it.
      const line = typeof probe.render === 'function'
        ? probe.render(result, ctx)
        : defaultRender(result, severity);
      record(severity === 'ok' ? 'ran-clean' : severity === 'warn' ? 'ran-warn' : 'ran-alert', {
        severity,
        workMs,
        ...(followUpFailure ? { followUp: followUpFailure } : {}),
        ...(line ? { line } : {}),
      });
    }),
  );

  meter.stop();

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
      // `work_ms` is the quantity the `timeout` verdict is computed FROM, so it
      // has to reach the ledger (`.claude/rules/host-resources.md` § HR-105 — a
      // rule you cannot falsify is not a rule). `duration_ms` at probe level is
      // deliberately NOT persisted: under parallel launch it ranks contention,
      // not work, and persisting a misleading field was the #1089 failure.
      ...(Number.isFinite(r.workMs) ? { work_ms: Math.round(r.workMs) } : {}),
      // A follow-up that fell back to the delivered result is otherwise
      // invisible (the outcome is `ran-*`); this is its revisit trigger's input.
      ...(typeof r.followUp === 'string' ? { follow_up: r.followUp } : {}),
    })),
  };

  // Telemetry is best-effort like every other side effect here: a ledger that
  // cannot be written must not cost the operator his banners.
  try {
    await emit('orchestrator.probes.completed', event, { repoRoot });
  } catch { /* never block the caller */ }

  return { bannerLines, results, event };
}
