#!/usr/bin/env node
/**
 * Install Session Orchestrator through Codex's public plugin lifecycle.
 *
 * The marketplace reads the host-local packed copy (`npm pack` of this clone,
 * with runtime dependencies, under ~/.cache/session-orchestrator/plugin-package),
 * never the clone itself: a marketplace on the working checkout copied all of
 * it into the Codex plugin cache — 15742 files, `.env.local`, `.orchestrator/`
 * and `tests/` included (#1518, measured 2026-10-03).
 *
 * Exit codes:
 *   0 — installed, enabled, and verified
 *   1 — argument or user-correctable environment error
 *   2 — system, upstream command/JSON, or runtime postcondition failure
 */

import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { validateCodexPluginContract } from './lib/codex/plugin-contract.mjs';
import { resolveStageDir, stagePackage } from './lib/plugin-package-stage.mjs';

const __filename = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(__filename);
const SO_ROOT = path.dirname(SCRIPT_DIR);
const STAGE_DIR = resolveStageDir();

const MIN_CODEX_VERSION = [0, 144, 4];
const MARKETPLACE_NAME = 'kanevry';
const PLUGIN_NAME = 'session-orchestrator';
const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
const LEGACY_PLUGIN_IDS = [
  `${PLUGIN_NAME}@openai-curated`,
  `${PLUGIN_NAME}@local`,
];
const CODEX_COMMAND_TIMEOUT_MS = 30_000;
const ERROR_CATEGORIES = Object.freeze({
  USER: 'user',
  SYSTEM: 'system',
});

class InstallerError extends Error {
  constructor(message, category = ERROR_CATEGORIES.SYSTEM) {
    super(message);
    this.name = 'InstallerError';
    this.category = category;
  }
}

function parseArguments(argv) {
  let json = false;
  let help = false;
  let version = false;

  for (const argument of argv) {
    if (argument === '--json') json = true;
    else if (argument === '--help' || argument === '-h') help = true;
    else if (argument === '--version') version = true;
    else {
      throw new InstallerError(
        `Unknown argument '${argument}'. Run with --help for usage.`,
        ERROR_CATEGORIES.USER,
      );
    }
  }

  return { json, help, version };
}

function printHelp() {
  process.stdout.write(`Usage: node scripts/codex-install.mjs [options]

Install Session Orchestrator through the public Codex plugin lifecycle.

Options:
  --json     Print the verified final state as JSON
  --version  Print the package/plugin base version
  -h, --help Show this help

Examples:
  node scripts/codex-install.mjs
  node scripts/codex-install.mjs --json
  node scripts/codex-install.mjs --version
`);
}

function progress(jsonMode, message) {
  if (!jsonMode) process.stdout.write(`${message}\n`);
}

function formatCommand(args) {
  return ['codex', ...args].map((part) => (
    /\s/.test(part) ? JSON.stringify(part) : part
  )).join(' ');
}

function runCodex(args) {
  const command = formatCommand(args);
  const result = spawnSync('codex', args, {
    encoding: 'utf8',
    timeout: CODEX_COMMAND_TIMEOUT_MS,
    // 'codex plugin list --available --json' exceeds the 1 MiB default once a
    // few marketplaces are registered (measured 2026-09-22: 2.19 MB → ENOBUFS).
    maxBuffer: 64 * 1024 * 1024,
  });

  if (result.error) {
    throw new InstallerError(`Cannot run '${command}': ${result.error.message}`);
  }
  if (result.status !== 0) {
    const diagnostic = (result.stderr || result.stdout || '').trim() || 'no diagnostic output';
    throw new InstallerError(`Command failed with exit ${String(result.status)}: ${command}\n${diagnostic}`);
  }

  return result.stdout;
}

function runCodexJson(args, label) {
  const stdout = runCodex(args);
  try {
    const parsed = JSON.parse(stdout);
    if (!isRecord(parsed)) {
      throw new Error('top-level value must be an object');
    }
    return parsed;
  } catch (error) {
    throw new InstallerError(
      `${label} returned malformed JSON from '${formatCommand(args)}': ${error.message}`,
    );
  }
}

function parseCodexVersion(output) {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][^\s]+)?\b/);
  if (!match) {
    throw new InstallerError(`Cannot parse Codex version from: ${output.trim() || '<empty output>'}`);
  }
  return match.slice(1, 4).map(Number);
}

function compareVersions(left, right) {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta !== 0) return Math.sign(delta);
  }
  return 0;
}

function formatVersion(version) {
  return version.join('.');
}

function parseFeatures(output) {
  const features = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(.+?)\s+(true|false)\s*$/);
    if (!match) continue;
    features.set(match[1], { state: match[2].trim(), enabled: match[3] === 'true' });
  }
  return features;
}

