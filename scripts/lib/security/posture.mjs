/**
 * posture.mjs — `/security posture`: install and publish settings of a repo (#2203).
 *
 * Judged at a commit (`ref`, default HEAD); expected values depend on the repo's
 * canonical package manager (`packageManager` field, else the tracked lockfile).
 * Checks, each `pass`/`fail`/`not-measurable`/`skipped`:
 *   script-execution  npm: `ignore-scripts=true`; pnpm: that, or a build allowlist
 *   release-age       npm `min-release-age`; pnpm `minimum-release-age` / `minimumReleaseAge`
 *   floating-tag      security-delta check, base = empty tree
 *   runtime-floor     security-delta check, base = empty tree
 *   update-automation Renovate or Dependabot config present (list shared with status.mjs)
 *   mirror-protection github-protection-audit, only with a GitHub remote and an authenticated gh
 *   baseline-npmrc    repo cooldown vs the baseline's templates/shared/.npmrc
 *
 * Never echoes a `.npmrc` line other than the keys it judges (the file can hold
 * auth tokens), never the gh auth text or a token scope, never a baseline path.
 * Contract: ./contract.mjs.
 */
import { lstatSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';

import { auditGithubBranchProtection } from '../../github-protection-audit.mjs';
import { baselineSourcePath, resolveBaselineLocation } from '../baseline-archetypes.mjs';
import { loadHostPaths } from '../config/host-paths.mjs';
import { execFileSync } from '../native-command.mjs';
import { loadOwnerConfig, resolveOwnerYamlPath } from '../owner-yaml.mjs';
import { runFloatingTagCheck } from '../security-delta/floating-tags.mjs';
import { runRuntimeFloorCheck } from '../security-delta/runtime-floor.mjs';
import { EMPTY_TREE } from '../security-pulse/refresh.mjs';
import { resolveRepoHost, resolveRepoSpec } from '../vcs-repo-spec.mjs';
import { makeResult } from './contract.mjs';
import { findUpdateAutomationFiles } from './status.mjs';

/** NAMED CEILING (BV-004): 1 MiB per config file read. Revisit if a real `.npmrc` or workspace file exceeds it. */
const MAX_READ_BYTES = 1024 * 1024;

const GIT_OPTS = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 2 * MAX_READ_BYTES };

/** Timeout for each `gh` probe (`--version`, `auth status`); mirrors the audit's own default. */
const GH_TIMEOUT_MS = 8000;

const MINUTES_PER_DAY = 1440;

const BASELINE_NPMRC = 'templates/shared/.npmrc';

/** Typed read failure; `code` is the error class reported as the reason. */
class ReadFailure extends Error {
  constructor(code) {
    super(code);
    this.name = 'ReadFailure';
    this.code = code;
  }
}

const failureCode = (err) => (err instanceof ReadFailure ? err.code : err?.reason ?? err?.name ?? 'unreadable');

/** File access at one commit: `read` returns the text, or null when the path is absent at `sha`. */
function makeReader(repoRoot, sha) {
  const tree = new Set(
    execFileSync('git', ['-C', repoRoot, 'ls-tree', '-r', '--name-only', '-z', sha], { ...GIT_OPTS, maxBuffer: 64 * MAX_READ_BYTES })
      .split('\0').filter(Boolean),
  );
  return {
    has: (rel) => tree.has(rel),
    /** Names directly inside `dir` ('' = root), files only. */
    list(dir) {
      const prefix = dir ? `${dir}/` : '';
      return [...tree].filter((p) => p.startsWith(prefix) && !p.slice(prefix.length).includes('/')).map((p) => p.slice(prefix.length));
    },
    read(rel) {
      if (!tree.has(rel)) return null;
      let text;
      try {
        text = execFileSync('git', ['-C', repoRoot, 'show', `${sha}:${rel}`], GIT_OPTS);
      } catch (err) {
        throw new ReadFailure(err?.code === 'ENOBUFS' ? 'too-large' : 'git-show-failed');
      }
      if (Buffer.byteLength(text) > MAX_READ_BYTES) throw new ReadFailure('too-large');
      return text;
    },
  };
}

/** Read a file into `{ text, problem }`; `text: null, problem: null` means absent. */
function readSafe(reader, rel) {
  try {
    return { text: reader.read(rel), problem: null };
  } catch (err) {
    return { text: null, problem: `${rel} unreadable (${failureCode(err)})` };
  }
}

/**
 * `.npmrc` as `key → value`. Comments (`#`, `;`) skipped; split on the first `=`
 * with `indexOf` (linear, no backtracking regex), key and value trimmed, so a
 * stray CR does not drop the key.
 * @param {string} text
 * @returns {Map<string, string>}
 */
