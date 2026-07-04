/**
 * board-writer.test.mjs — coverage for scripts/lib/vault-status/board-writer.mjs
 * (Epic #673 #674). Vault live-status board: render + idempotent write + status
 * derivation from session.lock + host registry.
 *
 * Portable: all temp state under os.tmpdir() via mkdtempSync; no hardcoded home
 * paths (the CI owner-leakage scanner blocks those). The module is imported by
 * relative path (tests/lib/vault-status → repo root is 3 levels up).
 *
 * Registry isolation: collectRows() falls back to readRegistry() (default host
 * path) when no explicit `registry` array is passed. We point
 * SO_SESSION_REGISTRY_DIR at an empty tmp dir so that fallback yields [] and the
 * host's real registry never leaks into a test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';

import {
  GENERATOR_MARKER,
  resolveBoardPath,
  collectRows,
  renderBoard,
  normalizeUpdated,
  parseBoardRows,
  writeBoard,
  mirrorBoard,
} from '../../../scripts/lib/vault-status/board-writer.mjs';

import { repoPathHash } from '../../../scripts/lib/session-registry.mjs';
import { parseFrontmatter } from '../../../scripts/lib/vault-mirror/utils.mjs';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

let sandbox;
let prevRegistryDir;
// mirrorBoard's Session Config read (readConfigFile) is a REAL disk read, not
// injectable, and its vault-dir safety guard requires the resolved vault dir
// to live under $HOME — so the foldKey/mirrorBoard tests below need vault
// dirs created under os.homedir(), tracked here for cleanup alongside sandbox
// (mirrors the precedent in board-writer-sweep.test.mjs).
let extraCleanupDirs;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'board-writer-test-'));
  extraCleanupDirs = [];
  // Isolate the host session registry: point the default registry dir at an
  // empty tmp dir so readRegistry() inside collectRows() returns [].
  prevRegistryDir = process.env.SO_SESSION_REGISTRY_DIR;
  const emptyReg = mkdtempSync(join(tmpdir(), 'board-writer-reg-'));
  process.env.SO_SESSION_REGISTRY_DIR = emptyReg;
});

afterEach(() => {
  if (prevRegistryDir === undefined) delete process.env.SO_SESSION_REGISTRY_DIR;
  else process.env.SO_SESSION_REGISTRY_DIR = prevRegistryDir;
  rmSync(sandbox, { recursive: true, force: true });
  for (const d of extraCleanupDirs) {
    rmSync(d, { recursive: true, force: true });
  }
  extraCleanupDirs = [];
});

/** Create a temp repo dir with an optional crafted session.lock. */
function makeRepo(name, lock) {
  const repoRoot = join(sandbox, name);
  mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
  if (lock !== undefined && lock !== null) {
    writeFileSync(
      join(repoRoot, '.orchestrator', 'session.lock'),
      JSON.stringify(lock, null, 2) + '\n',
      'utf8',
    );
  }
  return repoRoot;
}

/** A non-existent repo path inside the sandbox (readLock → null). */
function ghostRepo(name) {
  return join(sandbox, name);
}

