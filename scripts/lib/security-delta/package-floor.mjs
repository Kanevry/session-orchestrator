/**
 * package-floor.mjs — the `package-floor` Security-Delta check (#1769, stage 3, item 1b).
 *
 * Offline. Compares the npm packages a range INTRODUCED against the package
 * floors of the security-floor register (projects-baseline
 * `scripts/lib/security-floors.json`, semantics of its checker
 * `check-security-floors.mjs`, #763). Candidates:
 *   (a) every npm package `readLockfileDelta()` reports as introduced;
 *   (b) a `packageManager` value of a `package.json` changed in the range
 *       whose value differs between base and head (`pnpm@10.34.5+sha512.…`).
 * Only names the register lists under `kind: package` are judged.
 *
 * Register source: the host-local baseline (`resolveBaselineLocation()` →
 * `scripts/lib/security-floors.json`). Only when no baseline is configured, or
 * the baseline has no register file, the repository as committed at `head`
 * (`scripts/security-floors.json`, then `scripts/lib/security-floors.json`) is
 * used, else `skipped`/`no-register`. A configured but unavailable baseline
 * degrades with `baseline-unavailable` and never falls back to the repo register.
 *
 * Register text is data from another repository: its `source` and `bad`
 * strings never enter a finding or a reason. Only the validated `floor`
 * semver reaches `fixedIn`.
 *
 * Ceilings (BV-004):
 *   - Only `kind: package` entries are used; `runtime` (Node has its own
 *     check), `image` and `platform` entries are ignored. Revisit when the
 *     register carries image floors a fleet repo pins.
 *   - `engines.node` / `engines.<pm>` lower bounds and dependency RANGES in
 *     `package.json` are not read — only lockfile pins and `packageManager`.
 *     Revisit when a floor miss slips through a range-only repo.
 *   - Only `package.json` files changed in `base..head` are read for
 *     `packageManager`; an unchanged one is pre-existing and out of the delta.
 *   - Lockfiles the lockfile reader could not parse are not re-counted here;
 *     the `lockfile` check already degrades the run on them.
 */
import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { baselineSourcePath, resolveBaselineLocation } from '../baseline-archetypes.mjs';
import { makeCheckResult, makeFinding } from './contract.mjs';
import { PATH_ABSENT } from './floating-tags.mjs';
import { defaultRunGit, readLockfileDelta } from './lockfiles.mjs';

const ID = 'package-floor';

/** Register path inside the baseline, and the repo-local paths tried at `head`. */
export const BASELINE_REGISTER_PATH = 'scripts/lib/security-floors.json';
export const REPO_REGISTER_PATHS = Object.freeze(['scripts/security-floors.json', 'scripts/lib/security-floors.json']);

/** Larger registers are rejected as invalid, never read. */
export const MAX_REGISTER_BYTES = 256 * 1024;

