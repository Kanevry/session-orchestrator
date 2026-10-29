/**
 * runtime-readiness.mjs — #1848
 *
 * Does the plugin install this code runs from actually have its runtime
 * dependencies?
 *
 * ## Why this exists
 *
 * The Codex marketplace short form (`codex plugin marketplace add …` +
 * `codex plugin add session-orchestrator@<marketplace>`) copies the plugin into
 * `~/.codex/plugins/cache/<marketplace>/<name>/<version>` WITHOUT
 * `node_modules`. Codex reports the plugin installed and enabled, the
 * dependency-free MCP server works, and yet every script importing a runtime
 * dependency fails (`ERR_MODULE_NOT_FOUND 'js-yaml'`, `'zod'`) or — worse —
 * degrades silently (`loadOwnerConfig()` → `reason: 'yaml-parser-missing'`).
 * Each plugin update creates a NEW cache directory, so a manual repair does
 * not survive the next update. This module makes the gap visible.
 *
 * ## Constraints (load-bearing)
 *
 *  - ZERO third-party imports, only `node:*` (plus `./sh-quote.mjs`, which has
 *    no imports): it must load inside exactly the cache that has no
 *    `node_modules`. A test walks the whole import closure.
 *  - NO process spawning: the SessionStart probe runner imports it, and a
 *    session-start probe that spawns runs in every on-session-start hook test.
 *    The import probes and the repair live in `scripts/runtime-readiness.mjs`.
 *  - `checkRuntimeReadinessBanner()` never throws (Phase 4 banner contract,
 *    see `scripts/lib/owner-config-banner.mjs`).
 *
 * Presence check, not a version check — like `missingRuntimeDeps()` in
 * `scripts/self-update.mjs`, but with Node's ancestor walk-up, because a
 * clone inside a workspace can resolve its deps from a parent `node_modules`.
 *
 * @module scripts/lib/runtime-readiness
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { shellQuote } from './sh-quote.mjs';

/** How many missing names the one-line banner spells out before "…". */
const BANNER_NAME_LIMIT = 4;

/** Typed failure of `checkRuntimeDeps()`; `code` is machine-readable. */
export class ReadinessError extends Error {
  /**
   * @param {'package-json-unreadable'|'package-json-invalid'} code
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'ReadinessError';
    this.code = code;
  }
}

/**
 * Absolute root of the plugin install this module belongs to.
 * @returns {string}
 */
export function ownPluginRoot() {
  return path.resolve(import.meta.dirname, '..', '..');
}

/**
 * Whether bare specifier `name` resolves from `root`: Node looks in
 * `<dir>/node_modules/<name>` for `dir` = root and every ancestor. Scoped
 * names (`@babel/parser`) are a nested path, which `path.join` handles.
 * @param {string} root
 * @param {string} name
 * @returns {boolean}
 */
function depInstalled(root, name) {
  let dir = path.resolve(root);
  for (;;) {
    if (existsSync(path.join(dir, 'node_modules', name, 'package.json'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/**
 * Declared runtime dependencies of the package at `root` and which of them
 * do not resolve.
 * @param {string} root plugin root (contains package.json)
 * @returns {{ root: string, version: string|null, declared: string[], missing: string[] }}
 * @throws {ReadinessError} package.json unreadable or not a JSON object
 */
export function checkRuntimeDeps(root) {
  const abs = path.resolve(root);
  const file = path.join(abs, 'package.json');
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new ReadinessError('package-json-unreadable', `cannot read ${file}: ${cause?.code ?? cause?.message}`, { cause });
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (cause) {
    throw new ReadinessError('package-json-invalid', `${file} is not valid JSON`, { cause });
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    throw new ReadinessError('package-json-invalid', `${file} is not a JSON object`);
  }
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const declared = Object.keys(deps);
  return {
    root: abs,
    version: typeof pkg.version === 'string' ? pkg.version : null,
    declared,
    missing: declared.filter((name) => !depInstalled(abs, name)),
  };
}

/**
 * The command that installs the runtime dependencies in `root`. `npm ci`
 * needs a lockfile (the npm-registry package ships none → `npm install`).
 * `--ignore-scripts` is mandatory (SEC-020): no lifecycle script runs.
 * `--omit=dev` only for a plugin install: in a git checkout (`.git` dir or
 * worktree file) `npm ci --omit=dev` would wipe vitest and eslint, so a
 * checkout gets the full install.
 * @param {string} root
 * @returns {{ cwd: string, argv: string[] }}
 */
export function repairCommand(root) {
  const cwd = path.resolve(root);
  const locked = existsSync(path.join(cwd, 'package-lock.json')) || existsSync(path.join(cwd, 'npm-shrinkwrap.json'));
  const checkout = existsSync(path.join(cwd, '.git'));
  return { cwd, argv: ['npm', locked ? 'ci' : 'install', ...(checkout ? [] : ['--omit=dev']), '--ignore-scripts'] };
}

/**
 * One copy-pasteable POSIX shell line for a `repairCommand()` result. The
 * path is single-quoted (`shellQuote`), because the banner shows this line to
 * a model as the thing to run: a `$(…)` in a path must stay literal.
 * @param {{ cwd: string, argv: string[] }} cmd
 * @returns {string}
 */
export function formatRepairCommand(cmd) {
  return `cd ${shellQuote(cmd.cwd)} && ${cmd.argv.join(' ')}`;
}

/**
 * Session-start banner probe: warn when runtime dependencies of the plugin
 * install are missing. Never throws. An unreadable package.json is a warning
 * with `degraded: true`, never null: null means "every dependency resolves",
 * and a check that could not run is not the same as a clean one.
 * @param {{ root?: string }} [opts] `root` defaults to `ownPluginRoot()`
 * @returns {null | { severity: 'warn', message: string, missing: string[], root: string, degraded?: true }}
 */
export function checkRuntimeReadinessBanner({ root = ownPluginRoot() } = {}) {
  try {
    const deps = checkRuntimeDeps(root);
    if (deps.missing.length === 0) return null;
    const names = deps.missing.slice(0, BANNER_NAME_LIMIT).join(', ')
      + (deps.missing.length > BANNER_NAME_LIMIT ? ', …' : '');
    const message = `⚠ runtime-readiness: ${deps.missing.length} of ${deps.declared.length} runtime dependencies `
      + `missing in ${deps.root} (${names}) — skills and scripts importing them fail. `
      + `Repair: ${formatRepairCommand(repairCommand(deps.root))} `
      + '(repeat after every plugin update: each version gets a new cache dir).';
    return { severity: 'warn', message, missing: deps.missing, root: deps.root };
  } catch (err) {
    const code = err instanceof ReadinessError ? err.code : 'unexpected';
    return {
      severity: 'warn',
      degraded: true,
      message: `⚠ runtime-readiness: could not read ${root}/package.json (${code}) — runtime dependencies `
        + 'not checked, which is not the same as installed.',
      missing: [],
      root,
    };
  }
}