/** Build a valid session.lock body. ageHours = how long ago the heartbeat was. */
function buildLockBody({ sessionId, mode = 'deep', ttlHours = 4, heartbeatAgeHours = 0, now, semanticSessionId }) {
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
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

/** Build a registry entry matching a repoRoot (branch lives only here). */
function buildRegistryEntry({ repoRoot, branch, sessionId = 'reg-session', mode = 'feature', heartbeatAgeMin = 0, now }) {
  const nowMs = now instanceof Date ? now.getTime() : Date.now();
  const hb = new Date(nowMs - heartbeatAgeMin * 60_000).toISOString();
  return {
    session_id: sessionId,
    repo_path_hash: repoPathHash(repoRoot),
    branch,
    mode,
    started_at: hb,
    last_heartbeat: hb,
  };
}

const FIXED_NOW = new Date('2026-06-18T12:00:00.000Z');

/**
 * A fresh vault dir under $HOME (mirrorBoard's safety guard requires this),
 * tracked in `extraCleanupDirs` for teardown.
 */
function makeVaultDir() {
  const d = mkdtempSync(join(homedir(), '.so-board-writer-fold-test-'));
  extraCleanupDirs.push(d);
  return d;
}

/**
 * Create the "calling repo" fixture mirrorBoard needs: a real CLAUDE.md
 * declaring vault-integration enabled, pointing at vaultDir. Mirrors the
 * precedent in board-writer-sweep.test.mjs `makeThisRepo`.
 */
function makeThisRepoConfig(name, vaultDir) {
  const repoRoot = join(sandbox, name);
  mkdirSync(repoRoot, { recursive: true });
  writeFileSync(
    join(repoRoot, 'CLAUDE.md'),
    `# Repo\n\n## Session Config\n\nvault-integration:\n  enabled: true\n  vault-dir: ${vaultDir}\n  mode: warn\n`,
  );
  return repoRoot;
}

/**
 * Hand-build a generator-owned board file with EXACT row order (renderBoard
 * always re-sorts alphabetically, which would defeat tests that need to prove
 * a result is independent of file order — see the #719 heartbeat-preference
 * tests below).
 */
function buildPriorBoardContent(rows, { now = FIXED_NOW } = {}) {
  const nowIso = now.toISOString();
  const lines = [
    '---',
    `_generator: ${GENERATOR_MARKER}`,
    'type: board',
    `created: ${nowIso}`,
    `updated: ${nowIso}`,
    '---',
    '',
    '# Active Sessions',
    '',
    '> Live session-status board. Generator-owned — do not hand-edit.',
    '',
    '| Repo | Status | Session | Branch | Mode | Last heartbeat |',
    '|---|---|---|---|---|---|',
    ...rows.map(
      (r) =>
        `| ${r.repo} | ${r.status} | ${r.session ?? '—'} | ${r.branch ?? '—'} | ${r.mode ?? '—'} | ${r.heartbeat ?? '—'} |`,
    ),
    '',
  ];
  return lines.join('\n');
}

/** In-memory fs stub for writeBoard/mirrorBoard. Seed with { path: content }. */
function makeFsStub(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { writeFileSync: [], mkdirSync: [], existsSync: [], readFileSync: [] };
  return {
    store,
    calls,
    fs: {
      existsSync(p) {
        calls.existsSync.push(p);
        return store.has(p);
      },
      readFileSync(p) {
        calls.readFileSync.push(p);
        if (!store.has(p)) {
          const err = new Error(`ENOENT: ${p}`);
          err.code = 'ENOENT';
          throw err;
        }
        return store.get(p);
      },
      writeFileSync(p, content) {
        calls.writeFileSync.push({ path: p, content });
        store.set(p, content);
      },
      mkdirSync(p) {
        calls.mkdirSync.push(p);
      },
    },
  };
}

// ===========================================================================
// resolveBoardPath
// ===========================================================================

describe('resolveBoardPath', () => {
  it('appends 01-projects/_active-sessions.md to the vault dir', () => {
    expect(resolveBoardPath('/srv/vault')).toBe('/srv/vault/01-projects/_active-sessions.md');
  });
});

// ===========================================================================
// renderBoard (pure)
// ===========================================================================

describe('renderBoard', () => {
  it('emits the _generator frontmatter sentinel', () => {
    const out = renderBoard([], { now: FIXED_NOW });
    expect(out).toContain(`_generator: ${GENERATOR_MARKER}`);
  });

  it('emits schema-valid active-sessions board frontmatter', () => {
    const out = renderBoard([], { now: FIXED_NOW });
    const frontmatter = parseFrontmatter(out);

    expect(frontmatter).toMatchObject({
      _generator: GENERATOR_MARKER,
      id: 'active-sessions',
      type: 'board',
      created: FIXED_NOW.toISOString(),
      updated: FIXED_NOW.toISOString(),
    });
  });

  it('renders a markdown table header', () => {
    const out = renderBoard([{ repo: 'alpha', status: 'in-progress' }], { now: FIXED_NOW });
    expect(out).toContain('| Repo | Status | Session | Branch | Mode | Last heartbeat |');
    expect(out).toContain('|---|---|---|---|---|---|');
  });

  it('sorts rows alphabetically by repo (b after a)', () => {
    const out = renderBoard(
      [
        { repo: 'bravo', status: 'frei' },
        { repo: 'alpha', status: 'frei' },
      ],
      { now: FIXED_NOW },
    );
    const idxAlpha = out.indexOf('| alpha |');
    const idxBravo = out.indexOf('| bravo |');
    expect(idxAlpha).toBeGreaterThan(-1);
    expect(idxBravo).toBeGreaterThan(idxAlpha);
  });

  it('renders a frei row with placeholders and no session id', () => {
    const out = renderBoard(
      [{ repo: 'idle-repo', status: 'frei', session: null, branch: null, mode: null, heartbeat: null }],
      { now: FIXED_NOW },
    );
    // The row exists...
    expect(out).toContain('| idle-repo | frei |');
    // ...and carries the '—' placeholder for every empty cell, no session id.
    expect(out).toContain('| idle-repo | frei | — | — | — | — |');
  });

  it('escapes a pipe in a cell so it cannot break the table', () => {
    const out = renderBoard(
      [{ repo: 'r', status: 'in-progress', branch: 'feat|x', session: 's', mode: 'm', heartbeat: 'h' }],
      { now: FIXED_NOW },
    );
    expect(out).toContain('feat\\|x');
  });

  it('uses the updatedPlaceholder for the updated: line when supplied', () => {
    const out = renderBoard([], { now: FIXED_NOW, updatedPlaceholder: 'PLACE' });
    expect(out).toContain('updated: PLACE');
  });
});

// ===========================================================================
// writeBoard (idempotent + safety)
// ===========================================================================

describe('writeBoard', () => {
  it('fresh write (no existing file) returns written and calls writeFileSync', () => {
    const { fs, calls } = makeFsStub();
    const outputPath = '/vault/01-projects/_active-sessions.md';
    const content = renderBoard([{ repo: 'a', status: 'frei' }], { now: FIXED_NOW });

    const result = writeBoard({ outputPath, content, fs });

    expect(result).toEqual({ action: 'written', path: outputPath });
    expect(calls.writeFileSync).toHaveLength(1);
    expect(calls.writeFileSync[0]).toEqual({ path: outputPath, content });
  });

  it('existing file WITHOUT _generator → skipped-handwritten, no write', () => {
    const outputPath = '/vault/01-projects/_active-sessions.md';
    const handwritten = '---\ntype: board\nupdated: x\n---\n\n# My notes\n';
    const { fs, calls } = makeFsStub({ [outputPath]: handwritten });

    const result = writeBoard({ outputPath, content: 'new', fs });

    expect(result).toEqual({ action: 'skipped-handwritten', path: outputPath });
    expect(calls.writeFileSync).toHaveLength(0);
  });

  it('existing file with a FOREIGN _generator value → skipped-handwritten', () => {
    const outputPath = '/vault/01-projects/_active-sessions.md';
    const foreign = '---\n_generator: some-other-tool@9\nupdated: x\n---\n\nbody\n';
    const { fs, calls } = makeFsStub({ [outputPath]: foreign });

    const result = writeBoard({ outputPath, content: 'new', fs });

    expect(result).toEqual({ action: 'skipped-handwritten', path: outputPath });
    expect(calls.writeFileSync).toHaveLength(0);
  });

  it('generator-owned file identical modulo updated: → skipped-noop', () => {
    const outputPath = '/vault/01-projects/_active-sessions.md';
    const newContent = renderBoard([{ repo: 'a', status: 'frei' }], { now: FIXED_NOW });
    // Existing differs ONLY in the updated: timestamp line.
    const existing = newContent.replace(/^(updated:\s*).+$/m, '$11999-01-01T00:00:00.000Z');
    // Sanity: the two genuinely differ before normalization (otherwise the test
    // would pass trivially even if noop detection were broken).
    expect(existing).not.toBe(newContent);
    const { fs, calls } = makeFsStub({ [outputPath]: existing });

    const result = writeBoard({ outputPath, content: newContent, fs });

    expect(result).toEqual({ action: 'skipped-noop', path: outputPath });
    expect(calls.writeFileSync).toHaveLength(0);
  });

  it('generator-owned file that differs materially → written', () => {
    const outputPath = '/vault/01-projects/_active-sessions.md';
    const existing = renderBoard([{ repo: 'a', status: 'frei' }], { now: FIXED_NOW });
    const newContent = renderBoard([{ repo: 'a', status: 'in-progress', session: 's1' }], { now: FIXED_NOW });
    const { fs, calls } = makeFsStub({ [outputPath]: existing });

    const result = writeBoard({ outputPath, content: newContent, fs });

    expect(result).toEqual({ action: 'written', path: outputPath });
    expect(calls.writeFileSync).toHaveLength(1);
  });

  it('dryRun:true → dry-run and never touches the fs', () => {
    const outputPath = '/vault/01-projects/_active-sessions.md';
    const { fs, calls } = makeFsStub();

    const result = writeBoard({ outputPath, content: 'x', dryRun: true, fs });

    expect(result).toEqual({ action: 'dry-run', path: outputPath });
    expect(calls.existsSync).toHaveLength(0);
    expect(calls.writeFileSync).toHaveLength(0);
    expect(calls.readFileSync).toHaveLength(0);
    expect(calls.mkdirSync).toHaveLength(0);
  });

  it('SAFETY: basename _overview.md is refused and never written', () => {
    const outputPath = '/vault/01-projects/_overview.md';
    const { fs, calls } = makeFsStub();

    const result = writeBoard({ outputPath, content: 'x', fs });

    expect(result).toEqual({ action: 'skipped-handwritten', path: outputPath });
    expect(calls.writeFileSync).toHaveLength(0);
  });
});

// ===========================================================================
// collectRows — status derivation
// ===========================================================================

describe('collectRows status derivation', () => {
  it('throws TypeError when repos is not an array', async () => {
    await expect(collectRows({ repos: 'nope', registry: [] })).rejects.toThrow(TypeError);
  });

  it('in-progress: fresh heartbeat lock → in-progress with session/mode/heartbeat', async () => {
    const lock = buildLockBody({ sessionId: 'sess-1', mode: 'deep', ttlHours: 4, heartbeatAgeHours: 0, now: FIXED_NOW });
    const repoRoot = makeRepo('live-repo', lock);

    const rows = await collectRows({ repos: [{ repoRoot }], now: FIXED_NOW, registry: [] });

    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('live-repo');
    expect(rows[0].status).toBe('in-progress');
    expect(rows[0].session).toBe('sess-1');
    expect(rows[0].mode).toBe('deep');
    expect(rows[0].heartbeat).toBe(lock.last_heartbeat);
    // No matching registry entry → branch is null.
    expect(rows[0].branch).toBeNull();
  });

  it('in-progress: branch is sourced from the matching registry entry', async () => {
    const lock = buildLockBody({ sessionId: 'sess-b', heartbeatAgeHours: 0, now: FIXED_NOW });
    const repoRoot = makeRepo('branchy-repo', lock);
    const registry = [buildRegistryEntry({ repoRoot, branch: 'feat/board', now: FIXED_NOW })];

    const rows = await collectRows({ repos: [{ repoRoot }], now: FIXED_NOW, registry });

    expect(rows[0].status).toBe('in-progress');
    expect(rows[0].branch).toBe('feat/board');
  });

  it('force-closed: dead lease (heartbeat older than ttl) preserves the session id', async () => {
    // ttl 4h, heartbeat 5h ago → not live → force-closed.
    const lock = buildLockBody({ sessionId: 'dead-sess', ttlHours: 4, heartbeatAgeHours: 5, now: FIXED_NOW });
    const repoRoot = makeRepo('dead-repo', lock);

    const rows = await collectRows({ repos: [{ repoRoot }], now: FIXED_NOW, registry: [] });

    expect(rows[0].status).toBe('force-closed');
    // The dead lock is NOT silently dropped — its fields are preserved.
    expect(rows[0].session).toBe('dead-sess');
    expect(rows[0].heartbeat).toBe(lock.last_heartbeat);
  });

  it('closed (explicit override): wins even over a LIVE lock', async () => {
    const lock = buildLockBody({ sessionId: 'live-sess', heartbeatAgeHours: 0, now: FIXED_NOW });
    const repoRoot = makeRepo('override-repo', lock);

    const rows = await collectRows({
      repos: [{ repoRoot, status: 'closed' }],
      now: FIXED_NOW,
      registry: [],
    });

    expect(rows[0].status).toBe('closed');
  });

  it('closed: prior in-progress + no lock now → closed', async () => {
    const repoRoot = ghostRepo('gone-repo');
    const priorStatusByRepo = new Map([['gone-repo', 'in-progress']]);

    const rows = await collectRows({
      repos: [{ repoRoot }],
      now: FIXED_NOW,
      registry: [],
      priorStatusByRepo,
    });

    expect(rows[0].status).toBe('closed');
  });

  it('STICKY TERMINAL: prior closed + fresh registry + no lock → stays closed (no resurrection)', async () => {
    const repoRoot = ghostRepo('sticky-repo');
    // A FRESH matching registry entry exists — the bug would resurrect to in-progress.
    const registry = [buildRegistryEntry({ repoRoot, branch: 'main', heartbeatAgeMin: 0, now: FIXED_NOW })];
    const priorStatusByRepo = new Map([['sticky-repo', 'closed']]);

    const rows = await collectRows({
      repos: [{ repoRoot }],
      now: FIXED_NOW,
      registry,
      priorStatusByRepo,
    });

    expect(rows[0].status).toBe('closed');
  });

  it('STICKY TERMINAL: prior force-closed + fresh registry + no lock → stays force-closed', async () => {
    const repoRoot = ghostRepo('sticky-fc-repo');
    const registry = [buildRegistryEntry({ repoRoot, branch: 'main', heartbeatAgeMin: 0, now: FIXED_NOW })];
    const priorStatusByRepo = new Map([['sticky-fc-repo', 'force-closed']]);

    const rows = await collectRows({
      repos: [{ repoRoot }],
      now: FIXED_NOW,
      registry,
      priorStatusByRepo,
    });

    expect(rows[0].status).toBe('force-closed');
  });

  it('registry-fresh: no lock + no prior + fresh registry entry → in-progress', async () => {
    const repoRoot = ghostRepo('reg-fresh-repo');
    const registry = [buildRegistryEntry({ repoRoot, branch: 'wip', heartbeatAgeMin: 1, now: FIXED_NOW })];

    const rows = await collectRows({
      repos: [{ repoRoot }],
      now: FIXED_NOW,
      registry,
    });

    expect(rows[0].status).toBe('in-progress');
    expect(rows[0].branch).toBe('wip');
  });

  it('frei: no lock + no prior + no registry → frei with null fields', async () => {
    const repoRoot = ghostRepo('empty-repo');

    const rows = await collectRows({
      repos: [{ repoRoot }],
      now: FIXED_NOW,
      registry: [],
    });

    expect(rows[0].status).toBe('frei');
    expect(rows[0].session).toBeNull();
    expect(rows[0].branch).toBeNull();
    expect(rows[0].mode).toBeNull();
    expect(rows[0].heartbeat).toBeNull();
  });

  it('frei: a STALE registry entry (older than freshness window) does NOT promote to in-progress', async () => {
    const repoRoot = ghostRepo('stale-reg-repo');
    // 30 min old > default 15 min freshness → not fresh → stays frei.
    const registry = [buildRegistryEntry({ repoRoot, branch: 'old', heartbeatAgeMin: 30, now: FIXED_NOW })];

    const rows = await collectRows({
      repos: [{ repoRoot }],
      now: FIXED_NOW,
      registry,
    });

    expect(rows[0].status).toBe('frei');
  });

  it('skips a malformed repo descriptor (missing repoRoot) without throwing', async () => {
    const lock = buildLockBody({ sessionId: 'ok-sess', heartbeatAgeHours: 0, now: FIXED_NOW });
    const goodRepo = makeRepo('good-repo', lock);

    const rows = await collectRows({
      repos: [{ notRepoRoot: true }, 'bare-string', null, { repoRoot: goodRepo }],
      now: FIXED_NOW,
      registry: [],
    });

    // Only the one well-formed descriptor yields a row.
    expect(rows).toHaveLength(1);
    expect(rows[0].repo).toBe('good-repo');
  });
});

// ===========================================================================
// Idempotent merge (collectRows + renderBoard) — preserves untouched repos
// ===========================================================================

describe('idempotent merge semantics', () => {
  // Lighter unit-level proof of the mirrorBoard merge: collectRows derives the
  // current repo's row; the prior "other" row is recovered from the existing
  // board via parseBoardRows. renderBoard over the merged set MUST keep BOTH.
  // (mirrorBoard itself wires config-read + vault-path-under-$HOME guard, which
  // is heavier to stand up; the merge math it relies on is exercised here.)
  it('rendering the merge of a prior board row + a new derived row keeps both', async () => {
    // Prior board carries a row for "other" (not in this update).
    const priorBoard = renderBoard(
      [{ repo: 'other', status: 'in-progress', session: 'other-sess', branch: 'main', mode: 'deep', heartbeat: 'h' }],
      { now: FIXED_NOW },
    );
    const preserved = new Map();
    for (const row of parseBoardRows(priorBoard)) preserved.set(row.repo, row);

    // This update touches only "this-repo".
    const lock = buildLockBody({ sessionId: 'this-sess', heartbeatAgeHours: 0, now: FIXED_NOW });
    const thisRepo = makeRepo('this-repo', lock);
    const freshRows = await collectRows({ repos: [{ repoRoot: thisRepo }], now: FIXED_NOW, registry: [] });

    const merged = new Map(preserved);
    for (const row of freshRows) merged.set(row.repo, row);

    const out = renderBoard([...merged.values()], { now: FIXED_NOW });

    expect(out).toContain('| other | in-progress |');
    expect(out).toContain('| this-repo | in-progress |');
  });
});

// ===========================================================================
// parseBoardRows / normalizeUpdated
// ===========================================================================

describe('parseBoardRows', () => {
  it('roundtrips renderBoard output, recovering repo + status per row', () => {
    const rows = [
      { repo: 'alpha', status: 'in-progress', session: 's-a', branch: 'main', mode: 'deep', heartbeat: 'h-a' },
      { repo: 'bravo', status: 'frei', session: null, branch: null, mode: null, heartbeat: null },
    ];
    const out = renderBoard(rows, { now: FIXED_NOW });

    const parsed = parseBoardRows(out);

    expect(parsed).toHaveLength(2);
    // renderBoard sorts; alpha first, bravo second.
    expect(parsed[0]).toEqual({
      repo: 'alpha',
      status: 'in-progress',
      session: 's-a',
      branch: 'main',
      mode: 'deep',
      heartbeat: 'h-a',
    });
    expect(parsed[1].repo).toBe('bravo');
    expect(parsed[1].status).toBe('frei');
    expect(parsed[1].session).toBeNull();
  });

  it('does not emit spurious rows for the header or separator line', () => {
    const out = renderBoard([{ repo: 'solo', status: 'frei' }], { now: FIXED_NOW });

    const parsed = parseBoardRows(out);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].repo).toBe('solo');
  });

  it('returns an empty array for content with no table rows', () => {
    expect(parseBoardRows('---\n_generator: x\n---\n\n# Empty\n')).toEqual([]);
  });
});

