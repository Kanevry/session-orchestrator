/**
 * osv.mjs — the `lockfile` check of the close-time Security-Delta (#1769, stage 1).
 *
 * Composes the lockfile delta (lockfiles.mjs) and the public-package filter
 * (npmrc.mjs), asks OSV which introduced packages carry advisories
 * (`/v1/querybatch`) and fetches the advisory details it needs for severity
 * and fix version (`/v1/vulns/<id>`), inside a network deadline.
 *
 * `MAL-*` ids are classified by prefix alone (malicious → critical, no fix),
 * so they spend no detail request from the cap or the deadline.
 */
import path from 'node:path';

import { BUDGET, makeCheckResult, makeFinding, normalizeOsvSeverity, severityRank } from './contract.mjs';
import { defaultRunGit, PIP_INDEX_UNVERIFIABLE, readLockfileDelta } from './lockfiles.mjs';
import { filterPublicPackages, readHostNpmrcPolicy, readNpmrcPolicy } from './npmrc.mjs';
import { httpRequest } from '../http-request.mjs';

const OSV_BASE = 'https://api.osv.dev/v1';
const BATCH_SIZE = 1000;
const DETAIL_CONCURRENCY = 8;
const BATCH_MAX_BYTES = 16 * 1024 * 1024;
const DETAIL_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DETAILS = 25;

/** Reason priority when several detail gaps occur in one run. */
const DETAIL_REASONS = ['deadline', 'detail-cap', 'network'];

/**
 * Compare two version strings segment by segment (numeric where both are).
 * Ceiling (BV-004): not full semver/PEP 440 — pre-release ordering
 * (`1.0.0-rc1` vs `1.0.0`, `1.0rc1`) is approximate. Revisit when a fixedIn
 * value is reported wrong for a pre-release.
 */
