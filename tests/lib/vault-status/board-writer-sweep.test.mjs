/**
 * board-writer-sweep.test.mjs — coverage for buildSweepRepos + sweepBoard
 * (scripts/lib/vault-status/board-writer.mjs, issue #716).
 *
 * Split from board-writer.test.mjs (32 pre-existing tests untouched) so this
 * file can own the heavier real-fs sweep scaffolding without bloating the
 * original suite.
 *
 * Portability + isolation notes:
 *   - No hardcoded home paths (owner-leakage scanner). All paths are built
 *     from os.homedir()/os.tmpdir() calls, never literal `/Users/...` strings.
 *   - GOTCHA (macOS /var → /private/var symlink hop): enumerateCandidates'
 *     confinement guard (validatePathInsideProject) does a lexical check
 *     followed by a realpath check of the CHILD against the (non-canonicalized)
 *     ROOT. On macOS, os.tmpdir() lexically resolves under `/var/...` while a
 *     freshly-created child's realpath resolves under `/private/var/...` —
 *     the mismatch makes the guard silently DROP every candidate (0 found,
 *     no error). Building the confinement root from `realpathSync(tmpdir())`
 *     avoids the hop entirely. Confirmed empirically: a raw `mkdtempSync(join(
 *     tmpdir(), ...))` root yielded 0 candidates; a `realpathSync(tmpdir())`-based
 *     root yielded the expected candidate.
 *   - `mirrorBoard` (invoked inside `sweepBoard`) refuses to write unless the
 *     resolved vault-dir lives under `$HOME` (Epic #673 safety guard) — so the
 *     vault dir for every sweepBoard test MUST be created under os.homedir(),
 *     mirroring the precedent in tests/lib/gitlab-portfolio/cli.test.mjs
 *     (`path.join(os.homedir(), '_test-vault-...')`).
 *   - `mirrorBoard`'s Session Config read (`readConfigFile`) is a REAL disk
 *     read, not injectable — every "this repo" fixture needs a real CLAUDE.md
 *     on disk declaring `vault-integration: { enabled: true, vault-dir: ... }`.
 *   - `SO_VAULT_DIR` env resolves with HIGHEST precedence over the CLAUDE.md
 *     `vault-dir:` value (scripts/lib/config/host-paths.mjs) — left unset here
 *     so the CLAUDE.md fixture value is what actually resolves; explicitly
 *     saved/restored in afterEach in case the host or a parallel test left it set.
 *   - `SO_SESSION_REGISTRY_DIR` is pointed at an empty tmp dir per test so
 *     collectRows' readRegistry() fallback never leaks the host's real
 *     session registry into a test (same isolation as board-writer.test.mjs).
 *   - collectRows/isLockLive are NOT deps-injectable through sweepBoard — only
 *     enumerateCandidates' `deps` seam is. Real lock files on disk are
 *     therefore the only correct way to drive status derivation end-to-end.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  buildSweepRepos,
  sweepBoard,
  resolveBoardPath,
  renderBoard,
  writeBoard,
  parseBoardRows,
} from '../../../scripts/lib/vault-status/board-writer.mjs';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

/** Realpath-canonicalized tmp base — see the macOS symlink-hop gotcha above. */
const REAL_TMP_BASE = realpathSync(tmpdir());

const FIXED_NOW = new Date('2026-06-18T12:00:00.000Z');

let cleanupDirs;
let prevRegistryDir;
let prevVaultDirEnv;

beforeEach(() => {
  cleanupDirs = [];

  prevRegistryDir = process.env.SO_SESSION_REGISTRY_DIR;
  const emptyReg = mkdtempSync(join(tmpdir(), 'sweep-reg-'));
  cleanupDirs.push(emptyReg);
  process.env.SO_SESSION_REGISTRY_DIR = emptyReg;

  prevVaultDirEnv = process.env.SO_VAULT_DIR;
  delete process.env.SO_VAULT_DIR;
});