describe('normalizeUpdated', () => {
  it('makes two contents differing only in updated: compare equal', () => {
    const base = renderBoard([{ repo: 'a', status: 'frei' }], { now: FIXED_NOW });
    const other = base.replace(/^(updated:\s*).+$/m, '$12099-12-31T23:59:59.000Z');

    // Precondition: they genuinely differ before normalization.
    expect(other).not.toBe(base);
    // After normalization they are byte-equal.
    expect(normalizeUpdated(base)).toBe(normalizeUpdated(other));
  });

  it('leaves content without an updated: line unchanged', () => {
    const input = '---\ntype: board\n---\nbody\n';
    expect(normalizeUpdated(input)).toBe(input);
  });
});

// ===========================================================================
// mirrorBoard — case-insensitive merge-key folding (issue #719)
// ===========================================================================

describe('mirrorBoard — case-insensitive key folding (issue #719)', () => {
  it('case-collision collapse: two prior rows differing only by case + a fresh row for one casing collapse to exactly ONE row, and the FRESH row wins', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
    const priorContent = buildPriorBoardContent([
      { repo: 'some-repo', status: 'closed' },
      { repo: 'Some-Repo', status: 'force-closed', session: 'old-sess', mode: 'deep', heartbeat: '2026-05-01T00:00:00.000Z' },
    ]);
    writeFileSync(boardPath, priorContent, 'utf8');

    const thisRepoRoot = makeThisRepoConfig('this-repo-fold-a', vaultDir);
    const freshLock = buildLockBody({ sessionId: 'fresh-sess', mode: 'deep', heartbeatAgeHours: 0, now: FIXED_NOW });
    const freshRepoRoot = makeRepo('Some-Repo-live', freshLock);

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot }, { repoRoot: freshRepoRoot, repoName: 'Some-Repo' }],
      now: FIXED_NOW,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    const matches = rows.filter((r) => r.repo.toLowerCase() === 'some-repo');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      repo: 'Some-Repo',
      status: 'in-progress',
      session: 'fresh-sess',
      branch: null,
      mode: 'deep',
      heartbeat: freshLock.last_heartbeat,
    });
  });

  it.each([
    [
      'newer row FIRST in the file',
      [
        { repo: 'Some-Repo', status: 'closed', session: 'newer-sess', heartbeat: '2026-06-10T00:00:00.000Z' },
        { repo: 'some-repo', status: 'force-closed', session: 'older-sess', heartbeat: '2026-06-01T00:00:00.000Z' },
      ],
    ],
    [
      'newer row LAST in the file',
      [
        { repo: 'some-repo', status: 'force-closed', session: 'older-sess', heartbeat: '2026-06-01T00:00:00.000Z' },
        { repo: 'Some-Repo', status: 'closed', session: 'newer-sess', heartbeat: '2026-06-10T00:00:00.000Z' },
      ],
    ],
  ])(
    'preserved-only collision (no fresh row): survivor is always the newer-heartbeat row — %s',
    async (_label, rowsInFileOrder) => {
      const vaultDir = makeVaultDir();
      const boardPath = resolveBoardPath(vaultDir);
      mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
      writeFileSync(boardPath, buildPriorBoardContent(rowsInFileOrder), 'utf8');

      const thisRepoRoot = makeThisRepoConfig('this-repo-fold-c', vaultDir);

      const result = await mirrorBoard({
        repoRoot: thisRepoRoot,
        // No repo in this update folds to the 'some-repo' key — the survivor
        // must come purely from the within-prior-file collision resolution.
        repos: [{ repoRoot: thisRepoRoot, repoName: 'unrelated-active-repo' }],
        now: FIXED_NOW,
      });

      expect(result.action).toBe('written');
      const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
      const matches = rows.filter((r) => r.repo.toLowerCase() === 'some-repo');
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        repo: 'Some-Repo',
        status: 'closed',
        session: 'newer-sess',
        branch: null,
        mode: null,
        heartbeat: '2026-06-10T00:00:00.000Z',
      });
    },
  );

  it.each([
    [
      'row A first, row B second',
      [
        { repo: 'some-repo', status: 'closed', session: 'row-a' },
        { repo: 'Some-Repo', status: 'force-closed', session: 'row-b' },
      ],
      'row-b',
    ],
    [
      'row B first, row A second',
      [
        { repo: 'Some-Repo', status: 'force-closed', session: 'row-b' },
        { repo: 'some-repo', status: 'closed', session: 'row-a' },
      ],
      'row-a',
    ],
  ])(
    'unparsable/missing heartbeats on both colliding rows fall back to last-written-wins (pinned current behavior) — %s',
    async (_label, rowsInFileOrder, expectedSurvivorSession) => {
      const vaultDir = makeVaultDir();
      const boardPath = resolveBoardPath(vaultDir);
      mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
      // Both heartbeats render as '—' (absent/unparsable) so Date.parse('') is
      // NaN on both sides of the comparison — the guard cannot pick a winner
      // by recency, so the loop's default (whichever is processed last)
      // applies: the LAST row written into the file order wins.
      writeFileSync(boardPath, buildPriorBoardContent(rowsInFileOrder), 'utf8');

      const thisRepoRoot = makeThisRepoConfig('this-repo-fold-d', vaultDir);

      const result = await mirrorBoard({
        repoRoot: thisRepoRoot,
        repos: [{ repoRoot: thisRepoRoot, repoName: 'unrelated-active-repo-2' }],
        now: FIXED_NOW,
      });

      expect(result.action).toBe('written');
      const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
      const matches = rows.filter((r) => r.repo.toLowerCase() === 'some-repo');
      expect(matches).toHaveLength(1);
      expect(matches[0].session).toBe(expectedSurvivorSession);
    },
  );

  it('idempotency: a second mirrorBoard write over an already-collapsed board is skipped-noop', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'some-repo', status: 'closed' },
        { repo: 'Some-Repo', status: 'force-closed', session: 'old-sess', heartbeat: '2026-06-01T00:00:00.000Z' },
      ]),
      'utf8',
    );

    const thisRepoRoot = makeThisRepoConfig('this-repo-fold-e', vaultDir);
    const repos = [{ repoRoot: thisRepoRoot, repoName: 'idempotent-repo' }];

    const first = await mirrorBoard({ repoRoot: thisRepoRoot, repos, now: FIXED_NOW });
    expect(first.action).toBe('written');

    const second = await mirrorBoard({ repoRoot: thisRepoRoot, repos, now: FIXED_NOW });
    expect(second.action).toBe('skipped-noop');
  });

  it('sticky-status fold: a lock-less repo whose prior row used DIFFERENT casing still inherits the terminal status via the folded prior-status lookup', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
    // Prior board row is capitalized ('Some-Repo', in-progress).
    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'Some-Repo', status: 'in-progress', session: 'prior-sess', mode: 'deep', heartbeat: '2026-06-01T00:00:00.000Z' },
      ]),
      'utf8',
    );

    const thisRepoRoot = makeThisRepoConfig('this-repo-fold-f', vaultDir);
    // This update's repoName is lowercase — a DIFFERENT casing than the prior
    // board row — and has no session.lock (ghost repo, no live lease).
    const ghost = ghostRepo('some-repo-ghost-f');

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot }, { repoRoot: ghost, repoName: 'some-repo' }],
      now: FIXED_NOW,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    const row = rows.find((r) => r.repo.toLowerCase() === 'some-repo');
    expect(row.status).toBe('closed');
  });
});
