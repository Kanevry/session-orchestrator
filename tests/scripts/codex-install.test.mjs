import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installScriptCli } from '../_helpers/executable-fixture.mjs';

const REPO_ROOT = join(fileURLToPath(new URL('../../', import.meta.url)), '.');
const SCRIPT = join(REPO_ROOT, 'scripts', 'codex-install.mjs');
const PACKAGE = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, '.codex-plugin', 'plugin.json'), 'utf8'),
);
const FIRST_BUNDLE_SNAPSHOT = {
  revision: 'fake-bundle-r1',
  files: { 'skills/session/SKILL.md': 'revision-one' },
};
const SECOND_BUNDLE_SNAPSHOT = {
  revision: 'fake-bundle-r2',
  files: { 'skills/session/SKILL.md': 'revision-two' },
};
const PLUGIN_ID = 'session-orchestrator@kanevry';
const LEGACY_OPENAI = 'session-orchestrator@openai-curated';
const LEGACY_LOCAL = 'session-orchestrator@local';
const UNKNOWN_PLUGIN = 'unrelated-plugin@team-catalog';
// Per-test stage dir (<tmp XDG_CACHE_HOME>/session-orchestrator/plugin-package),
// set in beforeEach: the installer must hand Codex this path, never the clone.
let STAGE = '';

function commandKey(args) {
  return JSON.stringify(args);
}

function jsonResponse(stdout, options = {}) {
  return {
    status: options.status ?? 0,
    stdout,
    stderr: options.stderr ?? '',
    delayMs: options.delayMs,
    installedBundleSnapshot: options.installedBundleSnapshot,
  };
}

function targetEntry(overrides = {}) {
  return {
    pluginId: PLUGIN_ID,
    name: 'session-orchestrator',
    marketplaceName: 'kanevry',
    version: MANIFEST.version,
    installed: true,
    enabled: true,
    ...overrides,
  };
}

function pluginList({ installed = [targetEntry()], available = [] } = {}) {
  return { installed, available };
}

function makeScenario(options = {}) {
  const marketplaceAdd = {
    marketplaceName: 'kanevry',
    installedRoot: STAGE,
    alreadyAdded: options.alreadyAdded ?? false,
  };
  const pluginAdd = {
    pluginId: PLUGIN_ID,
    name: 'session-orchestrator',
    marketplaceName: 'kanevry',
    version: MANIFEST.version,
    installedPath: '/fake/codex/plugins/session-orchestrator',
  };
  const bundleSnapshots = options.bundleSnapshots ?? [
    FIRST_BUNDLE_SNAPSHOT,
    SECOND_BUNDLE_SNAPSHOT,
  ];

  return {
    responses: {
      [commandKey(['--version'])]: [jsonResponse(options.version ?? 'codex-cli 0.144.4\n')],
      [commandKey(['features', 'list'])]: [jsonResponse(
        options.features ?? 'plugins stable true\nhooks stable true\n',
      )],
      [commandKey(['plugin', 'marketplace', 'list', '--json'])]: [
        jsonResponse(options.marketplaceList ?? { marketplaces: [] }),
      ],
      [commandKey(['plugin', 'marketplace', 'add', STAGE, '--json'])]: [
        jsonResponse(options.marketplaceAdd ?? marketplaceAdd),
      ],
      [commandKey(['plugin', 'add', PLUGIN_ID, '--json'])]: bundleSnapshots.map((snapshot) => (
        jsonResponse(options.pluginAdd ?? pluginAdd, { installedBundleSnapshot: snapshot })
      )),
      [commandKey(['plugin', 'list', '--available', '--json'])]: (
        options.pluginLists ?? [pluginList(), pluginList()]
      ).map((payload) => jsonResponse(payload)),
      [commandKey(['plugin', 'remove', LEGACY_OPENAI, '--json'])]: [
        jsonResponse({ pluginId: LEGACY_OPENAI }),
      ],
      [commandKey(['plugin', 'remove', LEGACY_LOCAL, '--json'])]: [
        jsonResponse({ pluginId: LEGACY_LOCAL }),
      ],
    },
  };
}

