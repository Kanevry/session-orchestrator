#!/usr/bin/env node
/**
 * runtime-readiness.mjs — #1848
 *
 * Checks (and with `--repair` fixes) whether a Session Orchestrator install
 * can actually load its runtime dependencies.
 *
 * Why: the Codex marketplace short form installs the plugin into
 * `~/.codex/plugins/cache/<marketplace>/<name>/<version>` without
 * `node_modules`. Codex reports it installed and enabled, yet 0 of 11 runtime
 * dependencies resolve — imports fail with ERR_MODULE_NOT_FOUND and
 * `loadOwnerConfig()` silently falls back to defaults
 * (`reason: 'yaml-parser-missing'`). Every plugin update creates a new cache
 * directory, so the gap recurs. `scripts/self-update.mjs` only helps from a
 * git clone, which short-form users do not have.
 *
 * Checks, in order:
 *  1. presence of every `dependencies` entry (`checkRuntimeDeps`, lib);
 *  2. import probes in ONE fresh child Node process (a failed ESM import is
 *     cached in-process, so this process could never see a repair take
 *     effect) — two dependency-heavy modules plus `loadOwnerConfig()`, of
 *     which ONLY `source` and `reason` leave the child (owner.yaml is private).
 *
 * Every process start goes through `spawnNativeSync` (never
 * `node:child_process` directly). Nothing is installed without `--repair`.
 *
 * @module scripts/runtime-readiness
 */

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import { spawnNativeSync } from './lib/native-command.mjs';
import {
  ReadinessError,
  checkRuntimeDeps,
  formatRepairCommand,
  ownPluginRoot,
  repairCommand,
} from './lib/runtime-readiness.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const PLUGIN_NAME = 'session-orchestrator';
const MAX_BUFFER = 64 * 1024 * 1024; // `codex plugin list --json` measured 2.56 MB
const LIST_TIMEOUT_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const REPAIR_TIMEOUT_MS = 10 * 60_000;
const RECHECK_TIMEOUT_MS = 120_000;

/** Modules whose import proves the heavy runtime deps load (relative to root). */
export const PROBE_MODULES = [
  'scripts/lib/persona-panel/catalog-loader.mjs',
  'scripts/lib/learnings/evidence-candidates.mjs',
];

const OWNER_YAML_MODULE = 'scripts/lib/owner-yaml.mjs';

/** Exit 1: the target cannot be resolved or the arguments are wrong. */
export class TargetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TargetError';
  }
}

/** Exit 2: a process the check depends on could not run. */
class SystemError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SystemError';
  }
}

const HELP = `Usage: node scripts/runtime-readiness.mjs [--root <dir> | --codex | --claude] [--repair] [--json]

Check whether a Session Orchestrator install can load its runtime dependencies
(#1848). Codex marketplace installs ship without node_modules; every plugin
update creates a new cache directory, so the check has to be repeated.

Target (pick one; default: the install this script belongs to):
  --root <dir>  Check the plugin install at <dir> (must contain package.json)
  --codex       Check the install Codex uses (codex plugin list --json)
  --claude      Check the install Claude Code uses (claude plugin list --json)

Options:
  --repair      When not ready, install the runtime deps in the target
                (npm ci|install --omit=dev --ignore-scripts), then re-check
                in a fresh process. Without it nothing is installed.
  --json        Print one JSON object on stdout
  -h, --help    Show this help

Exit codes:
  0  ready
  3  not ready (missing deps, failing import, or owner.yaml parser missing);
     missing deps are a filesystem measurement, so this holds even when the
     import probe could not run, and --repair then still installs them
  1  usage or target error (unknown flag, no install found, no package.json)
  2  system error (a required process could not be started or answered
     garbage, and nothing was measured — e.g. the import probe crashed while
     every dependency is present; --repair does not run npm then)

Examples:
  node scripts/runtime-readiness.mjs --codex
  node scripts/runtime-readiness.mjs --codex --repair
  node scripts/runtime-readiness.mjs --root ~/.codex/plugins/cache/<m>/session-orchestrator/<v> --json
`;

/**
 * Pick the Claude Code install path of session-orchestrator from
 * `claude plugin list --json` (bare array or `{plugins: [...]}`; entry shape
 * measured with Claude Code 2.1.312, 2026-10-28: `{ id, version, scope,
 * enabled, installPath, ... }`). Only ENABLED entries count — a disabled user
 * install must not be checked or repaired in place of the one Claude loads.
 * Pure: does not touch the disk.
 * @param {unknown} listJson parsed CLI output
 * @returns {string} the install path
 * @throws {TargetError} zero enabled entries, or several with different paths
 */
