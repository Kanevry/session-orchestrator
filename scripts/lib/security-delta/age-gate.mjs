/**
 * age-gate.mjs — Security-Delta check `age-gate` (#1769, stage 1).
 *
 * When a lockfile changed in `base..head`, check that the repo configures a
 * minimum release age for that package manager, so a freshly published
 * (possibly malicious) version is not installed on day one.
 *
 * Settings, measured 2026-10-23:
 *   - pnpm: `curl -s https://pnpm.io/settings | grep -io 'minimumReleaseAge[^<]*'`
 *     → `minimumReleaseAge` (pnpm-workspace.yaml); the `.npmrc` spelling is
 *     `minimum-release-age` (security.md SEC-020). Local pnpm 10.33.0.
 *   - npm 11.19.1: `npm config ls -l` lists `min-release-age = null` and
 *     `before = null` (an unknown key reads `undefined`), so npm HAS an age
 *     gate; `npm-no-age-gate` is therefore not emitted for current npm.
 *   - uv: `exclude-newer` under `[tool.uv]` in pyproject.toml, or top level in uv.toml.
 *   - pip (`requirements*.txt` without uv config): no age setting → not measurable.
 */

import { basename, dirname, posix } from 'node:path';

import { makeCheckResult, makeFinding } from './contract.mjs';
import { changedFiles, isGitExecError, isSafeRef, pathExistsAt, showFile } from './floating-tags.mjs';

/**
 * Lockfile kind for a path, or null when the path is not a lockfile.
 * @param {string} path
 * @returns {'npm'|'pnpm'|'uv'|'pip'|null}
 */
export function lockfileKind(path) {
  if (path.split('/').includes('node_modules')) return null;
  const name = basename(path);
  if (name === 'package-lock.json') return 'npm';
  if (name === 'pnpm-lock.yaml') return 'pnpm';
  if (name === 'uv.lock') return 'uv';
  if (/^requirements.*\.txt$/.test(name)) return 'pip';
  return null;
}

/** Value of `key=value` in an ini-style `.npmrc`, or null. Comments (`#`, `;`) are skipped. */
export function npmrcValue(text, key) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const m = /^([^=\s]+)\s*=\s*(.*)$/.exec(line);
    if (m && m[1] === key) return m[2].trim();
  }
  return null;
}

/** A set value that is not empty, `0`, `false` or `null`. */
function isEnabled(value) {
  if (value === null || value === undefined) return false;
  const v = String(value).trim().replace(/^["']|["']$/g, '').toLowerCase();
  return v !== '' && v !== '0' && v !== 'false' && v !== 'null';
}

/** `exclude-newer` inside `[tool.uv]` of a pyproject.toml. */
function pyprojectHasExcludeNewer(text) {
  let inUv = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inUv = line === '[tool.uv]';
      continue;
    }
    const m = /^exclude-newer\s*=\s*(.+)$/.exec(line);
    if (inUv && m && isEnabled(m[1])) return true;
  }
  return false;
}

/** Top-level `exclude-newer` in a uv.toml. */
function uvTomlHasExcludeNewer(text) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) return false;
    const m = /^exclude-newer\s*=\s*(.+)$/.exec(line);
    if (m && isEnabled(m[1])) return true;
  }
  return false;
}

/** Config directories to consult for a lockfile: its own directory, then the repo root. */
function configDirs(lockfile) {
  const dir = dirname(lockfile);
  return dir === '.' ? [''] : [dir, ''];
}

async function readConfig(repoRoot, head, dir, name) {
  return showFile(repoRoot, head, dir ? posix.join(dir, name) : name);
}

/**
 * Whether an age gate is configured for one lockfile.
 * @returns {Promise<'gated'|'missing'|{notMeasurable:string}>}
 */