function parseNpmrc(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (key === '' || key[0] === '#' || key[0] === ';') continue;
    out.set(key, line.slice(eq + 1).trim());
  }
  return out;
}

/** A numeric value as shown to the operator; anything else is never echoed. */
const shown = (v) => (/^\d+$/.test(v) ? v : '(non-numeric value)');

/** The canonical package manager at the commit, or a reason it is not measurable. */
function detectPackageManager(reader, pkg) {
  if (pkg.problem) return { pm: null, problem: pkg.problem };
  if (pkg.json && typeof pkg.json.packageManager === 'string') {
    const name = pkg.json.packageManager.split('@')[0].trim();
    if (name) return { pm: name, source: 'packageManager field', problem: null };
  }
  if (reader.has('package-lock.json')) return { pm: 'npm', source: 'package-lock.json', problem: null };
  if (reader.has('pnpm-lock.yaml')) return { pm: 'pnpm', source: 'pnpm-lock.yaml', problem: null };
  for (const [file, pm] of [['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']]) {
    if (reader.has(file)) return { pm, source: file, problem: null };
  }
  return { pm: null, problem: 'no packageManager field and no tracked lockfile' };
}

function readPackageJson(reader) {
  const r = readSafe(reader, 'package.json');
  if (r.problem || r.text === null) return { json: null, problem: r.problem };
  try {
    return { json: JSON.parse(r.text), problem: null };
  } catch {
    return { json: null, problem: 'package.json is not valid JSON' };
  }
}

function readWorkspace(reader) {
  const r = readSafe(reader, 'pnpm-workspace.yaml');
  if (r.problem || r.text === null) return { yaml: null, problem: r.problem };
  try {
    return { yaml: parseYaml(r.text) ?? {}, problem: null };
  } catch {
    return { yaml: null, problem: 'pnpm-workspace.yaml is not valid YAML' };
  }
}

const notCovered = (pm) => `package manager ${pm} not covered`;

function scriptExecutionCheck(ctx) {
  const base = { id: 'script-execution', check: 'script execution' };
  const { pm, npmrc, pkg, ws } = ctx;
  if (!pm.pm) return { ...base, state: 'not-measurable', detail: 'package manager unknown', reason: pm.problem };
  if (pm.pm !== 'npm' && pm.pm !== 'pnpm') return { ...base, state: 'not-measurable', detail: `package manager ${pm.pm}`, reason: notCovered(pm.pm) };
  if (npmrc.problem) return { ...base, state: 'not-measurable', detail: '.npmrc not read', reason: npmrc.problem };
  if (npmrc.map.get('ignore-scripts') === 'true') return { ...base, state: 'pass', detail: `${pm.pm}: ignore-scripts=true in .npmrc`, file: '.npmrc' };
  if (pm.pm === 'pnpm') {
    if (Array.isArray(ws.yaml?.onlyBuiltDependencies)) {
      return { ...base, state: 'pass', detail: 'pnpm: build allowlist onlyBuiltDependencies in pnpm-workspace.yaml', file: 'pnpm-workspace.yaml' };
    }
    if (Array.isArray(pkg.json?.pnpm?.onlyBuiltDependencies)) {
      return { ...base, state: 'pass', detail: 'pnpm: build allowlist pnpm.onlyBuiltDependencies in package.json', file: 'package.json' };
    }
    if (ws.problem) return { ...base, state: 'not-measurable', detail: 'pnpm-workspace.yaml not read', reason: ws.problem };
    if (pkg.problem) return { ...base, state: 'not-measurable', detail: 'package.json not read', reason: pkg.problem };
    return {
      ...base, state: 'fail', file: '.npmrc',
      detail: 'pnpm: no ignore-scripts=true in .npmrc and no onlyBuiltDependencies allowlist',
      fix: 'set ignore-scripts=true in .npmrc or add onlyBuiltDependencies to pnpm-workspace.yaml',
    };
  }
  return { ...base, state: 'fail', file: '.npmrc', detail: 'npm: ignore-scripts=true is not set in .npmrc', fix: 'set ignore-scripts=true in .npmrc' };
}

/**
 * The repo's release-age cooldown in minutes, or why it is unknown.
 * @returns {{minutes: number|null, key: string, file: string|null, raw: string|null, problem: string|null, unit: string}}
 */
