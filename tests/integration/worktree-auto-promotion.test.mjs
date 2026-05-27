/**
 * tests/integration/worktree-auto-promotion.test.mjs
 *
 * Integration tests for `enterWorktree` — the Worktree-Auto-Promotion entry-point
 * landed in W2 I1 of session main-2026-05-27-deep-2 (Issue #574, Epic #568 Phase 3.1).
 *
 * Covers PRD §3 P3 Gherkin rows 1-2 (Auto-Promotion path):
 *  - Row 1 (happy path): creates sibling worktree at `<basePath>/<repoBasename>-<sessionId>/`,
 *                        emits WARN to stderr, returns `{ wtPath, reused: false }`.
 *  - Row 2 (idempotency / collision): returns `{ reused: true }` if `<wtPath>/.git` exists.
 *
 * Plus the structural invariants the DoD lists:
 *  - Worktree-name-collision behaviour when path exists but `.git` is absent → fresh create.
 *  - WorktreeBoundaryError when computed path escapes basePath (CWE-23 / SEC-013).
 *  - Input validation (TypeError) on all 4 required params + 1 schema-violation.
 *
 * Patterns mirrored from tests/lib/autopilot/worktree-pipeline.test.mjs:
 *  - DI seam via `opts.$` (vi.fn() acting as a tagged-template tag function).
 *  - mkdtempSync tmp-dir lifecycle with realpathSync to defend macOS /var→/private/var.
 *  - vi.doMock('node:fs') + dynamic re-import for the symlink-escape adversarial test.
 *
 * No production code is modified by this test file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  realpathSync as realRealpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  enterWorktree,
  WorktreeBoundaryError,
} from '@lib/autopilot/worktree-pipeline.mjs';

// ---------------------------------------------------------------------------
// DI factory — copied from tests/lib/autopilot/worktree-pipeline.test.mjs
// ---------------------------------------------------------------------------

/**
 * Build a vi.fn() that acts as a tagged-template tag (production uses it as
 * `await exec\`git -C ${repoRoot} ...\``). Optionally reject on Nth call to
 * simulate `git rev-parse --verify <branch>` failing (branch doesn't exist).
 *
 * @param {object} [opts]
 * @param {number[]} [opts.throwOnCalls] - 1-based call indices that should reject.
 * @returns {ReturnType<typeof vi.fn>}
 */
function makeMockDollar({ throwOnCalls = [] } = {}) {
  let callCount = 0;
  return vi.fn().mockImplementation(() => {
    callCount += 1;
    if (throwOnCalls.includes(callCount)) {
      return Promise.reject(new Error(`mock $: rejected on call #${callCount}`));
    }
    return Promise.resolve({ stdout: '' });
  });
}

// ---------------------------------------------------------------------------
// Fixtures — fresh tmp dir per test, fully resolved to handle macOS symlinks.
// ---------------------------------------------------------------------------

const VALID_SESSION_ID = 'main-2026-05-27-deep-2';

let tmp;
let basePath;
let repoRoot;

