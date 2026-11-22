/**
 * fetch.mjs — read-only tracker access for the backlog checker (#2094).
 *
 * Contract: docs/backlog-refinement.md § Data contract. GitLab only in v1
 * (§ Ceilings). Every request is a GET through `glab api` spawned with an
 * argv array — nothing from `--repo`/`--host` ever reaches a shell.
 */

import { statSync } from 'node:fs';
import path from 'node:path';

import { spawnSync } from '../native-command.mjs';
import { dotGitAncestor } from '../platform.mjs';
import {
  detectVcsFamily,
  redactUrlCredentials,
  resolveGitlabProjectTarget,
} from '../vcs-repo-spec.mjs';

/** Per-call timeout for one `glab api` request. */
export const DEFAULT_TIMEOUT_MS = 30000;
/** GitLab's maximum page size. */
const PER_PAGE = 100;
/** Runaway guard: more pages than this per state is reported, never truncated. */
export const PAGE_CAP = 50;
/** A full page of long descriptions exceeds spawnSync's 1 MiB default buffer. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** `group/name` (or deeper): conservative segments, no shell or URL syntax. */
const PROJECT_PATH_RE = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;
/** Hostname with optional port; must start alphanumeric so it can never read as a flag. */
const HOST_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;

/**
 * @typedef {{ iid: number, project_id: number, title: string, description: string, labels: string[],
 *   state: string, created_at: string|null, updated_at: string|null, closed_at: string|null,
 *   web_url: string|null, milestone: string|null, tasks: { count: number, completed: number },
 *   merge_requests_count: number }} NormalizedIssue
 * @typedef {{ ok: true, vcs: 'gitlab', host: string, projectPath: string, cwd: string, checkoutRoot?: string }} Target
 * @typedef {{ iid: number, state: string, title?: string, project_id?: number }} RelatedMr
 * @typedef {(bin: string, args: string[], opts: { cwd: string, timeout: number }) =>
 *   { status: number|null, stdout?: string, stderr?: string, signal?: string|null, error?: { code?: string } }} Run
 */

/** @type {Run} */
function defaultRun(bin, args, opts) {
  return spawnSync(bin, args, {
    encoding: 'utf8',
    cwd: opts.cwd,
    timeout: opts.timeout,
    maxBuffer: MAX_BUFFER,
  });
}

/** @param {unknown} v */
function nonNegInt(v) {
  return Number.isSafeInteger(v) && v >= 0 ? v : 0;
}

/**
 * Normalize one raw GitLab issue into the contract shape.
 *
 * @param {Record<string, any>} raw — one element of a `glab api …/issues` array
 * @returns {NormalizedIssue}
 */
export function normalizeIssue(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const tcs =
    r.task_completion_status && typeof r.task_completion_status === 'object'
      ? r.task_completion_status
      : {};
  const labels = Array.isArray(r.labels)
    ? r.labels
        .map((l) => (l && typeof l === 'object' ? l.name : l))
        .filter((l) => typeof l === 'string')
    : [];
  const milestone =
    r.milestone && typeof r.milestone === 'object' && typeof r.milestone.title === 'string'
      ? r.milestone.title
      : null;
  const str = (v) => (typeof v === 'string' ? v : null);
  return {
    iid: r.iid,
    project_id: nonNegInt(r.project_id),
    title: typeof r.title === 'string' ? r.title : '',
    description: typeof r.description === 'string' ? r.description : '',
    labels,
    state: typeof r.state === 'string' ? r.state : '',
    created_at: str(r.created_at),
    updated_at: str(r.updated_at),
    closed_at: str(r.closed_at),
    web_url: str(r.web_url),
    milestone,
    tasks: { count: nonNegInt(tcs.count), completed: nonNegInt(tcs.completed_count) },
    merge_requests_count: nonNegInt(r.merge_requests_count),
  };
}