function repoCooldown(ctx) {
  const { pm, npmrc, ws } = ctx;
  if (pm.pm === 'npm') {
    if (npmrc.problem) return { minutes: null, key: 'min-release-age', file: '.npmrc', raw: null, problem: npmrc.problem, unit: 'days' };
    const raw = npmrc.map.get('min-release-age') ?? null;
    const minutes = raw !== null && /^\d+$/.test(raw) ? Number(raw) * MINUTES_PER_DAY : null;
    return { minutes, key: 'min-release-age', file: raw === null ? null : '.npmrc', raw, problem: null, unit: 'days' };
  }
  // pnpm: `.npmrc` key first, then the workspace setting; both in minutes.
  if (npmrc.problem) return { minutes: null, key: 'minimum-release-age', file: '.npmrc', raw: null, problem: npmrc.problem, unit: 'minutes' };
  const fromRc = npmrc.map.get('minimum-release-age') ?? null;
  if (fromRc !== null) {
    return { minutes: /^\d+$/.test(fromRc) ? Number(fromRc) : null, key: 'minimum-release-age', file: '.npmrc', raw: fromRc, problem: null, unit: 'minutes' };
  }
  if (ws.problem) return { minutes: null, key: 'minimumReleaseAge', file: 'pnpm-workspace.yaml', raw: null, problem: ws.problem, unit: 'minutes' };
  const fromWs = ws.yaml?.minimumReleaseAge;
  if (fromWs !== undefined && fromWs !== null) {
    const raw = String(fromWs);
    return { minutes: /^\d+$/.test(raw) ? Number(raw) : null, key: 'minimumReleaseAge', file: 'pnpm-workspace.yaml', raw, problem: null, unit: 'minutes' };
  }
  return { minutes: null, key: 'minimum-release-age (.npmrc) or minimumReleaseAge (pnpm-workspace.yaml)', file: null, raw: null, problem: null, unit: 'minutes' };
}

function releaseAgeCheck(ctx) {
  const base = { id: 'release-age', check: 'release-age cooldown' };
  const { pm } = ctx;
  if (!pm.pm) return { ...base, state: 'not-measurable', detail: 'package manager unknown', reason: pm.problem };
  if (pm.pm !== 'npm' && pm.pm !== 'pnpm') return { ...base, state: 'not-measurable', detail: `package manager ${pm.pm}`, reason: notCovered(pm.pm) };
  const c = ctx.cooldown;
  if (c.problem) return { ...base, state: 'not-measurable', detail: `${c.key} not read`, reason: c.problem };
  if (c.raw === null) {
    return { ...base, state: 'fail', detail: `release age not set (${c.key})`, fix: `set ${c.key} (${c.unit})` };
  }
  if (c.minutes === null) return { ...base, state: 'not-measurable', detail: `${c.key} is set`, reason: `${c.key} is not a whole number`, file: c.file };
  // npm and pnpm both read 0 as "no cooldown".
  if (c.minutes === 0) return { ...base, state: 'fail', detail: `release age is 0 (${c.key}), no cooldown`, file: c.file, fix: `set ${c.key} above 0 (${c.unit})` };
  return { ...base, state: 'pass', detail: `${c.key}=${shown(c.raw)} (${c.unit})`, file: c.file };
}

/** Map a security-delta check result onto a Check plus contract Findings. */
function deltaCheck(id, label, result, toFinding) {
  const base = { id, check: label };
  const findings = (result.findings ?? []).map(toFinding);
  const why = result.reason ?? 'no reason given';
  if (findings.length > 0) {
    const partial = result.status === 'degraded' ? ` (run incomplete: ${why}, ${result.unchecked} not checked)` : '';
    return { check: { ...base, state: 'fail', detail: `${findings.length} finding(s), ${result.checked} checked${partial}`, checked: result.checked }, findings };
  }
  if (result.status === 'ok') return { check: { ...base, state: 'pass', detail: `${result.checked} declaration(s) checked, none below standard`, checked: result.checked }, findings };
  if (result.status === 'skipped') return { check: { ...base, state: 'skipped', detail: 'nothing to judge', reason: why }, findings };
  return { check: { ...base, state: 'not-measurable', detail: `check ${result.status}`, reason: why }, findings };
}

const floatingFinding = (f) => ({
  id: `floating-tag:${f.file}:${f.package}`,
  class: 'floating-tag',
  state: 'measured',
  detail: `image ${f.package} uses floating tag ${f.version ?? '(none)'}`,
  file: f.file,
  fix: 'pin a concrete tag or a sha256 digest',
  severity: f.severity,
});