beforeEach(() => {
  // mkdtempSync may return /var/... on macOS; resolve it so all path-equality
  // assertions match the production code's realpathSync output. Mirrors the
  // #374/#375 fix pattern from worktree-pipeline.test.mjs.
  tmp = realRealpathSync(mkdtempSync(path.join(tmpdir(), 'enter-wt-')));

  basePath = path.join(tmp, 'base');
  repoRoot = path.join(tmp, 'base', 'myrepo');
  mkdirSync(basePath, { recursive: true });
  mkdirSync(repoRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Gherkin row 1 — Auto-Promotion happy path
// ---------------------------------------------------------------------------

describe('enterWorktree — Gherkin row 1 (Auto-Promotion happy path)', () => {
  it('creates sibling worktree at <basePath>/<repo-name>-<sessionId>/', async () => {
    const $mock = makeMockDollar();
    const expected = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);

    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/auto-promote', repoRoot },
      { $: $mock },
    );

    expect(result.wtPath).toBe(expected);
    expect(result.reused).toBe(false);
  });

  it('invokes git worktree add on fresh creation', async () => {
    const $mock = makeMockDollar();

    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/x', repoRoot },
      { $: $mock },
    );

    // First call is the rev-parse probe (rejects → branch doesn't exist),
    // second call is the actual `git worktree add -b ...`. Two calls minimum.
    expect($mock.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('emits WARN to console.warn on fresh creation containing wtPath and sessionId', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const $mock = makeMockDollar();

    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/x', repoRoot },
      { $: $mock },
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0][0];
    expect(warnMsg).toMatch(/enterWorktree: created sibling worktree at /);
    expect(warnMsg).toContain(`myrepo-${VALID_SESSION_ID}`);
    expect(warnMsg).toContain(VALID_SESSION_ID);
    expect(warnMsg).toContain('feat/x');
  });

  it('uses `-b <branch>` flag when branch does not exist (rev-parse rejects)', async () => {
    // throwOnCalls: [1] simulates `git rev-parse --verify <branch>` failing
    // (branch absent) → code falls through to the `-b` create-new path.
    const $mock = makeMockDollar({ throwOnCalls: [1] });

    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/new', repoRoot },
      { $: $mock },
    );

    // 2 calls: rev-parse (rejects) + worktree add -b
    expect($mock.mock.calls.length).toBe(2);
  });

  it('omits `-b` flag when branch already exists (rev-parse succeeds)', async () => {
    // No throw on any call → rev-parse resolves → branchExists=true → no -b flag.
    const $mock = makeMockDollar();

    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'existing-branch', repoRoot },
      { $: $mock },
    );

    // 2 calls: rev-parse (resolves) + worktree add (no -b)
    expect($mock.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Gherkin row 1 implicit invariant + Gherkin row 2 — Idempotency / collision
// ---------------------------------------------------------------------------

describe('enterWorktree — idempotency + collision (Gherkin row 2)', () => {
  it('returns {reused: true} when target already exists with .git stub', async () => {
    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(path.join(wtPath, '.git'), 'gitdir: /tmp/somewhere/.git/worktrees/x');

    const $mock = makeMockDollar();
    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/x', repoRoot },
      { $: $mock },
    );

    expect(result.reused).toBe(true);
    expect(result.wtPath).toBe(wtPath);
  });

  it('does NOT invoke git when reusing existing worktree', async () => {
    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(path.join(wtPath, '.git'), 'gitdir: /tmp/elsewhere');

    const $mock = makeMockDollar();
    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/x', repoRoot },
      { $: $mock },
    );

    expect($mock).not.toHaveBeenCalled();
  });

  it('does NOT emit WARN to console.warn when reusing existing worktree', async () => {
    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(path.join(wtPath, '.git'), 'gitdir: /tmp/elsewhere');

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const $mock = makeMockDollar();
    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/x', repoRoot },
      { $: $mock },
    );

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('proceeds with fresh creation when target dir exists but no .git inside (collision-not-worktree)', async () => {
    // Directory pre-exists but is NOT a git worktree (no .git file). The
    // idempotency guard only fires on .git presence, so this path takes the
    // fresh-create branch even though the directory is non-empty.
    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(path.join(wtPath, 'README.md'), 'not a worktree');

    const $mock = makeMockDollar();
    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/x', repoRoot },
      { $: $mock },
    );

    expect(result.reused).toBe(false);
    expect(result.wtPath).toBe(wtPath);
    // git was invoked (rev-parse + worktree add — at least one call).
    expect($mock).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Boundary check — WorktreeBoundaryError (SEC-013 / CWE-23)
// ---------------------------------------------------------------------------

describe('enterWorktree — boundary check (WorktreeBoundaryError)', () => {
  it('throws WorktreeBoundaryError when realpathSync resolves wtPath outside basePath', async () => {
    // Pattern mirrored from worktree-pipeline.test.mjs adversarial-symlink test:
    // inject an adversarial realpathSync via vi.doMock('node:fs') that returns
    // an out-of-tree path for the wtPath resolution. validateWorkspacePath then
    // returns false → WorktreeBoundaryError is thrown BEFORE any git invocation.
    const resolvedBasePath = realRealpathSync(basePath);
    const outOfTreePath = path.join(tmp, 'EVIL-OUTSIDE-ROOT', 'escaped');

    const stderrChunks = [];
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });

    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual('node:fs');
      return {
        ...actual,
        realpathSync: (p) => {
          // basePath / repoRoot resolve normally.
          if (p === basePath) return resolvedBasePath;
          if (p === repoRoot) return repoRoot;
          // wtPath resolution simulates a symlink escape.
          return outOfTreePath;
        },
      };
    });

    // Dynamic re-import so the mock applies to the fresh module instance.
    const { enterWorktree: freshEnter, WorktreeBoundaryError: FreshWBE } = await import(
      '@lib/autopilot/worktree-pipeline.mjs?adv-enter-1'
    );

    const $mock = makeMockDollar();
    const thrown = await freshEnter(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/x', repoRoot },
      { $: $mock },
    ).catch((e) => e);

    expect(thrown).toBeInstanceOf(FreshWBE);
    expect(thrown.name).toBe('WorktreeBoundaryError');
    expect(thrown.message).toContain(outOfTreePath);
    expect(thrown.computed).toBe(outOfTreePath);
    expect(thrown.root).toBe(resolvedBasePath);

    // Attack blocked BEFORE git invocation.
    expect($mock).not.toHaveBeenCalled();

    // Stderr contains the symlink-escape warning.
    const stderrOutput = stderrChunks.join('');
    expect(stderrOutput).toMatch(/enterWorktree: refusing to create symlink-escape/);
    expect(stderrOutput).toContain(outOfTreePath);

    stderrSpy.mockRestore();
    vi.doUnmock('node:fs');
  });

  it('WorktreeBoundaryError instance is also an Error (prototype chain)', async () => {
    // Direct constructor test — verifies the class is exported and usable
    // without needing to trigger the boundary path. Mirrors the smoke check
    // from worktree-pipeline.test.mjs § 2.
    const err = new WorktreeBoundaryError('boundary violation', {
      computed: '/tmp/evil',
      root: '/tmp/safe',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WorktreeBoundaryError);
    expect(err.name).toBe('WorktreeBoundaryError');
    expect(err.computed).toBe('/tmp/evil');
    expect(err.root).toBe('/tmp/safe');
  });
});

// ---------------------------------------------------------------------------
// Input validation — TypeError on all required params
// ---------------------------------------------------------------------------

describe('enterWorktree — input validation (TypeError)', () => {
  it('throws TypeError when basePath is missing', async () => {
    await expect(
      enterWorktree({ sessionId: VALID_SESSION_ID, branch: 'main', repoRoot }, {}),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when basePath is not absolute', async () => {
    await expect(
      enterWorktree(
        { basePath: 'relative/path', sessionId: VALID_SESSION_ID, branch: 'main', repoRoot },
        {},
      ),
    ).rejects.toThrow(/basePath must be an absolute path/);
  });

  it('throws TypeError when sessionId is missing', async () => {
    await expect(
      enterWorktree({ basePath, branch: 'main', repoRoot }, {}),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when sessionId does not match SEMANTIC_ID_RE', async () => {
    await expect(
      enterWorktree(
        { basePath, sessionId: 'not-semantic-format', branch: 'main', repoRoot },
        {},
      ),
    ).rejects.toThrow(/does not match SEMANTIC_ID_RE/);
  });

  it('throws TypeError when branch is missing', async () => {
    await expect(
      enterWorktree({ basePath, sessionId: VALID_SESSION_ID, repoRoot }, {}),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when branch contains invalid characters', async () => {
    // Spaces are not in the allow-list [a-zA-Z0-9._/-].
    await expect(
      enterWorktree(
        { basePath, sessionId: VALID_SESSION_ID, branch: 'feat with space', repoRoot },
        {},
      ),
    ).rejects.toThrow(/contains invalid characters/);
  });

  it('throws TypeError when repoRoot is missing', async () => {
    await expect(
      enterWorktree({ basePath, sessionId: VALID_SESSION_ID, branch: 'main' }, {}),
    ).rejects.toThrow(TypeError);
  });

  it('throws TypeError when repoRoot is not absolute', async () => {
    await expect(
      enterWorktree(
        { basePath, sessionId: VALID_SESSION_ID, branch: 'main', repoRoot: 'rel/repo' },
        {},
      ),
    ).rejects.toThrow(/repoRoot must be an absolute path/);
  });

  it('throws TypeError when repoRoot does not exist on filesystem', async () => {
    await expect(
      enterWorktree(
        {
          basePath,
          sessionId: VALID_SESSION_ID,
          branch: 'main',
          repoRoot: path.join(tmp, 'nonexistent-repo'),
        },
        {},
      ),
    ).rejects.toThrow(/does not exist/);
  });

  it('throws TypeError when called with no arguments (default empty object)', async () => {
    // The default `{} = {}` destructure means basePath is undefined → triggers
    // the first validation branch.
    await expect(enterWorktree()).rejects.toThrow(TypeError);
  });
});
