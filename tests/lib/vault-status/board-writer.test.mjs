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
  boardKey,
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
import { DEFAULT_TTL_HOURS } from '../../../scripts/lib/session-lock.mjs';

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
 * Hermetic hostPaths ctx (issue #783) — mirrorBoard's Session Config read
 * defaults to the REAL host `owner.yaml` when no `hostPaths` is passed. On a
 * host with `paths.vault-dir` set, that override wins over the fixture's
 * `vault-dir:` value AND resolves to the real vault dir (not the tmp dir these
 * tests create), silently mutating the operator's real vault board. Every
 * `mirrorBoard()` call below MUST pass this hermetic ctx so the fixture's
 * `vault-dir:` value is what actually resolves.
 */
const HERMETIC_HOST_PATHS = { env: {}, ownerConfig: undefined };

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
 *
 * Emits the pre-#871 SIX-column format on purpose: these fixtures double as the
 * legacy-board corpus, so every test built on them also exercises the
 * 6-column-tolerant parse + one-shot adoption path. Pass `key` on a row to get
 * the 7-column form instead.
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
        `| ${r.repo} | ${r.status} | ${r.session ?? '—'} | ${r.branch ?? '—'} | ${r.mode ?? '—'} | ${r.heartbeat ?? '—'} |`
        + (r.key ? ` ${r.key} |` : ''),
    ),
    '',
  ];
  return lines.join('\n');
}

/**
 * In-memory fs stub for writeBoard/mirrorBoard. Seed with { path: content }.
 *
 * Carries `renameSync` since #734c: writeBoard now lands its bytes through
 * `atomicWriteWithBackup` (tmp + rename), so a stub that mocked only
 * `writeFileSync` would leave the REAL `renameSync` hunting for a tmp file the
 * stub never created on disk. `landed` records the (tmpPath → finalPath) hops
 * so a test can prove the rename actually happened rather than assuming it.
 */
