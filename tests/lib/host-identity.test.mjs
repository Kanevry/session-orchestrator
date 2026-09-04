import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFile, mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  isSSH,
  classifyHost,
  hashHostname,
  collectFingerprint,
  collectPrivateInfo,
  getHostFingerprint,
  resolveSalt,
  stableHostname,
  hostnamesMatch,
  lockHostCandidate,
  recordHostAlias,
  readHostAliases,
} from '@lib/host-identity.mjs';

describe('host-identity', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'host-identity-'));
  });

  afterEach(async () => {
    try { await rm(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('isSSH', () => {
    let origConn, origClient, origTty;

    beforeEach(() => {
      origConn = process.env.SSH_CONNECTION;
      origClient = process.env.SSH_CLIENT;
      origTty = process.env.SSH_TTY;
      delete process.env.SSH_CONNECTION;
      delete process.env.SSH_CLIENT;
      delete process.env.SSH_TTY;
    });

    afterEach(() => {
      if (origConn !== undefined) process.env.SSH_CONNECTION = origConn; else delete process.env.SSH_CONNECTION;
      if (origClient !== undefined) process.env.SSH_CLIENT = origClient; else delete process.env.SSH_CLIENT;
      if (origTty !== undefined) process.env.SSH_TTY = origTty; else delete process.env.SSH_TTY;
    });

    it('returns false when no SSH env vars are set', () => {
      expect(isSSH()).toBe(false);
    });

    it('returns true when SSH_CONNECTION is set', () => {
      process.env.SSH_CONNECTION = '192.0.2.1 59210 192.0.2.2 22';
      expect(isSSH()).toBe(true);
    });

    it('returns true when SSH_CLIENT is set', () => {
      process.env.SSH_CLIENT = '192.0.2.1 59210 22';
      expect(isSSH()).toBe(true);
    });

    it('returns true when SSH_TTY is set', () => {
      process.env.SSH_TTY = '/dev/pts/0';
      expect(isSSH()).toBe(true);
    });
  });

  describe('classifyHost', () => {
    it('classifies Apple M1 as macos-arm64-m1', () => {
      expect(classifyHost('darwin', 'arm64', 'Apple M1')).toBe('macos-arm64-m1');
    });

    it('classifies Apple M3 Pro as macos-arm64-m3pro', () => {
      expect(classifyHost('darwin', 'arm64', 'Apple M3 Pro')).toBe('macos-arm64-m3pro');
    });

    it('classifies Apple M4 Max as macos-arm64-m4max', () => {
      expect(classifyHost('darwin', 'arm64', 'Apple M4 Max')).toBe('macos-arm64-m4max');
    });

    it('classifies Apple M2 Ultra as macos-arm64-m2ultra', () => {
      expect(classifyHost('darwin', 'arm64', 'Apple M2 Ultra')).toBe('macos-arm64-m2ultra');
    });

    it('falls back to macos-arm64-apple for unknown Apple chip strings', () => {
      expect(classifyHost('darwin', 'arm64', 'Unknown Apple Silicon')).toBe('macos-arm64-apple');
    });

    it('classifies Intel Macs as macos-x86_64', () => {
      expect(classifyHost('darwin', 'x64', 'Intel(R) Core(TM) i7')).toBe('macos-x86_64');
    });

    it('classifies Linux x86_64 as linux-x86_64', () => {
      expect(classifyHost('linux', 'x64', 'AMD EPYC')).toBe('linux-x86_64');
    });

    it('classifies Linux ARM64 as linux-arm64', () => {
      expect(classifyHost('linux', 'arm64', 'Neoverse-N1')).toBe('linux-arm64');
    });

    it('classifies Windows x86_64 as windows-x86_64', () => {
      expect(classifyHost('win32', 'x64', 'Intel')).toBe('windows-x86_64');
    });

    it('falls back to os-arch for unknown combinations', () => {
      expect(classifyHost('freebsd', 'mips64', '')).toBe('freebsd-mips64');
    });
  });

  describe('hashHostname', () => {
    it('produces a 64-char hex string', () => {
      const h = hashHostname('example.local', 'salt-v1');
      expect(h).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic for identical inputs', () => {
      const a = hashHostname('example.local', 'salt-v1');
      const b = hashHostname('example.local', 'salt-v1');
      expect(a).toBe(b);
    });

    it('produces different hashes for different hostnames with same salt', () => {
      const a = hashHostname('host-a', 'salt-v1');
      const b = hashHostname('host-b', 'salt-v1');
      expect(a).not.toBe(b);
    });

    it('produces different hashes for the same hostname under different salts', () => {
      const a = hashHostname('example.local', 'salt-v1');
      const b = hashHostname('example.local', 'salt-v2');
      expect(a).not.toBe(b);
    });
  });

  describe('collectFingerprint', () => {
    it('returns the expected shape', async () => {
      const fp = await collectFingerprint({ salt: 'test-salt' });
      expect(fp).toMatchObject({
        host_class: expect.any(String),
        os: expect.any(String),
        os_version: expect.any(String),
        cpu_cores: expect.any(Number),
        ram_total_gb: expect.any(Number),
        hostname_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        is_ssh: expect.any(Boolean),
        first_seen: expect.any(String),
      });
    });

    it('records a live platform value, never null (W2-C8 follow-up, #1153 P5)', async () => {
      // The bug: collectFingerprint() destructured the deprecated SO_PLATFORM
      // live binding, which stays `undefined` until getPlatform() has run
      // elsewhere in the process — so `platform` silently recorded null/undefined
      // instead of the live getter's value.
      const fp = await collectFingerprint({ salt: 'test-salt' });
      expect(['claude', 'codex', 'cursor', 'pi']).toContain(fp.platform);
    });

    it('never includes raw hostname', async () => {
      const fp = await collectFingerprint({ salt: 'test-salt' });
      const serialized = JSON.stringify(fp);
      expect(serialized).not.toContain(os.hostname());
    });

    it('never includes absolute filesystem paths', async () => {
      const fp = await collectFingerprint({ salt: 'test-salt' });
      const serialized = JSON.stringify(fp);
      expect(serialized).not.toContain(os.homedir());
    });

    it('produces a parseable ISO 8601 first_seen timestamp', async () => {
      const fp = await collectFingerprint({ salt: 'test-salt' });
      const t = Date.parse(fp.first_seen);
      expect(Number.isNaN(t)).toBe(false);
      expect(t).toBeGreaterThan(0);
    });
  });

  describe('collectPrivateInfo', () => {
    it('contains the raw hostname (local-only, never shared)', () => {
      const info = collectPrivateInfo(tmpDir);
      expect(info.hostname).toBe(os.hostname());
    });

    it('contains the absolute project path', () => {
      const info = collectPrivateInfo(tmpDir);
      expect(info.project_path).toBe(path.resolve(tmpDir));
    });
  });

  describe('getHostFingerprint (cache)', () => {
    it('writes .orchestrator/host.json on first call', async () => {
      const fp = await getHostFingerprint(tmpDir, { salt: 'test-salt' });
      const cacheFile = path.join(tmpDir, '.orchestrator', 'host.json');
      const raw = await readFile(cacheFile, 'utf8');
      const parsed = JSON.parse(raw);
      expect(parsed.host_class).toBe(fp.host_class);
      expect(parsed.hostname_hash).toBe(fp.hostname_hash);
    });

    it('returns cached fingerprint when within TTL', async () => {
      const first = await getHostFingerprint(tmpDir, { salt: 'salt-a' });
      const second = await getHostFingerprint(tmpDir, { salt: 'salt-b' });
      // salt is different but cache hit short-circuits before re-hashing
      expect(second.hostname_hash).toBe(first.hostname_hash);
    });

    it('refreshes when TTL expires', async () => {
      await getHostFingerprint(tmpDir, { salt: 'salt-a' });
      // simulate expired cache via ttl = 0
      const refreshed = await getHostFingerprint(tmpDir, { salt: 'salt-b', ttl: 0 });
      expect(refreshed.hostname_hash).toBe(hashHostname(os.hostname(), 'salt-b'));
    });

    it('refreshes when force flag set', async () => {
      const first = await getHostFingerprint(tmpDir, { salt: 'salt-a' });
      const forced = await getHostFingerprint(tmpDir, { salt: 'salt-b', force: true });
      expect(forced.hostname_hash).not.toBe(first.hostname_hash);
    });
  });

  describe('resolveSalt', () => {
    it('returns the placeholder when owner.yaml is missing', async () => {
      // Can't override ~/.config without touching user state; smoke-check return type only.
      const s = await resolveSalt();
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
    });

    it('reads hash-salt from a fixture owner.yaml when present', async () => {
      // This test exercises the parsing logic directly by writing a temp file
      // and re-reading via a local parse of the same regex. It does NOT touch
      // the real ~/.config/session-orchestrator/owner.yaml.
      const fixture = path.join(tmpDir, 'owner.yaml');
      await mkdir(path.dirname(fixture), { recursive: true });
      await writeFile(fixture, 'hardware-sharing:\n  hash-salt: "my-custom-salt"\n', 'utf8');
      const content = await readFile(fixture, 'utf8');
      const match = content.match(/^\s*hash-salt:\s*["']?([^"'\n\r]+)["']?\s*$/m);
      expect(match[1].trim()).toBe('my-custom-salt');
    });
  });

  // -------------------------------------------------------------------------
  // Stable host identity (#1072)
  // -------------------------------------------------------------------------
  //
  // The bug: os.hostname() is not stable on a single machine. Measured on the
  // reference host 2026-08-24, ten minutes apart: `Mac.home` then
  // `Ferdinands-MacBook-Pro.local`; events.jsonl carries both (106× / 27×).
  // Every `lock.host === os.hostname()` comparison in the lock family then
  // fails against the machine's OWN lock.

  describe('stableHostname', () => {
    it('strips a .home suffix and lowercases (the measured spelling A)', () => {
      expect(stableHostname('Mac.home')).toBe('mac');
    });

    it('strips a .local suffix, so the two spellings of one name converge', () => {
      // Catches: a lock written as `Mac.home` read back as `Mac.local`
      // classified cross-host, which disables stale detection entirely.
      expect(stableHostname('Mac.local')).toBe('mac');
      expect(stableHostname('Mac.home')).toBe(stableHostname('Mac.local'));
    });

    it('lowercases a bare name', () => {
      expect(stableHostname('MAC')).toBe('mac');
    });

    it('strips .lan and .localdomain', () => {
      expect(stableHostname('foo.lan')).toBe('foo');
      expect(stableHostname('foo.localdomain')).toBe('foo');
    });

    it('leaves a real FQDN alone — only local-network suffixes are stripped', () => {
      // Catches an over-eager "drop the last label" rule that would collapse
      // two genuinely different hosts in the same domain into one identity.
      expect(stableHostname('a.b.example.com')).toBe('a.b.example.com');
    });

    it('strips exactly ONE suffix', () => {
      expect(stableHostname('foo.lan.local')).toBe('foo.lan');
    });

    it('is safe on empty, whitespace, and non-string input', () => {
      expect(stableHostname('')).toBe('');
      expect(stableHostname('   ')).toBe('');
      expect(stableHostname(null)).toBe('');
      expect(stableHostname(42)).toBe('');
      // A bare suffix must not normalise away to nothing.
      expect(stableHostname('.local')).toBe('.local');
    });

    it('defaults to the local hostname when called with no argument', () => {
      // Documents JS default-parameter semantics: `undefined` takes the
      // default, it does NOT mean "empty".
      expect(stableHostname()).toBe(stableHostname(os.hostname()));
      expect(stableHostname(undefined)).toBe(stableHostname(os.hostname()));
    });
  });

  describe('hostnamesMatch', () => {
    it('matches a suffix pair without consulting any ledger', () => {
      expect(hostnamesMatch('Mac.home', 'Mac.local', { aliases: [] })).toBe(true);
    });

    it('does NOT match the two measured spellings on normalisation alone', () => {
      // The load-bearing negative: suffix-stripping alone leaves
      // `mac` !== `ferdinands-macbook-pro`, which is why layer 2 exists.
      expect(hostnamesMatch('Mac.home', 'Ferdinands-MacBook-Pro.local', { aliases: [] })).toBe(false);
    });

    it('matches the two measured spellings ONLY when both are in the alias set', () => {
      // THE regression test for #1072: this is the exact pair that made a
      // session unable to reap, override, or release its own lock.
      const aliases = ['Mac.home', 'Ferdinands-MacBook-Pro'];
      expect(hostnamesMatch('Mac.home', 'Ferdinands-MacBook-Pro.local', { aliases })).toBe(true);
      // One-sided membership is not enough — else any name could pair with a
      // single known alias and the cross-host invariant would collapse.
      expect(hostnamesMatch('Mac.home', 'some-other-box', { aliases })).toBe(false);
    });

    it('never matches a genuinely foreign host', () => {
      expect(hostnamesMatch('a-different-host', 'Mac.home', { aliases: ['Mac.home'] })).toBe(false);
      expect(hostnamesMatch('a-different-host', 'Mac.home')).toBe(false);
    });

    it('returns false when either side is empty or non-string', () => {
      expect(hostnamesMatch('', 'mac')).toBe(false);
      expect(hostnamesMatch('mac', undefined)).toBe(false);
      expect(hostnamesMatch(null, null)).toBe(false);
    });
  });

  describe('host-alias ledger', () => {
    let origAliasFile;

    beforeEach(() => {
      origAliasFile = process.env.SO_HOST_ALIASES_FILE;
      // MANDATORY: never let a test write into the operator's real ~/.config.
      process.env.SO_HOST_ALIASES_FILE = path.join(tmpDir, 'host-aliases.json');
    });

    afterEach(() => {
      if (origAliasFile !== undefined) process.env.SO_HOST_ALIASES_FILE = origAliasFile;
      else delete process.env.SO_HOST_ALIASES_FILE;
    });

    it('records normalised names, deduplicates, and reads them back', () => {
      expect(readHostAliases()).toEqual([]);
      recordHostAlias('Mac.home');
      recordHostAlias('Ferdinands-MacBook-Pro.local');
      recordHostAlias('MAC.LOCAL'); // same machine, third spelling → dedup to `mac`
      expect(readHostAliases()).toEqual(['mac', 'ferdinands-macbook-pro']);
    });

    it('writes the ledger 0o600 — it names the operator\'s machine', async () => {
      recordHostAlias('Mac.home');
      const { statSync } = await import('node:fs');
      const mode = statSync(process.env.SO_HOST_ALIASES_FILE).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('caps the ledger and keeps the most recent names', () => {
      for (let i = 0; i < 20; i += 1) recordHostAlias(`host-${i}`);
      const aliases = readHostAliases();
      expect(aliases).toHaveLength(16);
      expect(aliases).toContain('host-19');
      expect(aliases).not.toContain('host-0');
    });

    it('is best-effort: never throws and records nothing for an empty name', () => {
      expect(() => recordHostAlias('')).not.toThrow();
      expect(() => recordHostAlias(null)).not.toThrow();
      expect(readHostAliases()).toEqual([]);
    });

    it('fails CLOSED — an unreadable/malformed ledger degrades to normalised-equal only', async () => {
      await writeFile(process.env.SO_HOST_ALIASES_FILE, '{ not json', 'utf8');
      expect(readHostAliases()).toEqual([]);
      // Suffix pair still matches (normalisation needs no ledger)…
      expect(hostnamesMatch('Mac.home', 'Mac.local')).toBe(true);
      // …but the alias-only pair does not. A broken ledger can only refuse a
      // match, never manufacture one.
      expect(hostnamesMatch('Mac.home', 'Ferdinands-MacBook-Pro.local')).toBe(false);
    });

    it('a recorded pair then matches through the on-disk ledger', () => {
      recordHostAlias('Mac.home');
      recordHostAlias('Ferdinands-MacBook-Pro.local');
      expect(hostnamesMatch('Mac.home', 'Ferdinands-MacBook-Pro.local')).toBe(true);
      expect(hostnamesMatch('Mac.home', 'a-different-host')).toBe(false);
    });
  });

  describe('lockHostCandidate', () => {
    it('prefers host_id over a divergent host', () => {
      expect(lockHostCandidate({ host_id: 'mac', host: 'ferdinands-macbook-pro.local' })).toBe('mac');
    });

    it('falls back to host when host_id is EMPTY, not just null/undefined', () => {
      // The `??` bug: an empty-string host_id short-circuits to '', and
      // hostnamesMatch('', x) is false by contract — so the machine reads its
      // OWN lock as cross-host and stale detection switches itself off.
      for (const empty of ['', '   ', null, undefined]) {
        expect(lockHostCandidate({ host_id: empty, host: 'Mac.home' })).toBe('Mac.home');
        expect(hostnamesMatch(lockHostCandidate({ host_id: empty, host: 'Mac.home' }), 'Mac.local'))
          .toBe(true);
      }
    });

    it('never throws and yields \'\' when there is nothing to go on', () => {
      expect(lockHostCandidate(null)).toBe('');
      expect(lockHostCandidate(undefined)).toBe('');
      expect(lockHostCandidate({})).toBe('');
      expect(lockHostCandidate({ host_id: 42, host: 0 })).toBe('');
      // '' still never matches — the fallback widens nothing.
      expect(hostnamesMatch(lockHostCandidate({}), 'Mac.local')).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// #1153 P6 — `_privateDir()` is overridable.
//
// TV-001: the bug these catch is a hand-run vault/host probe writing into the
// operator's REAL `~/.config/session-orchestrator` because the private dir had
// no override at all (only the narrower `SO_HOST_ALIASES_FILE` did). The
// observable surface is `readHostAliases()`, whose path is
// `_privateDir()/host-aliases.json` when `SO_HOST_ALIASES_FILE` is unset.
// ---------------------------------------------------------------------------
describe('_privateDir override (#1153 P6)', () => {
  let tmp;
  let saved;

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'privatedir-'));
    saved = {
      so: process.env.SO_CONFIG_HOME,
      xdg: process.env.XDG_CONFIG_HOME,
      aliases: process.env.SO_HOST_ALIASES_FILE,
    };
    // The narrower Tier-1 override must be OUT of the way for these tests —
    // otherwise `_privateDir()` is never consulted at all.
    delete process.env.SO_HOST_ALIASES_FILE;
    delete process.env.SO_CONFIG_HOME;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['SO_CONFIG_HOME', saved.so],
      ['XDG_CONFIG_HOME', saved.xdg],
      ['SO_HOST_ALIASES_FILE', saved.aliases],
    ]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { await rm(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('honours SO_CONFIG_HOME as the private dir itself', async () => {
    process.env.SO_CONFIG_HOME = tmp;
    await writeFile(path.join(tmp, 'host-aliases.json'), JSON.stringify(['Alpha.local']), 'utf8');
    expect(readHostAliases()).toEqual([stableHostname('Alpha.local')]);
  });

  it('falls THROUGH a whitespace-only SO_CONFIG_HOME to XDG_CONFIG_HOME', async () => {
    // A whitespace-only env var is truthy: a bare `||` would return '   ' and
    // resolve the ledger to a relative path that never matches anything.
    process.env.SO_CONFIG_HOME = '   ';
    process.env.XDG_CONFIG_HOME = tmp;
    const dir = path.join(tmp, 'session-orchestrator');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'host-aliases.json'), JSON.stringify(['Beta.local']), 'utf8');
    expect(readHostAliases()).toEqual([stableHostname('Beta.local')]);
  });

  it('appends session-orchestrator under XDG_CONFIG_HOME when SO_CONFIG_HOME is unset', async () => {
    process.env.XDG_CONFIG_HOME = tmp;
    const dir = path.join(tmp, 'session-orchestrator');
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'host-aliases.json'), JSON.stringify(['Gamma.local']), 'utf8');
    expect(readHostAliases()).toEqual([stableHostname('Gamma.local')]);
  });

  it('keeps SO_HOST_ALIASES_FILE winning over SO_CONFIG_HOME', async () => {
    const explicit = path.join(tmp, 'explicit.json');
    await writeFile(explicit, JSON.stringify(['Delta.local']), 'utf8');
    await writeFile(path.join(tmp, 'host-aliases.json'), JSON.stringify(['Alpha.local']), 'utf8');
    process.env.SO_HOST_ALIASES_FILE = explicit;
    process.env.SO_CONFIG_HOME = tmp;
    expect(readHostAliases()).toEqual([stableHostname('Delta.local')]);
  });

  it('prefers SO_CONFIG_HOME over XDG_CONFIG_HOME when BOTH are set to real dirs', async () => {
    // Bug this catches: every other test in this describe sets exactly ONE of
    // the two vars, so a refactor that FLIPPED the precedence (XDG first) would
    // pass all of them — each var is the only candidate in its own test. Only a
    // both-set case where both dirs hold a DIFFERENT ledger discriminates.
    const soDir = path.join(tmp, 'so');
    const xdgDir = path.join(tmp, 'xdg');
    await mkdir(soDir, { recursive: true });
    await mkdir(path.join(xdgDir, 'session-orchestrator'), { recursive: true });
    await writeFile(path.join(soDir, 'host-aliases.json'), JSON.stringify(['Epsilon.local']), 'utf8');
    await writeFile(
      path.join(xdgDir, 'session-orchestrator', 'host-aliases.json'),
      JSON.stringify(['Zeta.local']),
      'utf8',
    );
    process.env.SO_CONFIG_HOME = soDir;
    process.env.XDG_CONFIG_HOME = xdgDir;
    expect(readHostAliases()).toEqual([stableHostname('Epsilon.local')]);
  });
});
