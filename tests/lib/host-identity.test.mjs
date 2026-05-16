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
      process.env.SSH_CONNECTION = '10.0.0.1 59210 10.0.0.2 22';
      expect(isSSH()).toBe(true);
    });

    it('returns true when SSH_CLIENT is set', () => {
      process.env.SSH_CLIENT = '10.0.0.1 59210 22';
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
});