// The fake `codex` runs through the committed launcher (installScriptCli): its
// first call is `codex --version`, and a freshly written executable per test
// would pay macOS's first-launch check (#1497).
function installFakeCodex(binDir) {
  installScriptCli(binDir, 'codex', `import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const key = JSON.stringify(argv);
const scenario = JSON.parse(readFileSync(process.env.FAKE_CODEX_SCENARIO, 'utf8'));
const state = existsSync(process.env.FAKE_CODEX_STATE)
  ? JSON.parse(readFileSync(process.env.FAKE_CODEX_STATE, 'utf8'))
  : { counts: {}, installedBundle: null, bundleHistory: [] };
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify(argv) + '\\n');
const responses = scenario.responses[key];
if (!Array.isArray(responses) || responses.length === 0) {
  process.stderr.write('Unexpected fake codex argv: ' + key + '\\n');
  process.exit(97);
}
const count = state.counts[key] ?? 0;
state.counts[key] = count + 1;
const response = responses[Math.min(count, responses.length - 1)];
if (response.delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, response.delayMs);
}
if (response.installedBundleSnapshot !== undefined) {
  state.installedBundle = response.installedBundleSnapshot;
  state.bundleHistory ??= [];
  state.bundleHistory.push(response.installedBundleSnapshot);
}
writeFileSync(process.env.FAKE_CODEX_STATE, JSON.stringify(state));
if (response.stdout !== undefined) {
  process.stdout.write(
    typeof response.stdout === 'string'
      ? response.stdout
      : JSON.stringify(response.stdout) + '\\n'
  );
}
if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.status ?? 0);
`);
}

// A fake `npm`: real `npm pack` of this repo takes ~13 s (measured 2026-10-03),
// once per test is too slow. `pack` tars the subset the Codex contract reads
// into a `package/` tarball like npm does; `ci` leaves a node_modules marker.
// Every call is logged, so a test can assert staging did or did not run.
const FAKE_PACKED = ['.codex-plugin', '.claude-plugin', 'hooks', 'assets', '.mcp.json', 'package.json'];
function installFakeNpm(binDir) {
  installScriptCli(binDir, 'npm', `import { appendFileSync, cpSync, mkdirSync, mkdtempSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + '\\n');
if (process.env.FAKE_NPM_FAIL === argv[0]) { process.stderr.write('simulated npm failure\\n'); process.exit(3); }
if (argv[0] === 'pack') {
  const dest = argv[argv.indexOf('--pack-destination') + 1];
  const src = mkdtempSync(join(process.env.FAKE_NPM_TMP, 'pack-'));
  for (const entry of ${JSON.stringify(FAKE_PACKED)}) {
    if (entry === process.env.FAKE_NPM_OMIT) continue;
    cpSync(join(process.cwd(), entry), join(src, 'package', entry), { recursive: true });
  }
  const tar = spawnSync('tar', ['-czf', join(dest, 'fake-1.0.0.tgz'), '-C', src, 'package']);
  if (tar.status !== 0) process.exit(4);
  process.stdout.write(JSON.stringify([{ filename: 'fake-1.0.0.tgz' }]));
} else if (argv[0] === 'ci') {
  mkdirSync(join(process.cwd(), 'node_modules', '.fake-ci'), { recursive: true });
}
`);
}

