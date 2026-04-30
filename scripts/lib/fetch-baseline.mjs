#!/usr/bin/env node
/**
 * scripts/lib/fetch-baseline.mjs
 *
 * Fetch a file from a GitLab project's repository raw endpoint.
 * Node.js port of scripts/lib/fetch-baseline.sh (issue #218).
 *
 * Used by the bootstrap skill to pull canonical baseline files (rules, agents,
 * CLAUDE.md / AGENTS.md snippets) on demand instead of relying on local copies
 * that drift.
 *
 * Required env vars:
 *   GITLAB_TOKEN  — personal access token with read_api or read_repository scope
 *
 * Optional env vars:
 *   GITLAB_HOST         — default: gitlab.gotzendorfer.at
 *   BASELINE_REF        — default: main
 *   FETCH_TIMEOUT_MS    — default: 10000 (ms; maps to FETCH_TIMEOUT seconds in .sh)
 *   BASELINE_CACHE_DIR  — override cache directory
 *
 * Named export (module usage):
 *   import { fetchBaselineFile } from './fetch-baseline.mjs';
 *   const result = await fetchBaselineFile({ baselineRef, filePath, token, projectId });
 *
 * CLI usage:
 *   node scripts/lib/fetch-baseline.mjs <project_id> <file_path> [ref]
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Configuration defaults (mirrors the .sh defaults)
// ---------------------------------------------------------------------------

const DEFAULT_GITLAB_HOST = 'gitlab.gotzendorfer.at';
const DEFAULT_BASELINE_REF = 'main';
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the cache directory.
 * Honours BASELINE_CACHE_DIR env override, then falls back to
 * <repo-root>/.claude/.baseline-cache (same logic as .sh).
 *
 * @returns {string}
 */
