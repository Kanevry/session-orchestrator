/**
 * aggregator.mjs — Fetch and normalize open issues from GitLab / GitHub repos.
 *
 * Exports:
 *   fetchRepoIssues(opts)         — single-repo fetch
 *   fetchIssuesMultiRepo(opts)    — parallel multi-repo fetch via Promise.allSettled
 *   summarizeRepo(issues, opts)   — compute per-repo summary stats
 *
 * Security: uses execFile (never exec/execSync with shell strings) — SEC-006.
 * Testable: accepts execFile as an injected dependency.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(_execFile);

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
 * Run a CLI command with a timeout race. Kills nothing explicitly — Node
 * garbage-collects the child once the process exits or the timeout fires.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, execFile?: Function }} opts
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function execWithTimeout(cmd, args, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, execFile = execFileAsync } = opts;

  // AbortController is used to signal the timeout branch; the child process
  // itself is not aborted here since promisify(execFile) does not expose the
  // child handle. The race simply lets the outer caller handle the timeout error.
  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timeout: ${cmd} ${args[0]} after ${timeoutMs}ms`)), timeoutMs),
  );

  return Promise.race([
    execFile(cmd, args, { env: process.env }),
    timeoutPromise,
  ]);
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
 *   execFile?: Function,
 * }} opts
 * @returns {Promise<{ ok: true, issues: NormalizedIssue[] } | { ok: false, error: string }>}
 */
export async function fetchRepoIssues(opts) {
  const {
    repo,
    vcs,
    perPage = DEFAULT_PER_PAGE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    execFile = execFileAsync,
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
    const result = await execWithTimeout(cmd, args, { timeoutMs, execFile });
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
 *   execFile?: Function,
 * }} opts
 * @returns {Promise<Map<string, { ok: boolean, issues?: NormalizedIssue[], error?: string }>>}
 */
export async function fetchIssuesMultiRepo(opts) {
  const {
    repos,
    perPage = DEFAULT_PER_PAGE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    concurrency = DEFAULT_CONCURRENCY,
    execFile = execFileAsync,
  } = opts;

  if (!Array.isArray(repos) || repos.length === 0) {
    return new Map();
  }

  const semaphore = createSemaphore(Math.max(1, concurrency));
  const resultMap = new Map();

  const tasks = repos.map(({ repo, vcs }) => async () => {
    await semaphore.acquire();
    try {
      const result = await fetchRepoIssues({ repo, vcs, perPage, timeoutMs, execFile });
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