/** A register whose `checked ?? updated` date is older than this degrades the check. */
export const STALE_AFTER_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const KINDS = new Set(['runtime', 'package', 'image', 'platform']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SEMVER_CORE = String.raw`(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?`;
const FLOOR_RE = new RegExp(`^${SEMVER_CORE}$`);
const VERSION_RE = new RegExp(`^v?${SEMVER_CORE}$`);
// Same shape as the PB checker: optional scope, name, `@`, version up to an optional `+hash`.
const PACKAGE_MANAGER_RE = /^((?:@[^/@]+\/)?[^@]+)@([^+]+)/;

class RegisterError extends Error {
  constructor() {
    super('security-floor register invalid');
    this.name = 'RegisterError';
  }
}

/** @returns {{major:number, minor:number, patch:number, pre:string[]}|null} */
function parseSemver(text, re) {
  const m = typeof text === 'string' ? re.exec(text) : null;
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** Semver precedence (build metadata ignored): <0, 0, >0. `1.0.0-rc.1 < 1.0.0`. */
export function compareSemver(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const an = /^\d+$/.test(a.pre[i]);
    const bn = /^\d+$/.test(b.pre[i]);
    if (an && bn) {
      const d = Number(a.pre[i]) - Number(b.pre[i]);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (a.pre[i] !== b.pre[i]) {
      return a.pre[i] < b.pre[i] ? -1 : 1;
    }
  }
  return 0;
}

/** Epoch ms of a valid `YYYY-MM-DD` calendar date, else null. */
function calendarDate(value) {
  const m = typeof value === 'string' ? DATE_RE.exec(value) : null;
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(ms);
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? ms : null;
}

const nonEmpty = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate a register text with the PB `loadFloors` strictness.
 * Throws RegisterError on any violation (the message carries no register text).
 *
 * @param {string} text
 * @returns {{asOf:number, packages:{name:string, line:number, floor:object|null, floorText:string|null, bad:boolean}[]}}
 */
export function parseRegister(text) {
  const check = (ok) => {
    if (!ok) throw new RegisterError();
  };
  check(typeof text === 'string' && Buffer.byteLength(text, 'utf8') <= MAX_REGISTER_BYTES);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new RegisterError();
  }
  check(doc !== null && typeof doc === 'object' && !Array.isArray(doc));
  const updated = calendarDate(doc.updated);
  check(updated !== null);
  const checked = doc.checked === undefined ? null : calendarDate(doc.checked);
  check(doc.checked === undefined || checked !== null);
  check(Array.isArray(doc.entries) && doc.entries.length > 0);
  const keys = new Set();
  const packages = [];
  for (const e of doc.entries) {
    check(e !== null && typeof e === 'object' && !Array.isArray(e));
    check(KINDS.has(e.kind) && nonEmpty(e.name) && nonEmpty(e.source) && nonEmpty(e.since));
    check(calendarDate(e.since) !== null);
    check((e.floor !== undefined) !== (e.bad !== undefined));
    const floor = e.floor === undefined ? null : parseSemver(e.floor, FLOOR_RE);
    check(e.floor === undefined || floor !== null);
    check(e.bad === undefined || nonEmpty(e.bad));
    if (e.kind === 'package') {
      check(typeof e.line === 'string' && /^\d+$/.test(e.line));
      check(floor === null || floor.major === Number(e.line));
    }
    if (e.kind === 'runtime' && e.name === 'node') {
      check(Number.isInteger(e.major) && e.major >= 1 && (floor === null || floor.major === e.major));
    }
    // Same key as PB `loadFloors`: every kind is discriminated by major ?? line.
    const key = `${e.kind}:${e.name}:${String(e.major ?? e.line ?? '')}`;
    check(!keys.has(key));
    keys.add(key);
    if (e.kind === 'package') {
      packages.push({ name: e.name, line: Number(e.line), floor, floorText: floor ? e.floor : null, bad: e.bad !== undefined });
    }
  }
  return { asOf: checked ?? updated, packages };
}

/**
 * Judge one candidate version against the package entries of its name.
 * @returns {{fixedIn:string|null}|null} a finding shape, or null when the version passes
 */
export function judgeVersion(version, entries) {
  const lines = entries.map((e) => e.line);
  const entry = entries.find((e) => e.line === version.major);
  if (!entry) {
    // No entry for this major: older than every registered line = a bad line;
    // newer than all, or a missing middle line, passes (PB #763 semantics).
    return lines.every((l) => version.major < l) ? { fixedIn: null } : null;
  }
  if (entry.bad) return { fixedIn: null };
  return compareSemver(version, entry.floor) < 0 ? { fixedIn: entry.floorText } : null;
}

/** `git show <ref>:<file>`, null when the path does not exist at that ref; any other failure rethrows. */
async function showAt(runGit, ref, file) {
  try {
    return await runGit(['show', `${ref}:${file}`]);
  } catch (err) {
    if (PATH_ABSENT.test(`${err?.stderr ?? ''}\n${err?.message ?? ''}`)) return null;
    throw err;
  }
}

/** `packageManager` of a package.json text; undefined = unparseable, null = none. */
function packageManagerOf(text) {
  if (text === null) return null;
  try {
    const doc = JSON.parse(text);
    return doc && typeof doc === 'object' && typeof doc.packageManager === 'string' ? doc.packageManager : null;
  } catch {
    return undefined;
  }
}

/** Name part of a `packageManager` value: text before the first `@` after an optional scope, else the whole value. */
function packageManagerName(value) {
  const at = value.indexOf('@', value.startsWith('@') ? 1 : 0);
  return at === -1 ? value : value.slice(0, at);
}

/**
 * Candidates the range introduced: lockfile npm packages plus changed `packageManager` values.
 * `unparsed` counts unparseable head package.json files (always unchecked);
 * `unmatchedPm` holds the names of changed `packageManager` values without a
 * parseable version — unchecked only if the register lists that name.
 * @returns {Promise<{candidates:{name:string, version:string, file:string}[], unparsed:number, unmatchedPm:string[]}>}
 */
async function readCandidates({ repoRoot, base, head, runGit, env, homeDir, readConfigFile }) {
  // Ceiling (BV-004): the lockfile check reads the same delta, so git runs it twice
  // per close. Revisit when `budget_exceeded` events show package-floor degraded `budget`.
  const delta = await readLockfileDelta({ repoRoot, base, head, runGit, env, homeDir, readConfigFile });
  const candidates = delta.packages.filter((p) => p.ecosystem === 'npm').map((p) => ({ name: p.name, version: p.version, file: p.file }));
  let unparsed = 0;
  const unmatchedPm = [];
  const changed = (await runGit(['diff', '--name-only', '-z', base, head]))
    .split('\0')
    .filter((f) => f && path.posix.basename(f) === 'package.json' && !f.split('/').includes('node_modules'));
  for (const file of changed) {
    const [before, after] = await Promise.all([showAt(runGit, base, file), showAt(runGit, head, file)]);
    const pmAfter = packageManagerOf(after);
    if (pmAfter === undefined) {
      unparsed += 1; // an unreadable head package.json may hide a packageManager change
      continue;
    }
    if (pmAfter === null || pmAfter === packageManagerOf(before)) continue;
    const m = PACKAGE_MANAGER_RE.exec(pmAfter);
    if (!m) {
      unmatchedPm.push(packageManagerName(pmAfter));
      continue;
    }
    candidates.push({ name: m[1], version: m[2], file });
  }
  const seen = new Set();
  return {
    candidates: candidates.filter((c) => {
      const key = `${c.name}\0${c.version}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
    unparsed,
    unmatchedPm,
  };
}

/** Read a baseline register file with the size cap; oversized reads as an invalid register. */
function readCapped(file) {
  if (lstatSync(file).size > MAX_REGISTER_BYTES) throw new RegisterError();
  return readFileSync(file, 'utf8');
}

/**
 * Locate and read the register text.
 *
 * The repo register at `head` is used ONLY when no baseline is configured
 * (`resolveBaseline` returns null) or the baseline has no register file
 * (`register-missing`). Every other baseline failure — a THROW from
 * `resolveBaseline` (config unavailable, unsafe baseline dir), an unsafe or
 * unreadable baseline register file — returns `baselineUnavailable`, even when
 * a repo register exists: the repo-controlled register must never silently
 * replace the host one (a laxer repo floor would hide a miss).
 *
 * @returns {Promise<{text:string|null, baselineUnavailable:boolean, invalid:boolean}>}
 */
async function loadRegisterText({ repoRoot, head, runGit, resolveBaseline }) {
  const unavailable = { text: null, baselineUnavailable: true, invalid: false };
  let root;
  try {
    root = await resolveBaseline({ repoRoot });
  } catch {
    return unavailable;
  }
  if (root) {
    let file = null;
    try {
      file = baselineSourcePath(root, BASELINE_REGISTER_PATH, false, { missingReason: 'register-missing' });
    } catch (err) {
      if (err?.reason !== 'register-missing') return unavailable;
    }
    if (file) {
      try {
        return { text: readCapped(file), baselineUnavailable: false, invalid: false };
      } catch (err) {
        return err instanceof RegisterError ? { text: null, baselineUnavailable: false, invalid: true } : unavailable;
      }
    }
  }
  for (const p of REPO_REGISTER_PATHS) {
    const text = await showAt(runGit, head, p);
    if (text !== null) return { text, baselineUnavailable: false, invalid: false };
  }
  return { text: null, baselineUnavailable: false, invalid: false };
}

/**
 * Run the `package-floor` check over `base..head`. Never throws.
 *
 * @param {object} [opts]
 * @param {string} opts.repoRoot
 * @param {string|null} opts.base   empty → skipped `no-range`
 * @param {string} opts.head
 * @param {(args: string[]) => Promise<string>} [opts.runGit]  injectable git runner (tests)
 * @param {(o: {repoRoot: string}) => Promise<string|null>} [opts.resolveBaseline]
 *   baseline dir resolver (default `resolveBaselineLocation`); tests inject it so they never read the host baseline
 * @param {() => number} [opts.now]  clock for the staleness check (tests)
 * @param {NodeJS.ProcessEnv} [opts.env]  passed to the lockfile reader (pip index lookup)
 * @param {string} [opts.homeDir]
 * @param {(file: string) => string|null} [opts.readConfigFile]
 * @returns {Promise<ReturnType<typeof makeCheckResult>>} CheckResult with id `package-floor`
 *
 * Reasons: `no-range`, `no-candidates` (skipped, register never read),
 * `no-register` (skipped), `baseline-unavailable`, `register-invalid`,
 * `stale-register`, `unmeasurable-version`, `internal-error` (degraded).
 * An invalid register with candidates degrades with `unchecked` = candidate
 * count; without candidates the register is not read at all.
 */
export async function runPackageFloorCheck({
  repoRoot,
  base,
  head,
  runGit = defaultRunGit(repoRoot),
  resolveBaseline = resolveBaselineLocation,
  now = Date.now,
  env,
  homeDir,
  readConfigFile,
} = {}) {
  const started = Date.now();
  const ms = () => Math.max(0, Date.now() - started);
  let pending = 1;
  try {
    if (!base || !head) return makeCheckResult({ id: ID, status: 'skipped', reason: 'no-range', ms: ms() });

    const { candidates, unparsed, unmatchedPm } = await readCandidates({ repoRoot, base, head, runGit, env, homeDir, readConfigFile });
    if (candidates.length === 0 && unparsed === 0 && unmatchedPm.length === 0) {
      return makeCheckResult({ id: ID, status: 'skipped', reason: 'no-candidates', ms: ms() });
    }
    pending = candidates.length + unparsed + unmatchedPm.length;

    const loaded = await loadRegisterText({ repoRoot, head, runGit, resolveBaseline });
    let register = null;
    if (!loaded.invalid && loaded.text !== null) {
      try {
        register = parseRegister(loaded.text);
      } catch {
        register = null;
        loaded.invalid = true;
      }
    }
    if (loaded.invalid) {
      return makeCheckResult({ id: ID, status: 'degraded', reason: 'register-invalid', unchecked: pending, ms: ms() });
    }
    if (register === null) {
      return loaded.baselineUnavailable
        ? makeCheckResult({ id: ID, status: 'degraded', reason: 'baseline-unavailable', unchecked: pending, ms: ms() })
        : makeCheckResult({ id: ID, status: 'skipped', reason: 'no-register', ms: ms() });
    }

    const byName = new Map();
    for (const e of register.packages) {
      if (!byName.has(e.name)) byName.set(e.name, []);
      byName.get(e.name).push(e);
    }
    let checked = 0;
    // A versionless packageManager value only hides a floor miss when the register lists its name.
    let unchecked = unparsed + unmatchedPm.filter((name) => byName.has(name)).length;
    const findings = [];
    for (const c of candidates) {
      const entries = byName.get(c.name);
      if (!entries) continue;
      const version = parseSemver(c.version, VERSION_RE);
      if (!version) {
        unchecked += 1;
        continue;
      }
      checked += 1;
      const hit = judgeVersion(version, entries);
      if (!hit) continue;
      findings.push(
        makeFinding({
          class: 'package-floor',
          severity: 'critical',
          ecosystem: 'npm',
          package: c.name,
          version: c.version,
          fixedIn: hit.fixedIn,
          ids: [],
          file: c.file,
          introduced: true,
        }),
      );
    }

    const stale = now() - register.asOf > STALE_AFTER_DAYS * DAY_MS;
    const reason = stale ? 'stale-register' : unchecked > 0 ? 'unmeasurable-version' : null;
    return makeCheckResult({ id: ID, status: reason ? 'degraded' : 'ok', reason, checked, unchecked, findings, ms: ms() });
  } catch {
    return makeCheckResult({ id: ID, status: 'degraded', reason: 'internal-error', unchecked: pending, ms: ms() });
  }
}