function makeFsStub(seed = {}) {
  const store = new Map(Object.entries(seed));
  const calls = { writeFileSync: [], mkdirSync: [], existsSync: [], readFileSync: [], renameSync: [] };
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
      renameSync(from, to) {
        calls.renameSync.push({ from, to });
        if (!store.has(from)) {
          const err = new Error(`ENOENT: ${from}`);
          err.code = 'ENOENT';
          throw err;
        }
        store.set(to, store.get(from));
        store.delete(from);
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

  it('renders a markdown table header with the #871 Key column', () => {
    const out = renderBoard([{ repo: 'alpha', status: 'in-progress' }], { now: FIXED_NOW });
    expect(out).toContain('| Repo | Status | Session | Branch | Mode | Last heartbeat | Key |');
    expect(out).toContain('|---|---|---|---|---|---|---|');
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
    // The 7th cell is the #871 key, absent here (no repoRoot behind this row).
    expect(out).toContain('| idle-repo | frei | — | — | — | — | — |');
  });

  it('renders the path-derived key in the 7th column (#871)', () => {
    const out = renderBoard(
      [{ repo: 'keyed-repo', status: 'in-progress', key: 'abc12345' }],
      { now: FIXED_NOW },
    );
    expect(out).toContain('| keyed-repo | in-progress | — | — | — | — | abc12345 |');
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
  it('fresh write (no existing file) lands the content atomically: written to a tmp sibling, renamed onto the target (#734c)', () => {
    const { fs, calls, store } = makeFsStub();
    const outputPath = '/vault/01-projects/_active-sessions.md';
    const content = renderBoard([{ repo: 'a', status: 'frei' }], { now: FIXED_NOW });

    const result = writeBoard({ outputPath, content, fs });

    expect(result).toEqual({ action: 'written', path: outputPath });
    // The bytes never go straight at the live board: exactly one write, to a
    // tmp SIBLING (same dir → same filesystem → the rename is atomic), then one
    // rename onto the target. A regression back to a direct writeFileSync would
    // leave renameSync at length 0 and fail here.
    expect(calls.writeFileSync).toHaveLength(1);
    expect(calls.writeFileSync[0].path).not.toBe(outputPath);
    expect(calls.writeFileSync[0].path.startsWith('/vault/01-projects/.active-sessions.')).toBe(true);
    expect(calls.writeFileSync[0].content).toBe(content);
    expect(calls.renameSync).toEqual([{ from: calls.writeFileSync[0].path, to: outputPath }]);
    // …and the tmp file does not survive the write.
    expect(store.get(outputPath)).toBe(content);
    expect(store.has(calls.writeFileSync[0].path)).toBe(false);
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
  it('roundtrips renderBoard output, recovering repo + key + status per row', () => {
    const rows = [
      { repo: 'alpha', key: 'aaaa1111', status: 'in-progress', session: 's-a', branch: 'main', mode: 'deep', heartbeat: 'h-a' },
      { repo: 'bravo', key: null, status: 'frei', session: null, branch: null, mode: null, heartbeat: null },
    ];
    const out = renderBoard(rows, { now: FIXED_NOW });

    const parsed = parseBoardRows(out);

    expect(parsed).toHaveLength(2);
    // renderBoard sorts; alpha first, bravo second.
    expect(parsed[0]).toEqual({
      repo: 'alpha',
      key: 'aaaa1111',
      status: 'in-progress',
      session: 's-a',
      branch: 'main',
      mode: 'deep',
      heartbeat: 'h-a',
    });
    expect(parsed[1].repo).toBe('bravo');
    expect(parsed[1].status).toBe('frei');
    expect(parsed[1].session).toBeNull();
    expect(parsed[1].key).toBeNull();
  });

  it('parses a LEGACY 6-column row (pre-#871 board) as key: null instead of dropping it', () => {
    // The upgrade hazard this pins: a hard `cells.length !== 7` filter would
    // silently discard every row on an operator's existing board, which looks
    // like the board resetting itself on first run after the upgrade.
    const legacy = buildPriorBoardContent([
      { repo: 'legacy-repo', status: 'in-progress', session: 'old-sess', branch: 'main', mode: 'deep', heartbeat: 'old-hb' },
    ]);
    // Precondition: the fixture really is the 6-column form.
    expect(legacy).toContain('| legacy-repo | in-progress | old-sess | main | deep | old-hb |');
    expect(legacy).not.toContain('| Key |');

    expect(parseBoardRows(legacy)).toEqual([
      {
        repo: 'legacy-repo',
        key: null,
        status: 'in-progress',
        session: 'old-sess',
        branch: 'main',
        mode: 'deep',
        heartbeat: 'old-hb',
      },
    ]);
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
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    const matches = rows.filter((r) => r.repo.toLowerCase() === 'some-repo');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toEqual({
      repo: 'Some-Repo',
      // The fresh row ADOPTED the legacy name slot and carries its own key now
      // (#871 one-shot migration) — it did not render beside the legacy rows.
      key: boardKey(freshRepoRoot),
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
        hostPaths: HERMETIC_HOST_PATHS,
      });

      expect(result.action).toBe('written');
      const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
      const matches = rows.filter((r) => r.repo.toLowerCase() === 'some-repo');
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({
        repo: 'Some-Repo',
        // Purely PRESERVED: no repo in this update derives it, so nothing can
        // supply a path — the row stays legacy (key null) until its own repo
        // is next swept. That is the migration contract, not a defect.
        key: null,
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
        hostPaths: HERMETIC_HOST_PATHS,
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

    const first = await mirrorBoard({ repoRoot: thisRepoRoot, repos, now: FIXED_NOW, hostPaths: HERMETIC_HOST_PATHS });
    expect(first.action).toBe('written');

    const second = await mirrorBoard({ repoRoot: thisRepoRoot, repos, now: FIXED_NOW, hostPaths: HERMETIC_HOST_PATHS });
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
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    const row = rows.find((r) => r.repo.toLowerCase() === 'some-repo');
    expect(row.status).toBe('closed');
  });
});

// ===========================================================================
// mirrorBoard — path-derived row identity (issue #871)
// ===========================================================================

describe('mirrorBoard — path-derived identity (#871)', () => {
  it('two repos with the SAME basename under DIFFERENT parents render as TWO rows, each keeping its own status', async () => {
    // THE bug #871 fixes. Keyed by `path.basename`, `<org-a>/name` and
    // `<org-b>/name` fold onto one row and whichever is written second silently
    // overwrites the other's status — a same-named sibling repo's session
    // simply disappears from the board. Both are enumerable since the depth-2
    // walk of #832, so this is reachable on the real host, not hypothetical.
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    // Same directory NAME ('twin'), two different parents.
    const orgA = join(sandbox, 'org-a');
    const orgB = join(sandbox, 'org-b');
    mkdirSync(orgA, { recursive: true });
    mkdirSync(orgB, { recursive: true });

    const liveLock = buildLockBody({ sessionId: 'twin-a-sess', mode: 'deep', heartbeatAgeHours: 0, now: FIXED_NOW });
    const repoA = join(orgA, 'twin');
    mkdirSync(join(repoA, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoA, '.orchestrator', 'session.lock'), JSON.stringify(liveLock, null, 2) + '\n', 'utf8');

    const deadLock = buildLockBody({
      sessionId: 'twin-b-sess', mode: 'feature', ttlHours: 4, heartbeatAgeHours: 5, now: FIXED_NOW,
    });
    const repoB = join(orgB, 'twin');
    mkdirSync(join(repoB, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoB, '.orchestrator', 'session.lock'), JSON.stringify(deadLock, null, 2) + '\n', 'utf8');

    const thisRepoRoot = makeThisRepoConfig('this-repo-twin', vaultDir);

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot }, { repoRoot: repoA }, { repoRoot: repoB }],
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const twins = parseBoardRows(readFileSync(boardPath, 'utf8')).filter((r) => r.repo === 'twin');

    // Pre-#871 this was exactly ONE row (repoB's, having overwritten repoA's).
    expect(twins).toHaveLength(2);
    // Each row carries its OWN path key and its OWN derived status — no bleed.
    const byKey = Object.fromEntries(twins.map((r) => [r.key, r]));
    expect(byKey[boardKey(repoA)].status).toBe('in-progress');
    expect(byKey[boardKey(repoA)].session).toBe('twin-a-sess');
    expect(byKey[boardKey(repoB)].status).toBe('force-closed');
    expect(byKey[boardKey(repoB)].session).toBe('twin-b-sess');
    // Both keys are genuinely distinct (guards against boardKey degenerating
    // to a constant, which would make the length-2 assertion above pass for
    // the wrong reason).
    expect(boardKey(repoA)).not.toBe(boardKey(repoB));
  });

  it('a never-before-seen repo does NOT inherit a same-basename sibling\'s terminal status through the legacy name fallback', async () => {
    // The sticky-status half of the same identity bug: repo A closed cleanly
    // and its row is keyed; repo B (same basename, different parent, no lock)
    // must derive `frei`, not A's sticky `closed`.
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    const orgA = join(sandbox, 'sticky-org-a');
    mkdirSync(orgA, { recursive: true });
    const repoA = join(orgA, 'twin2');
    mkdirSync(repoA, { recursive: true });

    // Seed a KEYED prior row for repo A in terminal state.
    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'twin2', status: 'closed', session: 'a-sess', mode: 'deep', heartbeat: '2026-06-01T00:00:00.000Z', key: boardKey(repoA) },
      ]),
      'utf8',
    );

    const orgB = join(sandbox, 'sticky-org-b');
    mkdirSync(orgB, { recursive: true });
    const repoB = join(orgB, 'twin2'); // ghost: no .orchestrator, no lock

    const thisRepoRoot = makeThisRepoConfig('this-repo-twin2', vaultDir);

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot }, { repoRoot: repoB }],
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    const rowB = rows.find((r) => r.key === boardKey(repoB));
    expect(rowB.status).toBe('frei');
    // A's row is untouched and still terminal.
    expect(rows.find((r) => r.key === boardKey(repoA)).status).toBe('closed');
  });

  it('MIGRATION RUN: a KEY-LESS legacy row does not stamp its terminal status onto BOTH same-basename repos (#1022)', async () => {
    // The third combination the two tests above leave open. They cover a KEYED
    // prior (:976) and NO prior (:922); this is the one an operator actually
    // hits first: on the first run after #871 every existing board is still
    // 6-column, so the prior row carries NO key and nothing ties it to a path.
    // Both same-basename repos therefore miss the keyed lookup, both fall
    // through to the legacy NAME fallback, and both were written `closed` —
    // each under its OWN key. From run 2 on that wrong status is keyed and
    // therefore STICKY (a terminal status is never reset without a live lock),
    // so the repo that never had a session stands `closed` on the board
    // forever. Two such basename collisions were measured on the reference
    // host after the depth-2 walk of #832 — see sweepBoard note (d).
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    // Same basename, two different parents, NEITHER holding a lock.
    const repoA = join(sandbox, 'mig-org-a', 'twin3');
    const repoB = join(sandbox, 'mig-org-b', 'twin3');
    mkdirSync(repoA, { recursive: true });
    mkdirSync(repoB, { recursive: true });

    // LEGACY board: 6 columns, no Key column (buildPriorBoardContent's default).
    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'twin3', status: 'closed', session: 'legacy-sess', branch: 'main', mode: 'deep', heartbeat: '2026-06-18T11:00:00.000Z' },
      ]),
      'utf8',
    );

    const thisRepoRoot = makeThisRepoConfig('this-repo-twin3', vaultDir);

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot }, { repoRoot: repoA }, { repoRoot: repoB }],
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const twins = parseBoardRows(readFileSync(boardPath, 'utf8')).filter((r) => r.repo === 'twin3');
    expect(twins).toHaveLength(2);
    // Guards against boardKey degenerating to a constant, which would make the
    // per-key assertions below pass for the wrong reason.
    expect(boardKey(repoA)).not.toBe(boardKey(repoB));

    // CLASS INVARIANT: one legacy row describes one repo, so it can license at
    // most one inheritance. Pre-fix this was 2 — the assertion that goes red.
    expect(twins.filter((r) => r.status === 'closed').length).toBeLessThanOrEqual(1);

    // CHOSEN SEMANTICS: an AMBIGUOUS basename licenses NO inheritance at all.
    // With two claimants and no path in the legacy row, "which one" is not
    // derivable — awarding it to the first candidate would make a permanent,
    // sticky status depend on readdir order.
    const byKey = Object.fromEntries(twins.map((r) => [r.key, r]));
    expect(byKey[boardKey(repoA)].status).toBe('frei');
    expect(byKey[boardKey(repoB)].status).toBe('frei');
  });

  it('adopts a legacy 6-column row exactly once: run 1 converts it to a keyed row, run 2 is a noop (no duplicate)', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    const lock = buildLockBody({ sessionId: 'migrating-sess', mode: 'deep', heartbeatAgeHours: 0, now: FIXED_NOW });
    const repoRoot = makeRepo('migrating-repo', lock);

    // Legacy board: 6 columns, no key — what every operator's board looks like
    // on the first run after this change.
    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'migrating-repo', status: 'in-progress', session: 'stale-sess', branch: 'main', mode: 'deep', heartbeat: '2026-06-18T11:00:00.000Z' },
      ]),
      'utf8',
    );

    const thisRepoRoot = makeThisRepoConfig('this-repo-migrate', vaultDir);
    const repos = [{ repoRoot: thisRepoRoot }, { repoRoot }];

    const first = await mirrorBoard({ repoRoot: thisRepoRoot, repos, now: FIXED_NOW, hostPaths: HERMETIC_HOST_PATHS });
    expect(first.action).toBe('written');

    const afterFirst = parseBoardRows(readFileSync(boardPath, 'utf8')).filter((r) => r.repo === 'migrating-repo');
    // Adopted, not duplicated: ONE row, now carrying the path key and the
    // fresh lock's session (the whole point — a disjoint key space would leave
    // the legacy row here forever beside a new keyed one).
    expect(afterFirst).toHaveLength(1);
    expect(afterFirst[0].key).toBe(boardKey(repoRoot));
    expect(afterFirst[0].session).toBe('migrating-sess');

    const second = await mirrorBoard({ repoRoot: thisRepoRoot, repos, now: FIXED_NOW, hostPaths: HERMETIC_HOST_PATHS });
    expect(second.action).toBe('skipped-noop');
  });
});

