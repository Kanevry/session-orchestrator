/**
 * glab.mjs — GitLab CLI helpers for vault-backfill.
 *
 * All functions shell out to `glab`; never throw — return ok:false on failure.
 * Part of scripts/vault-backfill.mjs (Issue #241).
 */

import { spawnSync } from 'node:child_process';

import { redactUrlCredentials } from '../vcs-repo-spec.mjs';
import { isValidRepoPath } from './manifest.mjs';

let _verbose = false;

/** Enable verbose stderr logging. */
export function setVerbose(v) {
  _verbose = v;
}

function vlog(msg) {
  if (_verbose) process.stderr.write(`[vault-backfill:verbose] ${msg}\n`);
}

/**
 * Check glab is on PATH. Calls dieFn(1, ...) if missing.
 * Uses `glab --version` (no shell:true) to avoid the DEP0190 warning.
 */
export function assertGlabExists(dieFn) {
  const result = spawnSync('glab', ['--version'], { encoding: 'utf8' });
  if (result.error || result.status !== 0) {
    dieFn(
      1,
      'glab CLI not found — install per https://gitlab.com/gitlab-org/cli\n' +
        '  (macOS: brew install glab)',
    );
  }
  vlog('glab CLI found on PATH');
}

/**
 * Run a glab command, return { ok, stdout, stderr }.
 *
 * Host-pinning (#872): deliberately ambient — this module runs instance-wide
 * queries (`glab api groups/<group>/projects`) that are not scoped to a single
 * repo/project, so there is no single `-R`/`--repo` spec to pin. If a
 * caller ever needs single-repo host-pinning here, use `--hostname` (the
 * flag `glab api` and instance-wide subcommands accept), NOT `-R`/`--repo` —
 * see `scripts/lib/vcs-repo-spec.mjs` for the `resolveRepoSpec` (`-R`) vs
 * `resolveRepoHost` (`--hostname`) contract this repo already established.
 */
export function glabRun(glabArgs) {
  vlog(`glab ${redactUrlCredentials(glabArgs.join(' '))}`);
  const result = spawnSync('glab', glabArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, stdout: '', stderr: redactUrlCredentials(result.error.message) };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: redactUrlCredentials(result.stderr || ''),
  };
}

const PROJECT_VISIBILITIES = new Set(['private', 'internal', 'public']);
const ISO_TIMESTAMP = /^(?<year>[1-9]\d{3})-(?<month>\d{2})-(?<day>\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/**
 * GitLab returns `created_at` as an ISO-8601 timestamp. Validate the calendar
 * components separately because Date normalizes impossible dates such as Feb 30.
 */
function isValidCreatedAt(value) {
  if (typeof value !== 'string') return false;

  const match = ISO_TIMESTAMP.exec(value);
  if (!match?.groups) return false;

  const { year, month, day } = match.groups;
  const calendarDate = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return (
    calendarDate.getUTCFullYear() === Number(year) &&
    calendarDate.getUTCMonth() === Number(month) - 1 &&
    calendarDate.getUTCDate() === Number(day)
  );
}

/**
 * Reduce a GitLab project response to the fields vault-backfill consumes.
 *
 * The group API with `simple=true` still includes presentation and URL fields.
 * Keeping only this projection prevents those opaque project objects from
 * flowing into logs or downstream actions.
 */
function normalizeRepo(project) {
  return {
    id: project.id,
    path: project.path_with_namespace ?? project.path,
    visibility: project.visibility === undefined ? 'private' : project.visibility,
    createdAt: project.created_at === undefined ? '' : project.created_at.slice(0, 10),
  };
}

function isSimpleProject(project) {
  const path = project?.path_with_namespace ?? project?.path;
  return (
    project !== null &&
    typeof project === 'object' &&
    !Array.isArray(project) &&
    Number.isInteger(project.id) &&
    project.id > 0 &&
    isValidRepoPath(path) &&
    (project.visibility === undefined || PROJECT_VISIBILITIES.has(project.visibility)) &&
    (project.created_at === undefined || isValidCreatedAt(project.created_at))
  );
}

/**
 * Parse `glab api --paginate --slurp` output (a project array or page arrays).
 *
 * Returns an array of { id, path, visibility, createdAt }, or null when an
 * exit-zero response does not fully match the simple-project list contract.
 */
export function parseRepoList(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;

  let data;
  try {
    data = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!Array.isArray(data)) return null;
  if (data.length === 0) return [];

  const projects = data.every(isSimpleProject)
    ? data
    : data.every(Array.isArray)
      ? data.flat()
      : null;

  if (!projects || !projects.every(isSimpleProject)) return null;
  return projects.map(normalizeRepo);
}

/**
 * List all repos in a GitLab group. Returns repo array or null on API error.
 */
export function listGroupRepos(group) {
  const encodedGroup = encodeURIComponent(group);
  const { ok, stdout, stderr } = glabRun([
    'api', `groups/${encodedGroup}/projects?simple=true&per_page=100`, '--paginate', '--slurp',
  ]);

  if (!ok) {
    process.stderr.write(
      `[vault-backfill] WARN: glab api groups/<group>/projects failed for group '${group}': ${stderr.trim()}\n`,
    );
    return null;
  }

  const repos = parseRepoList(stdout);
  if (repos === null) {
    process.stderr.write(
      `[vault-backfill] WARN: glab api groups/<group>/projects returned an unexpected project-list response shape for group '${group}'\n`,
    );
    return null;
  }

  return repos;
}

/**
 * Check if a repo already has .vault.yaml via glab API.
 * Returns: 'present' | 'absent' | 'error'
 */
export function checkVaultYaml(repoPath) {
  const encodedPath = encodeURIComponent(repoPath);
  const { ok, stderr, stdout } = glabRun([
    'api', `projects/${encodedPath}/repository/files/.vault.yaml/raw`,
  ]);

  if (ok) {
    vlog(`${repoPath}: .vault.yaml present (${stdout.length} bytes)`);
    return 'present';
  }

  if (
    stderr.includes('404') ||
    stderr.includes('not found') ||
    stderr.includes('File Not Found')
  ) {
    vlog(`${repoPath}: .vault.yaml absent (404)`);
    return 'absent';
  }

  process.stderr.write(
    `[vault-backfill] WARN: could not probe ${repoPath}: ${stderr.trim().slice(0, 120)}\n`,
  );
  return 'error';
}