/** @param {Target} target */
function withCheckoutRoot(target) {
  const checkoutRoot = dotGitAncestor(target.cwd);
  return checkoutRoot ? { ...target, checkoutRoot } : target;
}

/**
 * Resolve the GitLab project behind a checkout directory.
 *
 * @param {string} dir
 * @param {Function|undefined} gitRun
 * @param {string|null} [preferVcs] the checkout's configured `vcs:`; decides
 *   between remotes of both families exactly as the `maintenance-due` probe
 *   does, so the due signal and this resolver never disagree on a repo
 * @returns {Target|{ ok: false, reason: string }}
 */
function resolveCheckout(dir, gitRun, preferVcs = null) {
  const opts = gitRun ? { repoRoot: dir, gitRun } : { repoRoot: dir };
  const family = detectVcsFamily({ ...opts, preferVcs });
  if (!family.ok) return { ok: false, reason: family.reason };
  if (family.vcs === 'github') return { ok: false, reason: 'github-not-supported' };
  const gl = resolveGitlabProjectTarget(opts);
  if (!gl) return { ok: false, reason: 'no-gitlab-remote' };
  return {
    ok: true,
    vcs: 'gitlab',
    host: gl.host,
    projectPath: decodeURIComponent(gl.encodedProjectPath),
    cwd: dir,
  };
}

/** @param {string} p */
function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The checkout directory {@link resolveTarget} reads its remotes from: the
 * `repo` argument when it is a directory, else `cwd`.
 *
 * @param {{ repo?: string|null, cwd?: string }} [opts]
 * @returns {string}
 */
export function targetDirectory({ repo, cwd = process.cwd() } = {}) {
  if (typeof repo === 'string' && repo !== '') {
    const asDir = path.resolve(cwd, repo);
    if (isDirectory(asDir)) return asDir;
  }
  return cwd;
}

/**
 * Resolve which GitLab project to read. Trust boundary: `repo` and `host` are
 * operator input and are validated before they reach any argv.
 *
 * @param {{ repo?: string|null, host?: string|null, cwd?: string, gitRun?: Function, preferVcs?: string|null }} [opts]
 *   `preferVcs`: the configured `vcs:` of the checkout {@link targetDirectory} names
 * @returns {Target|{ ok: false, reason: string }}
 */
export function resolveTarget({
  repo: rawRepo,
  host: rawHost,
  cwd = process.cwd(),
  gitRun,
  preferVcs = null,
} = {}) {
  const repo = rawRepo ?? null;
  let host = rawHost ?? null;
  if (host !== null) {
    if (typeof host !== 'string' || !HOST_RE.test(host))
      return { ok: false, reason: 'invalid-host' };
    if (/(^|\.)github\.com(:\d+)?$/i.test(host))
      return { ok: false, reason: 'github-not-supported' };
    host = host.toLowerCase();
  }

  if (repo === null || repo === '') {
    const t = resolveCheckout(cwd, gitRun, preferVcs);
    if (!t.ok) return t;
    return host !== null && host !== t.host.toLowerCase() ? { ...t, host } : withCheckoutRoot(t);
  }
  if (typeof repo !== 'string') return { ok: false, reason: 'invalid-repo' };

  const asDir = path.resolve(cwd, repo);
  if (isDirectory(asDir)) {
    const t = resolveCheckout(asDir, gitRun, preferVcs);
    if (!t.ok) return t;
    return host !== null && host !== t.host.toLowerCase() ? { ...t, host } : withCheckoutRoot(t);
  }

  if (/github\.com/i.test(repo)) return { ok: false, reason: 'github-not-supported' };
  const segments = repo.split('/');
  if (!PROJECT_PATH_RE.test(repo) || segments.some((s) => /^\.+$/.test(s) || s.startsWith('-'))) {
    return { ok: false, reason: 'invalid-repo' };
  }

  const here = resolveCheckout(cwd, gitRun, preferVcs);
  if (host === null && !here.ok) {
    return {
      ok: false,
      reason: here.reason === 'github-not-supported' ? 'no-host' : `no-host: ${here.reason}`,
    };
  }
  const resolvedHost = host ?? here.host;
  /** @type {Target} */
  const target = { ok: true, vcs: 'gitlab', host: resolvedHost, projectPath: repo, cwd };
  if (
    here.ok &&
    resolvedHost.toLowerCase() === here.host.toLowerCase() &&
    repo.toLowerCase() === here.projectPath.toLowerCase()
  ) {
    return withCheckoutRoot(target);
  }
  return target;
}