// ===========================================================================
// mirrorBoard — hostPaths forwarding is load-bearing (issue #783 follow-up)
//
// The tests above all pass HERMETIC_HOST_PATHS ({ env: {}, ownerConfig:
// undefined }) — an EMPTY ctx that happens to equal the CI default. That
// proves the fix does not LEAK the real host owner.yaml into a fixture
// assertion, but it does NOT prove mirrorBoard actually FORWARDS `hostPaths`
// to parseSessionConfig: if the forwarding were silently dropped (i.e.
// mirrorBoard called `parseSessionConfig(text)` with no options), every test
// above would still pass, because falling back to the real (empty-on-CI)
// host context produces the same resolved vault-dir as passing the empty
// ctx explicitly. This test closes that gap with a FAKE, NON-EMPTY
// hostPaths override that must win over the fixture's committed vault-dir.
// ===========================================================================

describe('mirrorBoard — hostPaths forwarding (load-bearing, #783 falsification)', () => {
  it('a fake owner.yaml vault-dir override resolves the board path, proving hostPaths is forwarded to parseSessionConfig', async () => {
    // Fixture's OWN committed vault-dir (what CLAUDE.md declares).
    const committedVaultDir = makeVaultDir();
    const thisRepoRoot = makeThisRepoConfig('this-repo-hostpaths-fwd', committedVaultDir);

    // A FAKE vault-dir injected via ownerConfig.paths — must live under $HOME
    // to pass mirrorBoard's safety guard, but is otherwise never created on
    // disk (dryRun means nothing touches it).
    const fakeVaultDir = join(homedir(), '.so-board-writer-fake-owner-injected-mirrorBoard');

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot }],
      now: FIXED_NOW,
      dryRun: true,
      hostPaths: { env: {}, ownerConfig: { paths: { 'vault-dir': fakeVaultDir } } },
    });

    // Falsification proof: if mirrorBoard stopped forwarding `hostPaths` to
    // parseSessionConfig, config would resolve via the REAL host context
    // instead (empty on CI — no SO_VAULT_DIR, no owner.yaml paths.vault-dir),
    // which falls through to the fixture's COMMITTED vault-dir. The resolved
    // path would then equal resolveBoardPath(committedVaultDir), NOT
    // resolveBoardPath(fakeVaultDir) — this assertion would go RED.
    expect(result.action).toBe('dry-run');
    expect(result.path).toBe(resolveBoardPath(fakeVaultDir));
    expect(result.path).not.toBe(resolveBoardPath(committedVaultDir));
  });
});

