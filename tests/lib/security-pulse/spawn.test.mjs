import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readHostNpmrcPolicy } from '../../../scripts/lib/security-delta/npmrc.mjs';
import { defaultSpawnRefresh, maybeSpawnRefresh, refresherEnv } from '../../../scripts/lib/security-pulse/spawn.mjs';
import { unwritablePath } from '../../_helpers/unwritable-path.mjs';

const SPAWN_MODULE = fileURLToPath(new URL('../../../scripts/lib/security-pulse/spawn.mjs', import.meta.url));
const NOW = Date.parse('2026-10-25T08:00:00.000Z');

let tmp;
let markerPath;
let calls;
const counting = () => { calls += 1; };
const run = (extra = {}) => maybeSpawnRefresh({ repoRoot: tmp, markerPath, nowMs: NOW, env: {}, spawnRefresh: counting, ...extra });

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'so-pulse-spawn-'));
  markerPath = path.join(tmp, 'cache', 'spawn-abc.marker');
  calls = 0;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

describe('maybeSpawnRefresh claim', () => {
  it('unwritable cache dir: claim-failed twice, no child (the throttle no longer fails open)', () => {
    const marker = path.join(unwritablePath('so-pulse'), 'spawn-abc.marker');
    expect([run({ markerPath: marker }), run({ markerPath: marker })]).toEqual(['claim-failed', 'claim-failed']);
    expect(calls).toBe(0);
  });

  it('a claim held by another starting session throttles instead of spawning a second child', () => {
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(`${markerPath}.claim`, '');
    expect(run()).toBe('throttled');
    expect(calls).toBe(0);
  });

  it('an abandoned claim (older than a minute) is broken once and the spawn goes ahead', () => {
    mkdirSync(path.dirname(markerPath), { recursive: true });
    writeFileSync(`${markerPath}.claim`, '');
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(`${markerPath}.claim`, old, old);
    expect(run()).toBe('spawned');
    expect(calls).toBe(1);
    expect(existsSync(`${markerPath}.claim`)).toBe(false);
    expect(readFileSync(markerPath, 'utf8')).toBe('2026-10-25T08:00:00.000Z\n');
  });

  it('eight sessions starting at once spawn exactly one refresher', { timeout: 20_000 }, async () => {
    const log = path.join(tmp, 'spawns.log');
    const startAt = Date.now() + 1500;
    const script = `
      import { appendFileSync } from 'node:fs';
      const { maybeSpawnRefresh } = await import(${JSON.stringify(SPAWN_MODULE)});
      while (Date.now() < ${startAt}) await new Promise((r) => setTimeout(r, 2));
      const r = maybeSpawnRefresh({ repoRoot: '.', markerPath: ${JSON.stringify(markerPath)}, nowMs: ${NOW}, env: {},
        spawnRefresh: () => appendFileSync(${JSON.stringify(log)}, 'x') });
      process.stdout.write(r);
    `;
    const results = await Promise.all(Array.from({ length: 8 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      child.on('close', () => resolve(out));
    })));
    expect(results.filter((r) => r === 'spawned')).toHaveLength(1);
    expect(readFileSync(log, 'utf8')).toBe('x');
  });
});

describe('maybeSpawnRefresh opt-out', () => {
  it('SO_SECURITY_PULSE_REFRESH=off in the passed env: disabled, no child, no marker', () => {
    expect(run({ env: { SO_SECURITY_PULSE_REFRESH: 'off' } })).toBe('disabled');
    expect(calls).toBe(0);
    expect(existsSync(markerPath)).toBe(false);
  });
});

describe('refresher child env', () => {
  const parent = {
    PATH: '/usr/bin',
    HOME: '/h',
    SO_CONFIG_HOME: '/cfg',
    https_proxy: 'http://proxy.example:3128',
    npm_config_registry: 'https://npm.example.org/',
    'npm_config_@acme:registry': 'https://npm.example.org/acme/',
    'npm_config_//npm.example.org/:_authToken': 'tok-not-a-secret',
    GITLAB_TOKEN: 'tok-not-a-secret',
    ANTHROPIC_API_KEY: 'tok-not-a-secret',
    AWS_SECRET_ACCESS_KEY: 'tok-not-a-secret',
  };

  it('keeps what the refresher reads and drops secret-named variables', () => {
    expect(refresherEnv(parent)).toEqual({
      PATH: '/usr/bin',
      HOME: '/h',
      SO_CONFIG_HOME: '/cfg',
      https_proxy: 'http://proxy.example:3128',
      npm_config_registry: 'https://npm.example.org/',
      'npm_config_@acme:registry': 'https://npm.example.org/acme/',
    });
  });

  it('the filtered env yields the same private-registry policy as the full one', () => {
    const full = readHostNpmrcPolicy({ env: parent, homeDir: tmp });
    expect(readHostNpmrcPolicy({ env: refresherEnv(parent), homeDir: tmp })).toEqual(full);
    expect([...full.privateScopes]).toEqual(['@acme']);
  });

  it('the detached child actually receives the filtered env (secret absent, needed var present)', { timeout: 15_000 }, async () => {
    const out = path.join(tmp, 'env.json');
    const cli = path.join(tmp, 'dump-env.mjs');
    writeFileSync(cli, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(out)}, JSON.stringify(Object.keys(process.env)));\n`);
    const child = defaultSpawnRefresh({ repoRoot: tmp, env: { ...parent, PATH: process.env.PATH ?? '' }, cli });
    await new Promise((resolve) => child.on('close', resolve));
    const names = JSON.parse(readFileSync(out, 'utf8'));
    expect(names).toContain('SO_CONFIG_HOME');
    expect(names).not.toContain('GITLAB_TOKEN');
    expect(names).not.toContain('npm_config_//npm.example.org/:_authToken');
  });
});
