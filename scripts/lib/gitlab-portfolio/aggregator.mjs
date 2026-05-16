/**
 * aggregator.mjs — Fetch and normalize open issues from GitLab / GitHub repos.
 *
 * Exports:
 *   fetchRepoIssues(opts)         — single-repo fetch
 *   fetchIssuesMultiRepo(opts)    — parallel multi-repo fetch via Promise.allSettled
 *   summarizeRepo(issues, opts)   — compute per-repo summary stats
 *
 * Security: uses spawn (never exec/execSync with shell strings) — SEC-006.
 * Testable: accepts spawn as an injected dependency.
 */

import { spawn as _spawn } from 'node:child_process';

/** Default timeout per repo CLI invocation (ms). */
export const DEFAULT_TIMEOUT_MS = 15_000;

/** Default max parallel CLI invocations. */
export const DEFAULT_CONCURRENCY = 8;

/** Default issues per-page. */
export const DEFAULT_PER_PAGE = 100;

// ── Normalization ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw issue object from glab or gh into a consistent shape.
 *
 * @param {object} issue  — raw issue from glab or gh JSON output
 * @param {'gitlab'|'github'} vcs
 * @param {string} repo   — canonical "owner/name" identifier
 * @returns {NormalizedIssue}
 */
export function normalizeIssue(issue, vcs, repo) {
  return {
    iid: issue.iid ?? issue.number,
    title: issue.title,
    body: issue.body ?? issue.description ?? '',
    labels: (issue.labels ?? [])
      .map((l) => (typeof l === 'string' ? l : l?.name))
      .filter(Boolean),
    updated_at: issue.updated_at ?? issue.updatedAt,
    milestone: issue.milestone ?? null,
    state: (issue.state ?? 'opened').toLowerCase(),
    url: issue.web_url ?? issue.url,
    vcs,
    repo,
  };
}

// ── CLI invocation helpers ─────────────────────────────────────────────────────

/**
 * Run a CLI command with genuine process termination on timeout.
 *
 * Uses spawn() + AbortController so the child process is actually killed via
 * SIGTERM when the timeout fires — unlike the previous Promise.race approach
 * which abandoned the child without sending any signal. This ensures no orphan
 * processes are left behind on slow repos, directly addressing GitHub #45 (LOW
 * execFile AbortSignal resource hygiene) and matching the playwright-driver
 * precedent established in runner.mjs (issue #399).
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, spawn?: Function }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function execWithTimeout(cmd, args, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, spawn: spawnImpl = _spawn } = opts;

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const proc = spawnImpl(cmd, args, {
      env: process.env,
      signal: controller.signal,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk; });
    proc.stderr.on('data', (chunk) => { stderr += chunk; });

    return await new Promise((resolve, reject) => {
      proc.on('error', (err) => {
        if (err.name === 'AbortError') {
          reject(new Error(`timeout: ${cmd} ${args[0]} after ${timeoutMs}ms`));
        } else {
          reject(err);
        }
      });
      proc.on('close', (code, signal) => {
        if (signal === 'SIGTERM' || code === null) {
          reject(new Error(`timeout: ${cmd} ${args[0]} after ${timeoutMs}ms`));
        } else if (code !== 0) {
          const err = new Error(`exit ${code}: ${cmd} ${args[0]}`);
          err.stdout = stdout;
          err.stderr = stderr;
          reject(err);
        } else {
          resolve({ stdout, stderr });
        }
      });
    });
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// ── Single-repo fetch ─────────────────────────────────────────────────────────

/**
 * Fetch and normalize open issues from a single repo.
 *
 * @param {{
 *   repo: string,
 *   vcs: 'gitlab'|'github',
 *   perPage?: number,
 *   timeoutMs?: number,
 *   spawn?: Function,
 * }} opts
 * @returns {Promise<{ ok: true, issues: NormalizedIssue[] } | { ok: false, error: string }>}
 */
export async function fetchRepoIssues(opts) {
  const {
    repo,
    vcs,
    perPage = DEFAULT_PER_PAGE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    spawn = _spawn,
  } = opts;

  if (!repo || typeof repo !== 'string') {
    return { ok: false, error: 'repo must be a non-empty string' };
  }
  if (vcs !== 'gitlab' && vcs !== 'github') {
    return { ok: false, error: `vcs must be 'gitlab' or 'github', got: ${vcs}` };
  }

  let cmd;
  let args;

  if (vcs === 'gitlab') {
    cmd = 'glab';
    args = [
      'issue', 'list',
      '--repo', repo,
      '--per-page', String(perPage),
      '--output', 'json',
    ];
  } else {
    cmd = 'gh';
    args = [
      'issue', 'list',
      '--repo', repo,
      '--limit', String(perPage),
      '--json', 'number,title,body,labels,updatedAt,milestone,state,url',
    ];
  }

  try {
    const result = await execWithTimeout(cmd, args, { timeoutMs, spawn });
    const raw = String(result.stdout ?? '').trim();
    if (!raw) {
      return { ok: false, error: `${cmd} returned empty output for ${repo}` };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      return { ok: false, error: `JSON parse failure for ${repo}: ${parseErr.message}` };
    }

    if (!Array.isArray(parsed)) {
      return { ok: false, error: `Expected array from ${cmd} for ${repo}, got ${typeof parsed}` };
    }

    // Filter to open issues only (defensive — CLI should already filter, but
    // glab may include all states on some versions).
    const issues = parsed
      .filter((issue) => {
        const state = (issue.state ?? '').toLowerCase();
        return state === 'opened' || state === 'open';
      })
      .map((issue) => normalizeIssue(issue, vcs, repo));

    return { ok: true, issues };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `fetch failed for ${repo}: ${msg}` };
  }
}