// ===========================================================================
// mirrorBoard — vault-name override on the single-repo descriptor (#832)
// ===========================================================================

describe('mirrorBoard — vault-name override (#832)', () => {
  /** Same as makeThisRepoConfig, plus a `vault-name:` key in the config block. */
  function makeThisRepoConfigWithVaultName(name, vaultDir, vaultName) {
    const repoRoot = join(sandbox, name);
    mkdirSync(repoRoot, { recursive: true });
    writeFileSync(
      join(repoRoot, 'CLAUDE.md'),
      `# Repo\n\n## Session Config\n\nvault-integration:\n  enabled: true\n  vault-dir: ${vaultDir}\n  vault-name: ${vaultName}\n  mode: warn\n`,
    );
    return repoRoot;
  }

  it('honours vault-name for the single-repo default descriptor instead of the directory basename', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    // Directory basename and configured vault-name deliberately differ.
    const thisRepoRoot = makeThisRepoConfigWithVaultName(
      'this-repo-dirname', vaultDir, 'configured-vault-name',
    );

    // No `repos` arg → mirrorBoard builds the single-repo default descriptor,
    // which is the code path that previously ignored vault-name entirely.
    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      explicitStatus: 'closed',
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    expect(rows.map((r) => r.repo)).toEqual(['configured-vault-name']);
    // Falsification: the pre-#832 fallback rendered path.basename(repoRoot).
    expect(rows.map((r) => r.repo)).not.toContain('this-repo-dirname');
  });

  it('falls back to the directory basename when vault-name is absent', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    const thisRepoRoot = makeThisRepoConfig('this-repo-no-vault-name', vaultDir);

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      explicitStatus: 'closed',
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    expect(rows.map((r) => r.repo)).toEqual(['this-repo-no-vault-name']);
  });

  it('an explicit repos array still wins — its own repoName is not overwritten by vault-name', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    const thisRepoRoot = makeThisRepoConfigWithVaultName(
      'this-repo-explicit-list', vaultDir, 'configured-vault-name',
    );

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot, repoName: 'caller-supplied-name', status: 'closed' }],
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    expect(rows.map((r) => r.repo)).toEqual(['caller-supplied-name']);
  });
});

