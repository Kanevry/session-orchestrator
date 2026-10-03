/**
 * plugin-package-stage.mjs — the host-local packed copy of this package that
 * every harness marketplace reads instead of the working checkout.
 *
 * WHY: a marketplace registered on the clone copies ALL of it into the
 * harness's plugin cache. Measured 2026-10-03: Claude Code cached 7557 files
 * instead of 1164, `.env.local` (NPM_TOKEN) and `.orchestrator/` included
 * (#1515); the Codex cache on the same host held 15742 files, `.env.local`,
 * `.orchestrator/` and `tests/` included (#1518). `npm pack` carries only the
 * package.json `files` allowlist, so the staged copy cannot leak the rest.
 *
 * Shared by scripts/self-update.mjs (Claude Code) and scripts/codex-install.mjs
 * (Codex): one stage dir, one staging routine.
 */

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const COMMAND_TIMEOUT_MS = 300_000;
const WORK_PREFIX = '.stage-';
// A work dir older than this is the leftover of a killed run (the finally never
// ran). Ceiling: a concurrent stage that itself runs longer than 60 min would be
// swept mid-run — npm ci is the slow step at ~minutes; revisit if that changes.
const STALE_WORK_MS = 60 * 60 * 1000;

/**
 * Remove `.stage-*` work dirs in `parent` older than STALE_WORK_MS. Only real
 * directories carrying this helper's exact prefix; a symlink is never followed
 * or removed. Best effort: a sweep failure never blocks staging.
 * @param {string} parent
 * @param {number} [now]
 */
export function sweepStaleWorkDirs(parent, now = Date.now()) {
  let entries;
  try { entries = readdirSync(parent, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (!entry.name.startsWith(WORK_PREFIX) || !entry.isDirectory()) continue;
    const dir = path.join(parent, entry.name);
    try {
      const st = lstatSync(dir);
      if (st.isDirectory() && !st.isSymbolicLink() && now - st.mtimeMs > STALE_WORK_MS) {
        rmSync(dir, { recursive: true, force: true });
      }
    } catch { /* best effort */ }
  }
}

/**
 * `<XDG_CACHE_HOME or ~/.cache>/session-orchestrator/plugin-package`. The XDG
 * spec says a relative XDG_CACHE_HOME is invalid and must be ignored.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {string}
 */
export function resolveStageDir(env = process.env, home = os.homedir()) {
  const xdg = (env.XDG_CACHE_HOME || '').trim();
  return path.join(path.isAbsolute(xdg) ? xdg : path.join(home, '.cache'), 'session-orchestrator', 'plugin-package');
}

/**
 * Tarball filename from `npm pack --json`. npm <= 11 emits `[ { filename } ]`,
 * npm >= 12.0.2 `{ "<name>": { filename } }` (same split pack-policy-floor.test
 * documents for `files`).
 * @param {unknown} packJson
 * @returns {string | null}
 */
export function packedFilename(packJson) {
  const entry = Array.isArray(packJson) ? packJson[0] : Object.values(packJson ?? {})[0];
  return typeof entry?.filename === 'string' && entry.filename !== '' ? entry.filename : null;
}

/**
 * Minimal command runner with the shape stagePackage expects.
 * @returns {{ok: true, stdout: string} | {ok: false, detail: string}}
 */
export function spawnRun(cmd, args, { cwd, env } = {}) {
  const shown = `${cmd} ${args.join(' ')}`;
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { ok: false, detail: `${shown}: ${r.error.message}` };
  if (r.status !== 0) {
    return { ok: false, detail: `${shown} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-400)}` };
  }
  return { ok: true, stdout: r.stdout };
}

/**
 * Replace `stageDir` with the extracted `npm pack` of `soRoot`. The work dir
 * sits beside `stageDir` so every rename stays on one filesystem, and it is
 * removed on every path out — the previous stage is only swapped out once the
 * new one is complete and valid, and is put back if the swap itself fails.
 *
 * @param {{soRoot: string, stageDir: string, run?: Function, log?: (line: string) => void,
 *   dryRun?: boolean, installDeps?: boolean,
 *   validate?: (dir: string) => ({ok: true} | {ok: false, detail: string})}} options
 *   `installDeps` runs `npm ci --omit=dev --ignore-scripts` in the new copy
 *   before the swap, for a harness that copies the marketplace as-is (Codex).
 *   `validate` vets the new copy before the swap; a failure keeps the old stage.
 * @returns {{ok: true} | {ok: false, detail: string}}
 */
export function stagePackage({
  soRoot, stageDir, run = spawnRun, log = () => {}, dryRun = false, installDeps = false, validate,
}) {
  log(`packing ${soRoot} into ${stageDir} (package files only)`);
  if (dryRun) {
    run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', '<work>']);
    run('tar', ['-xzf', '<work>/<tarball>', '-C', '<work>']);
    if (installDeps) run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: '<work>/package' });
    return { ok: true };
  }
  let work;
  try {
    mkdirSync(path.dirname(stageDir), { recursive: true });
    sweepStaleWorkDirs(path.dirname(stageDir));
    work = mkdtempSync(path.join(path.dirname(stageDir), WORK_PREFIX));
    // An inherited silent loglevel suppresses the JSON parsed below.
    const env = { ...process.env };
    delete env.npm_config_loglevel;
    delete env.NPM_CONFIG_LOGLEVEL;
    // --ignore-scripts explicitly: never rely on the clone's .npmrc for prepack.
    const pack = run('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', work], { cwd: soRoot, env });
    if (!pack.ok) return { ok: false, detail: pack.detail };
    let filename;
    try { filename = packedFilename(JSON.parse(pack.stdout)); } catch { filename = null; }
    if (!filename) return { ok: false, detail: 'npm pack --json reported no tarball filename' };
    const untar = run('tar', ['-xzf', path.join(work, filename), '-C', work]);
    if (!untar.ok) return { ok: false, detail: untar.detail };
    const pkg = path.join(work, 'package');
    // npm never packs package-lock.json, and every dependency install of the
    // plugin copy runs `npm ci`, which refuses to run without one.
    copyFileSync(path.join(soRoot, 'package-lock.json'), path.join(pkg, 'package-lock.json'));
    if (installDeps) {
      // The packed copy carries no .npmrc, so the repo's ignore-scripts=true
      // (SEC-020) has to travel as a flag.
      const ci = run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: pkg, env });
      if (!ci.ok) return { ok: false, detail: ci.detail };
    }
    if (validate) {
      const verdict = validate(pkg);
      if (!verdict.ok) return { ok: false, detail: verdict.detail };
    }
    const previous = path.join(work, 'previous');
    const hadPrevious = existsSync(stageDir);
    if (hadPrevious) renameSync(stageDir, previous);
    try {
      renameSync(pkg, stageDir);
    } catch (error) {
      // Put the old stage back before the finally deletes the work dir with it.
      // If even that fails, keep the work dir: it is the only copy left.
      if (hadPrevious) {
        try {
          renameSync(previous, stageDir);
        } catch (restoreError) {
          work = undefined;
          throw new Error(`${error.message}; restoring the previous stage failed (${restoreError.message}) — it is kept at ${previous}`, { cause: restoreError });
        }
      }
      throw error;
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, detail: `staging ${stageDir}: ${error.message}` };
  } finally {
    if (work) rmSync(work, { recursive: true, force: true });
  }
}
