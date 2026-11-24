/**
 * deps.mjs — `/security deps`: advisories of every lockfile, ranked (#2202).
 *
 * Every lockfile in the tree at `ref` (default HEAD) goes through the existing
 * OSV client with git's empty tree as base, exactly as the advisory-pulse
 * refresher does (whole tree, 30 s network deadline, 50 detail records). The
 * private-scope filter of that client keeps private packages away from OSV.
 *
 * The client dedupes a package across lockfiles; this mode copies each finding
 * back to EVERY lockfile that contains the same (ecosystem, name, version), so
 * results stay split per lockfile.
 *
 * Ranking (finding `class` and extra key `rank`):
 *   fix-now        a malicious package (OSV class `malicious`), always; or
 *                  severity >= the repo's audit threshold and not dev-only
 *   can-wait       severity below the threshold
 *   not-reachable  dev-only in package-lock.json, or a direct dependency with
 *                  no static import found, the latter also only in package-lock.json
 *                  (other formats measure neither the dev flag nor direct vs nested
 *                  copies); a transitive production package never
 *   (none)         severity not measurable → finding state `not-measurable`
 *
 * Reads only (git at the judged commit); never throws. Contract: ./contract.mjs.
 */
import path from 'node:path';

import { severityRank } from '../security-delta/contract.mjs';
import { defaultRunGit, PIP_INDEX_UNVERIFIABLE, readLockfileDelta } from '../security-delta/lockfiles.mjs';
import { filterPublicPackages, readHostNpmrcPolicy, readNpmrcPolicy } from '../security-delta/npmrc.mjs';
import { runLockfileCheck } from '../security-delta/osv.mjs';
import { EMPTY_TREE } from '../security-pulse/refresh.mjs';
import { execFileSync } from '../native-command.mjs';
import { makeResult } from './contract.mjs';

/** The refresher's whole-tree budget (refresh.mjs REPO_DEADLINE_MS / REPO_MAX_DETAILS). */
const NETWORK_DEADLINE_MS = 30_000;
const MAX_DETAILS = 50;

const SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** npm package name grammar; anything else never reaches a git argument. */
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const LEVEL_WORDS = { critical: 'critical', high: 'high', moderate: 'medium', medium: 'medium', low: 'low', info: 'low', none: 'low' };
/** Service failures that make the whole run degraded (a detail-cap gap does not). */
const SERVICE_FAILURES = new Set(['timeout', 'network', 'deadline', 'internal-error']);
const EXCEPTION_OFFER = 'exception with date';
const PRIVATE_ONLY = 'only private packages; none sent to the advisory service';
const LOCKFILE_EXCLUDES = ['**/node_modules/**', '**/package-lock.json', '**/pnpm-lock.yaml', '**/uv.lock', '**/requirements*.txt']
  .map((g) => `:(exclude,glob)${g}`);

/** Memoised git runner: the lockfile reader, the OSV client and this mode read the same blobs. */
function memoGit(repoRoot) {
  const run = defaultRunGit(repoRoot);
  const cache = new Map();
  return (args) => {
    const key = args.join('\0');
    if (!cache.has(key)) cache.set(key, run(args));
    return cache.get(key);
  };
}

/** `git show <sha>:<rel>` text, or null when absent or unreadable. */
async function showOrNull(git, sha, rel) {
  try {
    return await git(['show', `${sha}:${rel}`]);
  } catch {
    return null;
  }
}

/** Own keys only: `constructor`, `__proto__` or `toString` must not resolve through the prototype. */
const level = (word) => {
  const key = String(word).toLowerCase();
  return Object.hasOwn(LEVEL_WORDS, key) ? LEVEL_WORDS[key] : null;
};

/** Lines without YAML comments. */
const codeLines = (text) => text.split(/\r?\n/).filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s#.*$/, ''));

/**
 * Audit threshold: `.npmrc` audit-level, else a literal `--audit-level` of an
 * audit command in CI, else `high` (source `default`). Only the key is read.
 */