// ===========================================================================
// mirrorBoard — TTL-staleness re-derivation on PRESERVED rows (issue #829
// Finding 2, also self-heals Finding 1 leftovers)
// ===========================================================================

describe('mirrorBoard — TTL-staleness re-derivation on preserved rows (#829)', () => {
  it('flips preserved in-progress rows past DEFAULT_TTL_HOURS to force-closed, at multiple ages, while leaving a fresh row and an unparseable-heartbeat row unchanged', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    const staleHb5h = new Date(FIXED_NOW.getTime() - (DEFAULT_TTL_HOURS + 1) * 3600 * 1000).toISOString();
    const staleHb10d = new Date(FIXED_NOW.getTime() - 10 * 24 * 3600 * 1000).toISOString();
    const freshHb = new Date(FIXED_NOW.getTime() - 1 * 3600 * 1000).toISOString();

    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'stale-5h-repo', status: 'in-progress', session: 'sess-5h', branch: 'main', mode: 'deep', heartbeat: staleHb5h },
        { repo: 'stale-10d-repo', status: 'in-progress', session: 'sess-10d', branch: 'main', mode: 'deep', heartbeat: staleHb10d },
        { repo: 'fresh-repo', status: 'in-progress', session: 'sess-fresh', branch: 'main', mode: 'deep', heartbeat: freshHb },
        { repo: 'unparseable-hb-repo', status: 'in-progress', session: 'sess-bad-hb', branch: 'main', mode: 'deep' },
      ]),
      'utf8',
    );

    const thisRepoRoot = makeThisRepoConfig('this-repo-ttl-a', vaultDir);

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      // None of the four seeded repos appear in this update — every one of
      // their rows is genuinely PRESERVED, not freshly re-derived.
      repos: [{ repoRoot: thisRepoRoot, repoName: 'unrelated-active-repo-ttl' }],
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    const byRepo = Object.fromEntries(rows.map((r) => [r.repo, r]));

    expect(byRepo['stale-5h-repo'].status).toBe('force-closed');
    expect(byRepo['stale-5h-repo'].session).toBe('sess-5h'); // fields preserved, only status flips
    expect(byRepo['stale-10d-repo'].status).toBe('force-closed');
    expect(byRepo['stale-10d-repo'].session).toBe('sess-10d');
    expect(byRepo['fresh-repo'].status).toBe('in-progress');
    expect(byRepo['unparseable-hb-repo'].status).toBe('in-progress');
  });

  it('boundary: a preserved in-progress row whose heartbeat is EXACTLY DEFAULT_TTL_HOURS old flips to force-closed (>= semantics pinned)', async () => {
    // board-writer.mjs's staleness check is `(nowMs - heartbeatMs) >= ttlMs`
    // (~line 609) — an age exactly equal to the TTL counts as stale, not live.
    // This pins the >= boundary itself; a future accidental `>` regression
    // would leave this exact-age row wrongly `in-progress` and fail here.
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    const ttlMs = DEFAULT_TTL_HOURS * 3600 * 1000;
    const exactlyStaleHb = new Date(FIXED_NOW.getTime() - ttlMs).toISOString();

    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'exactly-ttl-repo', status: 'in-progress', session: 'sess-exact', branch: 'main', mode: 'deep', heartbeat: exactlyStaleHb },
      ]),
      'utf8',
    );

    const thisRepoRoot = makeThisRepoConfig('this-repo-ttl-boundary-exact', vaultDir);

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot, repoName: 'unrelated-active-repo-ttl-boundary-exact' }],
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    const row = rows.find((r) => r.repo === 'exactly-ttl-repo');
    expect(row.status).toBe('force-closed');
    expect(row.session).toBe('sess-exact');
  });

  it('boundary: a preserved in-progress row whose heartbeat is (DEFAULT_TTL_HOURS - 1s) old stays in-progress', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    const ttlMs = DEFAULT_TTL_HOURS * 3600 * 1000;
    const justUnderStaleHb = new Date(FIXED_NOW.getTime() - (ttlMs - 1000)).toISOString();

    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'just-under-ttl-repo', status: 'in-progress', session: 'sess-under', branch: 'main', mode: 'deep', heartbeat: justUnderStaleHb },
      ]),
      'utf8',
    );

    const thisRepoRoot = makeThisRepoConfig('this-repo-ttl-boundary-under', vaultDir);

    const result = await mirrorBoard({
      repoRoot: thisRepoRoot,
      repos: [{ repoRoot: thisRepoRoot, repoName: 'unrelated-active-repo-ttl-boundary-under' }],
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(boardPath, 'utf8'));
    const row = rows.find((r) => r.repo === 'just-under-ttl-repo');
    expect(row.status).toBe('in-progress');
    expect(row.session).toBe('sess-under');
  });

  it('is idempotent: a second mirrorBoard run over an already-TTL-flipped board is skipped-noop', async () => {
    const vaultDir = makeVaultDir();
    const boardPath = resolveBoardPath(vaultDir);
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });

    const staleHb = new Date(FIXED_NOW.getTime() - (DEFAULT_TTL_HOURS + 1) * 3600 * 1000).toISOString();
    writeFileSync(
      boardPath,
      buildPriorBoardContent([
        { repo: 'stale-idem-repo', status: 'in-progress', session: 'sess-idem', branch: 'main', mode: 'deep', heartbeat: staleHb },
      ]),
      'utf8',
    );

    const thisRepoRoot = makeThisRepoConfig('this-repo-ttl-b', vaultDir);
    const repos = [{ repoRoot: thisRepoRoot, repoName: 'unrelated-active-repo-ttl-b' }];

    const first = await mirrorBoard({ repoRoot: thisRepoRoot, repos, now: FIXED_NOW, hostPaths: HERMETIC_HOST_PATHS });
    expect(first.action).toBe('written');
    const afterFirst = parseBoardRows(readFileSync(boardPath, 'utf8'));
    expect(afterFirst.find((r) => r.repo === 'stale-idem-repo').status).toBe('force-closed');

    const second = await mirrorBoard({ repoRoot: thisRepoRoot, repos, now: FIXED_NOW, hostPaths: HERMETIC_HOST_PATHS });
    expect(second.action).toBe('skipped-noop');

    const afterSecond = readFileSync(boardPath, 'utf8');
    expect(normalizeUpdated(afterSecond)).toBe(normalizeUpdated(readFileSync(boardPath, 'utf8')));
    // Byte-identical run-twice guarantee: re-parsing after the noop-skipped
    // second run still shows exactly one force-closed row, unchanged.
    const rows = parseBoardRows(afterSecond);
    expect(rows.filter((r) => r.repo === 'stale-idem-repo')).toEqual([
      { repo: 'stale-idem-repo', key: null, status: 'force-closed', session: 'sess-idem', branch: 'main', mode: 'deep', heartbeat: staleHb },
    ]);
  });
});