// ── Multi-repo parallel fetch ──────────────────────────────────────────────────

/**
 * Simple semaphore for bounding concurrency without external dependencies.
 *
 * @param {number} limit
 * @returns {{ acquire: () => Promise<void>, release: () => void }}
 */
function createSemaphore(limit) {
  let active = 0;
  const queue = [];

  function release() {
    active--;
    if (queue.length > 0) {
      const next = queue.shift();
      active++;
      next();
    }
  }

  function acquire() {
    if (active < limit) {
      active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => queue.push(resolve));
  }

  return { acquire, release };
}

/**
 * Fetch issues from many repos in parallel, bounded by concurrency.
 * Per-repo failures do not abort the batch — they are recorded as { ok: false }.
 *
 * @param {{
 *   repos: Array<{ repo: string, vcs: 'gitlab'|'github' }>,
 *   perPage?: number,
 *   timeoutMs?: number,
 *   concurrency?: number,
 *   spawn?: Function,
 * }} opts
 * @returns {Promise<Map<string, { ok: boolean, issues?: NormalizedIssue[], error?: string }>>}
 */
export async function fetchIssuesMultiRepo(opts) {
  const {
    repos,
    perPage = DEFAULT_PER_PAGE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
    spawn = _spawn,
  } = opts;

  if (!Array.isArray(repos) || repos.length === 0) {
    return new Map();
  }

  const semaphore = createSemaphore(Math.max(1, concurrency));
  const resultMap = new Map();

  const tasks = repos.map(({ repo, vcs }) => async () => {
    await semaphore.acquire();
    try {
      const result = await fetchRepoIssues({ repo, vcs, perPage, timeoutMs, spawn });
      resultMap.set(repo, result);
    } catch (err) {
      // Should not happen since fetchRepoIssues never throws, but be defensive.
      const msg = err instanceof Error ? err.message : String(err);
      resultMap.set(repo, { ok: false, error: `unexpected error for ${repo}: ${msg}` });
    } finally {
      semaphore.release();
    }
  });

  // Promise.allSettled so a thrown task does not abort other tasks.
  await Promise.allSettled(tasks.map((t) => t()));

  return resultMap;
}

// ── Per-repo summarization ─────────────────────────────────────────────────────

/**
 * Extract the soonest non-null milestone due date from a normalized issue list.
 *
 * @param {NormalizedIssue[]} issues
 * @returns {{ title: string, due_date: string } | null}
 */
function findNextMilestone(issues) {
  let soonest = null;
  let soonestTs = Infinity;

  for (const issue of issues) {
    const ms = issue.milestone;
    if (!ms || typeof ms !== 'object') continue;
    const due = ms.due_date ?? ms.dueOn ?? null;
    if (!due) continue;
    const ts = Date.parse(due);
    if (Number.isNaN(ts)) continue;
    if (ts < soonestTs) {
      soonestTs = ts;
      soonest = { title: ms.title ?? String(ms.id ?? ''), due_date: due };
    }
  }

  return soonest;
}

/**
 * Compute a per-repo summary from a normalized issue list.
 *
 * All issues in the list are assumed to be open (callers should pre-filter).
 *
 * @param {NormalizedIssue[]} issues
 * @param {{
 *   now?: Date,
 *   staleDays: number,
 *   criticalLabels: string[],
 * }} opts
 * @returns {{
 *   openCount: number,
 *   criticalCount: number,
 *   staleCount: number,
 *   nextMilestone: { title: string, due_date: string } | null,
 *   lastActivity: string | null,
 *   topThree: Array<{ iid: number|string, title: string, labels: string[], url: string }>,
 * }}
 */
export function summarizeRepo(issues, opts) {
  const {
    now = new Date(),
    staleDays,
    criticalLabels,
  } = opts;

  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const staleThresholdMs = staleDays * 86_400_000;
  const criticalSet = new Set(Array.isArray(criticalLabels) ? criticalLabels : []);

  let criticalCount = 0;
  let staleCount = 0;
  let lastActivityTs = -Infinity;
  let lastActivityIso = null;

  for (const issue of issues) {
    // Critical
    if (issue.labels.some((l) => criticalSet.has(l))) {
      criticalCount++;
    }

    // Stale
    const updatedTs = issue.updated_at ? Date.parse(issue.updated_at) : NaN;
    if (!Number.isNaN(updatedTs)) {
      if (nowMs - updatedTs > staleThresholdMs) {
        staleCount++;
      }
      if (updatedTs > lastActivityTs) {
        lastActivityTs = updatedTs;
        lastActivityIso = issue.updated_at;
      }
    }
  }

  // Top 3: most recently updated (latest first)
  const sorted = [...issues].sort((a, b) => {
    const ta = a.updated_at ? Date.parse(a.updated_at) : 0;
    const tb = b.updated_at ? Date.parse(b.updated_at) : 0;
    return tb - ta;
  });

  const topThree = sorted.slice(0, 3).map((issue) => ({
    iid: issue.iid,
    title: issue.title,
    labels: issue.labels,
    url: issue.url,
  }));

  return {
    openCount: issues.length,
    criticalCount,
    staleCount,
    nextMilestone: findNextMilestone(issues),
    lastActivity: lastActivityIso,
    topThree,
  };
}
