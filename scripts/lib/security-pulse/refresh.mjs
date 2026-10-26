/**
 * refresh.mjs — fills the security-pulse cache (#1769, stage 2).
 *
 * Runs DETACHED from the SessionStart probe (see spawn.mjs), never on the hook
 * path. Two independent parts:
 *   - host part (TTL 6 h): Node security floors per major from the Node release
 *     index, and the CISA KEV CVE id list. Each source is fetched on its own; a
 *     failed source keeps its previous value and is marked `degraded`.
 *   - repo part (TTL 6 h, or HEAD moved): every lockfile package at HEAD, checked
 *     against OSV by REUSING the close-time `runLockfileCheck` with git's empty
 *     tree as base — one filter for private packages, one OSV client.
 *
 * Package names stay in the host-local cache; callers print counts only.
 */
import { httpRequest } from '../http-request.mjs';
import { releaseFileLock, tryAcquireFileLock } from '../file-lock.mjs';
import { defaultRunGit } from '../security-delta/lockfiles.mjs';
import { runLockfileCheck } from '../security-delta/osv.mjs';
import { NODE_INDEX_URL, securityFloors } from '../security-delta/runtime-floor.mjs';
import { cachePartStatus, hostSourcePart, repoPart, safePackageName, safePackageVersion } from '../security-pulse-banner.mjs';
import { CACHE_SCHEMA, MAX_CACHED_FINDINGS, cachePaths, ensurePrivateDir, readCacheFile, writeCacheJson } from './cache.mjs';

/** git's well-known empty tree object: every lockfile at HEAD reads as introduced. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export const KEV_URL = 'https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json';

const CVE_RE = /^CVE-\d{4}-\d{4,}$/;
const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** NAMED CEILING (BV-004): source size caps. Node index ~875 entries / KEV ~1.5 MB (2026-10). Revisit on a `exceeded maxBytes` degraded status. */
const NODE_INDEX_MAX_BYTES = 8 * 1024 * 1024;
const KEV_MAX_BYTES = 8 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 15_000;
/** Repo OSV run: generous deadline and detail cap compared with the close-time 2 s / 25. */
const REPO_DEADLINE_MS = 30_000;
const REPO_MAX_DETAILS = 50;

/** Is a cached source entry due? The probe's own rule (TTL when ok, retry interval when degraded). */
function sourceDue(entry, nowMs) {
  return cachePartStatus(hostSourcePart(entry), nowMs).due;
}

async function fetchNodeFloors(request) {
  const res = await request(NODE_INDEX_URL, { method: 'GET', timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: NODE_INDEX_MAX_BYTES });
  if (!res?.ok) throw new Error(`node index HTTP ${res?.status}`);
  const floors = {};
  for (const [major, parts] of securityFloors(await res.json())) floors[String(major)] = parts.join('.');
  if (Object.keys(floors).length === 0) throw new Error('node index carried no security release');
  return floors;
}

async function fetchKev(request) {
  const res = await request(KEV_URL, { method: 'GET', timeoutMs: SOURCE_TIMEOUT_MS, maxBytes: KEV_MAX_BYTES });
  if (!res?.ok) throw new Error(`kev HTTP ${res?.status}`);
  const doc = await res.json();
  const list = Array.isArray(doc?.vulnerabilities) ? doc.vulnerabilities : null;
  if (list === null) throw new Error('kev feed without vulnerabilities[]');
  const ids = [...new Set(list.map((v) => v?.cveID).filter((id) => typeof id === 'string' && CVE_RE.test(id)))];
  if (ids.length === 0) throw new Error('kev feed carried no CVE id');
  return ids.sort();
}

/**
 * One host source: fetch, or keep the previous value and mark it degraded.
 * @returns {Promise<object>} the new cache entry
 */
async function refreshSource(prev, fetcher, key, nowIso) {
  try {
    const value = await fetcher();
    return { status: 'ok', fetched_at: nowIso, attempted_at: nowIso, [key]: value };
  } catch (err) {
    const kept = prev && prev[key] !== undefined ? prev[key] : null;
    return {
      status: 'degraded',
      reason: String(err?.message ?? err).slice(0, 120),
      fetched_at: prev?.fetched_at ?? null,
      attempted_at: nowIso,
      [key]: kept,
    };
  }
}

/** Reduce a contract finding to the cached shape (no file path, no fingerprint). */
function reduceFinding(f, kevSet) {
  const ids = Array.isArray(f.ids) ? f.ids.filter((id) => typeof id === 'string') : [];
  return {
    class: f.class,
    severity: f.severity,
    ecosystem: f.ecosystem,
    // Lockfile-controlled text: only a strict name/version charset is cached.
    package: safePackageName(f.package),
    version: safePackageVersion(f.version),
    fixedIn: f.fixedIn,
    ids,
    // NAMED CEILING (BV-004): osv.mjs appends the CVE aliases of every advisory
    // whose `/v1/vulns/<id>` detail record it fetched, so the join is exact for
    // those. An advisory past `maxDetails` (reason `detail-cap`) or past the
    // deadline (reason `deadline`) still contributes only its primary
    // GHSA-/PYSEC-… id, and a KEV-listed CVE behind it is missed — the banner's
    // KEV count (`kevHits`) is a lower bound exactly when the repo cache shows
    // such a gap. Revisit
    // trigger: a `detail-cap`/`deadline` repo status on a repo whose findings
    // are KEV-relevant.
    kev: ids.some((id) => kevSet.has(id)),
  };
}