afterEach(() => {
  if (prevRegistryDir === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
  else process.env.SO_SESSION_REGISTRY_DIR = prevRegistryDir;

  if (prevVaultDirEnv === undefined) delete process.env.SO_VAULT_DIR;
  else process.env.SO_VAULT_DIR = prevVaultDirEnv;

  for (const dir of cleanupDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs = [];

  vi.restoreAllMocks();
});

/**
 * Fresh sandbox (realpath-clean, so it is safe to use as an enumerateCandidates
 * confinement root) + a sibling vault dir under $HOME. Both tracked for cleanup.
 */
function scaffold() {
  const sandbox = mkdtempSync(join(REAL_TMP_BASE, 'sweep-'));
  const vaultDir = mkdtempSync(join(homedir(), '.so-sweep-test-vault-'));
  const hostDir = join(sandbox, 'host');
  mkdirSync(hostDir, { recursive: true });
  cleanupDirs.push(sandbox, vaultDir);
  return { sandbox, hostDir, vaultDir };
}

/** Build a valid session.lock body. ageHours = how long ago the heartbeat was. */
function buildLockBody({ sessionId, mode = 'deep', ttlHours = 4, heartbeatAgeHours = 0, now, semanticSessionId }) {
  const nowMs = now instanceof Date ? now.getTime() : now;
  const hb = new Date(nowMs - heartbeatAgeHours * 3600 * 1000).toISOString();
  const lock = {
    session_id: sessionId,
    started_at: hb,
    last_heartbeat: hb,
    mode,
    pid: 999999,
    host: 'test-host',
    ttl_hours: ttlHours,
  };
  if (semanticSessionId) lock.semantic_session_id = semanticSessionId;
  return lock;
}

/**
 * Create a candidate repo under the confinement root: a `.git` marker (so
 * enumerateCandidates' isGitRepo check passes) plus an optional session.lock.
 */
function makeCandidateRepo(hostDir, name, lock) {
  const repoRoot = join(hostDir, name);
  mkdirSync(join(repoRoot, '.git'), { recursive: true });
  if (lock !== undefined && lock !== null) {
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, '.orchestrator', 'session.lock'), JSON.stringify(lock, null, 2) + '\n', 'utf8');
  }
  return repoRoot;
}

/**
 * Create the "calling repo" fixture: a real CLAUDE.md declaring vault-integration
 * enabled (pointing at vaultDir) plus an optional session.lock (its own lease).
 */
function makeThisRepo(sandbox, name, { vaultDir, lock }) {
  const repoRoot = join(sandbox, name);
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(
    join(repoRoot, 'CLAUDE.md'),
    `# Repo\n\n## Session Config\n\nvault-integration:\n  enabled: true\n  vault-dir: ${vaultDir}\n  mode: warn\n`,
  );
  if (lock !== undefined && lock !== null) {
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, '.orchestrator', 'session.lock'), JSON.stringify(lock, null, 2) + '\n', 'utf8');
  }
  return repoRoot;
}

/** deps override that keeps enumerateCandidates' secondary config source inert. */
const NO_CROSS_REPO_DEPS = { getCrossRepoProjects: async () => [] };

function readBoardRows(vaultDir) {
  const boardPath = resolveBoardPath(vaultDir);
  const content = readFileSync(boardPath, 'utf8');
  return parseBoardRows(content);
}

// ===========================================================================
// buildSweepRepos (pure)
// ===========================================================================

describe('buildSweepRepos', () => {
  it('returns only thisRepoRoot when candidates is empty', () => {
    const result = buildSweepRepos([], { thisRepoRoot: '/repos/this-repo' });
    expect(result).toEqual([{ repoRoot: '/repos/this-repo' }]);
  });

  it('returns only thisRepoRoot when every candidate is free', () => {
    const candidates = [
      { repoRoot: '/repos/a', free: true },
      { repoRoot: '/repos/b', free: true },
    ];
    const result = buildSweepRepos(candidates, { thisRepoRoot: '/repos/this-repo' });
    expect(result).toEqual([{ repoRoot: '/repos/this-repo' }]);
  });

  it('keeps busy candidates and unions thisRepoRoot for a mixed free/busy list', () => {
    const candidates = [
      { repoRoot: '/repos/free-a', free: true },
      { repoRoot: '/repos/busy-b', free: false },
      { repoRoot: '/repos/busy-c', free: false },
    ];
    const result = buildSweepRepos(candidates, { thisRepoRoot: '/repos/this-repo' });
    expect(result).toEqual([
      { repoRoot: '/repos/busy-b' },
      { repoRoot: '/repos/busy-c' },
      { repoRoot: '/repos/this-repo' },
    ]);
  });

  it('does not duplicate thisRepoRoot when it is already among the busy candidates', () => {
    const candidates = [{ repoRoot: '/repos/this-repo', free: false }];
    const result = buildSweepRepos(candidates, { thisRepoRoot: '/repos/this-repo' });
    expect(result).toEqual([{ repoRoot: '/repos/this-repo' }]);
  });

  it('dedupes a non-canonical thisRepoRoot (trailing slash) against the resolved candidate path', () => {
    const candidates = [{ repoRoot: '/repos/this-repo', free: false }];
    const result = buildSweepRepos(candidates, { thisRepoRoot: '/repos/this-repo/' });
    expect(result).toEqual([{ repoRoot: '/repos/this-repo' }]);
  });

  it('tolerates malformed candidate entries (null, missing repoRoot) without throwing', () => {
    const candidates = [null, { free: false }, { foo: 'bar', free: false }, undefined, { repoRoot: '/repos/good', free: false }];

    expect(() => buildSweepRepos(candidates, {})).not.toThrow();
    const result = buildSweepRepos(candidates, {});
    expect(result).toEqual([{ repoRoot: '/repos/good' }]);
  });
});