/**
 * Run one GET against the GitLab API and parse a JSON array.
 *
 * @param {Target} target
 * @param {string} endpoint
 * @param {Run} run
 * @param {number} timeoutMs
 * @param {boolean} [include] request response headers (issue lists only)
 * @returns {{ ok: true, items: any[], total: number|null } | { ok: false, reason: string }}
 */
function getArray(target, endpoint, run, timeoutMs, include = false) {
  let r;
  try {
    r = run(
      'glab',
      ['api', '--hostname', target.host, ...(include ? ['--include'] : []), endpoint],
      { cwd: target.cwd, timeout: timeoutMs },
    );
  } catch (err) {
    return { ok: false, reason: `glab api: ${err?.code ?? 'spawn error'}` };
  }
  if (r?.error?.code === 'ENOENT') return { ok: false, reason: 'glab not installed' };
  if (r?.error?.code === 'ETIMEDOUT' || r?.signal)
    return { ok: false, reason: `glab api timed out after ${timeoutMs} ms` };
  if (r?.error) return { ok: false, reason: `glab api: ${r.error.code ?? 'spawn error'}` };
  if (r?.status !== 0) {
    const firstLine = redactUrlCredentials(
      String(r?.stderr ?? '')
        .trim()
        .split('\n')[0] ?? '',
    ).slice(0, 200);
    return {
      ok: false,
      reason: `glab api exit ${r?.status ?? 'unknown'}${firstLine ? `: ${firstLine}` : ''}`,
    };
  }
  let body = String(r.stdout ?? '');
  let total = null;
  // Older glab versions/proxies may omit headers. Plain JSON remains usable,
  // but cannot establish whether offset pagination dropped an issue.
  if (/^HTTP\/\S+\s+\d{3}(?:[^\r\n]*)\r?\n/.test(body)) {
    const separator = /\r?\n\r?\n/.exec(body);
    if (separator) {
      const headers = body.slice(0, separator.index).split(/\r?\n/).slice(1);
      for (const header of headers) {
        const match = /^x-total:\s*(\d+)\s*$/i.exec(header);
        if (match && Number.isSafeInteger(Number(match[1]))) total = Number(match[1]);
      }
      body = body.slice(separator.index + separator[0].length);
    }
  }
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'glab api returned non-JSON' };
  }
  if (!Array.isArray(parsed)) return { ok: false, reason: 'glab api returned a non-array' };
  return { ok: true, items: parsed, total };
}

/**
 * Read every page of one issue list. Any failed page fails the whole list.
 *
 * @param {Target} target
 * @param {string} query — without page/per_page
 * @param {Run} run
 * @param {number} timeoutMs
 */
function fetchAllPages(target, query, run, timeoutMs) {
  const base = `projects/${encodeURIComponent(target.projectPath)}/issues?${query}&per_page=${PER_PAGE}`;
  const byIid = new Map();
  let total = null;
  for (let page = 1; page <= PAGE_CAP; page++) {
    const res = getArray(target, `${base}&page=${page}`, run, timeoutMs, true);
    if (!res.ok) return { ok: false, reason: `page ${page}: ${res.reason}` };
    if (page === 1) total = res.total;
    // Dedupe by iid: an issue moving between pages mid-read must not count twice.
    for (const raw of res.items) byIid.set(raw?.iid, raw);
    if (res.items.length < PER_PAGE) {
      if (total !== null && byIid.size !== total) {
        return {
          ok: false,
          reason: `pagination count mismatch: ${byIid.size} unique issues fetched; first-page X-Total ${total}`,
        };
      }
      return { ok: true, items: [...byIid.values()], paginationMeasured: total !== null };
    }
  }
  return { ok: false, reason: 'page-cap' };
}