function compareVersions(a, b) {
  const pa = String(a).split(/[.\-+_]/);
  const pb = String(b).split(/[.\-+_]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (nx !== null && ny !== null) {
      if (nx !== ny) return nx < ny ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function sameName(ecosystem, a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (ecosystem === 'PyPI') {
    const norm = (s) => s.toLowerCase().replace(/[-_.]+/g, '-');
    return norm(a) === norm(b);
  }
  return a === b;
}

/** Lowest `fixed` event above `version` in the affected entry matching the package. */
function fixedFromRecord(record, pkg) {
  let best = null;
  // Malformed (non-array) affected/ranges/events read as "no fix", never as a throw.
  const list = (v) => (Array.isArray(v) ? v : []);
  for (const affected of list(record?.affected)) {
    if (affected?.package?.ecosystem !== pkg.ecosystem) continue;
    if (!sameName(pkg.ecosystem, affected?.package?.name, pkg.name)) continue;
    for (const range of list(affected?.ranges)) {
      for (const event of list(range?.events)) {
        const fixed = event?.fixed;
        if (typeof fixed !== 'string' || fixed.length === 0) continue;
        if (compareVersions(fixed, pkg.version) <= 0) continue;
        if (best === null || compareVersions(fixed, best) < 0) best = fixed;
      }
    }
  }
  return best;
}

const RANGE_COMPARATOR_RE = /^(<=|>=|<|>|=)\s*(\d+(?:\.\d+)*)$/;
const NUMERIC_VERSION_RE = /^\d+(?:\.\d+)*$/;

/**
 * Parse a GHSA `last_known_affected_version_range` (`< 1.0.0`, `>= 0.0.0, < 1.0.0`)
 * into comparators, or null when any part does not parse.
 * Ceiling (BV-004): only purely numeric dotted versions — a pre-release bound
 * reads as unparseable, so the finding is kept. Revisit if such bounds show up.
 */
function parseVersionRange(text) {
  if (typeof text !== 'string') return null;
  const comparators = [];
  for (const part of text.split(',')) {
    const m = RANGE_COMPARATOR_RE.exec(part.trim());
    if (!m) return null;
    comparators.push({ op: m[1], version: m[2] });
  }
  return comparators;
}

/**
 * Compare two purely numeric dotted versions, a missing segment counting as 0
 * (`1.0` ≡ `1.0.0` ≡ `1.0.0.0`). compareVersions() ranks a missing segment
 * lower, which would drop an advisory whose bound the version meets. Segments
 * compare as BigInt: Number() rounds above 2^53 and turns very long digit runs
 * into Infinity, which would make an affected version look outside its bound.
 */
function compareNumericVersions(a, b) {
  const pa = a.split('.').map(BigInt);
  const pb = b.split('.').map(BigInt);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const x = pa[i] ?? 0n;
    const y = pb[i] ?? 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * True when the entry carries its own bound data (an upper OSV event or an
 * enumerated version list); the GHSA bound then competes with it and decides nothing.
 */
function hasOwnBound(entry) {
  if (Array.isArray(entry?.versions) && entry.versions.length > 0) return true;
  const ranges = Array.isArray(entry?.ranges) ? entry.ranges : [];
  return ranges.some((r) =>
    (Array.isArray(r?.events) ? r.events : []).some((e) => e && ('fixed' in e || 'last_affected' in e || 'limit' in e)),
  );
}

function satisfiesComparator(version, { op, version: bound }) {
  const c = compareNumericVersions(String(version), bound);
  if (op === '<') return c < 0;
  if (op === '<=') return c <= 0;
  if (op === '>') return c > 0;
  if (op === '>=') return c >= 0;
  return c === 0;
}

/**
 * True only when the record's GHSA bound proves `pkg.version` unaffected: every
 * affected entry for the package carries a parseable
 * `database_specific.last_known_affected_version_range` and the version lies
 * outside each one (#1814). OSV keeps such ranges open-ended
 * (`introduced: 0.0.0`), so its server-side match alone over-reports.
 * Fail-closed: no matching entry, a missing or unparseable bound, an entry
 * with its own fixed/last_affected/limit event or versions list, or a
 * non-numeric installed version (pre-release ordering is approximate) → false.
 */
function outsideKnownAffectedRange(record, pkg) {
  if (!NUMERIC_VERSION_RE.test(String(pkg.version))) return false;
  const matching = (Array.isArray(record?.affected) ? record.affected : []).filter(
    (a) => a?.package?.ecosystem === pkg.ecosystem && sameName(pkg.ecosystem, a?.package?.name, pkg.name),
  );
  if (matching.length === 0) return false;
  return matching.every((a) => {
    if (hasOwnBound(a)) return false;
    const comparators = parseVersionRange(a?.database_specific?.last_known_affected_version_range);
    return comparators !== null && !comparators.every((c) => satisfiesComparator(pkg.version, c));
  });
}

const CVE_RE = /^CVE-\d{4}-\d{4,}$/;

/**
 * CVE ids a fetched advisory record names: its own id if it is a CVE, then its
 * `aliases` that are CVEs. A missing or malformed `aliases` contributes nothing.
 * @returns {string[]}
 */
function cveAliasesFromRecord(record) {
  const own = typeof record?.id === 'string' && CVE_RE.test(record.id) ? [record.id] : [];
  const aliases = Array.isArray(record?.aliases) ? record.aliases : [];
  return [...own, ...aliases.filter((a) => typeof a === 'string' && CVE_RE.test(a))];
}

function isTimeout(err) {
  return err?.code === 'ETIMEDOUT' || /timed? ?out/i.test(String(err?.message ?? ''));
}

async function queryBatch(request, queries, deadlineAt) {
  const timeoutMs = Math.max(1, deadlineAt - Date.now());
  const res = await request(`${OSV_BASE}/querybatch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ queries }),
    timeoutMs,
    maxBytes: BATCH_MAX_BYTES,
  });
  if (!res?.ok) throw new Error(`querybatch HTTP ${res?.status}`);
  const doc = await res.json();
  const results = doc?.results;
  if (!Array.isArray(results) || results.length !== queries.length) {
    throw new Error('querybatch result count does not match the query count');
  }
  return results;
}

/** Fetch details for `ids`; returns { records: Map<id, record>, missing: Map<id, reason> }. */
async function fetchDetails(request, ids, { deadlineAt, maxDetails }) {
  const records = new Map();
  const missing = new Map();
  const toFetch = ids.slice(0, maxDetails);
  for (const id of ids.slice(maxDetails)) missing.set(id, 'detail-cap');
  let next = 0;
  const worker = async () => {
    while (next < toFetch.length) {
      const id = toFetch[next];
      next += 1;
      if (Date.now() >= deadlineAt) {
        missing.set(id, 'deadline');
        continue;
      }
      try {
        const res = await request(`${OSV_BASE}/vulns/${encodeURIComponent(id)}`, {
          method: 'GET',
          timeoutMs: Math.max(1, deadlineAt - Date.now()),
          maxBytes: DETAIL_MAX_BYTES,
        });
        if (!res?.ok) throw new Error(`vulns HTTP ${res?.status}`);
        records.set(id, await res.json());
      } catch (err) {
        missing.set(id, isTimeout(err) ? 'deadline' : 'network');
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(DETAIL_CONCURRENCY, toFetch.length) }, worker));
  return { records, missing };
}

/**
 * Run the `lockfile` check over `base..head`. Never throws.
 *
 * @param {object} [opts]
 * @param {string} opts.repoRoot     repository root
 * @param {string|null} opts.base    base ref (full SHA); empty → skipped `no-range`
 * @param {string} opts.head         head ref (full SHA)
 * @param {number} [opts.deadlineAt] epoch ms; no network request starts after it
 * @param {typeof httpRequest} [opts.request]  injectable HTTP transport (tests)
 * @param {(args: string[]) => Promise<string>} [opts.runGit]  injectable git runner (tests)
 * @param {number} [opts.maxDetails] cap on advisory detail requests (default 25)
 * @param {NodeJS.ProcessEnv} [opts.env]  environment for the host npm policy and pip index (tests)
 * @param {string} [opts.homeDir]  home directory for `~/.npmrc` and the user pip.conf (tests)
 * @param {(file: string) => string|null} [opts.readConfigFile]  pip config reader; null = absent (tests)
 * @returns {Promise<ReturnType<typeof makeCheckResult>>} CheckResult with id `lockfile`
 */
export async function runLockfileCheck({
  repoRoot,
  base,
  head,
  deadlineAt,
  request = httpRequest,
  runGit = defaultRunGit(repoRoot),
  maxDetails = DEFAULT_MAX_DETAILS,
  env,
  homeDir,
  readConfigFile,
} = {}) {
  const started = Date.now();
  const deadline = Number.isFinite(deadlineAt) ? deadlineAt : started + BUDGET.networkMs;
  const ms = () => Date.now() - started;
  let pending = 0; // public packages not yet measured, for the internal-error path

  try {
    if (!base || !head) return makeCheckResult({ id: 'lockfile', status: 'skipped', reason: 'no-range', ms: ms() });

    // The same host-state inputs the npm policy reads also decide pip's private
    // index (#1772); passing them keeps an injected env from mixing with the real one.
    const delta = await readLockfileDelta({ repoRoot, base, head, runGit, env, homeDir, readConfigFile });
    if (delta.files.length === 0) {
      return makeCheckResult({ id: 'lockfile', status: 'skipped', reason: 'no-lockfile-change', ms: ms() });
    }

    // Introduced but unmeasurable: unreadable files, entries without a usable
    // version, non-`==` requirement lines. They never read as a clean measurement.
    const preUnchecked = delta.unparsed + delta.unpinned;
    const preReason = delta.unparsed > 0 ? 'unparsed' : delta.unpinned > 0 ? 'unpinned' : null;

    // Each lockfile is governed by the root `.npmrc` plus the one next to it,
    // both as committed at `head` (#1788), and by the host's npm config.
    const host = readHostNpmrcPolicy({ env, homeDir });
    const byDir = new Map();
    for (const p of delta.packages) {
      const dir = path.posix.dirname(p.file);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(p);
    }
    // An unreadable `.npmrc` fails closed in readNpmrcPolicy; the run must then
    // say it is incomplete (#1775). It only governs npm packages, so a uv/pip-only
    // directory does not degrade on it.
    const npmrcUnreadable = new Set();
    const publicPackages = [];
    for (const [dir, pkgs] of byDir) {
      const policy = await readNpmrcPolicy({ head, runGit, dir, host });
      if (pkgs.some((p) => p.ecosystem === 'npm')) for (const f of policy.unreadable) npmrcUnreadable.add(f);
      publicPackages.push(...filterPublicPackages(pkgs, policy).public);
    }
    // A pin whose pip index could not be established is kept away from OSV
    // (fail closed) and counted as not measured, never dropped into a clean ok.
    // A pin from a KNOWN private index is excluded like an npm private scope.
    const pipGap = delta.packages.filter((p) => p.resolved === PIP_INDEX_UNVERIFIABLE).length;
    const sourceGap = npmrcUnreadable.size + pipGap;
    const gapReason =
      preReason ?? (npmrcUnreadable.size > 0 ? 'npmrc-unreadable' : pipGap > 0 ? 'pip-index-unverifiable' : null);
    // One query per (ecosystem, name, version); the first file that introduced it is reported.
    const byKey = new Map();
    for (const p of publicPackages) {
      const key = `${p.ecosystem}\0${p.name}\0${p.version}`;
      if (!byKey.has(key)) byKey.set(key, p);
    }
    const packages = [...byKey.values()];
    // `pending` feeds the timeout/network/internal-error returns: it carries the npmrc and pip gaps too.
    pending = packages.length + preUnchecked + sourceGap;
    if (packages.length === 0) {
      return makeCheckResult({
        id: 'lockfile',
        status: preUnchecked + sourceGap > 0 ? 'degraded' : 'ok',
        reason: gapReason,
        checked: 0,
        unchecked: preUnchecked + sourceGap,
        ms: ms(),
      });
    }

    const results = [];
    for (let i = 0; i < packages.length; i += BATCH_SIZE) {
      const chunk = packages.slice(i, i + BATCH_SIZE);
      const queries = chunk.map((p) => ({ package: { name: p.name, ecosystem: p.ecosystem }, version: p.version }));
      if (Date.now() >= deadline) {
        return makeCheckResult({ id: 'lockfile', status: 'degraded', reason: 'timeout', unchecked: pending, ms: ms() });
      }
      try {
        results.push(...(await queryBatch(request, queries, deadline)));
      } catch (err) {
        return makeCheckResult({
          id: 'lockfile',
          status: 'degraded',
          reason: isTimeout(err) ? 'timeout' : 'network',
          unchecked: pending,
          ms: ms(),
        });
      }
    }
    pending = preUnchecked + sourceGap;

    const hits = [];
    for (let i = 0; i < packages.length; i += 1) {
      const vulns = Array.isArray(results[i]?.vulns) ? results[i].vulns : [];
      const ids = [...new Set(vulns.map((v) => v?.id).filter((id) => typeof id === 'string' && id.length > 0))];
      if (ids.length > 0) hits.push({ pkg: packages[i], ids });
    }

    const detailIds = [...new Set(hits.flatMap((h) => h.ids.filter((id) => !id.startsWith('MAL-'))))];
    const { records, missing } = await fetchDetails(request, detailIds, { deadlineAt: deadline, maxDetails });

    let detailGaps = 0;
    let broken = 0;
    const findings = [];
    for (const { pkg, ids } of hits) {
      // One malformed package costs only itself, never the other findings.
      try {
        // A malicious package is critical with no fix, whatever its sibling
        // advisories say: record it before touching any (possibly malformed) record.
        if (ids.some((id) => id.startsWith('MAL-'))) {
          findings.push(
            makeFinding({
              class: 'malicious',
              severity: 'critical',
              ecosystem: pkg.ecosystem,
              package: pkg.name,
              version: pkg.version,
              fixedIn: null,
              ids,
              file: pkg.file,
              introduced: true,
            }),
          );
          continue;
        }
        const graded = []; // { severity, fixed } per advisory with a record
        // Primary ids first, then the CVE aliases of the records actually fetched,
        // so a KEV join on CVE ids sees a GHSA's CVE (#1769 stage 2).
        const withAliases = new Set(ids);
        let gap = false;
        let kept = 0; // advisories not ruled out by their version bound
        for (const id of ids) {
          const record = records.get(id);
          if (!record) {
            gap = true;
            kept += 1;
            continue;
          }
          // The bound proves this version unaffected: the advisory is no finding (#1814).
          if (outsideKnownAffectedRange(record, pkg)) {
            withAliases.delete(id);
            continue;
          }
          kept += 1;
          for (const cve of cveAliasesFromRecord(record)) withAliases.add(cve);
          graded.push({ severity: normalizeOsvSeverity(record?.database_specific?.severity), fixed: fixedFromRecord(record, pkg) });
        }
        if (kept === 0) continue;
        let severity = 'unknown';
        for (const g of graded) if (severityRank(g.severity) < severityRank(severity)) severity = g.severity;
        // fixedIn comes only from advisories AT the finding's severity: a fix for a
        // low advisory must not make an unfixed critical one look fixable (blocking).
        let fixedIn = null;
        for (const g of graded) {
          if (g.severity !== severity || g.fixed === null) continue;
          if (fixedIn === null || compareVersions(g.fixed, fixedIn) > 0) fixedIn = g.fixed;
        }
        findings.push(
          makeFinding({
            class: 'vuln',
            severity,
            ecosystem: pkg.ecosystem,
            package: pkg.name,
            version: pkg.version,
            fixedIn,
            ids: [...withAliases],
            file: pkg.file,
            introduced: true,
          }),
        );
        if (gap) detailGaps += 1;
      } catch {
        broken += 1;
      }
    }

    const unchecked = detailGaps + broken + preUnchecked + sourceGap;
    const detailReason = detailGaps > 0 ? DETAIL_REASONS.find((r) => [...missing.values()].includes(r)) : null;
    const reason = detailReason ?? (broken > 0 ? 'internal-error' : gapReason);
    return makeCheckResult({
      id: 'lockfile',
      status: unchecked > 0 ? 'degraded' : 'ok',
      reason: unchecked > 0 ? reason : null,
      checked: packages.length,
      unchecked,
      findings,
      ms: ms(),
    });
  } catch {
    // Something failed outside the per-item guards: at least one item went unmeasured.
    return makeCheckResult({ id: 'lockfile', status: 'degraded', reason: 'internal-error', unchecked: Math.max(1, pending), ms: ms() });
  }
}
