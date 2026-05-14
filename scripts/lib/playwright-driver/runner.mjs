#!/usr/bin/env node
/**
 * playwright-driver/runner.mjs — Phase 2 entry-point for the /test command.
 *
 * Spawns `npx playwright test` in the target repo directory, pipes output to
 * ${RUN_DIR}/console.log, and exits with a deterministic exit code per the
 * Composability Contract in skills/playwright-driver/SKILL.md.
 *
 * Exit codes:
 *   0 — all tests passed
 *   1 — at least one test failed (Playwright exit 1)
 *   2 — framework error, timeout, spawn failure, or invalid profile
 *
 * CLI args (all also accepted via env vars as fallback):
 *   --run-dir <path>   absolute path to artifact dir  (env: RUN_DIR)
 *   --profile <name>   profile name, e.g. "web-gate"  (env: PROFILE)
 *   --target <path>    absolute path to target repo    (env: TARGET)
 *   --dry-run          print resolved command, skip subprocess, exit 0
 *
 * DI seams for testability (all optional, accepted via opts object):
 *   opts.spawn   — override node:child_process spawn
 *   opts.fs      — override node:fs (sync subset: mkdirSync, createWriteStream, readFileSync, existsSync, writeFileSync)
 *
 * Issue: #385 — web-gate end-to-end proof against aiat-pmo-module
 */

import { spawn as realSpawn } from 'node:child_process';
import realFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { getProfile, loadProfiles, validateProfile } from '../test-runner/profile-registry.mjs';

// ---------------------------------------------------------------------------
// Path resolution helper
// ---------------------------------------------------------------------------

/**
 * Expand a leading `~` to $HOME; absolute paths pass through verbatim;
 * relative paths are resolved against process.cwd().
 * @param {string} p
 * @returns {string}
 */
function resolvePath(p) {
  if (!p) return process.cwd();
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(1));
  }
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

// ---------------------------------------------------------------------------
// axe-core presence check
// ---------------------------------------------------------------------------

/**
 * Check whether @axe-core/playwright is listed in the target's package.json.
 * Returns true if present (or if package.json cannot be read — fail-open).
 * @param {string} targetPath
 * @param {{ readFileSync: Function, existsSync: Function }} fsImpl
 * @returns {{ present: boolean, skipped: boolean }}
 */
function checkAxeCore(targetPath, fsImpl) {
  const pkgPath = path.join(targetPath, 'package.json');
  if (!fsImpl.existsSync(pkgPath)) {
    return { present: false, skipped: true };
  }
  let pkg;
  try {
    pkg = JSON.parse(fsImpl.readFileSync(pkgPath, 'utf8'));
  } catch {
    return { present: false, skipped: true };
  }
  const deps = pkg.dependencies ?? {};
  const devDeps = pkg.devDependencies ?? {};
  const present = '@axe-core/playwright' in deps || '@axe-core/playwright' in devDeps;
  return { present, skipped: false };
}

// ---------------------------------------------------------------------------
// Main run() function
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {Function} [opts.spawn]
 * @param {object}   [opts.fs]
 * @returns {Promise<void>}
 */
