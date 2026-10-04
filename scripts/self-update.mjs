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
 *   2. claude  — `npm pack` this clone and extract it into STAGE_DIR, then
 *                marketplace update + plugin update, then verify version and
 *                runtime dependencies in the reported installPath. The
 *                marketplace must read STAGE_DIR, not this clone: a directory
 *                marketplace on the working checkout copied ALL of it into the
 *                plugin cache — 7557 files instead of 1164, `.env.local`
 *                (NPM_TOKEN) and `.orchestrator/` included (#1515, measured
 *                2026-10-03). The step refuses, naming the remove + add
 *                commands, while ANY directory marketplace reads this clone;
 *                GitHub/npm sources update as before, with a one-line hint.
 *   3. codex   — only if the plugin is already installed in Codex: re-run
 *                scripts/codex-install.mjs, which installs from the same
 *                packed STAGE_DIR (#1518), never from this clone.
 *
 * Never deletes an old plugin cache directory: the running session still
 * loads it until the harness restarts.
 *
 * Exit codes: 0 all steps ok/skipped · 1 usage error · 2 a step failed.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandOnPath, spawnNativeSync } from './lib/native-command.mjs';
import { fileURLToPath } from 'node:url';

import { isMainModule } from './lib/is-main-module.mjs';
import { resolveStageDir, stagePackage } from './lib/plugin-package-stage.mjs';

const SO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Codex install id; the Claude id is read from the installed entry, because
// the marketplace name is whatever the host registered (`kanevry` per
// .claude-plugin/marketplace.json, `session-orchestrator` on older hosts).
const PLUGIN_ID = 'session-orchestrator@kanevry';
const PLUGIN_NAME = 'session-orchestrator';
const COMMAND_TIMEOUT_MS = 300_000;
// `codex plugin list --available --json` is 2.56 MB on a host with several
// marketplaces (measured 2026-10-02); the 1 MiB default fails with ENOBUFS.
const MAX_BUFFER = 64 * 1024 * 1024;
/** Host-local copy of the packed package; the marketplace reads this, never the clone. */
const STAGE_DIR = resolveStageDir();

/**
 * Claude Code config dir: CLAUDE_CONFIG_DIR when absolute, else ~/.claude. A
 * relative value is ignored like a relative XDG_CACHE_HOME — resolved against
 * whatever cwd this script runs in, it would point the marketplace guard at a
 * file that does not exist and let the update run unguarded (#1519).
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @returns {{dir: string, ignored: string | null}}
 */
export function resolveClaudeConfigDir(env = process.env, home = os.homedir()) {
  const raw = (env.CLAUDE_CONFIG_DIR || '').trim();
  if (path.isAbsolute(raw)) return { dir: raw, ignored: null };
  return { dir: path.join(home, '.claude'), ignored: raw || null };
}

const CLAUDE_CONFIG = resolveClaudeConfigDir();
const KNOWN_MARKETPLACES = path.join(CLAUDE_CONFIG.dir, 'plugins', 'known_marketplaces.json');

const realOrResolved = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

/**
 * Registered Claude Code marketplaces from `known_marketplaces.json`, read
 * defensively: a missing or unparseable file yields `null`, never a throw.
 * @param {string} file
 * @returns {Array<{name: string, source: string | undefined, path: string | undefined}> | null}
 */
