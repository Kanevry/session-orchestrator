/**
 * lock-reaper-cli.test.mjs — tests for the scripts/lock-reaper.mjs CLI wrapper
 * (Epic #724 C7). Drives main() with DI'd deps + tmp fixtures; never touches the
 * real ~/Projects fleet (getCrossRepoProjects + confinement guard stubbed, host/
 * pid/event seams injected).
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main } from '../../scripts/lock-reaper.mjs';

const HOST = 'reaper-cli-host';
const tmpDirs = [];

function makeStartDir() {
  const d = mkdtempSync(join(tmpdir(), 'lock-reaper-cli-'));
  tmpDirs.push(d);
  return d;
}

function deadLock(host = HOST, sessionId = 'ghost') {
  const hb = new Date(Date.now() - 5 * 3600 * 1000).toISOString();
  return { session_id: sessionId, started_at: hb, last_heartbeat: hb, mode: 'deep', pid: 999999, host, ttl_hours: 4 };
}

function makeRepo(startDir, name, lock) {
  const repo = join(startDir, name);
  mkdirSync(join(repo, '.git'), { recursive: true });
  if (lock) {
    mkdirSync(join(repo, '.orchestrator'), { recursive: true });
    writeFileSync(join(repo, '.orchestrator', 'session.lock'), JSON.stringify(lock, null, 2) + '\n');
  }
  return repo;
}

const lockFileOf = (repo) => join(repo, '.orchestrator', 'session.lock');

function makeDeps({ pidAlive = false } = {}) {
  return {
    hostname: () => HOST,
    isPidAliveOnHost: () => pidAlive,
    emitEvent: vi.fn(async () => {}),
    enumerateDeps: {
      getCrossRepoProjects: async () => [],
      validatePathInsideProject: () => ({ ok: true }),
    },
  };
}

/** Run main() capturing stdout. Returns { code, stdout }. */
async function runMain(argv, { startDir, deps } = {}) {
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { chunks.push(String(chunk)); return true; };
  let code;
  try {
    code = await main({ argv, startDir, deps });
  } finally {
    process.stdout.write = origWrite;
  }
  return { code, stdout: chunks.join('') };
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('lock-reaper CLI', () => {
  it('defaults to dry-run (no --apply) and mutates nothing', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'dead', deadLock());

    const { code, stdout } = await runMain([], { startDir, deps: makeDeps() });

    expect(code).toBe(0);
    expect(stdout).toContain('Dry-run mode');
    expect(stdout).toContain('Scanned 1 repo');
    // Nothing removed.
    expect(existsSync(lockFileOf(repo))).toBe(true);
  });

  it('--apply archive-moves the dead lease', async () => {
    const startDir = makeStartDir();
    const repo = makeRepo(startDir, 'dead', deadLock());

    const { code, stdout } = await runMain(['--apply'], { startDir, deps: makeDeps() });

    expect(code).toBe(0);
    expect(stdout).toContain('Archived 1');
    expect(existsSync(lockFileOf(repo))).toBe(false);
  });

  it('--json emits the full result shape', async () => {
    const startDir = makeStartDir();
    makeRepo(startDir, 'dead', deadLock());

    const { code, stdout } = await runMain(['--json'], { startDir, deps: makeDeps() });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({ dryRun: true, ownHostOnly: true });
    expect(typeof parsed.scanned).toBe('number');
    expect(Array.isArray(parsed.candidates)).toBe(true);
    expect(Array.isArray(parsed.reaped)).toBe(true);
    expect(Array.isArray(parsed.skipped)).toBe(true);
    // Dead own-host lock → one candidate in dry-run.
    expect(parsed.candidates).toHaveLength(1);
  });

  it('--start-dir <path> overrides the scan root', async () => {
    const startDir = makeStartDir();
    makeRepo(startDir, 'dead', deadLock());

    // startDir supplied ONLY via the flag, not opts.
    const { code, stdout } = await runMain(['--start-dir', startDir, '--json'], { deps: makeDeps() });

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.scanned).toBe(1);
  });

  it('--help prints usage and exits 0', async () => {
    const { code, stdout } = await runMain(['--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('USAGE');
    expect(stdout).toContain('--apply');
  });

  it('rejects an unknown flag with exit code 1', async () => {
    const errChunks = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
    let code;
    try {
      code = await main({ argv: ['--bogus'] });
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).toBe(1);
    expect(errChunks.join('')).toContain('unknown argument');
  });

  it('rejects --apply and --dry-run together with exit code 1', async () => {
    const errChunks = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
    let code;
    try {
      code = await main({ argv: ['--apply', '--dry-run'] });
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).toBe(1);
    expect(errChunks.join('')).toContain('mutually exclusive');
  });

  it('--start-dir without a value errors with exit code 1', async () => {
    const errChunks = [];
    const origErr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (c) => { errChunks.push(String(c)); return true; };
    let code;
    try {
      code = await main({ argv: ['--start-dir'] });
    } finally {
      process.stderr.write = origErr;
    }
    expect(code).toBe(1);
    expect(errChunks.join('')).toContain('requires a path');
  });
});
