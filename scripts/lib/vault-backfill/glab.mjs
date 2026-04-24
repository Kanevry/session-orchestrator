/**
 * glab.mjs — GitLab CLI helpers for vault-backfill.
 *
 * All functions shell out to `glab`; never throw — return ok:false on failure.
 * Part of scripts/vault-backfill.mjs (Issue #241).
 */

import { spawnSync } from 'node:child_process';

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
 */
export function glabRun(glabArgs) {
  vlog(`glab ${glabArgs.join(' ')}`);
  const result = spawnSync('glab', glabArgs, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.error) {
    return { ok: false, stdout: '', stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

/**
 * Parse `glab repo list --output json` output (JSON array or JSONL).
 * Returns array of { id, path, name, visibility, createdAt }.
 */
export function parseRepoList(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return [];

  try {
    const data = JSON.parse(trimmed);
    if (!Array.isArray(data)) return [];
    return data.map((r) => ({
      id: r.id ?? 0,
      path: r.path_with_namespace ?? r.path ?? '',
      name: r.name ?? '',
      visibility: r.visibility ?? 'private',
      createdAt: (r.created_at ?? '').slice(0, 10),
    }));
  } catch {
    // Try line-by-line JSONL
    const repos = [];
    for (const line of trimmed.split('\n')) {
      const l = line.trim();
      if (!l) continue;
      try {
        const r = JSON.parse(l);
        repos.push({
          id: r.id ?? 0,
          path: r.path_with_namespace ?? r.path ?? '',
          name: r.name ?? '',
          visibility: r.visibility ?? 'private',
          createdAt: (r.created_at ?? '').slice(0, 10),
        });
      } catch {
        // skip malformed line
      }
    }
    return repos;
  }
}

/**
 * List all repos in a GitLab group. Returns repo array or null on API error.
 */
export function listGroupRepos(group) {
  const { ok, stdout, stderr } = glabRun([
    'repo', 'list', '-g', group, '--output', 'json', '--per-page', '100',
  ]);

  if (!ok) {
    process.stderr.write(
      `[vault-backfill] WARN: glab repo list failed for group '${group}': ${stderr.trim()}\n`,
    );
    return null;
  }

  return parseRepoList(stdout);
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

/**
 * Fetch repo owner via glab API. Returns username or 'unknown' on failure.
 */
export function fetchRepoOwner(repoId) {
  const { ok, stdout } = glabRun(['api', `projects/${repoId}`]);
  if (!ok) return 'unknown';

  try {
    const data = JSON.parse(stdout);
    return (
      data?.namespace?.path ||
      data?.owner?.username ||
      data?.namespace?.name ||
      'unknown'
    );
  } catch {
    return 'unknown';
  }
}