/**
 * Refresh the cache for one repo. Never throws for network or git failures;
 * an fs failure writing the cache rejects (the CLI maps it to exit 2).
 *
 * @param {object} opts
 * @param {string} opts.repoRoot           absolute repo root
 * @param {NodeJS.ProcessEnv} [opts.env]    environment (cache dir via SO_CONFIG_HOME)
 * @param {() => number} [opts.now]         clock (tests)
 * @param {boolean} [opts.force]            ignore every TTL
 * @param {typeof httpRequest} [opts.request]  HTTP transport (tests)
 * @param {(args: string[]) => Promise<string>} [opts.runGit]  git runner (tests)
 * @param {typeof runLockfileCheck} [opts.lockfileCheck]  OSV lockfile check (tests)
 * @returns {Promise<object>} counts-only summary
 */
export async function refreshSecurityPulse({
  repoRoot,
  env = process.env,
  now = Date.now,
  force = false,
  request = httpRequest,
  runGit,
  lockfileCheck = runLockfileCheck,
} = {}) {
  const paths = cachePaths(repoRoot, { env });
  ensurePrivateDir(paths.dir);
  const lock = tryAcquireFileLock(paths.lockFile, { staleCheck: 'pid' });
  if (!lock.acquired) return { skipped: lock.reason === 'held' ? 'locked' : 'lock-error' };
  try {
    const nowMs = now();
    const nowIso = new Date(nowMs).toISOString();
    const summary = { skipped: null, host: { refreshed: false }, repo: { refreshed: false } };

    // ── host part ──────────────────────────────────────────────────────────
    const prevHostRead = readCacheFile(paths.hostFile);
    const prevHost = prevHostRead.ok ? prevHostRead.value : {};
    const nodeDue = force || sourceDue(prevHost.node, nowMs);
    const kevDue = force || sourceDue(prevHost.kev, nowMs);
    const [node, kev] = await Promise.all([
      nodeDue ? refreshSource(prevHost.node, () => fetchNodeFloors(request), 'floors', nowIso) : prevHost.node,
      kevDue ? refreshSource(prevHost.kev, () => fetchKev(request), 'cves', nowIso) : prevHost.kev,
    ]);
    if (nodeDue || kevDue) {
      writeCacheJson(paths.hostFile, { schema: CACHE_SCHEMA, node: node ?? null, kev: kev ?? null });
      summary.host.refreshed = true;
    }
    summary.host.node = node?.status ?? 'absent';
    summary.host.kev = kev?.status ?? 'absent';
    summary.host.node_majors = node?.floors ? Object.keys(node.floors).length : 0;
    summary.host.kev_ids = Array.isArray(kev?.cves) ? kev.cves.length : 0;

    // ── repo part ──────────────────────────────────────────────────────────
    const git = runGit ?? defaultRunGit(repoRoot);
    let head = null;
    try {
      const out = String(await git(['rev-parse', 'HEAD'])).trim();
      head = SHA_RE.test(out) ? out : null;
    } catch {
      head = null;
    }
    if (head === null) {
      summary.repo.status = 'head-unknown';
      return summary;
    }
    const prevRepoRead = readCacheFile(paths.repoFile);
    const prevRepo = prevRepoRead.ok ? prevRepoRead.value : null;
    const repoDue = force || prevRepo === null || prevRepo.head !== head
      || cachePartStatus(repoPart(prevRepo), nowMs).due;
    if (!repoDue) {
      summary.repo.status = 'fresh';
      return summary;
    }
    const check = await lockfileCheck({
      repoRoot,
      base: EMPTY_TREE,
      head,
      deadlineAt: Date.now() + REPO_DEADLINE_MS,
      maxDetails: REPO_MAX_DETAILS,
      request,
      ...(runGit ? { runGit } : {}),
      env,
    });
    const kevSet = new Set(Array.isArray(kev?.cves) ? kev.cves : []);
    const findings = (check.findings ?? []).slice(0, MAX_CACHED_FINDINGS).map((f) => reduceFinding(f, kevSet));
    writeCacheJson(paths.repoFile, {
      schema: CACHE_SCHEMA,
      fetched_at: nowIso,
      head,
      status: check.status,
      reason: check.reason ?? null,
      checked: check.checked ?? 0,
      unchecked: check.unchecked ?? 0,
      findings_total: (check.findings ?? []).length,
      findings,
    });
    summary.repo = {
      refreshed: true,
      status: check.status,
      checked: check.checked ?? 0,
      unchecked: check.unchecked ?? 0,
      findings: findings.length,
      malicious: findings.filter((f) => f.class === 'malicious').length,
      critical: findings.filter((f) => f.severity === 'critical').length,
    };
    return summary;
  } finally {
    releaseFileLock(paths.lockFile);
  }
}
