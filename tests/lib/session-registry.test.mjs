import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, readdir, stat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  registryBaseDir,
  activeDir,
  sweepLogPath,
  repoPathHash,
  registerSelf,
  heartbeat,
  readRegistry,
  detectPeers,
  sweepZombies,
  deregisterSelf,
  logSweepEvent,
} from '../../scripts/lib/session-registry.mjs';

describe('session-registry', () => {
  let tmpBase;
  let origEnv;

  beforeEach(async () => {
    tmpBase = await mkdtemp(path.join(os.tmpdir(), 'session-registry-test-'));
    origEnv = process.env.SO_SESSION_REGISTRY_DIR;
    process.env.SO_SESSION_REGISTRY_DIR = tmpBase;
  });

  afterEach(async () => {
    if (origEnv === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
    else process.env.SO_SESSION_REGISTRY_DIR = origEnv;
    try { await rm(tmpBase, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  describe('paths', () => {
    it('honours SO_SESSION_REGISTRY_DIR override', () => {
      expect(registryBaseDir()).toBe(tmpBase);
      expect(activeDir()).toBe(path.join(tmpBase, 'active'));
      expect(sweepLogPath()).toBe(path.join(tmpBase, 'sweep.log'));
    });

    it('falls back to ~/.config when env var unset', () => {
      delete process.env.SO_SESSION_REGISTRY_DIR;
      expect(registryBaseDir()).toBe(path.join(os.homedir(), '.config', 'session-orchestrator', 'sessions'));
    });
  });

  describe('repoPathHash', () => {
    it('produces a stable sha256 hex for the same absolute path', () => {
      const a = repoPathHash('/tmp/proj');
      const b = repoPathHash('/tmp/proj');
      expect(a).toBe(b);
      expect(a).toMatch(/^[a-f0-9]{64}$/);
    });

    it('normalises relative and absolute equivalents of the cwd', () => {
      const abs = repoPathHash(process.cwd());
      const rel = repoPathHash('.');
      expect(abs).toBe(rel);
    });

    it('produces different hashes for different paths', () => {
      expect(repoPathHash('/tmp/a')).not.toBe(repoPathHash('/tmp/b'));
    });

    it('rejects empty input', () => {
      expect(() => repoPathHash('')).toThrow(TypeError);
    });
  });

  describe('registerSelf', () => {
    it('writes a valid heartbeat file that can be round-tripped', async () => {
      const entry = await registerSelf({
        sessionId: 'abc',
        projectRoot: '/tmp/proj',
        branch: 'main',
        platform: 'claude',
        hostClass: 'macos-arm64-m3pro',
        currentWave: 1,
      });
      expect(entry.session_id).toBe('abc');
      expect(entry.pid).toBe(process.pid);
      expect(entry.platform).toBe('claude');
      expect(entry.repo_name).toBe('proj');
      expect(entry.repo_path_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(entry.branch).toBe('main');
      expect(entry.host_class).toBe('macos-arm64-m3pro');
      expect(entry.status).toBe('active');
      expect(entry.current_wave).toBe(1);

      const onDisk = JSON.parse(await readFile(path.join(tmpBase, 'active', 'abc.json'), 'utf8'));
      expect(onDisk).toEqual(entry);
    });

    it('writes with 0o600 permissions on POSIX', async () => {
      if (process.platform === 'win32') return;
      await registerSelf({ sessionId: 'perms', projectRoot: '/tmp/proj' });
      const s = await stat(path.join(tmpBase, 'active', 'perms.json'));
      expect(s.mode & 0o777).toBe(0o600);
    });

    it('rejects session ids with path separators', async () => {
      await expect(registerSelf({ sessionId: '../escape', projectRoot: '/tmp/proj' }))
        .rejects.toThrow(TypeError);
      await expect(registerSelf({ sessionId: 'a/b', projectRoot: '/tmp/proj' }))
        .rejects.toThrow(TypeError);
    });

    it('leaves no temp files behind after a successful write', async () => {
      await registerSelf({ sessionId: 'clean', projectRoot: '/tmp/proj' });
      const names = await readdir(path.join(tmpBase, 'active'));
      expect(names.every((n) => !n.includes('.tmp-'))).toBe(true);
    });

    it('supports two concurrent sessions producing two distinct files', async () => {
      await Promise.all([
        registerSelf({ sessionId: 'session-one', projectRoot: '/tmp/proj-1', branch: 'a' }),
        registerSelf({ sessionId: 'session-two', projectRoot: '/tmp/proj-2', branch: 'b' }),
      ]);
      const entries = await readRegistry();
      expect(entries.map((e) => e.session_id).sort()).toEqual(['session-one', 'session-two']);
    });
  });

  describe('heartbeat', () => {
    it('refreshes last_heartbeat and leaves other fields intact', async () => {
      const initial = await registerSelf({ sessionId: 'hb', projectRoot: '/tmp/proj' });
      await new Promise((r) => setTimeout(r, 5));
      const updated = await heartbeat('hb');
      expect(updated.last_heartbeat).not.toBe(initial.last_heartbeat);
      expect(Date.parse(updated.last_heartbeat)).toBeGreaterThanOrEqual(Date.parse(initial.last_heartbeat));
      expect(updated.session_id).toBe(initial.session_id);
      expect(updated.started_at).toBe(initial.started_at);
    });

    it('applies status + currentWave patches', async () => {
      await registerSelf({ sessionId: 'hb2', projectRoot: '/tmp/proj' });
      const updated = await heartbeat('hb2', { status: 'wave', currentWave: 3 });
      expect(updated.status).toBe('wave');
      expect(updated.current_wave).toBe(3);
    });

    it('returns null when the entry does not exist', async () => {
      expect(await heartbeat('missing')).toBeNull();
    });
  });

  describe('readRegistry', () => {
    it('returns [] when the active dir does not exist yet', async () => {
      expect(await readRegistry()).toEqual([]);
    });

    it('skips non-JSON files and malformed entries', async () => {
      await registerSelf({ sessionId: 'good', projectRoot: '/tmp/proj' });
      await mkdir(path.join(tmpBase, 'active'), { recursive: true });
      await writeFile(path.join(tmpBase, 'active', 'readme.txt'), 'ignore me');
      await writeFile(path.join(tmpBase, 'active', 'malformed.json'), '{not json');
      const entries = await readRegistry();
      expect(entries).toHaveLength(1);
      expect(entries[0].session_id).toBe('good');
    });
  });

  describe('detectPeers', () => {
    it('filters out self and stale entries', async () => {
      await registerSelf({ sessionId: 'self', projectRoot: '/tmp/proj-self' });
      await registerSelf({ sessionId: 'live-peer', projectRoot: '/tmp/proj-peer' });
      // Age a peer past the 15-min freshness window by rewriting its file.
      await registerSelf({ sessionId: 'stale', projectRoot: '/tmp/proj-stale' });
      const stalePath = path.join(tmpBase, 'active', 'stale.json');
      const stale = JSON.parse(await readFile(stalePath, 'utf8'));
      const oldTs = new Date(Date.now() - 30 * 60_000).toISOString();
      stale.last_heartbeat = oldTs;
      stale.started_at = oldTs;
      await writeFile(stalePath, JSON.stringify(stale, null, 2) + '\n');

      const peers = await detectPeers({ sessionId: 'self' });
      expect(peers.map((p) => p.session_id)).toEqual(['live-peer']);
    });

    it('returns all fresh peers when sessionId is omitted', async () => {
      await registerSelf({ sessionId: 'a', projectRoot: '/tmp/a' });
      await registerSelf({ sessionId: 'b', projectRoot: '/tmp/b' });
      const peers = await detectPeers();
      expect(peers.map((p) => p.session_id).sort()).toEqual(['a', 'b']);
    });
  });

  describe('sweepZombies', () => {
    it('removes entries older than threshold and keeps fresh ones', async () => {
      await registerSelf({ sessionId: 'fresh', projectRoot: '/tmp/a' });
      await registerSelf({ sessionId: 'old', projectRoot: '/tmp/b' });
      const oldPath = path.join(tmpBase, 'active', 'old.json');
      const oldEntry = JSON.parse(await readFile(oldPath, 'utf8'));
      const t = new Date(Date.now() - 120 * 60_000).toISOString();
      oldEntry.last_heartbeat = t;
      oldEntry.started_at = t;
      await writeFile(oldPath, JSON.stringify(oldEntry, null, 2) + '\n');

      const res = await sweepZombies({ thresholdMin: 60 });
      expect(res.removed).toEqual(['old.json']);
      expect(res.logged).toBe(1);

      const remaining = await readdir(path.join(tmpBase, 'active'));
      expect(remaining).toEqual(['fresh.json']);

      const log = await readFile(sweepLogPath(), 'utf8');
      const line = JSON.parse(log.trim().split('\n').pop());
      expect(line.session_id).toBe('old');
      expect(line.reason).toBe('stale-heartbeat');
      expect(line.age_minutes).toBeGreaterThanOrEqual(120);
    });

    it('removes malformed entries and logs reason malformed-entry', async () => {
      await mkdir(path.join(tmpBase, 'active'), { recursive: true });
      await writeFile(path.join(tmpBase, 'active', 'bad.json'), '{oops');
      const res = await sweepZombies({ thresholdMin: 60 });
      expect(res.removed).toEqual(['bad.json']);
      const log = await readFile(sweepLogPath(), 'utf8');
      const line = JSON.parse(log.trim());
      expect(line.reason).toBe('malformed-entry');
      expect(line.session_id).toBeNull();
    });

    it('returns empty result when registry dir does not exist', async () => {
      const res = await sweepZombies();
      expect(res).toEqual({ removed: [], logged: 0 });
    });
  });

  describe('deregisterSelf', () => {
    it('removes the file and returns true', async () => {
      await registerSelf({ sessionId: 'dead', projectRoot: '/tmp/proj' });
      expect(await deregisterSelf('dead')).toBe(true);
      const names = await readdir(path.join(tmpBase, 'active'));
      expect(names).toEqual([]);
    });

    it('is idempotent — returns false when file is missing', async () => {
      expect(await deregisterSelf('never-existed')).toBe(false);
    });

    it('rejects invalid session ids', async () => {
      await expect(deregisterSelf('')).rejects.toThrow(TypeError);
      await expect(deregisterSelf('../bad')).rejects.toThrow(TypeError);
    });
  });

  describe('logSweepEvent', () => {
    it('appends a valid JSONL line to sweep.log', async () => {
      logSweepEvent({ event: 'register-failed', session_id: 'sess-001', error: 'EACCES: permission denied' });
      const content = await readFile(sweepLogPath(), 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const entry = JSON.parse(lines[lines.length - 1]);
      expect(entry.event).toBe('register-failed');
      expect(entry.session_id).toBe('sess-001');
      expect(entry.error).toBe('EACCES: permission denied');
      expect(entry.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });

    it('writes a deregister-failed event', async () => {
      logSweepEvent({ event: 'deregister-failed', session_id: 'sess-002', error: 'EPERM: operation not permitted' });
      const content = await readFile(sweepLogPath(), 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entry = JSON.parse(lines[lines.length - 1]);
      expect(entry.event).toBe('deregister-failed');
      expect(entry.session_id).toBe('sess-002');
      expect(entry.error).toBe('EPERM: operation not permitted');
    });

    it('serialises null session_id correctly', async () => {
      logSweepEvent({ event: 'register-failed', session_id: null, error: 'test' });
      const content = await readFile(sweepLogPath(), 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      const entry = JSON.parse(lines[lines.length - 1]);
      expect(entry.session_id).toBeNull();
    });

    it('is non-throwing even when the log path is unwritable', () => {
      if (process.platform === 'win32') return;
      const origEnvVal = process.env.SO_SESSION_REGISTRY_DIR;
      // /proc/nonexistent-so-test-dir cannot be created — mkdir will fail,
      // appendFileSync will also fail, but logSweepEvent must swallow both.
      process.env.SO_SESSION_REGISTRY_DIR = '/proc/nonexistent-so-test-dir';
      try {
        expect(() => {
          logSweepEvent({ event: 'register-failed', session_id: 'x', error: 'boom' });
        }).not.toThrow();
      } finally {
        if (origEnvVal === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
        else process.env.SO_SESSION_REGISTRY_DIR = origEnvVal;
      }
    });

    it('accumulates multiple entries in order', async () => {
      logSweepEvent({ event: 'register-failed', session_id: 'a', error: 'first' });
      logSweepEvent({ event: 'deregister-failed', session_id: 'b', error: 'second' });
      const content = await readFile(sweepLogPath(), 'utf8');
      const lines = content.trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(2);
      const last2 = lines.slice(-2).map((l) => JSON.parse(l));
      expect(last2[0].session_id).toBe('a');
      expect(last2[1].session_id).toBe('b');
    });
  });
});