async function readThreshold(git, sha) {
  const npmrc = await showOrNull(git, sha, '.npmrc');
  if (npmrc !== null) {
    for (const line of npmrc.split(/\r?\n/)) {
      const m = /^\s*audit-level\s*=\s*([A-Za-z]+)\s*$/.exec(line);
      if (m && level(m[1])) return { threshold: level(m[1]), source: '.npmrc' };
    }
  }
  const ciFiles = ['.gitlab-ci.yml'];
  try {
    const listed = await git(['ls-tree', '--name-only', sha, '--', '.github/workflows/']);
    for (const p of listed.split('\n')) if (/\.ya?ml$/.test(p)) ciFiles.push(p);
  } catch {
    // no workflows directory readable: CI threshold from .gitlab-ci.yml only
  }
  for (const rel of ciFiles) {
    const text = await showOrNull(git, sha, rel);
    if (text === null) continue;
    for (const line of codeLines(text)) {
      if (!/\b(?:npm|pnpm|yarn|bun)\s+audit\b/.test(line)) continue;
      // A variable such as ${AUDIT_LEVEL} does not match the word and counts as not found.
      const m = /--audit-level(?:=|\s+)([A-Za-z]+)(?=\s|$|["'])/.exec(line);
      if (m && level(m[1])) return { threshold: level(m[1]), source: rel };
    }
  }
  return { threshold: 'high', source: 'default' };
}

/** package-lock.json → Map<`name\0version`, boolean devOnly> (every instance dev: true). */
function devFlags(text) {
  const flags = new Map();
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  for (const [key, entry] of Object.entries(doc?.packages ?? {})) {
    const idx = key.lastIndexOf('node_modules/');
    if (idx === -1 || !entry || typeof entry !== 'object' || typeof entry.version !== 'string') continue;
    const names = new Set([key.slice(idx + 'node_modules/'.length)]);
    if (typeof entry.name === 'string' && entry.name !== '') names.add(entry.name);
    for (const name of names) {
      const k = `${name}\0${entry.version}`;
      // devOptional packages are still installed under --omit=dev: not dev-only.
      flags.set(k, (flags.get(k) ?? true) && entry.dev === true);
    }
  }
  return { flags, topLevel: (name) => doc?.packages?.[`node_modules/${name}`]?.version ?? null };
}

/** Per-lockfile context: dev flags, direct dependency names, top-level versions. */
async function lockfileContext(git, sha, file) {
  const dir = path.posix.dirname(file);
  const ctx = { dir, dev: null, topLevel: null, prod: new Set(), devDirect: new Set(), manifest: false };
  if (path.posix.basename(file) === 'package-lock.json') {
    const text = await showOrNull(git, sha, file);
    const parsed = text === null ? null : devFlags(text);
    if (parsed) {
      ctx.dev = parsed.flags;
      ctx.topLevel = parsed.topLevel;
    }
  }
  const pkgText = await showOrNull(git, sha, dir === '.' ? 'package.json' : `${dir}/package.json`);
  if (pkgText !== null) {
    try {
      const pkg = JSON.parse(pkgText);
      ctx.manifest = true;
      for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg?.[field] ?? {})) ctx.prod.add(name);
      }
      for (const name of Object.keys(pkg?.devDependencies ?? {})) ctx.devDirect.add(name);
    } catch {
      ctx.manifest = false;
    }
  }
  return ctx;
}

/**
 * Static-import census of one package name inside the lockfile's directory, at
 * `sha`, fixed strings only. Returns the number of files, or null (not measurable).
 */
