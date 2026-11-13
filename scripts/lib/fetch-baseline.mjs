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
 *   GITLAB_HOST         — GitLab host (required; no private domain fallback)
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

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { httpRequest } from './http-request.mjs';
import { isMainModule } from './is-main-module.mjs';
import { execSync } from './native-command.mjs';

// ---------------------------------------------------------------------------
// Configuration defaults (mirrors the .sh defaults)
// ---------------------------------------------------------------------------

const DEFAULT_BASELINE_REF = 'main';
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

/**
 * Upper bound for one fetched baseline file. Rule files are a few KiB; 1 MiB
 * leaves ample headroom while keeping a misbehaving server from filling memory
 * or the cache. A larger body is a transport error, never written anywhere.
 */
export const MAX_BASELINE_FILE_BYTES = 1024 * 1024;

/** Cache sub-directory for identity-hashed entries; older flat keys are never read. */
const CACHE_SUBDIR = 'v2';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]']);

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
 * Validate a bare GitLab host (`name` or `name:port`) and build its origin.
 * Anything that would change the URL beyond the authority — a scheme, path,
 * userinfo, query, fragment or whitespace — is rejected.
 *
 * @param {string} host
 * @param {'https'|'http'} scheme - `http` only for loopback hosts (tests).
 * @returns {{ origin: string } | { error: string }}
 */
function _resolveOrigin(host, scheme) {
  const invalid = { error: `invalid GitLab host ${JSON.stringify(String(host))} — expected a bare host or host:port` };
  // `/` also excludes any `scheme://` prefix; `\` is normalised to `/` by URL.
  if (typeof host !== 'string' || /[/@\\?#\s]/.test(host)) return invalid;
  let parsed;
  try {
    parsed = new URL(`https://${host}`);
  } catch {
    return invalid;
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) return invalid;
  if (scheme === 'http') {
    if (!LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
      return { error: 'plain http is only allowed for a loopback host' };
    }
    return { origin: `http://${parsed.host}` };
  }
  if (scheme !== 'https') return { error: `unsupported scheme ${JSON.stringify(scheme)}` };
  return { origin: parsed.origin };
}

/**
 * Build the GitLab raw-file API URL. projectId and filePath are each encoded
 * as ONE path segment (GitLab expects `/` inside them as %2F); ref is a query
 * value so `#`, `&` and `?` stay part of the ref.
 *
 * @param {string} origin
 * @param {string} projectId
 * @param {string} filePath
 * @param {string} ref
 * @returns {URL}
 */
function _buildUrl(origin, projectId, filePath, ref) {
  const url = new URL(
    `/api/v4/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(filePath)}/raw`,
    origin,
  );
  url.searchParams.set('ref', ref);
  return url;
}

/**
 * Derive a filesystem-safe cache key from the full request identity. Hashing
 * an unambiguous JSON tuple means two different (origin, project, ref, path)
 * identities can never share an entry.
 *
 * @param {string} origin
 * @param {string} projectId
 * @param {string} ref
 * @param {string} filePath
 * @returns {string}
 */
function _cacheKey(origin, projectId, ref, filePath) {
  return createHash('sha256').update(JSON.stringify([origin, projectId, ref, filePath])).digest('hex');
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
 * @param {string} [opts.host]       - GitLab host (required; falls back to GITLAB_HOST env; no default private host)
 * @param {number} [opts.timeoutMs]  - wall-clock deadline in ms covering connect AND body (default: FETCH_TIMEOUT_MS env or 10000)
 * @param {'https'|'http'} [opts.scheme] - default `https`; `http` is accepted only for a loopback host (tests)
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
 *   ok:true                  — success (network or same-identity cache fallback)
 *   ok:false, status:401/403 — auth failure — fatal
 *   ok:false, status:3xx     — redirect, never followed, never cached, no cache fallback
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
  scheme = 'https',
} = {}) {
  const resolvedToken = token ?? process.env.GITLAB_TOKEN;
  const resolvedRef = baselineRef ?? process.env.BASELINE_REF ?? DEFAULT_BASELINE_REF;
  const resolvedHost = host ?? process.env.GITLAB_HOST;
  const resolvedTimeout = timeoutMs ?? Number(process.env.FETCH_TIMEOUT_MS ?? DEFAULT_FETCH_TIMEOUT_MS);

  if (!resolvedHost) {
    const errMsg = 'GITLAB_HOST not configured — set GITLAB_HOST env or pass opts.host';
    process.stderr.write(`ERROR: ${errMsg}\n`);
    return {
      ok: false,
      status: 0,
      error: errMsg,
    };
  }

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

  const resolvedProjectId = String(projectId);
  const origin = _resolveOrigin(resolvedHost, scheme);
  if ('error' in origin) {
    process.stderr.write(`ERROR: ${origin.error}\n`);
    return { ok: false, status: 0, error: origin.error };
  }

  const cacheDirectory = path.join(_cacheDir(), CACHE_SUBDIR);
  const cacheFile = path.join(cacheDirectory, _cacheKey(origin.origin, resolvedProjectId, resolvedRef, filePath));
  const url = _buildUrl(origin.origin, resolvedProjectId, filePath, resolvedRef);

  // ---------------------------------------------------------------------------
  // Attempt network fetch — httpRequest follows no redirect and bounds the
  // whole exchange (headers AND body) by both a deadline and a byte cap.
  // ---------------------------------------------------------------------------
  let response;
  let body;
  try {
    response = await httpRequest(url, {
      headers: { 'PRIVATE-TOKEN': resolvedToken },
      timeoutMs: resolvedTimeout,
      maxBytes: MAX_BASELINE_FILE_BYTES,
    });
    body = await response.text();
  } catch (err) {
    // Transport failure (DNS, timeout, connection refused, oversized body, …)
    const errMsg = err instanceof Error ? err.message : String(err);

    // Try the same-identity cache fallback
    try {
      const cached = await fs.readFile(cacheFile, 'utf8');
      process.stderr.write(`WARNING: fetch failed (network error: ${errMsg}); using cache for ${filePath}\n`);
      return { ok: true, body: cached, fromCache: true };
    } catch {
      process.stderr.write(
        `ERROR: fetch failed and no cache for ${filePath} (project ${resolvedProjectId}, ref ${resolvedRef}): ${errMsg}\n`,
      );
      return { ok: false, status: 0, error: errMsg };
    }
  }

  // ---------------------------------------------------------------------------
  // Handle HTTP status codes (mirrors the case statement in .sh)
  // ---------------------------------------------------------------------------

  if (response.status === 200) {
    // Write to cache (best-effort — don't fail the caller if cache write fails)
    try {
      await fs.mkdir(cacheDirectory, { recursive: true });
      await fs.writeFile(cacheFile, body, 'utf8');
    } catch {
      // ignore cache write errors
    }
    return { ok: true, body, status: 200 };
  }

  if (response.status >= 300 && response.status < 400) {
    // A redirect is never followed (the token must not travel to another
    // origin) and never answered from cache: the endpoint is not the expected one.
    const errMsg = `HTTP ${response.status} redirect for ${filePath} not followed — check GITLAB_HOST`;
    process.stderr.write(`ERROR: ${errMsg}\n`);
    return { ok: false, status: response.status, error: errMsg };
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

if (isMainModule(import.meta.url)) {
  _cliMain().catch((err) => {
    process.stderr.write(`FATAL: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  });
}
