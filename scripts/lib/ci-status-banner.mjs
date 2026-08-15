/**
 * ci-status-banner.mjs — #369
 * Checks CI status for the current HEAD commit and returns a structured
 * result for session-start Phase 4 banner rendering.
 *
 * Plain-JS — no Zod dependency. Never throws. Returns null on any
 * no-op condition (no VCS, CLI missing, timeout, parse failure).
 *
 * Supports GitLab (via glab) and GitHub (via gh).
 * VCS is auto-detected from git remote origin URL per gitlab-ops canonical logic.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRepoSpec, resolveRepoHost, redactUrlCredentials } from './vcs-repo-spec.mjs';

const execFileAsync = promisify(_execFile);

/** Default timeout in milliseconds for CLI invocations. */
export const DEFAULT_TIMEOUT_MS = 8000;

/**
 * Wraps execFile with a per-call timeout race.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number, execFile?: Function }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function execWithTimeout(cmd, args, opts = {}) {
  const { cwd, timeoutMs = DEFAULT_TIMEOUT_MS, execFile = execFileAsync } = opts;
  return Promise.race([
    execFile(cmd, args, { cwd, env: process.env }),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs),
    ),
  ]);
}

/**
 * Detect VCS from git remote URL.
 * Returns 'github' | 'gitlab'. Throws if git is unavailable or no origin.
 *
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
 * @returns {Promise<'github'|'gitlab'>}
 */
async function detectVcs(repoRoot, deps = {}) {
  // Use the smaller of 2000ms or the caller-supplied timeout so that a short
  // test-level timeout is still respected here.
  const gitTimeout = Math.min(2000, deps.timeoutMs ?? 2000);
  const result = await execWithTimeout(
    'git',
    ['remote', 'get-url', 'origin'],
    { cwd: repoRoot, timeoutMs: gitTimeout, execFile: deps.execFile },
  );
  const remoteUrl = result.stdout.trim();
  return remoteUrl.includes('github.com') ? 'github' : 'gitlab';
}

/**
 * Get current HEAD commit SHA.
 *
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
 * @returns {Promise<string>}
 */
async function getHeadSha(repoRoot, deps = {}) {
  const gitTimeout = Math.min(2000, deps.timeoutMs ?? 2000);
  const result = await execWithTimeout(
    'git',
    ['rev-parse', 'HEAD'],
    { cwd: repoRoot, timeoutMs: gitTimeout, execFile: deps.execFile },
  );
  return result.stdout.trim();
}

/**
 * Get GitLab project ID via glab.
 *
 * #872: pins to `deps.repoSpec` via `-R` when resolved (host-pinning —
 * `glab repo view` otherwise falls back to the ambient `GITLAB_HOST`).
 *
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number, repoSpec?: string }} deps
 * @returns {Promise<number>}
 */