/**
 * Read all open issues and the issues closed within the window.
 *
 * @param {{ target: Target, closedDays?: number, now?: Date, run?: Run, timeoutMs?: number }} opts
 * @returns {{ ok: true, open: NormalizedIssue[], closed: NormalizedIssue[], newestIid?: number, paginationUnmeasured?: string[] } | { ok: false, reason: string }}
 */
export function fetchBacklog({
  target,
  closedDays = 30,
  now = new Date(),
  run = defaultRun,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  // Ascending creation order keeps pages stable while new issues are filed.
  const order = 'order_by=created_at&sort=asc';
  const open = fetchAllPages(target, `state=opened&${order}`, run, timeoutMs);
  if (!open.ok) return { ok: false, reason: `open issues ${open.reason}` };

  const windowStartMs = now.getTime() - closedDays * 86400000;
  const windowStart = new Date(windowStartMs).toISOString();
  const closed = fetchAllPages(
    target,
    `state=closed&updated_after=${encodeURIComponent(windowStart)}&${order}`,
    run,
    timeoutMs,
  );
  if (!closed.ok) return { ok: false, reason: `closed issues ${closed.reason}` };

  const newest = getArray(
    target,
    `projects/${encodeURIComponent(target.projectPath)}/issues?order_by=created_at&sort=desc&per_page=1`,
    run,
    timeoutMs,
    true,
  );
  if (!newest.ok) return { ok: false, reason: `newest issue ${newest.reason}` };
  const newestIid = nonNegInt(newest.items[0]?.iid);
  if (newest.items.length > 0 && newestIid === 0)
    return { ok: false, reason: 'newest issue response has no valid iid' };

  return {
    ok: true,
    newestIid,
    paginationUnmeasured: [
      !open.paginationMeasured ? 'open' : null,
      !closed.paginationMeasured ? 'closed' : null,
    ].filter(Boolean),
    open: open.items.map(normalizeIssue),
    closed: closed.items
      .map(normalizeIssue)
      .filter((i) => i.closed_at !== null && Date.parse(i.closed_at) >= windowStartMs),
  };
}

/**
 * Look up related merge requests and merge requests configured to close the
 * issue. A failed closing lookup still leaves the related list usable.
 *
 * @param {{ target: Target, iids: number[], run?: Run, timeoutMs?: number }} opts
 * @returns {Map<number, { state: 'measured', mrs: RelatedMr[], closedBy: RelatedMr[]|null } | { state: 'not-measured', reason: string }>}
 */
export function fetchRelatedMrs({
  target,
  iids,
  run = defaultRun,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  const out = new Map();
  const project = encodeURIComponent(target.projectPath);
  for (const iid of iids ?? []) {
    if (!Number.isSafeInteger(iid) || iid <= 0) {
      out.set(iid, { state: 'not-measured', reason: 'invalid-iid' });
      continue;
    }
    const base = `projects/${project}/issues/${iid}`;
    const related = getArray(target, `${base}/related_merge_requests?per_page=${PER_PAGE}`, run, timeoutMs);
    if (!related.ok) {
      out.set(iid, { state: 'not-measured', reason: related.reason });
      continue;
    }
    const closing = getArray(target, `${base}/closed_by?per_page=${PER_PAGE}`, run, timeoutMs);
    const mrFields = (mr) => ({
      iid: mr?.iid,
      state: mr?.state,
      title: mr?.title,
      project_id: mr?.project_id,
    });
    out.set(iid, {
      state: 'measured',
      mrs: related.items.map(mrFields),
      closedBy: closing.ok ? closing.items.map(mrFields) : null,
    });
  }
  return out;
}