async function importCensus(git, sha, dir, name) {
  if (!NPM_NAME_RE.test(name)) return null;
  const patterns = ['from \'', 'from "', 'require(\'', 'require("', 'import(\'', 'import("', 'import \'', 'import "']
    .flatMap((p) => ['-e', `${p}${name}`]);
  let out;
  try {
    out = await git(['grep', '-l', '-F', ...patterns, sha, '--', dir, ...LOCKFILE_EXCLUDES]);
  } catch (err) {
    if (err?.code === 1) return 0; // git grep: no match
    return null;
  }
  return out.split('\n').filter((l) => l && !/(^|[/:])node_modules\//.test(l)).length;
}

/**
 * Why a lockfile yielded no package: the reader reports `unparsed`/`unpinned` only
 * in aggregate, so it is re-run for this one file (git reads are memoised).
 * Ceiling: outside package-lock.json v2/v3 (see isEmptyPackageLock), an empty
 * lockfile and an unsupported format version (package-lock v1) both read zero
 * entries and cannot be told apart; both count as not measurable.
 */
async function unlistedReason(git, repoRoot, sha, env, file) {
  const onlyThis = (args) => (args[0] === 'diff' && args[1] === '--name-only' ? Promise.resolve(`${file}\0`) : git(args));
  try {
    const one = await readLockfileDelta({ repoRoot, base: EMPTY_TREE, head: sha, runGit: onlyThis, env });
    if (one.unparsed > 0) return 'lockfile unreadable or unparsable';
    if (one.unpinned > 0) return 'no ==-pinned requirement';
    return 'no package entry read (empty or unsupported lockfile format)';
  } catch {
    return 'lockfile unreadable or unparsable';
  }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/**
 * Every field through which npm can be told to install something, with whether
 * it is a list by type. `{}` is empty for every field; `[]` only for a list field
 * (an array where npm expects a name→range map is a wrong type).
 */
const DEP_FIELD_IS_LIST = {
  dependencies: false, devDependencies: false, optionalDependencies: false, peerDependencies: false,
  bundleDependencies: true, bundledDependencies: true, workspaces: true,
};
const DEP_FIELDS = Object.keys(DEP_FIELD_IS_LIST);
/** Any value other than `{}` (or `[]` for a list field), e.g. non-empty, string, `true`, number, null, declares something. */
const isEmptyField = (k, v) => (isPlainObject(v) && Object.keys(v).length === 0)
  || (DEP_FIELD_IS_LIST[k] && Array.isArray(v) && v.length === 0);
/** A plain object none of whose own DEP_FIELDS declares anything. */
const declaresNothing = (o) => isPlainObject(o) && DEP_FIELDS.every((k) => !Object.hasOwn(o, k) || isEmptyField(k, o[k]));

/** git modes of a regular blob; a symlink (120000) shows its target text, not the file it points to. */
const isRegularMode = (mode) => mode === '100644' || mode === '100755';

/** git mode of one root-relative path at `sha`, or null when absent or unreadable. */
async function modeOrNull(git, sha, rel) {
  try {
    const m = /^(\d{6}) \S+ \S+\t/.exec(String((await git(['ls-tree', '--full-tree', '-z', sha, '--', rel])) ?? ''));
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** JSON.parse that returns null instead of throwing. */
function parseOrNull(text) {
  try {
    return text === null ? null : JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Measured zero: the project declares no dependency and the lockfile lists none.
 * `package.json` decides, because a lockfile alone cannot prove emptiness: npm
 * installs what package.json declares, so an empty lockfile next to a declared
 * dependency means an unpinned install, not a clean project. True ONLY when
 * - package-lock.json parses as an object with lockfileVersion exactly 2 or 3;
 * - `packages` is an object that is empty or holds only the root entry `""`
 *   (itself an object);
 * - neither the lockfile's top level nor its root entry carries a DEP_FIELDS key
 *   other than absent or empty (see isEmptyField);
 * - the package.json beside it exists at `sha`, parses as an object and carries
 *   no DEP_FIELDS key other than absent or empty;
 * - both files are regular blobs at `sha` (a symlink would be read as its
 *   target text, not as the file npm reads).
 * Anything else, including a read or parse failure, stays not measurable.
 */
async function isEmptyPackageLock(git, sha, file) {
  if (path.posix.basename(file) !== 'package-lock.json') return false;
  if (!isRegularMode(await modeOrNull(git, sha, file))) return false;
  const doc = parseOrNull(await showOrNull(git, sha, file));
  if (!declaresNothing(doc) || !Object.hasOwn(doc, 'lockfileVersion')) return false;
  if (doc.lockfileVersion !== 2 && doc.lockfileVersion !== 3) return false;
  const pkgs = Object.hasOwn(doc, 'packages') ? doc.packages : undefined;
  if (!isPlainObject(pkgs)) return false;
  const keys = Object.keys(pkgs);
  if (keys.length > 1 || (keys.length === 1 && (keys[0] !== '' || !declaresNothing(pkgs[''])))) return false;
  const dir = path.posix.dirname(file);
  const manifestPath = dir === '.' ? 'package.json' : `${dir}/package.json`;
  if (!isRegularMode(await modeOrNull(git, sha, manifestPath))) return false;
  const manifest = parseOrNull(await showOrNull(git, sha, manifestPath));
  return declaresNothing(manifest);
}

function proposedFix(finding, direct) {
  if (!finding.fixedIn) return 'replace (no patched release)';
  return direct ? `bump to ${finding.fixedIn}` : `override to ${finding.fixedIn}`;
}

/** One OSV finding in one lockfile → a contract Finding. */
async function rankFinding(git, sha, ctx, f, file, threshold, detailReason) {
  const key = `${f.package}\0${f.version}`;
  const listedDirect = ctx.prod.has(f.package) || ctx.devDirect.has(f.package);
  // With a package-lock, the direct copy is the top-level one; a nested other version is transitive.
  const direct = listedDirect && (ctx.topLevel === null || ctx.topLevel(f.package) === f.version);
  const devOnly = ctx.dev === null ? null : ctx.dev.get(key) === true;
  let imports;
  if (direct) imports = await importCensus(git, sha, ctx.dir, f.package);
  const ids = f.ids.join(', ');
  const base = {
    id: `${f.package}@${f.version}`,
    file,
    package: f.package,
    version: f.version,
    severity: f.severity,
    ids: [...f.ids],
    fixedIn: f.fixedIn,
    direct,
    devOnly: devOnly === null ? 'not-measurable' : devOnly,
    imports: direct ? (imports ?? 'not-measurable') : null,
  };
  const reach = !direct ? null : imports === null ? 'import census not measurable' : imports === 0 ? 'no static import found' : `imported in ${imports} file(s)`;
  const dev = devOnly === null ? 'dev flag not measurable' : devOnly ? 'dev-only' : 'production';
  // Only package-lock.json measures dev and direct-vs-nested copies; elsewhere "direct" is a manifest guess.
  const reachMeasured = ctx.dev !== null;
  const basisText = [direct ? 'direct' : 'transitive', dev, reach, reachMeasured ? null : 'reachability not measurable for this lockfile format']
    .filter(Boolean)
    .join(', ');
  if (f.class === 'malicious') {
    // Dev-only status, import census, severity and threshold do not apply: install scripts run on any install.
    const fix = 'remove the package (malicious)';
    return {
      ...base,
      class: 'fix-now',
      rank: 'fix-now',
      state: 'measured',
      detail: `malicious package ${ids}; ${basisText}; malicious package: runs at install time, reachability is irrelevant`,
      fix,
      offers: [fix],
    };
  }
  if (f.severity === 'unknown') {
    return {
      ...base,
      class: 'severity-not-measurable',
      state: 'not-measurable',
      detail: `${f.class === 'vuln' ? 'advisory' : f.class} ${ids}; ${basisText}`,
      reason: `severity not measurable: no advisory detail with a severity was read${detailReason ? ` (${detailReason})` : ''}`,
    };
  }
  let rank;
  if (devOnly === true || (reachMeasured && direct && imports === 0)) rank = 'not-reachable';
  else if (severityRank(f.severity) <= severityRank(threshold)) rank = 'fix-now';
  else rank = 'can-wait';
  const fix = proposedFix(f, direct);
  const offers = rank === 'fix-now' ? [fix] : [fix, EXCEPTION_OFFER];
  return {
    ...base,
    class: rank,
    rank,
    state: 'measured',
    detail: `${f.severity} advisory ${ids}; ${basisText}`,
    fix: offers.join('; or '),
    offers,
  };
}

/** Basis of the judgement: the commit, and whether the working tree differs from it. */
function judgedBasis(repoRoot, ref, sha) {
  if (ref !== null) return { tree: 'commit', ref: sha, note: null };
  let dirty;
  try {
    dirty = execFileSync('git', ['--no-optional-locks', '-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() !== '';
  } catch {
    return { tree: 'commit', ref: sha, note: 'working-tree state not readable; uncommitted changes are not included' };
  }
  return { tree: 'commit', ref: sha, note: dirty ? `judged commit ${sha}; uncommitted changes are not included` : null };
}

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string|null} args.ref
 * @param {NodeJS.ProcessEnv} args.env
 * @param {Date} args.now  part of the mode contract; deps reports no time of its own. The 30 s network
 *   deadline uses the wall clock (Date.now()) because the reused OSV client compares `deadlineAt`
 *   with Date.now() and accepts no clock, so a fixed `now` cannot shift or exhaust it.
 * @param {typeof import('../http-request.mjs').httpRequest} [args.request] test seam: replaces
 *   the OSV client's network call (same signature as httpRequest), never the address; absent →
 *   the client's default transport. The CLI does not pass it.
 * @returns {Promise<import('./contract.mjs').Result>}
 */
export async function run({ repoRoot, ref, env, request }) {
  const mode = 'deps';
  let sha = ref;
  if (sha === null) {
    try {
      sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch {
      sha = null;
    }
    if (!sha || !SHA_RE.test(sha)) return makeResult({ mode, status: 'degraded', reason: 'HEAD could not be resolved', notChecked: 1 });
  }
  const basis = judgedBasis(repoRoot, ref, sha);
  try {
    const git = memoGit(repoRoot);
    const delta = await readLockfileDelta({ repoRoot, base: EMPTY_TREE, head: sha, runGit: git, env });
    if (delta.files.length === 0) {
      return makeResult({ mode, status: 'skipped', basis, reason: 'no lockfile (package-lock.json, pnpm-lock.yaml, uv.lock, requirements*.txt) in the tree' });
    }
    const check = await runLockfileCheck({
      repoRoot,
      base: EMPTY_TREE,
      head: sha,
      runGit: git,
      // Wall clock on purpose: the reused client compares deadlineAt with Date.now() and takes no clock.
      deadlineAt: Date.now() + NETWORK_DEADLINE_MS,
      maxDetails: MAX_DETAILS,
      env,
      ...(request ? { request } : {}),
    });
    const { threshold, source } = await readThreshold(git, sha);
    const checks = [{
      id: 'audit-threshold',
      check: 'audit threshold',
      state: source === 'default' ? 'off' : 'on',
      detail: source === 'default' ? 'no audit-level configured; default high' : `${threshold} (from ${source})`,
      threshold,
      source,
      ...(source === 'default' ? {} : { file: source }),
    }];

    // Same private filter as the OSV client, per lockfile directory: which public packages each file holds.
    const host = readHostNpmrcPolicy({ env });
    const filesByKey = new Map();
    const publicCount = new Map();
    const listedCount = new Map();
    const byDir = new Map();
    const filterGap = new Set(); // dirs whose private filter was not measurable (unreadable .npmrc, pip index)
    for (const p of delta.packages) {
      const dir = path.posix.dirname(p.file);
      if (!byDir.has(dir)) byDir.set(dir, []);
      byDir.get(dir).push(p);
      listedCount.set(p.file, (listedCount.get(p.file) ?? 0) + 1);
      if (p.resolved === PIP_INDEX_UNVERIFIABLE) filterGap.add(dir);
    }
    for (const [dir, pkgs] of byDir) {
      const policy = await readNpmrcPolicy({ head: sha, runGit: git, dir, host });
      if (policy.unreadable.length > 0) filterGap.add(dir);
      for (const p of filterPublicPackages(pkgs, policy).public) {
        publicCount.set(p.file, (publicCount.get(p.file) ?? 0) + 1);
        const key = `${p.ecosystem}\0${p.name}\0${p.version}`;
        if (!filesByKey.has(key)) filesByKey.set(key, new Set());
        filesByKey.get(key).add(p.file);
      }
    }

    const detailReason = check.unchecked > 0 ? check.reason : null;
    const contexts = new Map();
    const findings = [];
    for (const f of check.findings) {
      const files = filesByKey.get(`${f.ecosystem}\0${f.package}\0${f.version}`) ?? new Set([f.file]);
      for (const file of [...files].sort()) {
        if (!contexts.has(file)) contexts.set(file, await lockfileContext(git, sha, file));
        findings.push(await rankFinding(git, sha, contexts.get(file), f, file, threshold, detailReason));
      }
    }
    findings.sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id));

    const serviceFailed = check.status === 'degraded' && SERVICE_FAILURES.has(check.reason);
    const unchecked = []; // { file, reason }: lockfiles that exist but of which nothing was checked
    let skippedFiles = 0;
    for (const file of [...delta.files].sort()) {
      const mine = findings.filter((x) => x.file === file);
      const counts = { fixNow: 0, canWait: 0, notReachable: 0, notMeasurable: 0 };
      for (const x of mine) {
        if (x.rank === 'fix-now') counts.fixNow += 1;
        else if (x.rank === 'can-wait') counts.canWait += 1;
        else if (x.rank === 'not-reachable') counts.notReachable += 1;
        else counts.notMeasurable += 1;
      }
      const base = { id: `lockfile:${file}`, check: `lockfile ${file}`, file, counts };
      const summary = `${counts.fixNow} fix now, ${counts.canWait} can wait, ${counts.notReachable} not reachable, ${counts.notMeasurable} severity not measurable`;
      const sent = publicCount.get(file) ?? 0;
      if (serviceFailed && mine.length === 0) {
        checks.push({ ...base, state: 'not-measurable', detail: 'advisories not read', reason: `advisory service failed (${check.reason})` });
      } else if (mine.length === 0 && sent === 0) {
        const listed = listedCount.get(file) ?? 0;
        const dir = path.posix.dirname(file);
        if (listed > 0 && !filterGap.has(dir)) {
          // Every package is private: nothing was sent by design. Skipped, not unchecked.
          skippedFiles += 1;
          checks.push({ ...base, state: 'skipped', detail: `${listed} package(s) listed, all private`, reason: PRIVATE_ONLY });
        } else if (listed === 0 && await isEmptyPackageLock(git, sha, file)) {
          checks.push({ ...base, state: 'pass', detail: '0 packages; nothing to check' });
        } else {
          const reason = listed > 0 ? 'private-package filter not measurable (unreadable .npmrc or pip index)' : await unlistedReason(git, repoRoot, sha, env, file);
          unchecked.push({ file, reason });
          checks.push({ ...base, state: 'not-measurable', detail: 'no package of this lockfile was checked', reason });
        }
      } else {
        checks.push({ ...base, state: mine.length > 0 ? 'fail' : 'pass', detail: mine.length > 0 ? summary : `${sent} package(s) checked, no advisory found` });
      }
    }

    const notChecked = check.unchecked;
    if (check.status === 'skipped') {
      return makeResult({ mode, status: 'skipped', basis, checks, reason: `advisory check skipped (${check.reason})` });
    }
    if (serviceFailed) {
      return makeResult({
        mode,
        status: 'degraded',
        findings,
        checks,
        basis,
        notChecked: Math.max(1, notChecked),
        reason: `advisory service failed (${check.reason}): ${notChecked} package(s) not checked; this is not a "no advisories" result`,
      });
    }
    const total = delta.files.length;
    if (unchecked.length > 0 && unchecked.length + skippedFiles === total) {
      // Not one lockfile was measured: never an ok, never a findings list that reads as a measurement.
      return makeResult({
        mode,
        status: 'degraded',
        findings,
        checks,
        basis,
        notChecked: Math.max(notChecked, unchecked.length),
        reason: `no lockfile could be checked: ${unchecked.length} of ${total} not measurable`,
      });
    }
    for (const { file, reason } of unchecked) {
      findings.push({
        id: `lockfile-unchecked:${file}`,
        class: 'lockfile-unchecked',
        state: 'not-measurable',
        file,
        detail: `lockfile ${file}: no package of this lockfile was checked`,
        reason,
      });
    }
    if (skippedFiles === total) {
      return makeResult({ mode, status: 'skipped', checks, basis, notChecked, reason: PRIVATE_ONLY });
    }
    return makeResult({ mode, status: findings.length > 0 ? 'findings' : 'ok', findings, checks, basis, notChecked });
  } catch (err) {
    return makeResult({ mode, status: 'degraded', basis, notChecked: 1, reason: `deps run failed (${err?.name ?? 'error'})` });
  }
}
