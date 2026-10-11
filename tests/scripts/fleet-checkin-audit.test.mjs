/** CLI contract tests: exits/streams, confinement and read-only inputs. */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs, mkdtempSync, mkdirSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main } from '../../scripts/fleet-checkin-audit.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/fleet-checkin-audit.mjs', import.meta.url));
const TEMP_BASE = process.env.TMPDIR || '/tmp/so-63a';
mkdirSync(TEMP_BASE, { recursive: true });
const AT = '2026-10-10T12:00:00Z';
const FROM = '2026-10-10T11:00:00Z';
const bindings = [{ repo_key: 'example', registry_hashes: ['a'.repeat(64)], checkin_repos: ['example-name'] }];
const registry = () => ({ version: 1, complete: true, captured_at: AT, repo_bindings: bindings, records: [] });
const checkins = () => ({ version: 1, complete: true, captured_at: AT, records: [], coverage: { complete: true, from: FROM, to: AT }, claims: [] });
let root;
let input;
const args = (extra = []) => ['--input-root', input, '--registry', 'registry.json', '--checkins', 'checkins.json', '--repo', 'example', '--at', AT, '--json', ...extra];
async function invoke(argv) {
  let stdout = ''; let stderr = '';
  const code = await main(argv, { stdout: { write: (s) => { stdout += s; } }, stderr: { write: (s) => { stderr += s; } } });
  return { code, stdout, stderr, report: JSON.parse(stdout) };
}
async function writeSnapshots(r = registry(), c = checkins()) {
  await fs.writeFile(path.join(input, 'registry.json'), JSON.stringify(r) + '\n');
  await fs.writeFile(path.join(input, 'checkins.json'), JSON.stringify(c) + '\n');
}
beforeAll(async () => { root = await fs.mkdtemp(path.join(await fs.realpath(TEMP_BASE), 'so-63a-cli-')); });
beforeEach(async () => {
  input = await fs.mkdtemp(path.join(root, 'input-'));
  await writeSnapshots();
});

describe('fleet-checkin-audit CLI boundary', () => {
  it('reports a complete empty population as measured zero, preserving exact input bytes', async () => {
    const paths = ['registry.json', 'checkins.json'].map((p) => path.join(input, p));
    const before = await Promise.all(paths.map((p) => fs.readFile(p)));
    const r = await invoke(args());
    expect(r.code).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n')).toHaveLength(2);
    expect(r.report.metrics.selected).toEqual({ status: 'measured', value: 0, reasons: [] });
    expect(r.report.metrics.collisions.value).toBe(0);
    expect(await Promise.all(paths.map((p) => fs.readFile(p)))).toEqual(before);
    expect((await fs.readdir(input)).sort()).toEqual(['checkins.json', 'registry.json']);
  });
  it.each([
    ['missing snapshot object', null, checkins(), 'registry:missing-snapshot'],
    ['unasserted completeness', { ...registry(), complete: false }, checkins(), 'registry:incomplete-population'],
    ['absent historical intervals', registry(), { version: 1, complete: true, captured_at: AT, records: [] }, 'history:missing-claims'],
  ])('returns exit 3 for %s rather than fabricated zero', async (_name, r, c, reason) => {
    await writeSnapshots(r, c);
    const result = await invoke(args());
    expect(result.code).toBe(3);
    expect(result.stderr).toBe('');
    expect(Object.values(result.report.metrics).flatMap((m) => m.reasons)).toContain(reason);
    expect(result.report.status).toBe('not-measurable');
  });
  it.each([
    ['missing flag', ['--json']],
    ['unknown flag', ['--bogus', '--json']],
    ['duplicate flag', null],
  ])('returns exit 1 and separate diagnostics for %s', async (_name, argv) => {
    const result = await invoke(argv || args(['--at', AT]));
    expect(result.code).toBe(1);
    expect(result.report.status).toBe('not-measurable');
    expect(result.stderr).toContain('fleet-checkin-audit:');
    expect(result.stdout).not.toContain(input);
  });
  it('returns exit 2 for absent input without disclosing its absolute path', async () => {
    const argv = args(); argv[argv.indexOf('--registry') + 1] = 'missing-secret-name.json';
    const result = await invoke(argv);
    expect(result.code).toBe(2);
    expect(result.report.error).toEqual({ category: 'input-io-error', errno: 'ENOENT' });
    expect(result.stderr).not.toContain(input);
    expect(result.stderr).not.toContain('missing-secret-name');
  });
  it.each([
    ['invalid-measurement-time', '--at', '2026-02-30T12:00:00Z'],
    ['invalid-measurement-time', '--at', '2026-10-10T12:00:00+00:00'],
    ['invalid-repo-selection', '--repo', ' example '],
  ])('rejects %s (%s %s) before reading snapshots', async (category, flag, value) => {
    const argv = args(); argv[argv.indexOf(flag) + 1] = value;
    const result = await invoke(argv);
    expect(result.code).toBe(1);
    expect(result.report.error.category).toBe(category);
  });
  it('rejects duplicated explicit repo selection', async () => {
    const result = await invoke(args(['--repo', 'example']));
    expect(result.code).toBe(1);
    expect(result.report.error.category).toBe('invalid-repo-selection');
  });
  it.each([Buffer.from('{"secret":"do-not-print"'), Buffer.from([0xff])])('rejects malformed JSON or UTF-8 without echoing bytes', async (bytes) => {
    await fs.writeFile(path.join(input, 'registry.json'), bytes);
    const result = await invoke(args());
    expect(result.code).toBe(1);
    expect(result.report.error.category).toBe('malformed-json-or-utf8');
    expect(result.stdout + result.stderr).not.toContain('do-not-print');
  });
  it.each(['../outside.json', path.resolve(TEMP_BASE, 'outside.json')])('rejects lexical escape %s before opening input', async (target) => {
    const argv = args(); argv[argv.indexOf('--registry') + 1] = target;
    const result = await invoke(argv);
    expect(result.code).toBe(1);
    expect(result.report.error.category).toBe('path-outside-input-root');
  });
  it.each(['final', 'parent', 'root'])('refuses a %s symlink without following its target', async (kind) => {
    const outside = await fs.mkdtemp(path.join(root, 'outside-'));
    await fs.writeFile(path.join(outside, 'registry.json'), 'DO-NOT-READ');
    const argv = args();
    if (kind === 'final') {
      await fs.symlink(path.join(outside, 'registry.json'), path.join(input, 'link.json'));
      argv[argv.indexOf('--registry') + 1] = 'link.json';
    } else if (kind === 'parent') {
      await fs.symlink(outside, path.join(input, 'linked'));
      argv[argv.indexOf('--registry') + 1] = 'linked/registry.json';
    } else {
      const link = path.join(root, `root-link-${path.basename(input)}`);
      await fs.symlink(input, link);
      argv[argv.indexOf('--input-root') + 1] = link;
    }
    const result = await invoke(argv);
    expect(result.code).toBe(1);
    expect(result.report.error.category).toBe('symlink-input');
    expect(await fs.readFile(path.join(outside, 'registry.json'), 'utf8')).toBe('DO-NOT-READ');
  });
  it('rejects a directory input as non-regular', async () => {
    await fs.mkdir(path.join(input, 'directory'));
    const argv = args(); argv[argv.indexOf('--registry') + 1] = 'directory';
    expect((await invoke(argv)).report.error.category).toBe('non-regular-input');
  });
  it('checks both path boundaries before parsing any snapshot content', async () => {
    await fs.writeFile(path.join(input, 'registry.json'), 'MALFORMED');
    const outside = path.join(root, 'outside-checkins.json');
    await fs.writeFile(outside, 'DO-NOT-READ');
    await fs.symlink(outside, path.join(input, 'checkin-link.json'));
    const argv = args(); argv[argv.indexOf('--checkins') + 1] = 'checkin-link.json';
    const result = await invoke(argv);
    expect(result.code).toBe(1);
    expect(result.report.error.category).toBe('symlink-input');
  });
  it('supports help, version and human-readable output', async () => {
    let output = ''; const io = { stdout: { write: (s) => { output += s; } }, stderr: { write: () => {} } };
    expect(await main(['--help'], io)).toBe(0); expect(output).toContain('--input-root');
    output = ''; expect(await main(['--version'], io)).toBe(0); expect(output).toMatch(/^\d+\.\d+\.\d+/);
    output = ''; expect(await main(args().filter((a) => a !== '--json'), io)).toBe(0);
    expect(output).toContain('selected: 0');
  });
});