const runtimeFinding = (f) => ({
  id: `runtime-floor:${f.file}:${f.version}`,
  class: 'runtime-floor',
  state: 'measured',
  detail: `node ${f.version} is below the security floor ${f.fixedIn}`,
  file: f.file,
  fix: `bump to ${f.fixedIn}`,
  severity: f.severity,
});

function updateAutomationCheck(reader) {
  const base = { id: 'update-automation', check: 'update automation' };
  const found = findUpdateAutomationFiles((dir) => reader.list(dir));
  if (found.length > 0) return { ...base, state: 'pass', detail: `config: ${found.join(', ')}`, file: found[0] };
  return { ...base, state: 'fail', detail: 'no Renovate or Dependabot config', fix: 'add a Renovate or Dependabot config' };
}

/** Exit status of a probe command; output is discarded, never returned. */
function probe(cmd, args, env) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore', timeout: GH_TIMEOUT_MS, env });
    return 'ok';
  } catch (err) {
    return err?.code === 'ENOENT' ? 'missing' : 'failed';
  }
}

async function mirrorProtectionCheck(repoRoot, env) {
  const base = { id: 'mirror-protection', check: 'mirror protection' };
  let spec;
  let host;
  try {
    spec = resolveRepoSpec({ repoRoot, vcs: 'github' });
    host = resolveRepoHost({ repoRoot, vcs: 'github' });
  } catch {
    spec = undefined;
  }
  if (!spec) return { check: { ...base, state: 'skipped', detail: 'not run', reason: 'no GitHub remote' }, findings: [] };
  if (probe('gh', ['--version'], env) === 'missing') return { check: { ...base, state: 'skipped', detail: 'not run', reason: 'gh not installed' }, findings: [] };
  const authArgs = host ? ['auth', 'status', '--hostname', host] : ['auth', 'status'];
  if (probe('gh', authArgs, env) !== 'ok') return { check: { ...base, state: 'skipped', detail: 'not run', reason: 'gh not authenticated' }, findings: [] };

  const audit = await auditGithubBranchProtection({ repoRoot });
  if (typeof audit?.degraded === 'string') {
    return { check: { ...base, state: 'not-measurable', detail: 'audit could not measure the mirror', reason: `audit degraded (${audit.degraded})` }, findings: [] };
  }
  // Only ids, severities and counts leave the audit: its messages can name token scopes.
  const ids = Array.isArray(audit?.findings) ? audit.findings.filter((f) => typeof f?.id === 'string') : [];
  const findings = ids.map((f) => ({
    id: `mirror-protection:${f.id}`,
    class: 'mirror-protection',
    state: 'measured',
    detail: `GitHub mirror default branch: ${f.id}`,
    fix: 'see docs/github-mirror-protection.md',
    severity: typeof f.severity === 'string' ? f.severity : null,
  }));
  if (findings.length === 0) return { check: { ...base, state: 'pass', detail: 'audit found nothing' }, findings };
  return { check: { ...base, state: 'fail', detail: `${findings.length} audit finding(s): ${ids.map((f) => f.id).join(', ')}`, count: findings.length }, findings };
}

/** Read the baseline template behind an lstat and the size cap. */
function readBaselineFile(file) {
  const st = lstatSync(file);
  if (!st.isFile() || st.size > MAX_READ_BYTES) throw new ReadFailure('not-regular-or-too-large');
  return readFileSync(file, 'utf8');
}

