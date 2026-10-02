#!/usr/bin/env node
/**
 * Bring every LOCAL install of Session Orchestrator to the newest version in
 * one command: this clone, the Claude Code plugin, and the Codex plugin.
 *
 * WHY THIS EXISTS: an update was three independent manual acts, and the
 * second one has a silent hole. Measured 2026-10-02 (5.3.0 → 5.4.0, Claude
 * Code 2.1.287): `claude plugin update` succeeded but left the cache WITHOUT
 * node_modules — `claude plugin list --json` carried
 * `noteDetails: [{type: "dependencies-refused"}]` because package.json sets
 * `overrides`. Hooks survive that (no static third-party imports), skill
 * scripts and the MCP server do not. This script reads that state back and
 * installs the runtime dependencies itself.
 *
 * Steps (each skipped when its harness is not installed on this host):
 *   1. repo    — `git fetch origin` + `git merge --ff-only origin/main`, then
 *                `npm ci` when HEAD moved or node_modules is missing.
 *   2. claude  — marketplace update + plugin update, then verify version and
 *                runtime dependencies in the reported installPath.
 *   3. codex   — only if the plugin is already installed in Codex: re-run
 *                scripts/codex-install.mjs (refreshes the installed bundle).
 *
 * Never deletes an old plugin cache directory: the running session still
 * loads it until the harness restarts.
 *
 * Exit codes: 0 all steps ok/skipped · 1 usage error · 2 a step failed.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/is-main-module.mjs';

const SO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PLUGIN_ID = 'session-orchestrator@kanevry';
const MARKETPLACE = 'kanevry';
const COMMAND_TIMEOUT_MS = 300_000;
// `codex plugin list --available --json` is 2.56 MB on a host with several
// marketplaces (measured 2026-10-02); the 1 MiB default fails with ENOBUFS.
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Pick the session-orchestrator entry from `claude plugin list --json`.
 * Accepts both the bare-array and the `{plugins: [...]}` shape.
 * @param {unknown} listJson
 * @returns {{version?: string, installPath?: string, enabled?: boolean, noteDetails?: Array<{type?: string}>} | null}
 */
export function findClaudeEntry(listJson) {
  const entries = Array.isArray(listJson) ? listJson : listJson?.plugins;
  if (!Array.isArray(entries)) return null;
  return entries.find((e) => e?.id === PLUGIN_ID && e?.scope === 'user')
    ?? entries.find((e) => e?.id === PLUGIN_ID)
    ?? null;
}

/**
 * Runtime dependencies of the package at `dir` that have no directory under
 * `dir/node_modules`. A presence check, not a version check: its job is to
 * catch the harness having skipped the install entirely.
 * @param {string} dir
 * @returns {string[]}
 */
export function missingRuntimeDeps(dir) {
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  return Object.keys(pkg.dependencies ?? {})
    .filter((name) => !existsSync(path.join(dir, 'node_modules', name)));
}

function parseArguments(argv) {
  const opts = { dryRun: false, json: false, skipPull: false, help: false };
  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--skip-pull') opts.skipPull = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw Object.assign(new Error(`Unknown argument '${arg}'. Run with --help.`), { usage: true });
  }
  return opts;
}

const HELP = `Usage: node scripts/self-update.mjs [--dry-run] [--skip-pull] [--json]

Update this clone, the Claude Code plugin and (if installed) the Codex plugin
to the newest Session Orchestrator, and verify each one afterwards.

  --dry-run    Print what would run; change nothing
  --skip-pull  Leave the clone as it is (e.g. right after a release)
  --json       Print the per-step result as JSON
`;

function makeRunner({ dryRun, json }) {
  const log = (line) => { if (!json) process.stdout.write(`${line}\n`); };
  /** Run a command; read-only queries also run under --dry-run. */
  function run(cmd, args, { cwd = SO_ROOT, mutates = true } = {}) {
    const shown = `${cmd} ${args.join(' ')}`;
    if (dryRun && mutates) {
      log(`  [dry-run] ${shown}${cwd === SO_ROOT ? '' : `   (in ${cwd})`}`);
      return { ok: true, stdout: '' };
    }
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    if (r.error) return { ok: false, detail: `${shown}: ${r.error.message}` };
    if (r.status !== 0) {
      return { ok: false, detail: `${shown} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-400)}` };
    }
    return { ok: true, stdout: r.stdout };
  }
  return { run, log };
}

function onPath(bin) {
  return spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
}

function repoVersion() {
  return JSON.parse(readFileSync(path.join(SO_ROOT, 'package.json'), 'utf8')).version;
}

function updateRepo({ run, log }, opts) {
  if (opts.skipPull) return { step: 'repo', status: 'skipped', detail: '--skip-pull' };
  const before = run('git', ['rev-parse', 'HEAD'], { mutates: false });
  if (!before.ok) return { step: 'repo', status: 'failed', detail: before.detail };
  const branch = run('git', ['branch', '--show-current'], { mutates: false }).stdout?.trim();
  if (branch !== 'main') {
    return { step: 'repo', status: 'failed', detail: `clone is on '${branch}', not main — switch or use --skip-pull` };
  }
  log('repo: fetching origin and fast-forwarding main');
  for (const [cmd, args] of [['git', ['fetch', 'origin']], ['git', ['merge', '--ff-only', 'origin/main']]]) {
    const r = run(cmd, args);
    if (!r.ok) return { step: 'repo', status: 'failed', detail: r.detail };
  }
  const after = run('git', ['rev-parse', 'HEAD'], { mutates: false });
  const moved = before.stdout !== after.stdout;
  if (moved || !existsSync(path.join(SO_ROOT, 'node_modules'))) {
    const r = run('npm', ['ci']);
    if (!r.ok) return { step: 'repo', status: 'failed', detail: r.detail };
  }
  return { step: 'repo', status: 'ok', detail: `${repoVersion()}${moved ? ' (updated)' : ' (already current)'}` };
}