// Every real child inherits isolated homes explicitly, including the probe.
// No filesystem/process mocks: inability to spawn is an honest named skip.
const childRoot = mkdtempSync(path.join(realpathSync(TEMP_BASE), 'so-63a-child-'));
const childEnv = { ...process.env, HOME: path.join(childRoot, 'home'), NAVIGATOR_CONFIG_DIR: path.join(childRoot, 'navigator'), SO_VAULT_DIR: path.join(childRoot, 'vault'), TMPDIR: path.join(childRoot, 'tmp') };
for (const dir of [childEnv.HOME, childEnv.NAVIGATOR_CONFIG_DIR, childEnv.SO_VAULT_DIR, childEnv.TMPDIR]) mkdirSync(dir);
const probe = spawnSync(process.execPath, ['-e', 'process.exit(0)'], { env: childEnv, encoding: 'utf8', timeout: 5000 });
const spawnDenied = probe.error?.code === 'EPERM' || probe.error?.code === 'EACCES';
if (spawnDenied) console.warn('fleet-checkin-audit subprocess tests: skipped, not measurable (spawn permission denied)');
describe.skipIf(spawnDenied)('fleet-checkin-audit native subprocess (not measurable when sandbox denies spawn)', () => {
  const run = (argv) => spawnSync(process.execPath, argv, { env: childEnv, encoding: 'utf8', timeout: 10000 });
  it('native success and byte preservation', async () => {
    expect(probe.status).toBe(0);
    const before = await fs.readFile(path.join(input, 'registry.json'));
    const r = run([SCRIPT, ...args()]);
    expect(r.error).toBeUndefined(); expect(r.status).toBe(0); expect(r.stderr).toBe('');
    expect(JSON.parse(r.stdout).metrics.selected.value).toBe(0);
    expect(await fs.readFile(path.join(input, 'registry.json'))).toEqual(before);
  });
  it('native error stream and exit', () => {
    const r = run([SCRIPT, '--json']);
    expect(r.status).toBe(1); expect(JSON.parse(r.stdout).error.category).toBe('missing-arguments');
    expect(r.stderr).toContain('fleet-checkin-audit:');
  });
  it('native symlink refusal', async () => {
    await fs.symlink(path.join(input, 'registry.json'), path.join(input, 'link.json'));
    const argv = args(); argv[argv.indexOf('--registry') + 1] = 'link.json';
    const r = run([SCRIPT, ...argv]);
    expect(r.status).toBe(1); expect(JSON.parse(r.stdout).error.category).toBe('symlink-input');
  });
  it('native import remains inert', () => {
    const r = run(['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../../scripts/fleet-checkin-audit.mjs', import.meta.url).href)})`]);
    expect(r.status).toBe(0); expect(r.stdout).toBe(''); expect(r.stderr).toBe('');
  });
});