// ===========================================================================
// sweepBoard — happy path (headline #716 case)
// ===========================================================================

describe('sweepBoard happy path', () => {
  it('renders a foreign repo with a dead lease as force-closed (headline #716 case)', async () => {
    const { hostDir, vaultDir, sandbox } = scaffold();
    const deadLock = buildLockBody({ sessionId: 'dead-sess', ttlHours: 4, heartbeatAgeHours: 5, now: FIXED_NOW });
    makeCandidateRepo(hostDir, 'foreign-dead-repo', deadLock);
    const thisRepoRoot = makeThisRepo(sandbox, 'this-repo', {
      vaultDir,
      lock: buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW }),
    });

    const result = await sweepBoard({
      repoRoot: thisRepoRoot,
      startDir: hostDir,
      now: FIXED_NOW,
      deps: NO_CROSS_REPO_DEPS,
    });

    expect(result.action).toBe('written');
    const rows = readBoardRows(vaultDir);
    const deadRow = rows.find((r) => r.repo === 'foreign-dead-repo');
    expect(deadRow).toEqual({
      repo: 'foreign-dead-repo',
      status: 'force-closed',
      session: 'dead-sess',
      branch: null,
      mode: 'deep',
      heartbeat: '2026-06-18T07:00:00.000Z',
    });
  });

  it('renders a foreign repo with a live lease as in-progress', async () => {
    const { hostDir, vaultDir, sandbox } = scaffold();
    const liveLock = buildLockBody({ sessionId: 'live-sess', ttlHours: 4, heartbeatAgeHours: 0, now: FIXED_NOW });
    makeCandidateRepo(hostDir, 'foreign-live-repo', liveLock);
    const thisRepoRoot = makeThisRepo(sandbox, 'this-repo', {
      vaultDir,
      lock: buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW }),
    });

    await sweepBoard({ repoRoot: thisRepoRoot, startDir: hostDir, now: FIXED_NOW, deps: NO_CROSS_REPO_DEPS });

    const rows = readBoardRows(vaultDir);
    const liveRow = rows.find((r) => r.repo === 'foreign-live-repo');
    expect(liveRow).toEqual({
      repo: 'foreign-live-repo',
      status: 'in-progress',
      session: 'live-sess',
      branch: null,
      mode: 'deep',
      heartbeat: '2026-06-18T12:00:00.000Z',
    });
  });

  it("derives THIS repo's own row from its own live lease", async () => {
    const { hostDir, vaultDir, sandbox } = scaffold();
    const thisRepoRoot = makeThisRepo(sandbox, 'this-repo', {
      vaultDir,
      lock: buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW }),
    });

    await sweepBoard({ repoRoot: thisRepoRoot, startDir: hostDir, now: FIXED_NOW, deps: NO_CROSS_REPO_DEPS });

    const rows = readBoardRows(vaultDir);
    const thisRow = rows.find((r) => r.repo === 'this-repo');
    expect(thisRow).toEqual({
      repo: 'this-repo',
      status: 'in-progress',
      session: 'this-sess',
      branch: null,
      mode: 'deep',
      heartbeat: '2026-06-18T12:00:00.000Z',
    });
  });

  it('excludes a free (lock-less) foreign candidate — no row rendered without a prior', async () => {
    const { hostDir, vaultDir, sandbox } = scaffold();
    makeCandidateRepo(hostDir, 'foreign-free-repo', null);
    const thisRepoRoot = makeThisRepo(sandbox, 'this-repo', {
      vaultDir,
      lock: buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW }),
    });

    await sweepBoard({ repoRoot: thisRepoRoot, startDir: hostDir, now: FIXED_NOW, deps: NO_CROSS_REPO_DEPS });

    const rows = readBoardRows(vaultDir);
    expect(rows.find((r) => r.repo === 'foreign-free-repo')).toBeUndefined();
  });

  it('writes to _active-sessions.md, never _overview.md (regression)', async () => {
    const { hostDir, vaultDir, sandbox } = scaffold();
    const thisRepoRoot = makeThisRepo(sandbox, 'this-repo', {
      vaultDir,
      lock: buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW }),
    });

    const result = await sweepBoard({ repoRoot: thisRepoRoot, startDir: hostDir, now: FIXED_NOW, deps: NO_CROSS_REPO_DEPS });

    expect(result.path.endsWith('_active-sessions.md')).toBe(true);
    expect(result.path.endsWith('_overview.md')).toBe(false);
  });
});