function updateClaude({ run, log }, opts) {
  if (!onPath('claude')) return { step: 'claude', status: 'skipped', detail: 'claude not on PATH' };
  log('claude: refreshing marketplace and plugin');
  for (const args of [['plugin', 'marketplace', 'update', MARKETPLACE], ['plugin', 'update', PLUGIN_ID]]) {
    const r = run('claude', args);
    if (!r.ok) return { step: 'claude', status: 'failed', detail: r.detail };
  }
  const list = run('claude', ['plugin', 'list', '--json'], { mutates: false });
  if (!list.ok) return { step: 'claude', status: 'failed', detail: list.detail };
  let entry;
  try { entry = findClaudeEntry(JSON.parse(list.stdout)); } catch (e) {
    return { step: 'claude', status: 'failed', detail: `plugin list --json unparseable: ${e.message}` };
  }
  if (!entry) return { step: 'claude', status: 'skipped', detail: `${PLUGIN_ID} not installed` };
  if (!entry.installPath || !existsSync(entry.installPath)) {
    return { step: 'claude', status: 'failed', detail: `installPath missing: ${entry.installPath}` };
  }
  const missing = missingRuntimeDeps(entry.installPath);
  if (missing.length > 0) {
    const refused = (entry.noteDetails ?? []).some((n) => n?.type === 'dependencies-refused');
    log(`claude: ${missing.length} runtime deps missing${refused ? ' (harness refused the install)' : ''} — installing`);
    const r = run('npm', ['ci', '--omit=dev'], { cwd: entry.installPath });
    if (!r.ok) return { step: 'claude', status: 'failed', detail: r.detail };
    const still = opts.dryRun ? [] : missingRuntimeDeps(entry.installPath);
    if (still.length > 0) return { step: 'claude', status: 'failed', detail: `still missing after npm ci: ${still.join(', ')}` };
  }
  const want = repoVersion();
  // The marketplace tracks GitHub main, so it can trail this clone until the
  // release is pushed — report it, do not fail on it.
  const lag = entry.version !== want ? `; clone is ${want} — marketplace not yet at it` : '';
  return {
    step: 'claude',
    status: 'ok',
    detail: `${entry.version}${missing.length ? `, installed ${missing.length} missing deps` : ''}${lag}`,
  };
}

function updateCodex({ run, log }, opts) {
  if (!onPath('codex')) return { step: 'codex', status: 'skipped', detail: 'codex not on PATH' };
  const list = run('codex', ['plugin', 'list'], { mutates: false });
  if (!list.ok) return { step: 'codex', status: 'failed', detail: list.detail };
  if (!new RegExp(`^${PLUGIN_ID}\\s+installed`, 'm').test(list.stdout)) {
    return { step: 'codex', status: 'skipped', detail: 'plugin not installed in Codex (install: node scripts/codex-install.mjs)' };
  }
  log('codex: re-running codex-install');
  const r = run(process.execPath, [path.join(SO_ROOT, 'scripts', 'codex-install.mjs'), '--json']);
  if (!r.ok) return { step: 'codex', status: 'failed', detail: r.detail };
  if (opts.dryRun) return { step: 'codex', status: 'ok', detail: 'dry-run' };
  try {
    return { step: 'codex', status: 'ok', detail: JSON.parse(r.stdout).pluginVersion };
  } catch {
    return { step: 'codex', status: 'ok', detail: 'installed (version not reported)' };
  }
}

function main(opts) {
  const io = makeRunner(opts);
  const results = [];
  // Order matters: the Codex installer installs FROM this clone, so the clone
  // must be current first. A failed repo step stops the chain for that reason.
  results.push(updateRepo(io, opts));
  if (results[0].status !== 'failed') {
    results.push(updateClaude(io, opts));
    results.push(updateCodex(io, opts));
  }
  const ok = results.every((r) => r.status !== 'failed');
  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ ok, dryRun: opts.dryRun, results }, null, 2)}\n`);
  } else {
    io.log('');
    for (const r of results) io.log(`  ${r.status.padEnd(7)} ${r.step.padEnd(7)} ${r.detail}`);
    io.log(ok
      ? '\nRestart Claude Code / Codex to load the new version. Old cache folders stay until then — delete them only after the restart.'
      : '\nA step failed (a failed repo step skips the plugin steps). Fix it and re-run — every step is idempotent.');
  }
  return ok ? 0 : 2;
}

if (isMainModule(import.meta.url)) {
  try {
    const opts = parseArguments(process.argv.slice(2));
    if (opts.help) process.stdout.write(HELP);
    else process.exitCode = main(opts);
  } catch (error) {
    process.stderr.write(`ERROR: ${error.message}\n`);
    process.exitCode = error.usage ? 1 : 2;
  }
}