function requireStableFeature(features, name) {
  const feature = features.get(name);
  if (feature?.state !== 'stable' || feature.enabled !== true) {
    const actual = feature ? `${feature.state} ${String(feature.enabled)}` : 'missing';
    throw new InstallerError(
      `Codex feature '${name}' must report 'stable true'; got '${actual}'. `
      + `Upgrade Codex and verify with 'codex features list'.`,
      ERROR_CATEGORIES.USER,
    );
  }
}

function readLocalJson(relativePath, label, root = SO_ROOT) {
  try {
    return JSON.parse(readFileSync(path.join(root, relativePath), 'utf8'));
  } catch (error) {
    throw new InstallerError(`Cannot read valid ${label}: ${error.message}`);
  }
}

function readBaseVersion(root = SO_ROOT) {
  const packageJson = readLocalJson('package.json', 'package.json', root);
  if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
    throw new InstallerError('package.json must contain a non-empty version string.');
  }
  return packageJson.version;
}

/** Validates the plugin Codex will actually install: the staged packed copy. */
function validateLocalContract(root) {
  const expectedBaseVersion = readBaseVersion(root);
  const manifest = readLocalJson(path.join('.codex-plugin', 'plugin.json'), 'Codex plugin manifest', root);
  const verdict = validateCodexPluginContract({
    pluginRoot: root,
    expectedBaseVersion,
  });

  if (!verdict.ok) {
    const details = verdict.errors
      .map((error) => `[${error.rule}] ${error.path}: ${error.message}`)
      .join('\n');
    throw new InstallerError(`Local Codex plugin contract failed:\n${details}`);
  }
  if (manifest.name !== PLUGIN_NAME || typeof manifest.version !== 'string') {
    throw new InstallerError('Codex plugin manifest must contain the expected name and version.');
  }

  return manifest.version;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) {
    throw new InstallerError(`${label} must be an array in Codex JSON output.`);
  }
  return value;
}

const realOrResolved = (p) => { try { return realpathSync(p); } catch { return path.resolve(p); } };

function sameLocalPath(left, right) {
  return typeof left === 'string' && realOrResolved(left) === realOrResolved(right);
}

function marketplaceSource(entry) {
  return { sourceType: entry.marketplaceSource?.sourceType, source: entry.marketplaceSource?.source ?? entry.root };
}

function assertMarketplaceCompatible(payload) {
  const marketplaces = requireArray(payload.marketplaces, 'marketplaces');
  // Any local marketplace on the working checkout copies all of it into the
  // plugin cache (#1518) — refuse, naming the one-time re-registration.
  const onCheckout = marketplaces.filter((entry) => {
    if (!isRecord(entry)) return false;
    const { sourceType, source } = marketplaceSource(entry);
    return sourceType === 'local' && sameLocalPath(source, SO_ROOT);
  });
  if (onCheckout.length > 0) {
    const removes = onCheckout.map((entry) => `codex plugin marketplace remove ${String(entry.name)}`).join(' && ');
    throw new InstallerError(
      `Marketplace ${onCheckout.map((entry) => `'${String(entry.name)}'`).join(', ')} reads this clone '${SO_ROOT}' — `
      + `the Codex plugin cache becomes a full copy incl. .env.local (#1518). Re-register once: `
      + `${removes} && node scripts/codex-install.mjs (it adds the packed copy at '${STAGE_DIR}').`,
      ERROR_CATEGORIES.USER,
    );
  }
  const matches = marketplaces.filter((entry) => isRecord(entry) && entry.name === MARKETPLACE_NAME);

  if (matches.length > 1) {
    throw new InstallerError(
      `Codex reports multiple '${MARKETPLACE_NAME}' marketplaces. `
      + `Inspect them with 'codex plugin marketplace list --json'; this installer will not remove any marketplace.`,
      ERROR_CATEGORIES.USER,
    );
  }
  if (matches.length === 0) return;

  const { sourceType, source } = marketplaceSource(matches[0]);
  if (sourceType !== 'local' || !sameLocalPath(source, STAGE_DIR)) {
    throw new InstallerError(
      `Marketplace '${MARKETPLACE_NAME}' already points to '${String(source)}' (${String(sourceType)}), `
      + `not '${STAGE_DIR}'. Resolve the conflict manually after reviewing `
      + `'codex plugin marketplace list --json'; this installer will not remove or replace it.`,
      ERROR_CATEGORIES.USER,
    );
  }
}

/**
 * Codex's personal marketplace (`~/.agents/plugins/marketplace.json`, paths
 * relative to the home dir) may list a plugin that resolves to this clone — on
 * the reference host `~/plugins/session-orchestrator` is a symlink to the main
 * checkout, and the resulting `session-orchestrator@local` cache held
 * `.env.local` (#1518). That catalog belongs to the operator, so this is a
 * read-only hint naming the cleanup, never a refusal or an edit.
 */