async function baselineNpmrcCheck(repoRoot, env, ctx) {
  const base = { id: 'baseline-npmrc', check: 'baseline .npmrc cooldown' };
  let root;
  try {
    const hostPaths = loadHostPaths({ env, ownerLoader: () => loadOwnerConfig({ path: resolveOwnerYamlPath(env) }) });
    root = await resolveBaselineLocation({ repoRoot, hostPaths });
  } catch (err) {
    return { ...base, state: 'not-measurable', detail: 'baseline not resolved', reason: `baseline unavailable (${failureCode(err)})` };
  }
  if (!root) return { ...base, state: 'skipped', detail: 'not judged', reason: 'no baseline configured' };
  let text;
  try {
    text = readBaselineFile(baselineSourcePath(root, BASELINE_NPMRC, false, { missingReason: 'template-missing' }));
  } catch (err) {
    return { ...base, state: 'not-measurable', detail: `baseline ${BASELINE_NPMRC} not read`, reason: failureCode(err) };
  }
  const raw = parseNpmrc(text).get('minimum-release-age');
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return { ...base, state: 'not-measurable', detail: 'baseline template has no numeric value', reason: `baseline ${BASELINE_NPMRC} has no numeric minimum-release-age` };
  }
  const expected = Number(raw);
  const { pm } = ctx;
  if (pm.pm !== 'npm' && pm.pm !== 'pnpm') {
    return { ...base, state: 'not-measurable', detail: `baseline expects ${expected} minutes`, reason: pm.pm ? notCovered(pm.pm) : pm.problem };
  }
  const c = ctx.cooldown;
  if (c.problem) return { ...base, state: 'not-measurable', detail: `baseline expects ${expected} minutes`, reason: c.problem };
  if (c.raw !== null && c.minutes === null) {
    return { ...base, state: 'not-measurable', detail: `baseline expects ${expected} minutes`, reason: `${c.key} is not a whole number` };
  }
  const unitNote = pm.pm === 'npm' ? ' (npm min-release-age is in days, 1 day = 1440 minutes)' : '';
  // No value at all is release-age's finding; one cause, one finding.
  if (c.minutes === null) {
    return { ...base, state: 'skipped', detail: `baseline expects ${expected} minutes${unitNote}`, reason: 'repo has no cooldown; see release-age' };
  }
  if (c.minutes >= expected) {
    return { ...base, state: 'pass', detail: `repo ${c.minutes} minutes >= baseline ${expected} minutes${unitNote}`, file: c.file };
  }
  return {
    ...base, state: 'fail', file: c.file,
    detail: `repo ${c.minutes} minutes < baseline ${expected} minutes${unitNote}`,
    fix: pm.pm === 'npm' ? `raise min-release-age to at least ${Math.ceil(expected / MINUTES_PER_DAY)} (days)` : `raise ${c.key} to at least ${expected}`,
  };
}

const findingFor = (c) => ({ id: c.id, class: c.id, state: 'measured', detail: c.detail, ...(c.file ? { file: c.file } : {}), ...(c.fix ? { fix: c.fix } : {}) });

/**
 * @param {object} args
 * @param {string} args.repoRoot
 * @param {string|null} args.ref
 * @param {NodeJS.ProcessEnv} args.env
 * @param {Date} [args.now]
 * @param {typeof import('../http-request.mjs').httpRequest} [args.request]
 *   test seam; replaces the network call, never the address. Forwarded to the runtime-floor
 *   check (the only reused check here that takes it). Absent → the check's own HTTP transport.
 * @returns {Promise<import('./contract.mjs').Result>}
 */
export async function run({ repoRoot, ref, env, request }) {
  let sha = ref;
  let reader;
  try {
    if (sha === null) sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--verify', 'HEAD^{commit}'], GIT_OPTS).trim();
    reader = makeReader(repoRoot, sha);
  } catch {
    return makeResult({
      mode: 'posture', status: 'degraded', reason: 'the commit tree could not be read',
      basis: { tree: 'commit', ref: sha || null, note: null },
    });
  }

  const npmrcRead = readSafe(reader, '.npmrc');
  const pkg = readPackageJson(reader);
  const ctx = {
    npmrc: { map: npmrcRead.text === null ? new Map() : parseNpmrc(npmrcRead.text), problem: npmrcRead.problem },
    pkg,
    ws: readWorkspace(reader),
    pm: detectPackageManager(reader, pkg),
  };
  ctx.cooldown = ctx.pm.pm === 'npm' || ctx.pm.pm === 'pnpm' ? repoCooldown(ctx) : null;

  const floating = deltaCheck('floating-tag', 'floating tags', await runFloatingTagCheck({ repoRoot, base: EMPTY_TREE, head: sha }), floatingFinding);
  const runtime = deltaCheck('runtime-floor', 'runtime floor', await runRuntimeFloorCheck({ repoRoot, base: EMPTY_TREE, head: sha, ...(request ? { request } : {}) }), runtimeFinding);
  const mirror = await mirrorProtectionCheck(repoRoot, env);

  const ownChecks = [scriptExecutionCheck(ctx), releaseAgeCheck(ctx), updateAutomationCheck(reader), await baselineNpmrcCheck(repoRoot, env, ctx)];
  const checks = [ownChecks[0], ownChecks[1], floating.check, runtime.check, ownChecks[2], mirror.check, ownChecks[3]];
  const findings = [
    ...ownChecks.filter((c) => c.state === 'fail').map(findingFor),
    ...floating.findings,
    ...runtime.findings,
    ...mirror.findings,
  ];
  const notChecked = checks.filter((c) => c.state === 'not-measurable').length;
  const basis = { tree: 'commit', ref: sha, note: 'mirror protection is read live from GitHub, not at the commit' };
  return makeResult({ mode: 'posture', status: findings.length > 0 ? 'findings' : 'ok', findings, checks, notChecked, basis });
}