export function claudeInstallRoot(listJson) {
  const entries = Array.isArray(listJson) ? listJson : listJson?.plugins;
  const enabled = (Array.isArray(entries) ? entries : []).filter((e) => typeof e?.id === 'string'
    && e.id.startsWith(`${PLUGIN_NAME}@`) && e.enabled !== false && typeof e.installPath === 'string');
  if (enabled.length === 0) {
    throw new TargetError(`${PLUGIN_NAME} is not installed and enabled in Claude Code (claude plugin list --json).`);
  }
  const paths = [...new Set(enabled.map((e) => e.installPath))];
  if (paths.length > 1) {
    const ids = enabled.map((e) => `${e.id} (${e.scope ?? '?'})`).join(', ');
    throw new TargetError(`${PLUGIN_NAME} is enabled in Claude Code more than once (${ids}); pass --root <dir> to pick one.`);
  }
  return paths[0];
}

/**
 * Pick the Codex install root of session-orchestrator from
 * `codex plugin list --json` (shape measured with codex-cli 0.160.1,
 * 2026-10-28: `{ installed: [{ name, marketplaceName, version, installed,
 * enabled, ... }], available: [...] }`). Pure: does not touch the disk.
 * @param {unknown} listJson parsed CLI output
 * @param {string} codexHome `$CODEX_HOME` or `~/.codex`
 * @returns {{ root: string, pluginId: string|null }}
 * @throws {TargetError} zero or more than one installed+enabled entry
 */
export function codexInstallRoot(listJson, codexHome) {
  const installed = Array.isArray(listJson?.installed) ? listJson.installed : [];
  const matches = installed.filter((e) => e?.name === PLUGIN_NAME && e.installed === true && e.enabled === true);
  if (matches.length === 0) {
    throw new TargetError(`${PLUGIN_NAME} is not installed/enabled in Codex (codex plugin list --json).`);
  }
  if (matches.length > 1) {
    const ids = matches.map((e) => e.pluginId ?? `${e.name}@${e.marketplaceName}`).join(', ');
    throw new TargetError(`${PLUGIN_NAME} is enabled in Codex more than once (${ids}); pass --root <dir> to pick one.`);
  }
  const [entry] = matches;
  if (typeof entry.marketplaceName !== 'string' || typeof entry.version !== 'string') {
    throw new TargetError(`Codex entry for ${PLUGIN_NAME} lacks marketplaceName/version; pass --root <dir>.`);
  }
  // Both values become path segments of a directory whose code the import
  // probe runs and where --repair runs npm: one plain segment each, and the
  // result must stay inside the cache (a `..` would redirect both).
  const segment = (v) => v !== '' && v !== '.' && v !== '..' && !/[/\\\0]/.test(v);
  if (!segment(entry.marketplaceName) || !segment(entry.version)) {
    throw new TargetError(`Codex entry for ${PLUGIN_NAME} has an unusable marketplaceName/version; pass --root <dir>.`);
  }
  const cache = path.join(codexHome, 'plugins', 'cache');
  const root = path.join(cache, entry.marketplaceName, entry.name, entry.version);
  if (path.relative(cache, root).startsWith('..')) {
    throw new TargetError(`Codex cache path for ${PLUGIN_NAME} leaves ${cache}; pass --root <dir>.`);
  }
  return {
    root,
    pluginId: typeof entry.pluginId === 'string' ? entry.pluginId : null,
  };
}

/**
 * Run a read-only listing command and parse its JSON stdout.
 * @param {string} cmd
 * @param {string[]} args
 * @param {typeof spawnNativeSync} spawn
 * @returns {unknown}
 */