async function gateFor(repoRoot, head, lockfile, kind) {
  for (const dir of configDirs(lockfile)) {
    const npmrc = await readConfig(repoRoot, head, dir, '.npmrc');
    if (kind === 'npm') {
      if (isEnabled(npmrcValue(npmrc, 'min-release-age')) || isEnabled(npmrcValue(npmrc, 'before'))) return 'gated';
    } else if (kind === 'pnpm') {
      if (isEnabled(npmrcValue(npmrc, 'minimum-release-age'))) return 'gated';
      const ws = await readConfig(repoRoot, head, dir, 'pnpm-workspace.yaml');
      const m = /^minimumReleaseAge\s*:\s*(.+?)\s*(?:#.*)?$/m.exec(ws ?? '');
      if (m && isEnabled(m[1])) return 'gated';
    } else {
      const pyproject = await readConfig(repoRoot, head, dir, 'pyproject.toml');
      const uvToml = await readConfig(repoRoot, head, dir, 'uv.toml');
      if (pyprojectHasExcludeNewer(pyproject) || uvTomlHasExcludeNewer(uvToml)) return 'gated';
      if (kind === 'pip' && !uvToml && !/^\[tool\.uv\]/m.test(pyproject ?? '')) return { notMeasurable: 'pip-no-age-gate' };
    }
  }
  return 'missing';
}

/**
 * Report lockfiles changed in `base..head` whose package manager has no
 * minimum-release-age configured at head. A finding is `introduced` only when
 * the lockfile is new in the range or the gate was configured at base.
 * Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string|null} [opts.base]  empty → skipped/no-range
 * @param {string} [opts.head]
 * @returns {Promise<ReturnType<typeof makeCheckResult>>}
 */
export async function runAgeGateCheck({ repoRoot, base, head } = {}) {
  const started = Date.now();
  const done = (r) => makeCheckResult({ id: 'age-gate', ms: Date.now() - started, ...r });
  try {
    if (!base) return done({ status: 'skipped', reason: 'no-range' });
    if (!isSafeRef(base) || !isSafeRef(head)) return done({ status: 'degraded', reason: 'invalid-ref', unchecked: 1 });
    const lockfiles = (await changedFiles(repoRoot, base, head))
      .map((file) => ({ file, kind: lockfileKind(file) }))
      .filter((l) => l.kind !== null);
    if (lockfiles.length === 0) return done({ status: 'skipped', reason: 'no-lockfile-change' });

    const findings = [];
    let checked = 0;
    let unreadable = 0;
    let notMeasurableReason = null;
    for (const { file, kind } of lockfiles) {
      // A config file git cannot read is unchecked, never absent: absent reads as "no gate" (#1774).
      let gate;
      try {
        gate = await gateFor(repoRoot, head, file, kind);
      } catch (err) {
        if (!isGitExecError(err)) throw err; // a defect, not a read failure: outer catch → internal-error
        unreadable += 1;
        continue;
      }
      if (typeof gate === 'object') {
        notMeasurableReason ??= gate.notMeasurable;
        continue;
      }
      checked += 1;
      if (gate === 'missing') {
        // Introduced only when the range removed the gate or added the lockfile;
        // a gate that was already missing at base is listed but moves no verdict.
        // An unreadable base leaves that open: report it as introduced.
        let introduced = true;
        try {
          // Existence only: reading the content would fail on a lockfile above git's buffer (#1775).
          const lockfileNew = !(await pathExistsAt(repoRoot, base, file));
          introduced = lockfileNew || (await gateFor(repoRoot, base, file, kind)) === 'gated';
        } catch (err) {
          if (!isGitExecError(err)) throw err;
          unreadable += 1;
        }
        findings.push(makeFinding({ class: 'age-gate-missing', severity: 'low', ecosystem: null, package: null, file, introduced }));
      }
    }
    if (unreadable > 0) return done({ status: 'degraded', reason: 'unreadable', checked, unchecked: unreadable, findings });
    if (checked === 0) return done({ status: 'not-measurable', reason: notMeasurableReason });
    return done({ status: 'ok', reason: notMeasurableReason, checked, findings });
  } catch {
    return done({ status: 'degraded', reason: 'internal-error', unchecked: 1 });
  }
}