// ===========================================================================
// sweepBoard — idempotent merge: frei exclusion preserves prior rows
// ===========================================================================

describe('sweepBoard idempotent merge — frei exclusion', () => {
  it('excludes a free candidate from re-derivation and preserves its prior board row unchanged', async () => {
    const { hostDir, vaultDir, sandbox } = scaffold();
    makeCandidateRepo(hostDir, 'frei-repo', null);
    const thisRepoRoot = makeThisRepo(sandbox, 'this-repo', {
      vaultDir,
      lock: buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW }),
    });

    // Seed a PRIOR generator-owned board row for frei-repo, written BEFORE the sweep.
    const boardPath = resolveBoardPath(vaultDir);
    const priorContent = renderBoard(
      [{ repo: 'frei-repo', status: 'closed', session: 'old-sess', branch: 'old-branch', mode: 'housekeeping', heartbeat: 'old-hb' }],
      { now: new Date('2020-01-01T00:00:00.000Z') },
    );
    const seedResult = writeBoard({ outputPath: boardPath, content: priorContent });
    // Sanity: the seed itself actually wrote (otherwise the "preserved unchanged"
    // assertion below would pass trivially against an empty board).
    expect(seedResult.action).toBe('written');

    const result = await sweepBoard({
      repoRoot: thisRepoRoot,
      startDir: hostDir,
      now: FIXED_NOW,
      deps: NO_CROSS_REPO_DEPS,
    });

    expect(result.action).toBe('written');
    const rows = readBoardRows(vaultDir);
    const freiRow = rows.find((r) => r.repo === 'frei-repo');
    expect(freiRow).toEqual({
      repo: 'frei-repo',
      status: 'closed',
      session: 'old-sess',
      branch: 'old-branch',
      mode: 'housekeeping',
      heartbeat: 'old-hb',
    });
  });
});

// ===========================================================================
// sweepBoard — enumeration-failure fallback (single-repo degrade)
// ===========================================================================

describe('sweepBoard enumeration-failure fallback', () => {
  it('degrades to a single-repo board write and logs a console.warn when enumeration throws', async () => {
    const { hostDir, vaultDir, sandbox } = scaffold();
    // A real candidate exists in hostDir — proves the fallback discards the
    // enumeration attempt entirely rather than partially using it.
    makeCandidateRepo(hostDir, 'some-repo', null);
    const thisRepoRoot = makeThisRepo(sandbox, 'this-repo', {
      vaultDir,
      lock: buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW }),
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await sweepBoard({
      repoRoot: thisRepoRoot,
      startDir: hostDir,
      now: FIXED_NOW,
      deps: {
        getCrossRepoProjects: async () => [],
        readLock: () => {
          throw new Error('boom-read-lock');
        },
      },
    });

    expect(result.action).toBe('written');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toBe(
      '[sweepBoard] host-wide enumeration failed — degraded to single-repo board write:',
    );

    const rows = readBoardRows(vaultDir);
    expect(rows).toEqual([
      {
        repo: 'this-repo',
        status: 'in-progress',
        session: 'this-sess',
        branch: null,
        mode: 'deep',
        heartbeat: '2026-06-18T12:00:00.000Z',
      },
    ]);
  });
});

// ===========================================================================
// sweepBoard — numeric `now` (epoch-ms) determinism
// ===========================================================================

describe('sweepBoard numeric now clock seam', () => {
  it('accepts a finite epoch-ms number and stamps updated:/created: deterministically (not wall-clock)', async () => {
    const { hostDir, vaultDir, sandbox } = scaffold();
    const thisRepoRoot = makeThisRepo(sandbox, 'this-repo', {
      vaultDir,
      lock: buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW }),
    });

    const result = await sweepBoard({
      repoRoot: thisRepoRoot,
      startDir: hostDir,
      now: FIXED_NOW.getTime(),
      deps: NO_CROSS_REPO_DEPS,
    });

    expect(result.action).toBe('written');
    const content = readFileSync(result.path, 'utf8');
    expect(content).toContain('updated: 2026-06-18T12:00:00.000Z');
    expect(content).toContain('created: 2026-06-18T12:00:00.000Z');
  });
});