export function readKnownMarketplaces(file) {
  let raw;
  try { raw = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  return Object.entries(raw).map(([name, v]) => ({
    name,
    source: typeof v?.source?.source === 'string' ? v.source.source : undefined,
    path: typeof v?.source?.path === 'string' ? v.source.path : undefined,
  }));
}

/**
 * Names of the `directory` marketplaces that read `dir` (realpath-compared) —
 * whatever they are called.
 * @param {ReturnType<typeof readKnownMarketplaces>} known
 * @param {string} dir
 * @returns {string[]}
 */
export function directoryMarketplacesOn(known, dir) {
  const target = realOrResolved(dir);
  return (known ?? [])
    .filter((m) => m.source === 'directory' && m.path && realOrResolved(m.path) === target)
    .map((m) => m.name);
}

/**
 * Pick the session-orchestrator entry from `claude plugin list --json`.
 * Accepts both the bare-array and the `{plugins: [...]}` shape.
 * @param {unknown} listJson
 * @returns {{version?: string, installPath?: string, enabled?: boolean, noteDetails?: Array<{type?: string}>} | null}
 */
export function findClaudeEntry(listJson) {
  const entries = Array.isArray(listJson) ? listJson : listJson?.plugins;
  if (!Array.isArray(entries)) return null;
  const ours = (e) => typeof e?.id === 'string' && e.id.startsWith(`${PLUGIN_NAME}@`);
  return entries.find((e) => ours(e) && e?.scope === 'user')
    ?? entries.find(ours)
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

export function makeRunner({ dryRun, json }) {
  const log = (line) => { if (!json) process.stdout.write(`${line}\n`); };
  /** Run a command; read-only queries also run under --dry-run. */
  function run(cmd, args, { cwd = SO_ROOT, mutates = true, env } = {}) {
    const shown = `${cmd} ${args.join(' ')}`;
    if (dryRun && mutates) {
      log(`  [dry-run] ${shown}${cwd === SO_ROOT ? '' : `   (in ${cwd})`}`);
      return { ok: true, stdout: '' };
    }
    const r = spawnNativeSync(cmd, args, { cwd, env, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
    if (r.error) return { ok: false, detail: `${shown}: ${r.error.message}` };
    if (r.status !== 0) {
      return { ok: false, detail: `${shown} exited ${r.status}: ${(r.stderr || r.stdout || '').trim().slice(-400)}` };
    }
    return { ok: true, stdout: r.stdout };
  }
  return { run, log };
}

function repoVersion(root = SO_ROOT) {
  return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
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

/** Marketplace name the packed copy registers under (its own marketplace.json). */
function packedMarketplaceName(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8')).name || 'kanevry';
  } catch {
    return 'kanevry';
  }
}

/**
 * The Claude Code step. `ctx` exists for tests (tmp config dir, tmp clone,
 * no PATH lookup); production passes nothing.
 */
export function updateClaude({ run, log }, opts, ctx = {}) {
  const {
    soRoot = SO_ROOT,
    stageDir = STAGE_DIR,
    knownMarketplacesFile = KNOWN_MARKETPLACES,
    ignoredConfigDir = CLAUDE_CONFIG.ignored,
    hasClaude = () => commandOnPath('claude'),
  } = ctx;
  const fail = (detail) => ({ step: 'claude', status: 'failed', detail });
  if (!hasClaude()) return { step: 'claude', status: 'skipped', detail: 'claude not on PATH' };
  if (ignoredConfigDir) {
    log(`claude: ignoring relative CLAUDE_CONFIG_DIR '${ignoredConfigDir}' — reading ${knownMarketplacesFile}`);
  }
  const stage = () => stagePackage({
    soRoot, stageDir, run, log: (line) => log(`claude: ${line}`), dryRun: opts.dryRun,
  });

  const parseEntry = (r) => {
    if (!r.ok) return { error: r.detail };
    try { return { entry: findClaudeEntry(JSON.parse(r.stdout)) }; } catch (e) {
      return { error: `plugin list --json unparseable: ${e.message}` };
    }
  };
  // Installed-check first: with nothing installed there is nothing to guard,
  // and the refusal below would replace the host's stage dir for no install (#1519).
  const before = parseEntry(run('claude', ['plugin', 'list', '--json'], { mutates: false }));
  if (before.error) return fail(before.error);
  if (!before.entry) return { step: 'claude', status: 'skipped', detail: `${PLUGIN_NAME} not installed` };

  const known = readKnownMarketplaces(knownMarketplacesFile);
  const leaking = directoryMarketplacesOn(known, soRoot);
  if (leaking.length > 0) {
    // Stage first so the `add` target named below exists.
    const staged = stage();
    const packedName = packedMarketplaceName(soRoot);
    // A marketplace already holding the packed copy's name (e.g. a GitHub
    // `kanevry`) would make `marketplace add <stage>` fail on the taken name.
    const sameName = known?.find((m) => m.name === packedName);
    const nameTaken = sameName && !leaking.includes(packedName)
      && !(sameName.source === 'directory' && sameName.path && realOrResolved(sameName.path) === realOrResolved(stageDir));
    const removes = [...leaking, ...(nameTaken ? [packedName] : [])]
      .map((n) => `claude plugin marketplace remove ${n}`).join(' && ');
    return fail(
      `directory marketplace ${leaking.map((n) => `'${n}'`).join(', ')} reads this clone — the plugin cache `
      + `becomes a full copy incl. .env.local (#1515). Re-register once: ${removes} && `
      + `claude plugin marketplace add ${stageDir} && claude plugin install ${PLUGIN_NAME}@${packedName}`
      + (staged.ok ? '' : ` (staging failed: ${staged.detail})`),
    );
  }

  const pluginId = before.entry.id;
  const marketplace = pluginId.slice(pluginId.indexOf('@') + 1);
  const reg = known?.find((m) => m.name === marketplace);
  const fromStage = reg?.source === 'directory' && !!reg.path && realOrResolved(reg.path) === realOrResolved(stageDir);

  if (fromStage) {
    const staged = stage();
    if (!staged.ok) return fail(staged.detail);
  } else {
    log(known
      ? `claude: marketplace '${marketplace}' reads ${reg?.path ?? reg?.source ?? 'an unknown source'}; to install this clone instead, register the packed copy at ${stageDir}`
      : `claude: ${knownMarketplacesFile} unreadable — cannot check the marketplace source; the packed-copy path is ${stageDir}`);
  }

  log(`claude: refreshing marketplace '${marketplace}' and plugin ${pluginId}`);
  for (const args of [['plugin', 'marketplace', 'update', marketplace], ['plugin', 'update', pluginId]]) {
    const r = run('claude', args);
    if (!r.ok) return fail(r.detail);
  }
  const after = parseEntry(run('claude', ['plugin', 'list', '--json'], { mutates: false }));
  if (after.error) return fail(after.error);
  const entry = after.entry;
  if (!entry) return fail(`${pluginId} disappeared from plugin list after the update`);
  if (!entry.installPath || !existsSync(entry.installPath)) return fail(`installPath missing: ${entry.installPath}`);
  const missing = missingRuntimeDeps(entry.installPath);
  if (missing.length > 0) {
    const refused = (entry.noteDetails ?? []).some((n) => n?.type === 'dependencies-refused');
    log(`claude: ${missing.length} runtime deps missing${refused ? ' (harness refused the install)' : ''} — installing`);
    // The packed copy carries no .npmrc, so the repo's ignore-scripts=true
    // (SEC-020) has to travel as a flag.
    const r = run('npm', ['ci', '--omit=dev', '--ignore-scripts'], { cwd: entry.installPath });
    if (!r.ok) return fail(r.detail);
    const still = opts.dryRun ? [] : missingRuntimeDeps(entry.installPath);
    if (still.length > 0) return fail(`still missing after npm ci: ${still.join(', ')}`);
  }
  const want = repoVersion(soRoot);
  if (entry.version !== want && fromStage && !opts.dryRun) {
    // The source IS this clone's packed copy, so a different version means
    // the update did not take effect — not that a remote is behind.
    return fail(`update did not take effect: installed ${entry.version}, packed ${want}`);
  }
  const lag = entry.version !== want && !fromStage
    ? `; clone is ${want} — marketplace '${marketplace}' source is not at it yet` : '';
  return {
    step: 'claude',
    status: 'ok',
    detail: `${entry.version}${missing.length ? `, installed ${missing.length} missing deps` : ''}${lag}`,
  };
}

function updateCodex({ run, log }, opts) {
  if (!commandOnPath('codex')) return { step: 'codex', status: 'skipped', detail: 'codex not on PATH' };
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
