import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';
import { getDefaults, loadOwnerConfig } from '../../../scripts/lib/owner-yaml.mjs';

const checker = resolve('skills/claude-md-drift-check/checker.mjs');
const prefix = '/Users/so-foreign-missing/Projects/remote';
let root;
beforeEach(() => { root = makeTmpDir('foreign-host-drift-'); });
afterEach(() => removeTree(root));
function owner(section) {
  const privateDir = join(root, 'config');
  mkdirSync(privateDir, { recursive: true });
  const config = getDefaults();
  config.owner.name = 'Test';
  if (section !== undefined) config['drift-check'] = section;
  const path = join(privateDir, 'owner.yaml');
  writeFileSync(path, JSON.stringify(config));
  return path;
}
function run(paths, mode = 'strict') {
  const vault = join(root, 'vault');
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, 'CLAUDE.md'), paths.join('\n'));
  const result = spawnSync(process.execPath, [checker, '--mode', mode, '--skip-issue-refs'], {
    env: { ...process.env, VAULT_DIR: vault, SO_CONFIG_HOME: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config') },
    encoding: 'utf8', timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  return { code: result.status, ...JSON.parse(result.stdout.trim()) };
}
describe('foreign host path allowlist', () => {
  it('changes only declared foreign paths from errors to warnings', () => {
    const paths = [`${prefix}/file`, '/Users/so-local-missing/Projects/local/file'];
    expect(run(paths).errors).toHaveLength(2);
    owner({ 'foreign-host-prefixes': [prefix] });
    const result = run(paths);
    expect(result.code).toBe(1);
    expect(result.errors.map(e => e.extracted)).toEqual([paths[1]]);
    expect(result.warnings.map(e => e.extracted)).toEqual([paths[0]]);
    expect(run([paths[0]]).code).toBe(0);
  });
  it('matches whole directory boundaries including trailing slashes', () => {
    owner({ 'foreign-host-prefixes': [`${prefix}/`] });
    const result = run([prefix, `${prefix}/file`, `${prefix}other/file`]);
    expect(result.warnings).toHaveLength(2);
    expect(result.errors.map(e => e.extracted)).toEqual([`${prefix}other/file`]);
  });
  it('checks normalized boundaries without changing the reported path', () => {
    owner({ 'foreign-host-prefixes': [prefix] });
    const inside = `${prefix}/./file`;
    const escape = `${prefix}/../../local/file`;
    const neighbor = `${prefix}/../remote-other/file`;
    const result = run([inside, escape, neighbor]);
    expect(result.code).toBe(1);
    expect(result.warnings.map(e => e.extracted)).toEqual([inside]);
    expect(result.errors.map(e => e.extracted)).toEqual([escape, neighbor]);
  });
  it('preserves legacy owner files and explicit mode precedence', () => {
    owner(undefined);
    expect(run([`${prefix}/file`]).code).toBe(1);
    expect(run([`${prefix}/file`], 'warn').code).toBe(0);
    expect(run([`${prefix}/file`], 'off').status).toBe('skipped-mode-off');
  });
  it.each(['/', '/Users', '/Users/somebody', '/Users/somebody/Projects', 'relative/path', '/Users/*/Projects/remote', '/Users/somebody/../remote', 42])('rejects unsafe prefix %s without enabling valid siblings', (bad) => {
    const path = owner({ 'foreign-host-prefixes': [prefix, bad] });
    const loaded = loadOwnerConfig({ path });
    expect(loaded.source).toBe('partial');
    expect(loaded.droppedSections.map(s => s.section)).toContain('drift-check');
    expect(loaded.config.owner.name).toBe('Test');
    expect(run([`${prefix}/file`]).errors).toHaveLength(1);
  });
  it.each([false, { 'foreign-host-prefixes': prefix }, { 'foreign-host-prefixes': null }])('fails safe for malformed optional section %s', (section) => {
    owner(section);
    expect(run([`${prefix}/file`]).code).toBe(1);
  });
});