async function getGlabProjectId(repoRoot, deps = {}) {
  const args = ['repo', 'view', '--output', 'json'];
  if (deps.repoSpec) args.push('-R', deps.repoSpec);
  const result = await execWithTimeout(
    'glab',
    args,
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  const parsed = JSON.parse(result.stdout);
  return parsed.id;
}

/**
 * Run `glab api <path>` and return parsed JSON.
 *
 * #872: `glab api` has no repo/`-R` concept — it accepts only `--hostname`
 * to pin which GitLab instance the request targets. Pinned via
 * `deps.repoHost` when resolved.
 *
 * @param {string} apiPath
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number, repoHost?: string }} deps
 * @returns {Promise<unknown>}
 */
async function glabApi(apiPath, repoRoot, deps = {}) {
  const args = ['api', apiPath];
  if (deps.repoHost) args.push('--hostname', deps.repoHost);
  const result = await execWithTimeout(
    'glab',
    args,
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  return JSON.parse(result.stdout);
}

/**
 * Run `gh api <path>` and return parsed JSON.
 *
 * #872: `gh api` has no repo/`-R` concept either — pinned via `--hostname`
 * from `deps.repoHost` when resolved.
 *
 * @param {string} apiPath
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number, repoHost?: string }} deps
 * @returns {Promise<unknown>}
 */
async function ghApi(apiPath, repoRoot, deps = {}) {
  const args = ['api', apiPath];
  if (deps.repoHost) args.push('--hostname', deps.repoHost);
  const result = await execWithTimeout(
    'gh',
    args,
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  return JSON.parse(result.stdout);
}

/**
 * Compute age in whole days between an ISO date string and `now`.
 *
 * @param {string} isoDate
 * @param {number} now  Unix epoch ms
 * @returns {number|null}
 */
function ageDaysFrom(isoDate, now) {
  const ts = Date.parse(isoDate);
  if (Number.isNaN(ts)) return null;
  return Math.floor((now - ts) / (24 * 60 * 60 * 1000));
}

/**
 * GitLab CI status check.
 * Returns a status result object or null on unrecoverable error.
 *
 * @param {string} repoRoot
 * @param {number} now
 * @param {{ execFile?: Function, timeoutMs?: number, repoSpec?: string, repoHost?: string }} deps
 * @returns {Promise<object|null>}
 */
async function checkGitlab(repoRoot, now, deps = {}) {
  const projectId = await getGlabProjectId(repoRoot, deps);
  const currentSha = await getHeadSha(repoRoot, deps);

  const pipelines = await glabApi(
    `projects/${projectId}/pipelines?order_by=updated_at&sort=desc&per_page=15`,
    repoRoot,
    deps,
  );

  if (!Array.isArray(pipelines)) return null;

  const currentPipeline = pipelines.find((p) => p.sha === currentSha);

  if (!currentPipeline) {
    return {
      status: 'unknown',
      ok: false,
      details: {
        currentPipelineId: null,
        cliUsed: 'glab',
        reason: 'no-pipeline-for-head-sha',
      },
    };
  }

  const pipelineStatus = currentPipeline.status;

  if (pipelineStatus === 'success') {
    // A pipeline reports `success` even when jobs marked `allow_failure: true`
    // failed. Those jobs are invisible at the pipeline level, so a permanently
    // red allow-failure job (observed: 4/4 consecutive pipelines) would never
    // surface. Inspect the job list to name them. Non-fatal: a failed job query
    // still yields a plain green result.
    let allowFailureJobs;
    try {
      const jobs = await glabApi(
        `projects/${projectId}/pipelines/${currentPipeline.id}/jobs`,
        repoRoot,
        deps,
      );
      if (Array.isArray(jobs)) {
        const softFailed = jobs
          .filter((j) => j.status === 'failed' && j.allow_failure === true)
          .map((j) => j.name);
        if (softFailed.length > 0) allowFailureJobs = softFailed;
      }
    } catch {
      // Non-fatal — report green without the allow-failure detail.
    }

    return {
      status: 'green',
      ok: true,
      ...(allowFailureJobs ? { allowFailureJobs } : {}),
      details: {
        currentPipelineId: currentPipeline.id,
        cliUsed: 'glab',
      },
    };
  }

  if (pipelineStatus === 'running' || pipelineStatus === 'pending') {
    return {
      status: 'unknown',
      ok: false,
      details: {
        currentPipelineId: currentPipeline.id,
        cliUsed: 'glab',
        reason: `pipeline-${pipelineStatus}`,
      },
    };
  }

  if (pipelineStatus === 'failed' || pipelineStatus === 'canceled') {
    // Find the last green pipeline in the history.
    const currentIdx = pipelines.indexOf(currentPipeline);
    const rest = pipelines.slice(currentIdx + 1);
    const lastGreenPipeline = rest.find((p) => p.status === 'success');

    // Count consecutive non-success pipelines from current onwards.
    let redCount = 1;
    for (const p of rest) {
      if (p.status === 'success') break;
      redCount++;
    }

    let lastGreen;
    if (lastGreenPipeline) {
      const ageDays = ageDaysFrom(lastGreenPipeline.created_at, now);
      // Approximate commit distance: redCount is the number of red pipelines
      // before reaching the last green (pipelines are one-per-commit on this project).
      lastGreen = {
        sha: lastGreenPipeline.sha,
        pipelineId: lastGreenPipeline.id,
        ageCommits: redCount,
        ageDays,
      };
    }

    // Get the name of the first failing job on the current pipeline.
    let failingJobName;
    try {
      const jobs = await glabApi(
        `projects/${projectId}/pipelines/${currentPipeline.id}/jobs`,
        repoRoot,
        deps,
      );
      if (Array.isArray(jobs)) {
        const failedJob = jobs.find((j) => j.status === 'failed');
        failingJobName = failedJob ? failedJob.name : undefined;
      }
    } catch {
      // Non-fatal — we still report red status without job name.
    }

    return {
      status: 'red',
      ok: false,
      ...(lastGreen ? { lastGreen } : {}),
      redCount,
      ...(failingJobName !== undefined ? { failingJobName } : {}),
      details: {
        currentPipelineId: currentPipeline.id,
        cliUsed: 'glab',
      },
    };
  }

  // Any other status (skipped, manual, etc.) → unknown.
  return {
    status: 'unknown',
    ok: false,
    details: {
      currentPipelineId: currentPipeline.id,
      cliUsed: 'glab',
      reason: `unrecognised-status-${pipelineStatus}`,
    },
  };
}

/**
 * GitHub CI status check (v1 — red/green only; lastGreen not implemented).
 *
 * #872/#1022: pins the `gh repo view` lookup to `deps.repoSpec` when resolved
 * (host-pinning — `gh repo view` otherwise falls back to the ambient
 * `GH_HOST`). The spec is passed POSITIONALLY, not via `-R`: `gh repo view`
 * takes `[<repository>]` as a positional argument and has no `-R`/`--repo`
 * flag at all, so `-R` made gh exit 1 with `unknown shorthand flag: 'R'` —
 * an error `checkCiStatus`'s outer catch swallowed to `null`, leaving the
 * Phase 4 banner silently dead on EVERY GitHub repo (#1022). The
 * `[HOST/]OWNER/REPO` shape `resolveRepoSpec({ vcs: 'github' })` returns is
 * exactly the positional's documented input format.
 *
 * The asymmetry with `getGlabProjectId` is real and deliberate: `glab repo
 * view` DOES accept `-R`, and `gh api`/`glab api` accept neither `-R` nor a
 * positional — only `--hostname`. Do not unify these three call sites.
 *
 * `nameWithOwner` is NOT derivable from `deps.repoSpec`, so this lookup
 * cannot be dropped: the spec carries a HOST prefix the `repos/<owner>/<repo>`
 * API path must not contain, it is `undefined` whenever no remote resolves
 * (cross-family guard, unsafe-argv guard), and `normalizeGithubSpec` falls
 * back to the raw URL on an unrecognised remote shape.
 *
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number, repoSpec?: string, repoHost?: string }} deps
 * @returns {Promise<object|null>}
 */
async function checkGithub(repoRoot, deps = {}) {
  // Resolve owner/repo from gh to keep the API path generic.
  const repoViewArgs = ['repo', 'view'];
  if (deps.repoSpec) repoViewArgs.push(deps.repoSpec);
  repoViewArgs.push('--json', 'nameWithOwner');
  const repoViewResult = await execWithTimeout(
    'gh',
    repoViewArgs,
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  const { nameWithOwner } = JSON.parse(repoViewResult.stdout);

  const data = await ghApi(
    `repos/${nameWithOwner}/commits/HEAD/check-runs`,
    repoRoot,
    deps,
  );

  const checkRuns = data.check_runs;
  if (!Array.isArray(checkRuns) || checkRuns.length === 0) {
    return {
      status: 'unknown',
      ok: false,
      details: {
        cliUsed: 'gh',
        reason: 'no-check-runs-for-head',
      },
    };
  }

  const failedRun = checkRuns.find(
    (r) => r.conclusion === 'failure' || r.conclusion === 'action_required',
  );

  if (failedRun) {
    return {
      status: 'red',
      ok: false,
      failingJobName: failedRun.name,
      details: {
        cliUsed: 'gh',
        reason: 'lastGreen-not-implemented-for-github',
      },
    };
  }

  const allSuccess = checkRuns.every((r) => r.conclusion === 'success');
  if (allSuccess) {
    return {
      status: 'green',
      ok: true,
      details: {
        cliUsed: 'gh',
      },
    };
  }

  // Some runs pending / in-progress / etc.
  return {
    status: 'unknown',
    ok: false,
    details: {
      cliUsed: 'gh',
      reason: 'check-runs-not-complete',
    },
  };
}

/**
 * Checks CI status for the current HEAD commit.
 *
 * Returns `null` (silent no-op) when:
 *   - Not in a VCS repo (no git origin)
 *   - Required CLI (glab / gh) not in PATH
 *   - Any CLI invocation times out
 *   - JSON parse failure on CLI output
 *
 * @param {{
 *   repoRoot?: string,
 *   vcs?: 'gitlab'|'github',
 *   timeoutMs?: number,
 *   now?: number,
 * }} opts
 * @param {{
 *   execFile?: Function,
 *   resolveRepoSpec?: (opts: { repoRoot: string, vcs: 'gitlab'|'github' }) => string|undefined,
 *   resolveRepoHost?: (opts: { repoRoot: string, vcs: 'gitlab'|'github' }) => string|undefined,
 * }} deps  Dependency-injection seam for testing. `resolveRepoSpec`/
 *   `resolveRepoHost` default to the real `vcs-repo-spec.mjs` exports
 *   (#872 host-pinning — see that module for the `-R` vs `--hostname`
 *   contract).
 * @returns {Promise<null | {
 *   status: 'green'|'red'|'unknown',
 *   ok: boolean,
 *   lastGreen?: { sha: string, pipelineId: number, ageCommits: number, ageDays: number|null },
 *   redCount?: number,
 *   failingJobName?: string,
 *   details: {
 *     currentPipelineId?: number,
 *     cliUsed: 'glab'|'gh',
 *     reason?: string,
 *     error?: string,
 *   },
 * }>}
 */
export async function checkCiStatus(opts = {}, deps = {}) {
  const {
    repoRoot = process.cwd(),
    vcs: forcedVcs,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = Date.now(),
  } = opts;

  const execFileDep = deps.execFile
    ? promisify(deps.execFile)
    : execFileAsync;

  const resolveRepoSpecDep = deps.resolveRepoSpec ?? resolveRepoSpec;
  const resolveRepoHostDep = deps.resolveRepoHost ?? resolveRepoHost;

  const depsWithExec = { execFile: execFileDep, timeoutMs };

  try {
    // Step 1: detect VCS (or use forced value).
    let vcs = forcedVcs;
    if (!vcs) {
      try {
        vcs = await detectVcs(repoRoot, depsWithExec);
      } catch {
        // No git remote → not in a VCS repo → silent no-op.
        return null;
      }
    }

    // Step 1b (#872): resolve the -R/--hostname host-pinning spec ONCE per
    // checkCiStatus call — a bare glab/gh spawn falls back to the ambient
    // GITLAB_HOST/GH_HOST env var, which can silently target the wrong
    // instance on a multi-instance host. `cwd: repoRoot` alone does not fix
    // this (ambient env still wins over cwd).
    const repoSpec = resolveRepoSpecDep({ repoRoot, vcs });
    const repoHost = resolveRepoHostDep({ repoRoot, vcs });
    const depsWithPinning = { ...depsWithExec, repoSpec, repoHost };

    // Step 2: dispatch to VCS-specific implementation.
    if (vcs === 'gitlab') {
      return await checkGitlab(repoRoot, now, depsWithPinning);
    }

    if (vcs === 'github') {
      return await checkGithub(repoRoot, depsWithPinning);
    }

    // Unknown VCS value — silent no-op.
    return null;
  } catch (err) {
    // Swallow all errors: ENOENT (CLI missing), timeout, parse failures.
    // These are all no-op conditions per the spec.
    const msg = err instanceof Error ? err.message : String(err);

    // Timeout and ENOENT (missing CLI) → silent null.
    if (
      msg === 'timeout' ||
      (err && err.code === 'ENOENT')
    ) {
      return null;
    }

    // Everything else means the CLI was PRESENT but the invocation failed —
    // non-zero exit, rejected flag, unparseable output. Returning a bare null
    // here makes that state indistinguishable from "CLI not installed", which
    // is exactly how #1022 (`gh repo view -R` → `unknown shorthand flag: 'R'`)
    // stayed invisible on every GitHub repo. THIS module keeps the two-state
    // contract (null ⇒ silent no-op) for backwards compatibility with the
    // Phase-4 callers already written against it, so leave a stderr trace
    // instead: non-blocking, but the next defect of this class is no longer
    // silent. Credentials redacted defense-in-depth (#907) — the message can
    // quote the failed argv, which carries the repo spec.
    //
    // DIRECTION FOR NEW BANNERS — do not copy this shape. The
    // absence-preserving form is `scripts/lib/mirror-issues-banner.mjs`: a
    // THIRD return state `{ severity, message, degraded }` whose `degraded`
    // is a member of the closed `DEGRADED_REASONS` enum exported there, so
    // "could not read" stays distinguishable from "read, and clean". This
    // module is the UNMIGRATED side of that contract — the `status:'unknown'`
    // returns above cover some in-band failures, but this outer catch still
    // collapses onto `null`, which a caller reads as all-clear. Same verdict,
    // stated caller-side, in `skills/session-start/SKILL.md` § Phase 4 (the
    // mirror-issues paragraph): "Do not reproduce it."
    console.warn(
      `WARN ci-status-banner: CI status check failed, banner suppressed — ${redactUrlCredentials(msg)}`,
    );
    return null;
  }
}
