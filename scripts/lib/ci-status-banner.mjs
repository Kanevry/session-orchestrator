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
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
 * @returns {Promise<number>}
 */
async function getGlabProjectId(repoRoot, deps = {}) {
  const result = await execWithTimeout(
    'glab',
    ['repo', 'view', '--output', 'json'],
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  const parsed = JSON.parse(result.stdout);
  return parsed.id;
}

/**
 * Run `glab api <path>` and return parsed JSON.
 *
 * @param {string} apiPath
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
 * @returns {Promise<unknown>}
 */
async function glabApi(apiPath, repoRoot, deps = {}) {
  const result = await execWithTimeout(
    'glab',
    ['api', apiPath],
    { cwd: repoRoot, timeoutMs: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS, execFile: deps.execFile },
  );
  return JSON.parse(result.stdout);
}

/**
 * Run `gh api <path>` and return parsed JSON.
 *
 * @param {string} apiPath
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
 * @returns {Promise<unknown>}
 */
async function ghApi(apiPath, repoRoot, deps = {}) {
  const result = await execWithTimeout(
    'gh',
    ['api', apiPath],
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
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
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
    return {
      status: 'green',
      ok: true,
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
 * @param {string} repoRoot
 * @param {{ execFile?: Function, timeoutMs?: number }} deps
 * @returns {Promise<object|null>}
 */
async function checkGithub(repoRoot, deps = {}) {
  // Resolve owner/repo from gh to keep the API path generic.
  const repoViewResult = await execWithTimeout(
    'gh',
    ['repo', 'view', '--json', 'nameWithOwner'],
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
 * }} deps  Dependency-injection seam for testing.
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

    // Step 2: dispatch to VCS-specific implementation.
    if (vcs === 'gitlab') {
      return await checkGitlab(repoRoot, now, depsWithExec);
    }

    if (vcs === 'github') {
      return await checkGithub(repoRoot, depsWithExec);
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

    // Unexpected errors → also silent null to keep the banner non-blocking.
    return null;
  }
}