function listJson(cmd, args, spawn) {
  const shown = `${cmd} ${args.join(' ')}`;
  const r = spawn(cmd, args, { encoding: 'utf8', timeout: LIST_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
  if (r.error) throw new SystemError(`${shown}: ${r.error.message}`);
  if (r.status !== 0) {
    throw new SystemError(`${shown} exited ${r.status}: ${(r.stderr || '').trim().slice(-400)}`);
  }
  try {
    return JSON.parse(r.stdout);
  } catch {
    throw new SystemError(`${shown} did not print JSON`);
  }
}

/**
 * Resolve the install root to check from the parsed flags.
 * @param {{ root?: string, codex?: boolean, claude?: boolean }} values
 * @param {{ spawn?: typeof spawnNativeSync, env?: NodeJS.ProcessEnv }} [deps]
 * @returns {string}
 */
export function resolveTarget(values, { spawn = spawnNativeSync, env = process.env } = {}) {
  const chosen = [values.root !== undefined, values.codex, values.claude].filter(Boolean).length;
  if (chosen > 1) throw new TargetError('--root, --codex and --claude are mutually exclusive.');

  let root;
  if (values.root !== undefined) {
    root = path.resolve(values.root);
  } else if (values.codex) {
    const codexHome = (env.CODEX_HOME || '').trim() || path.join(os.homedir(), '.codex');
    root = codexInstallRoot(listJson('codex', ['plugin', 'list', '--json'], spawn), codexHome).root;
    if (!existsSync(root)) throw new TargetError(`Codex install directory does not exist: ${root}`);
  } else if (values.claude) {
    root = claudeInstallRoot(listJson('claude', ['plugin', 'list', '--json'], spawn));
  } else {
    root = ownPluginRoot();
  }
  if (!existsSync(path.join(root, 'package.json'))) {
    throw new TargetError(`No package.json in ${root}; not a plugin install.`);
  }
  return root;
}

// Runs in the child: argv[1] is the root. Prints ONE JSON line. Projects only
// `source`/`reason` of the owner config — never a value, path or name.
const PROBE_CODE = `
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[1];
const modules = ${JSON.stringify(PROBE_MODULES)};
const imports = [];
for (const module of modules) {
  const file = path.join(root, module);
  if (!existsSync(file)) { imports.push({ module, ok: null, code: 'absent' }); continue; }
  try { await import(pathToFileURL(file).href); imports.push({ module, ok: true, code: null }); }
  catch (e) { imports.push({ module, ok: false, code: typeof e?.code === 'string' ? e.code : null }); }
}
let ownerConfig = { source: null, reason: 'absent' };
const ownerFile = path.join(root, ${JSON.stringify(OWNER_YAML_MODULE)});
if (existsSync(ownerFile)) {
  try {
    const { loadOwnerConfig } = await import(pathToFileURL(ownerFile).href);
    const r = loadOwnerConfig();
    ownerConfig = {
      source: typeof r?.source === 'string' ? r.source : null,
      reason: typeof r?.reason === 'string' ? r.reason : null,
    };
  } catch { ownerConfig = { source: null, reason: 'import-failed' }; }
}
process.stdout.write(JSON.stringify({ imports, ownerConfig }) + '\\n', () => process.exit(0));
`;

/**
 * Import probes in one fresh child process with `cwd: root`.
 * @param {string} root
 * @param {{ spawn?: typeof spawnNativeSync }} [deps]
 * @returns {{ imports: Array<{ module: string, ok: boolean|null, code: string|null }>, ownerConfig: { source: string|null, reason: string|null } }}
 */
export function runImportProbes(root, { spawn = spawnNativeSync } = {}) {
  const failed = () => ({
    imports: PROBE_MODULES.map((module) => ({ module, ok: false, code: 'probe-failed' })),
    ownerConfig: { source: null, reason: 'probe-failed' },
  });
  const r = spawn(process.execPath, ['--input-type=module', '-e', PROBE_CODE, root], {
    cwd: root, encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
  });
  if (r.error || r.status !== 0) return failed();
  // A probed module may print on import; the probe's line is the last one.
  const last = String(r.stdout ?? '').trim().split('\n').pop();
  try {
    const parsed = JSON.parse(last);
    if (!Array.isArray(parsed?.imports) || !parsed.ownerConfig) return failed();
    return {
      imports: parsed.imports,
      ownerConfig: { source: parsed.ownerConfig.source ?? null, reason: parsed.ownerConfig.reason ?? null },
    };
  } catch {
    return failed();
  }
}

/** Owner-config reasons that mean the install cannot do its job. */
const OWNER_NOT_READY = new Set(['yaml-parser-missing', 'import-failed', 'probe-failed']);

/**
 * Full readiness report for one install (the locked `--json` contract).
 * @param {string} root
 * @param {{ spawn?: typeof spawnNativeSync }} [deps]
 */
export function buildReport(root, deps = {}) {
  const { version, declared, missing } = checkRuntimeDeps(root);
  const { imports, ownerConfig } = runImportProbes(root, deps);
  const ready = missing.length === 0
    && imports.every((i) => i.ok !== false)
    && !OWNER_NOT_READY.has(ownerConfig.reason);
  return { ready, root, version, declared, missing, imports, ownerConfig, repair: repairCommand(root) };
}

/**
 * Run the repair for a not-ready report and re-check in a FRESH process
 * (this one has the failed imports cached). npm's output goes to stderr so
 * stdout stays one JSON object.
 * @param {ReturnType<typeof buildReport>} before
 * @param {{ spawn?: typeof spawnNativeSync }} [deps]
 * @returns {ReturnType<typeof buildReport> & { repaired: { argv: string[], rc: number|null, before: { missing: string[], ready: boolean } } }}
 * @throws {SystemError} npm could not be started, or the re-check gave no report
 */
export function repairAndRecheck(before, { spawn = spawnNativeSync } = {}) {
  const { cwd, argv } = before.repair;
  const [cmd, ...args] = argv;
  const r = spawn(cmd, args, { cwd, stdio: ['ignore', 2, 2], timeout: REPAIR_TIMEOUT_MS });
  if (r.error) throw new SystemError(`${argv.join(' ')}: ${r.error.message}`);

  const check = spawn(process.execPath, [SCRIPT_PATH, '--root', before.root, '--json'], {
    encoding: 'utf8', timeout: RECHECK_TIMEOUT_MS, maxBuffer: MAX_BUFFER,
  });
  let after;
  try {
    after = JSON.parse(check.stdout);
  } catch {
    throw new SystemError(`re-check after repair printed no report (exit ${check.status})`);
  }
  return { ...after, repaired: { argv, rc: r.status ?? null, before: { missing: before.missing, ready: before.ready } } };
}

/**
 * Human-readable rendering of a report.
 * @param {ReturnType<typeof buildReport> & { repaired?: object }} report
 * @param {{ repairRequested?: boolean }} [opts]
 * @returns {string}
 */
export function formatHuman(report, { repairRequested = false } = {}) {
  const lines = [`root: ${report.root}`, `version: ${report.version ?? 'unknown'}`];
  const resolvable = report.declared.length - report.missing.length;
  lines.push(`dependencies: ${resolvable}/${report.declared.length} resolvable`
    + (report.missing.length ? ` (missing: ${report.missing.join(', ')})` : ''));
  for (const i of report.imports) {
    const state = i.ok === true ? 'ok' : i.ok === null ? 'skipped' : 'FAILED';
    lines.push(`import ${i.module}: ${state}${i.code ? ` (${i.code})` : ''}`);
  }
  lines.push(`owner config: source=${report.ownerConfig.source ?? 'none'}`
    + (report.ownerConfig.reason ? ` reason=${report.ownerConfig.reason}` : ''));
  if (report.repaired) {
    lines.push(`repair: ran ${report.repaired.argv.join(' ')} (exit ${report.repaired.rc}); `
      + `before: ${report.repaired.before.missing.length} missing`);
  }
  lines.push(`status: ${report.ready ? 'READY' : 'NOT READY'}`);
  if (!report.ready) {
    lines.push(`repair: ${formatRepairCommand(report.repair)}`);
    if (!report.repaired) lines.push('  (--repair runs it; repeat after every plugin update)');
  } else if (repairRequested && !report.repaired) {
    lines.push('repair: nothing to do');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * CLI entry point.
 * @param {string[]} argv
 * @param {{ spawn?: typeof spawnNativeSync, env?: NodeJS.ProcessEnv,
 *   stdout?: { write(s: string): unknown }, stderr?: { write(s: string): unknown } }} [deps]
 * @returns {number} exit code
 */
export function main(argv, { spawn = spawnNativeSync, env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        codex: { type: 'boolean', default: false },
        claude: { type: 'boolean', default: false },
        repair: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    stderr.write(`runtime-readiness: ${e.message}\nRun with --help.\n`);
    return 1;
  }
  if (values.help) {
    stdout.write(HELP);
    return 0;
  }
  try {
    const root = resolveTarget(values, { spawn, env });
    let report = buildReport(root, { spawn });
    // A probe child that crashed, timed out or printed garbage measured
    // nothing: with every dependency present that is a system error (exit 2),
    // not "not ready", and no reason to run npm.
    const unmeasured = (r) => r.ownerConfig.reason === 'probe-failed' && r.missing.length === 0;
    if (values.repair && !report.ready && !unmeasured(report)) report = repairAndRecheck(report, { spawn });
    stdout.write(values.json ? `${JSON.stringify(report)}\n` : formatHuman(report, { repairRequested: values.repair }));
    if (report.ready) return 0;
    return unmeasured(report) ? 2 : 3;
  } catch (e) {
    stderr.write(`runtime-readiness: ${e.message}\n`);
    if (e instanceof TargetError || e instanceof ReadinessError) return 1;
    return 2;
  }
}

if (isMainModule(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