function _cacheDir() {
  if (process.env.BASELINE_CACHE_DIR) {
    return process.env.BASELINE_CACHE_DIR;
  }
  let root;
  try {
    root = execSync('git rev-parse --show-toplevel', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    root = process.cwd();
  }
  return path.join(root, '.claude', '.baseline-cache');
}

/**
 * URL-encode a file path for the GitLab API.
 * Encodes slashes as %2F and other special characters via encodeURIComponent.
 *
 * @param {string} filePath
 * @returns {string}
 */
function _urlEncodePath(filePath) {
  // encodeURIComponent handles all characters except A-Z a-z 0-9 - _ . ! ~ * ' ( )
  // GitLab expects slashes encoded as %2F in the path segment (already the default output).
  return encodeURIComponent(filePath);
}

/**
 * Derive a filesystem-safe cache key from (projectId, ref, filePath).
 * Mirrors the __cache_key() function in the .sh original.
 *
 * @param {string} projectId
 * @param {string} ref
 * @param {string} filePath
 * @returns {string}
 */
function _cacheKey(projectId, ref, filePath) {
  const raw = `${projectId}-${ref}-${filePath}`;
  return raw.replace(/[/.]/g, '_');
}

// ---------------------------------------------------------------------------
// Public named export
// ---------------------------------------------------------------------------

/**
 * Fetch a single file from a GitLab project's repository.
 *
 * @param {object} opts
 * @param {string} opts.filePath     - repo-relative path (e.g. ".claude/rules/security.md")
 * @param {string} [opts.baselineRef]  - git ref (default: BASELINE_REF env or "main")
 * @param {string} [opts.token]      - GitLab personal access token (default: GITLAB_TOKEN env)
 * @param {string|number} [opts.projectId] - GitLab project ID (default: 52)
 * @param {string} [opts.host]       - GitLab host (default: GITLAB_HOST env or "gitlab.gotzendorfer.at")
 * @param {number} [opts.timeoutMs]  - fetch timeout in ms (default: FETCH_TIMEOUT_MS env or 10000)
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   body?: string,
 *   status?: number,
 *   error?: string,
 *   fromCache?: boolean
 * }>}
 *
 * Exit-code semantics (mirrored as result shapes):
 *   ok:true                  — success (network or cache fallback)
 *   ok:false, status:401/403 — auth failure — fatal
 *   ok:false, status:404     — file not found + no cache
 *   ok:false, status:0       — network/transport failure + no cache (status 0 = transport)
 */
export async function fetchBaselineFile({
  filePath,
  baselineRef,
  token,
  projectId = 52,
  host,
  timeoutMs,
} = {}) {
  const resolvedToken = token ?? process.env.GITLAB_TOKEN;
  const resolvedRef = baselineRef ?? process.env.BASELINE_REF ?? DEFAULT_BASELINE_REF;
  const resolvedHost = host ?? process.env.GITLAB_HOST ?? DEFAULT_GITLAB_HOST;
  const resolvedTimeout = timeoutMs ?? Number(process.env.FETCH_TIMEOUT_MS ?? DEFAULT_FETCH_TIMEOUT_MS);

  if (!resolvedToken) {
    const errMsg = 'GITLAB_TOKEN not set — cannot fetch from baseline.';
    process.stderr.write(`ERROR: ${errMsg}\n`);
    return {
      ok: false,
      status: 401,
      error: errMsg,
    };
  }

  if (!filePath) {
    return {
      ok: false,
      status: 0,
      error: 'filePath is required.',
    };
  }

  const cacheDirectory = _cacheDir();
  const cacheKey = _cacheKey(String(projectId), resolvedRef, filePath);
  const cacheFile = path.join(cacheDirectory, cacheKey);

  const encodedPath = _urlEncodePath(filePath);
  const url = `https://${resolvedHost}/api/v4/projects/${projectId}/repository/files/${encodedPath}/raw?ref=${resolvedRef}`;

  // ---------------------------------------------------------------------------
  // Attempt network fetch
  // ---------------------------------------------------------------------------
  let response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), resolvedTimeout);
    try {
      response = await fetch(url, {
        headers: { 'PRIVATE-TOKEN': resolvedToken },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    // Transport/network failure (DNS, timeout, connection refused, etc.)
    const errMsg = err instanceof Error ? err.message : String(err);

    // Try cache fallback
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      process.stderr.write(`WARNING: fetch failed (network error: ${errMsg}); using cache for ${filePath}\n`);
      return { ok: true, body: cached, fromCache: true };
    } catch {
      process.stderr.write(
        `ERROR: fetch failed and no cache for ${filePath} (project ${projectId}, ref ${resolvedRef}): ${errMsg}\n`,
      );
      return { ok: false, status: 0, error: errMsg };
    }
  }

  // ---------------------------------------------------------------------------
  // Handle HTTP status codes (mirrors the case statement in .sh)
  // ---------------------------------------------------------------------------

  if (response.status === 200) {
    const body = await response.text();
    // Write to cache (best-effort — don't fail the caller if cache write fails)
    try {
      await fs.mkdir(cacheDirectory, { recursive: true });
      await fs.writeFile(cacheFile, body, 'utf8');
    } catch {
      // ignore cache write errors
    }
    return { ok: true, body, status: 200 };
  }

  if (response.status === 401 || response.status === 403) {
    // Auth failure — fatal, no cache fallback (matches .sh behaviour)
    const errMsg = `auth failed (${response.status}) fetching ${filePath} — check GITLAB_TOKEN scope`;
    process.stderr.write(`ERROR: ${errMsg}\n`);
    return { ok: false, status: response.status, error: errMsg };
  }

  if (response.status === 404) {
    // Try cache fallback
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      process.stderr.write(
        `WARNING: 404 for ${filePath}; using cache (file may have been removed from baseline)\n`,
      );
      return { ok: true, body: cached, status: 404, fromCache: true };
    } catch {
      const errMsg = `file not found (${filePath} on ${resolvedRef}) and no cache`;
      process.stderr.write(`ERROR: ${errMsg}\n`);
      return { ok: false, status: 404, error: errMsg };
    }
  }

  // Any other non-2xx status — try cache fallback
  try {
    const cached = await fs.readFile(cacheFile, 'utf8');
    process.stderr.write(`WARNING: HTTP ${response.status} for ${filePath}; using cache\n`);
    return { ok: true, body: cached, status: response.status, fromCache: true };
  } catch {
    const errMsg = `HTTP ${response.status} fetching ${filePath} — no cache`;
    process.stderr.write(`ERROR: ${errMsg}\n`);
    return { ok: false, status: response.status, error: errMsg };
  }
}

// ---------------------------------------------------------------------------
// CLI mode
// ---------------------------------------------------------------------------

/**
 * When invoked directly: node scripts/lib/fetch-baseline.mjs <project_id> <file_path> [ref]
 *
 * Fetches the file and prints the body to stdout.
 * Exit codes mirror the .sh original:
 *   0 — success
 *   1 — auth failure (401/403) or missing GITLAB_TOKEN
 *   2 — file not found (404, no cache)
 *   3 — network/transport failure, no cache; or unexpected HTTP status
 */
async function _cliMain() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    process.stderr.write(
      `Usage: node ${path.basename(process.argv[1])} <project_id> <file_path> [ref]\n`,
    );
    process.exit(1);
  }

  const [projectId, filePath, ref] = args;

  const result = await fetchBaselineFile({
    projectId,
    filePath,
    baselineRef: ref, // undefined when not supplied → uses env/default
  });

  if (result.ok) {
    process.stdout.write(result.body ?? '');
    process.exit(0);
  }

  // Map error to exit code matching .sh
  const status = result.status ?? 0;
  if (status === 401 || status === 403) {
    process.exit(1);
  }
  if (status === 404) {
    process.exit(2);
  }
  // network failure or unexpected HTTP status
  process.exit(3);
}

// Detect CLI invocation: import.meta.url matches the argv[1] path
const isMain = process.argv[1] && (
  process.argv[1] === new URL(import.meta.url).pathname ||
  // Handle invocation without file:// prefix
  process.argv[1].endsWith('fetch-baseline.mjs')
);

if (isMain) {
  _cliMain().catch((err) => {
    process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  });
}