describe('scripts/codex-install.mjs', () => {
  let tempRoot;
  let fakeBin;
  let scenarioPath;
  let statePath;
  let logPath;
  let homePath;
  let codexHomePath;
  let npmLogPath;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'codex-install-test-'));
    fakeBin = join(tempRoot, 'bin');
    scenarioPath = join(tempRoot, 'scenario.json');
    statePath = join(tempRoot, 'state.json');
    logPath = join(tempRoot, 'argv.jsonl');
    homePath = join(tempRoot, 'home');
    codexHomePath = join(tempRoot, 'codex-home');
    npmLogPath = join(tempRoot, 'npm.jsonl');
    STAGE = join(tempRoot, 'xdg', 'session-orchestrator', 'plugin-package');
    mkdirSync(join(tempRoot, 'npm-tmp'), { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    mkdirSync(homePath, { recursive: true });
    mkdirSync(codexHomePath, { recursive: true });
    installFakeCodex(fakeBin);
    installFakeNpm(fakeBin);
  });

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true });
  });

  function runInstaller({
    scenario = makeScenario(),
    args = [],
    pathValue = `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
    timeout = 30_000,
    extraEnv = {},
  } = {}) {
    writeFileSync(scenarioPath, JSON.stringify(scenario), 'utf8');
    return spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: pathValue,
        HOME: homePath,
        CODEX_HOME: codexHomePath,
        FAKE_CODEX_SCENARIO: scenarioPath,
        FAKE_CODEX_STATE: statePath,
        FAKE_CODEX_LOG: logPath,
        XDG_CACHE_HOME: join(tempRoot, 'xdg'),
        FAKE_NPM_LOG: npmLogPath,
        FAKE_NPM_TMP: join(tempRoot, 'npm-tmp'),
        ...extraEnv,
      },
      encoding: 'utf8',
      timeout,
    });
  }

  function readState() {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  }

  function readNpmCalls() {
    if (!existsSync(npmLogPath)) return [];
    return readFileSync(npmLogPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  }

  function readCalls() {
    return readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  it('uses the exact public lifecycle ordering and prints operator next steps', () => {
    const result = runInstaller();

    expect(result.status).toBe(0);
    expect(readCalls()).toEqual([
      ['--version'],
      ['features', 'list'],
      ['plugin', 'marketplace', 'list', '--json'],
      ['plugin', 'marketplace', 'add', STAGE, '--json'],
      ['plugin', 'add', PLUGIN_ID, '--json'],
      ['plugin', 'list', '--available', '--json'],
      ['plugin', 'list', '--available', '--json'],
    ]);
    expect(result.stdout).toContain('Local contract: valid');
    expect(result.stdout).toContain('Start a fresh Codex task or fully restart Codex');
    expect(result.stdout).toContain('run /hooks and review the hook bundle');
    expect(result.stdout).toContain('does not write or bypass hook trust');
    expect(result.stderr).toBe('');
  });

  it('treats an already-added same-source marketplace as idempotent success', () => {
    const scenario = makeScenario({
      alreadyAdded: true,
      marketplaceList: {
        marketplaces: [{
          name: 'kanevry',
          root: STAGE,
          marketplaceSource: { sourceType: 'local', source: STAGE },
        }],
      },
    });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already uses this source; refreshed");
    expect(readCalls()).toContainEqual(['plugin', 'marketplace', 'add', STAGE, '--json']);
  });

  it('refreshes the installed bundle state through plugin add on every rerun', () => {
    const scenario = makeScenario({ alreadyAdded: true });

    const first = runInstaller({ scenario });
    const firstState = readState();
    const second = runInstaller({ scenario });
    const secondState = readState();
    const calls = readCalls();

    expect(first.status).toBe(0);
    expect(firstState.installedBundle).toEqual(FIRST_BUNDLE_SNAPSHOT);
    expect(firstState.bundleHistory).toEqual([FIRST_BUNDLE_SNAPSHOT]);
    expect(second.status).toBe(0);
    expect(secondState.installedBundle).toEqual(SECOND_BUNDLE_SNAPSHOT);
    expect(secondState.installedBundle).not.toEqual(firstState.installedBundle);
    expect(secondState.bundleHistory).toEqual([
      FIRST_BUNDLE_SNAPSHOT,
      SECOND_BUNDLE_SNAPSHOT,
    ]);
    expect(calls.filter((args) => args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'add')).toHaveLength(2);
    expect(calls.filter((args) => args[0] === 'plugin' && args[1] === 'add')).toHaveLength(2);
  });

  it('returns exit 1 for an unknown user argument without invoking Codex', () => {
    const result = runInstaller({ args: ['--unknown'] });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown argument '--unknown'");
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  it('rejects an old Codex version before any mutation', () => {
    const result = runInstaller({ scenario: makeScenario({ version: 'codex-cli 0.144.3\n' }) });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Codex 0.144.3 is unsupported');
    expect(readCalls()).toEqual([['--version']]);
  });

  it('rejects an unstable plugins feature before any mutation', () => {
    const result = runInstaller({
      scenario: makeScenario({ features: 'plugins under development true\nhooks stable true\n' }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("feature 'plugins' must report 'stable true'");
    expect(readCalls()).toEqual([['--version'], ['features', 'list']]);
  });

  it('rejects a disabled hooks feature before any mutation', () => {
    const result = runInstaller({
      scenario: makeScenario({ features: 'plugins stable true\nhooks stable false\n' }),
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("feature 'hooks' must report 'stable true'");
    expect(readCalls()).toEqual([['--version'], ['features', 'list']]);
  });

  it('invokes the canonical contract before the first mutating command', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    const contractCall = source.indexOf('expectedVersion = validateLocalContract(dir);');
    const marketplaceMutation = source.indexOf("['plugin', 'marketplace', 'add', STAGE_DIR, '--json']");
    const result = runInstaller();

    expect(contractCall).toBeGreaterThan(-1);
    expect(marketplaceMutation).toBeGreaterThan(contractCall);
    expect(result.stdout.indexOf('Local contract: valid')).toBeLessThan(
      result.stdout.indexOf('Marketplace: adding'),
    );
  });

  it('fails on a conflicting kanevry source without removing or replacing it', () => {
    const scenario = makeScenario({
      marketplaceList: {
        marketplaces: [{
          name: 'kanevry',
          root: '/different/source',
          marketplaceSource: { sourceType: 'local', source: '/different/source' },
        }],
      },
    });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Marketplace 'kanevry' already points to '/different/source'");
    expect(result.stderr).toContain('will not remove or replace it');
    expect(readCalls()).toEqual([
      ['--version'],
      ['features', 'list'],
      ['plugin', 'marketplace', 'list', '--json'],
    ]);
  });

  it('installs from the packed stage with runtime deps, never from the clone (#1518)', () => {
    const result = runInstaller();
    const npmCalls = readNpmCalls();

    expect(result.status).toBe(0);
    expect(npmCalls.map((c) => c.argv[0])).toEqual(['pack', 'ci']);
    expect(npmCalls[0].argv).toContain('--ignore-scripts');
    expect(npmCalls[1].argv).toEqual(['ci', '--omit=dev', '--ignore-scripts']);
    expect(existsSync(join(STAGE, '.codex-plugin', 'plugin.json'))).toBe(true);
    expect(existsSync(join(STAGE, 'package-lock.json'))).toBe(true);
    expect(existsSync(join(STAGE, 'node_modules', '.fake-ci'))).toBe(true);
    expect(readCalls().flat()).not.toContain(REPO_ROOT);
  });

  it('refuses a marketplace on the clone before staging, naming the remove command (#1518)', () => {
    const scenario = makeScenario({
      marketplaceList: {
        marketplaces: [{
          name: 'kanevry',
          root: REPO_ROOT,
          marketplaceSource: { sourceType: 'local', source: REPO_ROOT },
        }],
      },
    });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('reads this clone');
    expect(result.stderr).toContain('codex plugin marketplace remove kanevry && node scripts/codex-install.mjs');
    expect(readNpmCalls()).toEqual([]);
    expect(existsSync(STAGE)).toBe(false);
  });

  it('returns exit 2 and makes no Codex mutation when staging fails', () => {
    const result = runInstaller({ extraEnv: { FAKE_NPM_FAIL: 'ci' } });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Cannot stage the packed copy');
    expect(readCalls().some((args) => args[2] === 'add' || args[1] === 'add')).toBe(false);
  });

  it('keeps the previous stage when the new copy fails the contract (#1518 review)', () => {
    mkdirSync(STAGE, { recursive: true });
    writeFileSync(join(STAGE, 'marker'), 'previous');

    const result = runInstaller({ extraEnv: { FAKE_NPM_OMIT: 'hooks' } });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Local Codex plugin contract failed');
    expect(readFileSync(join(STAGE, 'marker'), 'utf8')).toBe('previous');
    expect(readCalls().some((args) => args[2] === 'add' || args[1] === 'add')).toBe(false);
  });

  it('returns exit 2 when the installed target is disabled', () => {
    const scenario = makeScenario({
      pluginLists: [pluginList({ installed: [targetEntry({ enabled: false })] })],
    });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('installed=true, enabled=false');
    expect(readCalls().at(-1)).toEqual(['plugin', 'list', '--available', '--json']);
  });

  it('returns exit 2 when the target plugin is missing from the postcondition', () => {
    const scenario = makeScenario({
      pluginLists: [pluginList({ installed: [], available: [] })],
    });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`expected exactly one '${PLUGIN_ID}' entry, found 0`);
  });

  it('returns exit 2 when the installed target version differs from the manifest', () => {
    const scenario = makeScenario({
      pluginLists: [pluginList({ installed: [targetEntry({ version: '0.0.0+codex.20000101000000' })] })],
    });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`does not match manifest '${MANIFEST.version}'`);
  });

  it('removes only allowlisted legacy IDs after health and preserves unknown plugins', () => {
    const unknown = {
      pluginId: UNKNOWN_PLUGIN,
      name: 'unrelated-plugin',
      marketplaceName: 'team-catalog',
      version: '1.0.0',
      installed: true,
      enabled: true,
    };
    const legacyOpenai = targetEntry({ pluginId: LEGACY_OPENAI, marketplaceName: 'openai-curated' });
    const legacyLocal = targetEntry({ pluginId: LEGACY_LOCAL, marketplaceName: 'local' });
    const scenario = makeScenario({
      pluginLists: [
        pluginList({ installed: [legacyLocal, unknown, targetEntry(), legacyOpenai] }),
        pluginList({ installed: [unknown, targetEntry()] }),
      ],
    });

    const result = runInstaller({ scenario });
    const calls = readCalls();
    const firstHealthIndex = calls.findIndex((args) => args[1] === 'list' && args[2] === '--available');
    const openaiRemoveIndex = calls.findIndex((args) => args.at(-2) === LEGACY_OPENAI);
    const localRemoveIndex = calls.findIndex((args) => args.at(-2) === LEGACY_LOCAL);

    expect(result.status).toBe(0);
    expect(openaiRemoveIndex).toBeGreaterThan(firstHealthIndex);
    expect(localRemoveIndex).toBeGreaterThan(openaiRemoveIndex);
    expect(calls).not.toContainEqual(['plugin', 'remove', UNKNOWN_PLUGIN, '--json']);
    expect(calls.some((args) => args[0] === 'plugin' && args[1] === 'marketplace' && args[2] === 'remove')).toBe(false);
  });

  it('returns exit 2 if a legacy plugin remains installed after removal', () => {
    const legacyOpenai = targetEntry({ pluginId: LEGACY_OPENAI, marketplaceName: 'openai-curated' });
    const scenario = makeScenario({
      pluginLists: [
        pluginList({ installed: [targetEntry(), legacyOpenai] }),
        pluginList({ installed: [targetEntry(), legacyOpenai] }),
      ],
    });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`legacy plugins remain installed: ${LEGACY_OPENAI}`);
  });

  it('returns exit 2 for Codex command errors while preserving diagnostics', () => {
    const scenario = makeScenario();
    scenario.responses[commandKey(['plugin', 'add', PLUGIN_ID, '--json'])] = [
      jsonResponse('', { status: 9, stderr: 'simulated install failure\n' }),
    ];

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Command failed with exit 9');
    expect(result.stderr).toContain('simulated install failure');
    expect(readCalls().at(-1)).toEqual(['plugin', 'add', PLUGIN_ID, '--json']);
  });

  it('returns exit 2 when a Codex command exceeds the 30-second timeout', { timeout: 40_000 }, () => {
    const scenario = makeScenario();
    scenario.responses[commandKey(['--version'])] = [
      jsonResponse('codex-cli 0.144.4\n', { delayMs: 30_500 }),
    ];

    const result = runInstaller({ scenario, timeout: 35_000 });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cannot run 'codex --version'");
    expect(result.stderr).toContain('ETIMEDOUT');
    expect(readCalls()).toEqual([['--version']]);
  });

  it('returns exit 2 when the Codex binary is missing', () => {
    const result = runInstaller({ pathValue: homePath });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Cannot run 'codex --version'");
    expect(result.stderr).toContain('ENOENT');
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  it('returns exit 2 on malformed marketplace JSON before mutation', () => {
    const scenario = makeScenario();
    scenario.responses[commandKey(['plugin', 'marketplace', 'list', '--json'])] = [
      jsonResponse('{not-json\n'),
    ];

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Marketplace list returned malformed JSON');
    expect(readCalls().at(-1)).toEqual(['plugin', 'marketplace', 'list', '--json']);
  });

  it('returns exit 2 when marketplace JSON has the wrong array shape before mutation', () => {
    const scenario = makeScenario({ marketplaceList: { marketplaces: {} } });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('marketplaces must be an array in Codex JSON output');
    expect(readCalls()).toEqual([
      ['--version'],
      ['features', 'list'],
      ['plugin', 'marketplace', 'list', '--json'],
    ]);
  });

  it('returns exit 2 when plugin-add JSON reports a different version', () => {
    const scenario = makeScenario({
      pluginAdd: {
        pluginId: PLUGIN_ID,
        name: 'session-orchestrator',
        marketplaceName: 'kanevry',
        version: '0.0.0+codex.20000101000000',
        installedPath: '/fake/codex/plugins/session-orchestrator',
      },
    });

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      `Plugin add returned version '0.0.0+codex.20000101000000', expected '${MANIFEST.version}'`,
    );
    expect(readCalls().at(-1)).toEqual(['plugin', 'add', PLUGIN_ID, '--json']);
  });

  it('returns exit 2 on malformed plugin-list JSON after add', () => {
    const scenario = makeScenario();
    scenario.responses[commandKey(['plugin', 'list', '--available', '--json'])] = [
      jsonResponse('not-json\n'),
    ];

    const result = runInstaller({ scenario });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Plugin list returned malformed JSON');
  });

  it('prints the exact structured JSON result without mixing progress text into stdout', () => {
    const result = runInstaller({ args: ['--json'] });
    const payload = JSON.parse(result.stdout);

    expect(result.status).toBe(0);
    expect(payload).toEqual({
      ok: true,
      codexVersion: '0.144.4',
      marketplace: 'kanevry',
      marketplaceSource: STAGE,
      marketplaceAlreadyAdded: false,
      pluginId: PLUGIN_ID,
      pluginVersion: MANIFEST.version,
      installed: true,
      enabled: true,
      removedLegacyPlugins: [],
      nextSteps: [
        'Start a fresh Codex task or fully restart Codex so the plugin and hooks reload.',
        'In the fresh task, run /hooks and review the hook bundle before approving it.',
        'This installer does not write or bypass hook trust.',
      ],
    });
    expect(result.stdout).not.toContain('Session Orchestrator — Codex Setup');
    expect(result.stderr).toBe('');
  });

  it('prints the package/plugin base version without invoking Codex', () => {
    const result = runInstaller({ args: ['--version'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`${PACKAGE.version}\n`);
    expect(result.stderr).toBe('');
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  it('prints concise help examples without invoking Codex', () => {
    const result = runInstaller({ args: ['--help'] });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage: node scripts/codex-install.mjs [options]');
    expect(result.stdout).toContain('Examples:');
    expect(result.stdout).toContain('node scripts/codex-install.mjs --json');
    expect(result.stdout).toContain('node scripts/codex-install.mjs --version');
    expect(result.stderr).toBe('');
    expect(() => readFileSync(logPath, 'utf8')).toThrow();
  });

  // The personal catalog `~/.agents/plugins/marketplace.json` is READ for a
  // hint (#1518 review); the installer itself writes no file at all.
  it('contains no private Codex paths, file writes, hook-state writes, or trust bypass', () => {
    const source = readFileSync(SCRIPT, 'utf8');
    expect(source).not.toMatch(/\b(writeFileSync|appendFileSync|rmSync|unlinkSync|renameSync|cpSync)\b/);
    const forbidden = [
      ['.tmp', 'plugins'].join('/'),
      ['config', 'toml'].join('.'),
      ['hooks', 'state'].join('.'),
      ['--dangerously', 'bypass-hook-trust'].join('-'),
    ];

    expect(forbidden.filter((value) => source.includes(value))).toEqual([]);
    expect(source).not.toContain("['plugin', 'marketplace', 'remove'");
  });
});