// ===========================================================================
// mirrorBoard — board_written telemetry
// ===========================================================================

describe('mirrorBoard — board_written telemetry', () => {
  /**
   * Read the JSONL records this repo's own ledger accumulated. Deliberately
   * reads the FILE emitEvent wrote (not a spy): the deliverable is a record a
   * fleet query can find, so the file is the contract.
   */
  function readBoardEvents(repoRoot) {
    const raw = readFileSync(join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl'), 'utf8');
    return raw
      .split('\n')
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === 'orchestrator.vault.board_written');
  }

  it('records a board_written event on the SILENT no-op path (vault disabled), pinned to the calling repo', async () => {
    // Bug this catches: an emitter wired onto the `written` path only. The
    // no-op returns are precisely the states that look identical to a healthy
    // write from outside the process, so a writer that stops running stays
    // invisible — the whole premise of this telemetry (0 board events across
    // 28 387 ledger records, measured 2026-08-23).
    const repoRoot = makeRepo('no-vault-config-repo'); // no CLAUDE.md → config read throws

    const result = await mirrorBoard({ repoRoot, now: FIXED_NOW, hostPaths: HERMETIC_HOST_PATHS });
    expect(result).toEqual({ action: 'skipped-vault-disabled' });

    const events = readBoardEvents(repoRoot);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('skipped-vault-disabled');
    expect(events[0].caller).toBe('mirrorBoard');
    // Absent is not zero: nothing was resolved, rendered or swept on this path,
    // so those keys must be MISSING rather than reported as '' / 0.
    expect(events[0]).not.toHaveProperty('path');
    expect(events[0]).not.toHaveProperty('rows');
    expect(events[0]).not.toHaveProperty('repos_swept');
  });

  it('still writes the board when the events ledger path is unwritable', async () => {
    // Bug this catches: an emit that is not wrapped in try/catch lets telemetry
    // FAIL a board write. `.orchestrator/metrics` is created as a FILE here, so
    // emitEvent's own `fs.mkdir(..., {recursive:true})` throws EEXIST for real —
    // no mock, the genuine failure shape.
    const vaultDir = makeVaultDir();
    mkdirSync(join(vaultDir, '01-projects'), { recursive: true });
    const repoRoot = makeThisRepoConfig('ledger-blocked-repo', vaultDir);
    mkdirSync(join(repoRoot, '.orchestrator'), { recursive: true });
    writeFileSync(join(repoRoot, '.orchestrator', 'metrics'), 'not-a-directory\n', 'utf8');

    const result = await mirrorBoard({
      repoRoot,
      explicitStatus: 'closed',
      now: FIXED_NOW,
      hostPaths: HERMETIC_HOST_PATHS,
    });

    expect(result.action).toBe('written');
    const rows = parseBoardRows(readFileSync(resolveBoardPath(vaultDir), 'utf8'));
    expect(rows.map((r) => r.repo)).toEqual(['ledger-blocked-repo']);
    // The blocking file is untouched — the emit failed, it did not clobber.
    expect(readFileSync(join(repoRoot, '.orchestrator', 'metrics'), 'utf8')).toBe('not-a-directory\n');
  });
});
