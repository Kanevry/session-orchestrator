/**
 * setup-precheck.mjs — shared read-only setup measurement (#2230, first cut).
 *
 * Reports, per item, what a repo has (git, VCS remote, package manager and the
 * test/typecheck/lint commands) so callers can ask little and never fall back
 * to an assumed npm. Composes the existing detectors; writes nothing.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { detectVcsFamily } from './vcs-repo-spec.mjs';
import { detectPackageManager, defaultQualityGateCommands } from './package-manager.mjs';

/** @typedef {{ key: string, status: 'detected'|'skipped'|'unknown', value: string|null, reason: string }} PrecheckItem */

const SCRIPT_KEYS = ['test', 'typecheck', 'lint'];

function readScripts(repoRoot) {
  const path = join(repoRoot, 'package.json');
  if (!existsSync(path)) return { exists: false, scripts: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8'));
  const scripts =
    parsed && typeof parsed.scripts === 'object' && parsed.scripts ? parsed.scripts : {};
  return { exists: true, scripts };
}

function probe(key, fn) {
  try {
    return { key, ...fn() };
  } catch (error) {
    return {
      key,
      status: 'unknown',
      value: null,
      reason: `probe failed: ${error?.message ?? String(error)}`,
    };
  }
}

/**
 * Run all setup probes. Never throws; a failing probe yields `status: 'unknown'`.
 *
 * @param {{ repoRoot?: string, gitRun?: Function }} [opts]
 * @returns {{ repoRoot: string, items: PrecheckItem[], summary: { detected: number, skipped: number, unknown: number } }}
 */
export function runSetupPrecheck({ repoRoot = process.cwd(), gitRun } = {}) {
  const items = [];

  items.push(
    probe('git', () => {
      if (!existsSync(repoRoot))
        return { status: 'skipped', value: 'no', reason: 'repo root does not exist' };
      // `.git` is a dir (checkout) or a file (linked worktree); walk up like git does.
      let dir = repoRoot;
      for (;;) {
        if (existsSync(join(dir, '.git')))
          return { status: 'detected', value: 'yes', reason: 'inside a git work tree' };
        const parent = dirname(dir);
        if (parent === dir) break;
        dir = parent;
      }
      return { status: 'skipped', value: 'no', reason: 'not inside a git work tree' };
    }),
  );

  items.push(
    probe('vcs', () => {
      const res = detectVcsFamily({ repoRoot, ...(gitRun ? { gitRun } : {}) });
      if (res.ok)
        return {
          status: 'detected',
          value: `${res.vcs} (remote ${res.name})`,
          reason: `remote ${res.name} resolved via ${res.via}`,
        };
      if (res.reason === 'no-remotes') {
        return {
          status: 'skipped',
          value: 'none',
          reason: 'no git remote (local only, nothing to push)',
        };
      }
      return { status: 'unknown', value: null, reason: res.reason };
    }),
  );

  let pm = null;
  let pkg = { exists: false, scripts: {} };
  let pkgUnreadable = false;
  items.push(
    probe('packageManager', () => {
      try {
        pkg = readScripts(repoRoot);
      } catch (err) {
        pkgUnreadable = true;
        throw err;
      }
      if (!pkg.exists) return { status: 'skipped', value: null, reason: 'no package.json' };
      pm = detectPackageManager(repoRoot);
      if (!pm)
        return {
          status: 'skipped',
          value: null,
          reason: 'no lockfile and no packageManager field',
        };
      return { status: 'detected', value: pm, reason: 'from packageManager field or lockfile' };
    }),
  );

  for (const key of SCRIPT_KEYS) {
    items.push(
      probe(key, () => {
        if (pkgUnreadable) return { status: 'unknown', value: null, reason: 'package.json unreadable' };
        if (!pkg.exists) return { status: 'skipped', value: null, reason: 'no package.json' };
        if (!pm) return { status: 'skipped', value: null, reason: 'package manager unknown' };
        if (typeof pkg.scripts[key] !== 'string') {
          return { status: 'skipped', value: null, reason: `no "${key}" script in package.json` };
        }
        return {
          status: 'detected',
          value: defaultQualityGateCommands(pm)[key].command,
          reason: `"${key}" script present`,
        };
      }),
    );
  }

  const summary = { detected: 0, skipped: 0, unknown: 0 };
  for (const item of items) summary[item.status] += 1;
  return { repoRoot, items, summary };
}