function printPersonalMarketplaceHint(json) {
  const home = os.homedir();
  const catalog = path.join(home, '.agents', 'plugins', 'marketplace.json');
  let plugins;
  try {
    plugins = JSON.parse(readFileSync(catalog, 'utf8')).plugins;
  } catch {
    return;
  }
  if (!Array.isArray(plugins)) return;
  const hits = plugins.filter((plugin) => (
    isRecord(plugin) && typeof plugin.source?.path === 'string'
    && sameLocalPath(path.resolve(home, plugin.source.path), SO_ROOT)
  ));
  for (const plugin of hits) {
    const linked = path.resolve(home, plugin.source.path);
    const message = `Hint: ${catalog} lists '${String(plugin.name)}' at '${linked}', which resolves to this clone — `
      + `its Codex cache copies the whole checkout incl. .env.local (#1518). Cleanup, once: `
      + `(1) let this installer finish (it removes ${PLUGIN_NAME}@local after a healthy install); `
      + `(2) remove that entry from ${catalog}; (3) delete the link '${linked}' if it is a symlink; `
      + `(4) after restarting Codex, delete the old cache folders under ~/.codex/plugins/cache/local/ `
      + `(${PLUGIN_NAME}/ and any plugin-install-*/ or plugin-backup-*/ holding ${PLUGIN_NAME}).`;
    if (json) process.stderr.write(`${message}\n`);
    else progress(json, message);
  }
}

function assertMarketplaceAddResult(payload) {
  if (payload.marketplaceName !== MARKETPLACE_NAME) {
    throw new InstallerError(
      `Marketplace add returned '${String(payload.marketplaceName)}', expected '${MARKETPLACE_NAME}'.`,
    );
  }
  if (!sameLocalPath(payload.installedRoot, STAGE_DIR)) {
    throw new InstallerError(
      `Marketplace add returned root '${String(payload.installedRoot)}', expected '${STAGE_DIR}'.`,
    );
  }
  if (typeof payload.alreadyAdded !== 'boolean') {
    throw new InstallerError("Marketplace add JSON is missing boolean field 'alreadyAdded'.");
  }
}

function assertPluginAddResult(payload, expectedVersion) {
  if (payload.pluginId !== PLUGIN_ID) {
    throw new InstallerError(`Plugin add returned '${String(payload.pluginId)}', expected '${PLUGIN_ID}'.`);
  }
  if (payload.version !== expectedVersion) {
    throw new InstallerError(
      `Plugin add returned version '${String(payload.version)}', expected '${expectedVersion}'.`,
    );
  }
}

function pluginEntries(payload) {
  const installed = requireArray(payload.installed, 'installed plugins');
  const available = requireArray(payload.available, 'available plugins');
  return { installed, available, all: [...installed, ...available] };
}

function assertTargetHealthy(payload, expectedVersion, phase) {
  const entries = pluginEntries(payload);
  const matches = entries.all.filter((entry) => isRecord(entry) && entry.pluginId === PLUGIN_ID);

  if (matches.length !== 1) {
    throw new InstallerError(
      `${phase}: expected exactly one '${PLUGIN_ID}' entry, found ${matches.length}.`,
    );
  }

  const target = matches[0];
  if (target.installed !== true || target.enabled !== true) {
    throw new InstallerError(
      `${phase}: '${PLUGIN_ID}' must be installed and enabled; got installed=${String(target.installed)}, `
      + `enabled=${String(target.enabled)}.`,
    );
  }
  if (target.version !== expectedVersion) {
    throw new InstallerError(
      `${phase}: '${PLUGIN_ID}' version '${String(target.version)}' does not match manifest `
      + `'${expectedVersion}'.`,
    );
  }

  return entries;
}

function installedLegacyPluginIds(entries) {
  return LEGACY_PLUGIN_IDS.filter((pluginId) => entries.installed.some((entry) => (
    isRecord(entry) && entry.pluginId === pluginId && entry.installed === true
  )));
}