export default async function run(opts = {}) {
  const spawnFn = opts.spawn ?? realSpawn;
  const fsImpl = opts.fs ?? realFs;

  // -------------------------------------------------------------------------
  // Parse CLI args + env fallbacks
  // -------------------------------------------------------------------------

  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'run-dir': { type: 'string' },
      'profile': { type: 'string' },
      'target': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: false,
  });

  const runDir = resolvePath(values['run-dir'] ?? process.env.RUN_DIR ?? '');
  const profileName = values['profile'] ?? process.env.PROFILE ?? '';
  const targetRaw = values['target'] ?? process.env.TARGET ?? '';
  const dryRun = values['dry-run'] ?? false;

  if (!runDir) {
    console.error('runner: --run-dir (or env RUN_DIR) is required');
    process.exit(2);
  }

  // SEC-PD-MED-2: reject runDir values that would break the --reporter "html:...,json:..." comma+colon split
  if (/[,:]/.test(runDir)) {
    console.error('runner: --run-dir must not contain commas or colons');
    process.exit(2);
  }

  if (!profileName) {
    console.error('runner: --profile (or env PROFILE) is required');
    process.exit(2);
  }

  // -------------------------------------------------------------------------
  // Load + validate profile
  // -------------------------------------------------------------------------

  const loadResult = await loadProfiles();
  if (!loadResult.ok) {
    console.error(`runner: failed to load profiles — ${loadResult.error.message}`);
    process.exit(2);
  }

  const getResult = getProfile(loadResult.profiles, profileName);
  if (!getResult.ok) {
    console.error(`runner: ${getResult.error.message}`);
    process.exit(2);
  }

  const validateResult = validateProfile(getResult.profile);
  if (!validateResult.ok) {
    console.error(`runner: profile '${profileName}' is invalid — ${validateResult.error.message}`);
    process.exit(2);
  }

  const profile = validateResult.value;

  // -------------------------------------------------------------------------
  // Resolve target path
  // -------------------------------------------------------------------------

  const targetPath = resolvePath(targetRaw || profile.target || process.cwd());

  // -------------------------------------------------------------------------
  // axe-core presence check
  // -------------------------------------------------------------------------

  const axe = checkAxeCore(targetPath, fsImpl);
  if (!axe.present && !axe.skipped) {
    console.log('axe-violations: skipped — @axe-core/playwright not installed in target');
  }

  // -------------------------------------------------------------------------
  // Build Playwright args
  // -------------------------------------------------------------------------

  const playwrightArgs = [
    'playwright',
    'test',
    '--output', path.join(runDir, 'test-results'),
    '--reporter', `html:${path.join(runDir, 'report')},json:${path.join(runDir, 'results.json')}`,
    '--trace', 'on',
  ];

  if (profile.mode === 'headed') {
    playwrightArgs.push('--headed');
  }

  if (dryRun) {
    console.log('runner: dry-run mode — resolved command:');
    console.log(`  npx ${playwrightArgs.join(' ')}`);
    console.log(`  cwd: ${targetPath}`);
    process.exit(0);
  }

  // -------------------------------------------------------------------------
  // Create artifact directories
  // -------------------------------------------------------------------------

  fsImpl.mkdirSync(path.join(runDir, 'test-results'), { recursive: true });

  // -------------------------------------------------------------------------
  // Spawn Playwright
  // -------------------------------------------------------------------------

  const controller = new AbortController();
  const timeoutHandle = setTimeout(
    () => controller.abort(),
    profile.timeout_ms,
  );

  const logStream = fsImpl.createWriteStream(path.join(runDir, 'console.log'), { flags: 'a' });

  const proc = spawnFn('npx', playwrightArgs, {
    cwd: targetPath,
    signal: controller.signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  proc.stdout.pipe(logStream, { end: false });
  proc.stderr.pipe(logStream, { end: false });

  // -------------------------------------------------------------------------
  // Exit-code resolution
  // -------------------------------------------------------------------------

  /**
   * @param {number} mapped
   */
  function finish(mapped) {
    clearTimeout(timeoutHandle);
    logStream.end(() => {
      fsImpl.writeFileSync(path.join(runDir, 'exit_code'), String(mapped));
      process.exit(mapped);
    });
  }

  proc.on('error', (err) => {
    console.error(`runner: spawn error — ${err.message}`);
    finish(2);
  });

  proc.on('close', (code, signal) => {
    if (signal === 'SIGTERM' || code === null) {
      finish(2);
    } else if (code === 0) {
      finish(0);
    } else if (code === 1) {
      finish(1);
    } else {
      finish(2);
    }
  });
}

// ---------------------------------------------------------------------------
// CLI entry-point
// ---------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((err) => {
    console.error(`runner: unhandled error — ${err.message}`);
    process.exit(2);
  });
}
