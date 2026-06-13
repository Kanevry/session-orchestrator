/**
 * tests/scripts/pi-install.test.mjs
 *
 * Process-boundary smoke tests for scripts/pi-install.mjs. These tests use
 * --settings-only so they do not require a globally installed Pi binary.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)));
const SCRIPT = join(REPO_ROOT, 'scripts', 'pi-install.mjs');

function runPiInstall(args = [], { cwd, env = {} } = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: cwd ?? REPO_ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

describe('scripts/pi-install.mjs', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'pi-install-test-'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('settings-only project install writes .pi/settings.json', () => {
    const result = runPiInstall([tmp, '--settings-only']);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Session Orchestrator — Pi Setup');

    const settingsPath = join(tmp, '.pi', 'settings.json');
    expect(existsSync(settingsPath)).toBe(true);
    expect(readJson(settingsPath).packages).toContain(REPO_ROOT);
  });

  it('settings-only project install is idempotent', () => {
    const first = runPiInstall([tmp, '--settings-only']);
    const second = runPiInstall([tmp, '--settings-only']);

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);

    const settings = readJson(join(tmp, '.pi', 'settings.json'));
    expect(settings.packages.filter((entry) => entry === REPO_ROOT)).toHaveLength(1);
  });

  it('preserves existing settings keys and package entries', () => {
    const settingsPath = join(tmp, '.pi', 'settings.json');
    mkdirSync(join(tmp, '.pi'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ defaultProjectTrust: 'ask', packages: ['npm:existing/pkg'] }, null, 2) + '\n',
      'utf8',
    );

    const result = runPiInstall([tmp, '--settings-only']);
    expect(result.status).toBe(0);

    const settings = readJson(settingsPath);
    expect(settings.defaultProjectTrust).toBe('ask');
    expect(settings.packages).toContain('npm:existing/pkg');
    expect(settings.packages).toContain(REPO_ROOT);
  });

  it('settings-only global install writes PI_AGENT_HOME/settings.json', () => {
    const piHome = join(tmp, 'pi-agent-home');
    const result = runPiInstall(['--global', '--settings-only'], {
      env: { PI_AGENT_HOME: piHome },
    });

    expect(result.status).toBe(0);
    expect(readJson(join(piHome, 'settings.json')).packages).toContain(REPO_ROOT);
  });

  it('install mode fails clearly when the pi binary is unavailable', () => {
    const result = runPiInstall([tmp], { env: { PATH: '' } });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('pi is required for install mode');
  });

  it('refuses to create settings in a nonexistent project target', () => {
    const missing = join(tmp, 'does-not-exist');
    const result = runPiInstall([missing, '--settings-only']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Target project directory does not exist');
    expect(existsSync(missing)).toBe(false);
  });
});