function assertRemoveResult(payload, pluginId) {
  if (payload.pluginId !== pluginId) {
    throw new InstallerError(
      `Plugin remove returned '${String(payload.pluginId)}', expected '${pluginId}'.`,
    );
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function install({ json }) {
  progress(json, 'Session Orchestrator — Codex Setup');
  progress(json, '=================================');

  const version = parseCodexVersion(runCodex(['--version']));
  if (compareVersions(version, MIN_CODEX_VERSION) < 0) {
    throw new InstallerError(
      `Codex ${formatVersion(version)} is unsupported; install Codex ${formatVersion(MIN_CODEX_VERSION)} or newer.`,
      ERROR_CATEGORIES.USER,
    );
  }
  progress(json, `Codex: ${formatVersion(version)}`);

  const features = parseFeatures(runCodex(['features', 'list']));
  requireStableFeature(features, 'plugins');
  requireStableFeature(features, 'hooks');
  progress(json, 'Features: plugins stable true; hooks stable true');

  const marketplaceList = runCodexJson(
    ['plugin', 'marketplace', 'list', '--json'],
    'Marketplace list',
  );
  // Checked before staging: a refused install must not replace the stage dir.
  assertMarketplaceCompatible(marketplaceList);

  printPersonalMarketplaceHint(json);

  // The contract is checked on the new copy BEFORE it replaces the shared
  // stage: an invalid copy must never become what Claude Code or Codex reads.
  let expectedVersion;
  const staged = stagePackage({
    soRoot: SO_ROOT,
    stageDir: STAGE_DIR,
    installDeps: true,
    log: (line) => progress(json, `Package: ${line}`),
    validate: (dir) => {
      try {
        expectedVersion = validateLocalContract(dir);
        return { ok: true };
      } catch (error) {
        return { ok: false, detail: error.message };
      }
    },
  });
  if (!staged.ok) throw new InstallerError(`Cannot stage the packed copy: ${staged.detail}`);
  progress(json, `Local contract: valid (${expectedVersion})`);

  progress(json, `Marketplace: adding '${STAGE_DIR}'`);
  const marketplaceAdd = runCodexJson(
    ['plugin', 'marketplace', 'add', STAGE_DIR, '--json'],
    'Marketplace add',
  );
  assertMarketplaceAddResult(marketplaceAdd);
  progress(
    json,
    marketplaceAdd.alreadyAdded
      ? `Marketplace: '${MARKETPLACE_NAME}' already uses this source; refreshed`
      : `Marketplace: '${MARKETPLACE_NAME}' added`,
  );

  progress(json, `Plugin: adding '${PLUGIN_ID}'`);
  const pluginAdd = runCodexJson(
    ['plugin', 'add', PLUGIN_ID, '--json'],
    'Plugin add',
  );
  assertPluginAddResult(pluginAdd, expectedVersion);

  const firstPluginList = runCodexJson(
    ['plugin', 'list', '--available', '--json'],
    'Plugin list',
  );
  const firstEntries = assertTargetHealthy(firstPluginList, expectedVersion, 'Post-install check');
  progress(json, `Plugin: '${PLUGIN_ID}' is installed, enabled, and at ${expectedVersion}`);

  const removedLegacyPlugins = [];
  for (const legacyPluginId of installedLegacyPluginIds(firstEntries)) {
    const removeResult = runCodexJson(
      ['plugin', 'remove', legacyPluginId, '--json'],
      `Plugin remove (${legacyPluginId})`,
    );
    assertRemoveResult(removeResult, legacyPluginId);
    removedLegacyPlugins.push(legacyPluginId);
    progress(json, `Removed legacy plugin: ${legacyPluginId}`);
  }

  const finalPluginList = runCodexJson(
    ['plugin', 'list', '--available', '--json'],
    'Final plugin list',
  );
  const finalEntries = assertTargetHealthy(finalPluginList, expectedVersion, 'Final check');
  const remainingLegacyPlugins = installedLegacyPluginIds(finalEntries);
  if (remainingLegacyPlugins.length > 0) {
    throw new InstallerError(
      `Final check: legacy plugins remain installed: ${remainingLegacyPlugins.join(', ')}.`,
    );
  }

  const result = {
    ok: true,
    codexVersion: formatVersion(version),
    marketplace: MARKETPLACE_NAME,
    marketplaceSource: STAGE_DIR,
    marketplaceAlreadyAdded: marketplaceAdd.alreadyAdded,
    pluginId: PLUGIN_ID,
    pluginVersion: expectedVersion,
    installed: true,
    enabled: true,
    removedLegacyPlugins,
    nextSteps: [
      'Start a fresh Codex task or fully restart Codex so the plugin and hooks reload.',
      'In the fresh task, run /hooks and review the hook bundle before approving it.',
      'This installer does not write or bypass hook trust.',
    ],
  };

  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write('\nDone. The public Codex plugin state is healthy.\n\n');
    process.stdout.write('Next steps:\n');
    for (const [index, step] of result.nextSteps.entries()) {
      process.stdout.write(`  ${index + 1}. ${step}\n`);
    }
  }
}

try {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) printHelp();
  else if (options.version) process.stdout.write(`${readBaseVersion()}\n`);
  else install(options);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`ERROR: ${message}\n`);
  process.exitCode = error instanceof InstallerError && error.category === ERROR_CATEGORIES.USER
    ? 1
    : 2;
}
