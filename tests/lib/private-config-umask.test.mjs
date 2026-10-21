/**
 * #1629 — under `umask 000` (WSL default) every writer that created the
 * host-private config dir left it 0777. check-owner-leakage then refused the
 * (even absent) owner policy as `unsafe`, and `isOwnerLeakySegment()` failed
 * closed with CP1 for EVERY segment, so the vault mirror renamed every repo
 * to `redacted-repo` behind a misleading "owner-privacy leak" WARN.
 *
 * Each case runs in a child process with `process.umask(0)` so the parent's
 * umask (usually 022) cannot hide the bug. `SO_CONFIG_HOME` / HOME always point
 * into a mkdtemp sandbox — never the operator's real `~/.config`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, chmodSync, statSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const repoRoot = process.cwd();
const lib = (rel) => JSON.stringify(path.join(repoRoot, 'scripts/lib', rel));

let sandbox;
beforeEach(() => { sandbox = mkdtempSync(path.join(tmpdir(), 'so-umask-')); });
afterEach(() => { rmSync(sandbox, { recursive: true, force: true }); });

function runUmask0(code, env) {
  const res = spawnSync(process.execPath, ['--input-type=module', '-e', `process.umask(0);\n${code}`], {
    encoding: 'utf8',
    env: { ...process.env, HOME: sandbox, XDG_CONFIG_HOME: '', SO_OWNER_PATTERNS_FILE: '', SO_HOST_ALIASES_FILE: '', SO_SESSION_REGISTRY_DIR: '', ...env },
  });
  expect(res.status, res.stderr).toBe(0);
  return res;
}

// One case per production writer that can create the private config dir
// (census in the #1629 commit). `cfg` is two levels below the sandbox so the
// recursive create covers an intermediate level as well.
const WRITERS = [
  ['owner-yaml writeOwnerConfig', () => `const m = await import(${lib('owner-yaml.mjs')}); const r = m.writeOwnerConfig({ ...m.getDefaults(), owner: { ...m.getDefaults().owner, name: 'Probe' } }); if (!r.written) throw new Error(JSON.stringify(r));`],
  ['host-identity recordHostAlias', () => `const m = await import(${lib('host-identity.mjs')}); m.recordHostAlias('umask-probe');`],
  ['host-identity getPrivateHostInfo', () => `const m = await import(${lib('host-identity.mjs')}); await m.getPrivateHostInfo(process.cwd());`],
  ['session-registry logSweepEvent', () => `const m = await import(${lib('session-registry.mjs')}); m.logSweepEvent({ event: 'probe', session_id: null, error: 'x' });`],
  ['telemetry writeTelemetryState', (cfg) => `const m = await import(${lib('telemetry/consent.mjs')}); const r = m.writeTelemetryState({}, { path: ${JSON.stringify(path.join(cfg, 'telemetry.json'))} }); if (!r.ok) throw new Error(r.error);`],
  ['telemetry enqueue', (cfg) => `const m = await import(${lib('telemetry/queue.mjs')}); const r = m.enqueue({ a: 1 }, { path: ${JSON.stringify(path.join(cfg, 'telemetry-queue.ndjson'))} }); if (!r.ok) throw new Error(r.error);`],
];

describe('private config dir under umask 000 (#1629)', () => {
  it.each(WRITERS)('%s creates the private dir without group/world write', (_name, body) => {
    const cfg = path.join(sandbox, 'cfg', 'session-orchestrator');
    runUmask0(body(cfg), { SO_CONFIG_HOME: cfg });
    for (const dir of [path.dirname(cfg), cfg]) {
      expect((statSync(dir).mode & 0o077).toString(8), dir).toBe('0');
    }
    // End-to-end consequence: an absent policy reads as missing, not unsafe.
    const probe = runUmask0(
      `const m = await import(${lib('validate/check-owner-leakage.mjs')}); process.stdout.write(JSON.stringify([m.inspectOwnerPatterns().status, m.isOwnerLeakySegment('some-repo')]));`,
      { SO_CONFIG_HOME: cfg },
    );
    expect(JSON.parse(probe.stdout)).toEqual(['missing', null]);
  });

  it('names the unsafe config directory instead of reporting a CP1 leak', () => {
    const cfg = path.join(sandbox, 'cfg');
    mkdirSync(cfg);
    chmodSync(cfg, 0o777);
    const res = runUmask0(
      `const m = await import(${lib('validate/check-owner-leakage.mjs')}); process.stdout.write(JSON.stringify([m.inspectOwnerPatterns(), m.isOwnerLeakySegment('a'), m.isOwnerLeakySegment('b')]));`,
      { SO_CONFIG_HOME: cfg },
    );
    // Fail-closed stays: an unsafe directory never supplies (or waives) a policy.
    expect(JSON.parse(res.stdout)).toEqual([{ status: 'unsafe', reason: 'unsafe-config-dir' }, 'CP1', 'CP1']);
    const warnings = res.stderr.split('\n').filter(Boolean);
    expect(warnings).toHaveLength(1); // once per process, not once per segment
    expect(warnings[0]).toMatch(/unsafe config directory \$SO_CONFIG_HOME \(mode 777/);
    expect(warnings[0]).toContain('chmod 700');
    expect(warnings[0]).not.toContain(sandbox); // path stays redacted
  });

  it('suggests replacing a symlinked config dir, where chmod would not help', () => {
    const real = path.join(sandbox, 'real');
    mkdirSync(real, { mode: 0o700 });
    const cfg = path.join(sandbox, 'cfg');
    symlinkSync(real, cfg);
    const res = runUmask0(`const m = await import(${lib('validate/check-owner-leakage.mjs')}); m.isOwnerLeakySegment('a');`, { SO_CONFIG_HOME: cfg });
    expect(res.stderr).toContain('replace the symlink $SO_CONFIG_HOME with a real directory');
    expect(res.stderr).not.toContain('chmod');
  });

  it('vault-mirror redacts every repo but reports the unsafe dir, not a leak per repo', () => {
    const cfg = path.join(sandbox, 'cfg');
    mkdirSync(cfg);
    chmodSync(cfg, 0o777);
    const res = runUmask0(
      `const m = await import(${lib('vault-mirror/namespace.mjs')}); process.stdout.write(JSON.stringify(['repo-a', 'repo-b'].map((vaultName) => m.resolveRepoNamespace({ vaultName }))));`,
      { SO_CONFIG_HOME: cfg },
    );
    expect(JSON.parse(res.stdout)).toEqual(['redacted-repo', 'redacted-repo']); // fail-closed stays
    expect(res.stderr).not.toMatch(/leak detected/);
    expect(res.stderr.match(/owner policy unavailable \(unsafe config dir\)/g)).toHaveLength(2);
  });
});

// #1632 — the dir is 0700 since #1629, but the files inside were still created
// 0666 under umask 000. Each child prints the path of the file its writer
// produced; the parent asserts no group/world bits. win32 ignores mode bits.
const writeOwner = () => `const m = await import(${lib('owner-yaml.mjs')}); const r = m.writeOwnerConfig({ ...m.getDefaults(), owner: { ...m.getDefaults().owner, name: 'Probe' } }); if (!r.written) throw new Error(JSON.stringify(r)); process.stdout.write(m.resolveOwnerYamlPath());`;
const FILE_WRITERS = [
  ['owner-yaml writeOwnerConfig -> owner.yaml', writeOwner],
  ['session-registry logSweepEvent -> sweep.log', () => `const m = await import(${lib('session-registry.mjs')}); m.logSweepEvent({ event: 'probe', session_id: null, error: 'x' }); process.stdout.write(m.sweepLogPath());`],
  ['session-registry sweepZombies -> sweep.log', (cfg) => `const fs = await import('node:fs'); const d = ${JSON.stringify(path.join(cfg, 'sessions', 'active'))}; fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(d + '/stale.json', '{'); const m = await import(${lib('session-registry.mjs')}); const r = await m.sweepZombies({ thresholdMin: -1 }); if (r.logged !== 1) throw new Error(JSON.stringify(r)); process.stdout.write(m.sweepLogPath());`],
  ['telemetry writeTelemetryState -> telemetry.json', (cfg) => `const p = ${JSON.stringify(path.join(cfg, 'telemetry.json'))}; const m = await import(${lib('telemetry/consent.mjs')}); const r = m.writeTelemetryState({}, { path: p }); if (!r.ok) throw new Error(r.error); process.stdout.write(p);`],
  ['telemetry enqueue -> queue file (tmp before rename)', (cfg) => `const p = ${JSON.stringify(path.join(cfg, 'telemetry-queue.ndjson'))}; const m = await import(${lib('telemetry/queue.mjs')}); const r = m.enqueue({ a: 1 }, { path: p }); if (!r.ok) throw new Error(r.error); process.stdout.write(p);`],
];
const modeOf = (p) => (statSync(p).mode & 0o777).toString(8);

describe.skipIf(process.platform === 'win32')('private config files under umask 000 (#1632)', () => {
  it.each(FILE_WRITERS)('%s is created 0600', (_name, body) => {
    const cfg = path.join(sandbox, 'cfg', 'session-orchestrator');
    const res = runUmask0(body(cfg), { SO_CONFIG_HOME: cfg });
    expect(modeOf(res.stdout)).toBe('600');
  });

  it('owner-yaml tightens a pre-existing world-writable owner.yaml on rewrite', () => {
    const cfg = path.join(sandbox, 'cfg');
    mkdirSync(cfg, { mode: 0o700 });
    const file = path.join(cfg, 'owner.yaml');
    writeFileSync(file, 'schema-version: 1\n');
    chmodSync(file, 0o666);
    const res = runUmask0(writeOwner(), { SO_CONFIG_HOME: cfg });
    expect(res.stdout).toBe(file);
    expect(modeOf(file)).toBe('600');
  });

  it('host-identity creates the host-private.json tmp file 0600 before rename', () => {
    // A non-empty directory at the target makes rename fail, so the tmp file
    // stays behind and its creation mode becomes observable.
    const cfg = path.join(sandbox, 'cfg');
    mkdirSync(path.join(cfg, 'host-private.json'), { recursive: true });
    writeFileSync(path.join(cfg, 'host-private.json', 'block'), '');
    const res = runUmask0(
      `const fs = await import('node:fs'); const m = await import(${lib('host-identity.mjs')}); await m.getPrivateHostInfo(process.cwd()).then(() => { throw new Error('rename unexpectedly succeeded'); }, () => {}); const tmp = fs.readdirSync(${JSON.stringify(cfg)}).filter((n) => n.startsWith('host-private.json.tmp-')); if (tmp.length !== 1) throw new Error(JSON.stringify(tmp)); process.stdout.write(tmp[0]);`,
      { SO_CONFIG_HOME: cfg },
    );
    expect(modeOf(path.join(cfg, res.stdout))).toBe('600');
  });
});
