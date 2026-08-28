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
  readFileSync,
  existsSync,
  mkdirSync,
  realpathSync as realRealpathSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  enterWorktree,
  WorktreeBoundaryError,
  WorktreePromotionBranchError,
} from '@lib/autopilot/worktree-pipeline.mjs';
import {
  detectAutoPromotedWorktree,
  isWorktreeClean,
  PROMOTION_MARKER_RELPATH,
} from '@lib/session-end/worktree-cleanup.mjs';

// ---------------------------------------------------------------------------
// DI factory — copied from tests/lib/autopilot/worktree-pipeline.test.mjs
// ---------------------------------------------------------------------------

/**
 * Build a vi.fn() that acts as a tagged-template tag (production uses it as
 * `await exec\`git -C ${repoRoot} ...\``).
 *
 * `throwOnMatch` is preferred over the 1-based `throwOnCalls` since #1067 added
 * the `git worktree list --porcelain` probe as the FIRST git call: matching on
 * the command text survives further call-order changes, an index does not.
 *
 * @param {object} [opts]
 * @param {number[]} [opts.throwOnCalls]  - 1-based call indices that should reject.
 * @param {RegExp} [opts.throwOnMatch]    - reject any call whose command matches.
 * @param {string} [opts.worktreeList]    - stdout returned for `git worktree list
 *   --porcelain` (verbatim porcelain text; default '' = no worktree records).
 * @returns {ReturnType<typeof vi.fn>}
 *
 * NOTE on `rev-parse`: a bare `mockImplementation` that RESOLVES everything
 * means "every ref exists" — which, since the `so/<sessionId>` three-state fix,
 * routes the promotion path into branch-REUSE. Tests that want the create-new
 * arm must therefore reject rev-parse explicitly (`throwOnMatch: /rev-parse/`).
 */
function makeMockDollar({ throwOnCalls = [], throwOnMatch = null, worktreeList = '' } = {}) {
  let callCount = 0;
  return vi.fn().mockImplementation((strings, ...subs) => {
    callCount += 1;
    const cmd = reconstructCommand([strings, ...subs]);
    if (throwOnCalls.includes(callCount) || (throwOnMatch && throwOnMatch.test(cmd))) {
      return Promise.reject(new Error(`mock $: rejected on call #${callCount} (${cmd})`));
    }
    if (cmd.includes('worktree list --porcelain')) {
      return Promise.resolve({ stdout: worktreeList });
    }
    return Promise.resolve({ stdout: '' });
  });
}

/**
 * Render `git worktree list --porcelain` output for a set of checked-out
 * branches. Mirrors the real record shape (worktree / HEAD / branch, blank-line
 * separated) so the parser under test sees production-shaped input.
 *
 * @param {Array<{path: string, branch: string}>} records
 * @returns {string}
 */
function porcelainListing(records) {
  return records
    .map(
      (r) =>
        `worktree ${r.path}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/${r.branch}\n`,
    )
    .join('\n');
}

/**
 * Reconstruct the full command string from one tagged-template `$` invocation.
 *
 * The production code calls `await exec\`git -C ${repoRoot} worktree add -b ${branch} ${wtPath}\``,
 * so each `vi.fn().mock.calls[i]` is `[stringsArray, ...substitutions]`. We
 * interleave the literal segments with their interpolated values to recover the
 * exact command tokens the SUT would have run. Used to assert on the presence
 * or absence of the `-b` flag (new-branch vs existing-branch), which a
 * call-count-only assertion cannot distinguish.
 *
 * @param {[TemplateStringsArray, ...unknown[]]} call - One entry of mock.calls.
 * @returns {string}
 */
function reconstructCommand(call) {
  const [strings, ...subs] = call;
  let out = '';
  for (let i = 0; i < strings.length; i += 1) {
    out += strings[i];
    if (i < subs.length) out += String(subs[i]);
  }
  return out;
}

/**
 * Whitespace-tokenise a reconstructed command. Token-level membership is the
 * robust way to assert the `-b` flag is present/absent — a naive substring
 * `.includes('-b')` could false-match inside a branch name like `feat-bar`.
 *
 * @param {string} cmd
 * @returns {string[]}
 */
function commandTokens(cmd) {
  return cmd.trim().split(/\s+/);
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
    // throwOnMatch simulates `git rev-parse --verify <branch>` failing (branch
    // absent) → code falls through to the `-b` create-new path.
    const $mock = makeMockDollar({ throwOnMatch: /rev-parse/ });

    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/new', repoRoot },
      { $: $mock },
    );

    // 3 calls: worktree list (#1067 probe) + rev-parse (rejects) + worktree add -b
    expect($mock.mock.calls.length).toBe(3);

    // #579 Gap 2: command-token CAPTURE on the `worktree add` call.
    // A refactor swapping the new-branch/existing-branch arms would pass the
    // call-count assertion above but ship a regression. Capturing the actual
    // tokens proves the `-b` flag IS present on the create-new path.
    const addTokens = commandTokens(reconstructCommand($mock.mock.calls[2]));
    expect(addTokens).toContain('worktree');
    expect(addTokens).toContain('add');
    expect(addTokens).toContain('-b');
    expect(addTokens).toContain('feat/new');
    // The new-branch invocation form is `worktree add -b <branch> <wtPath>`:
    // `-b` immediately precedes the branch name.
    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    expect(reconstructCommand($mock.mock.calls[2])).toBe(
      `git -C ${repoRoot} worktree add -b feat/new ${wtPath}`,
    );
    // #1067: the non-promotion path reports the requested branch verbatim.
    expect(result.branch).toBe('feat/new');
    expect(result.promotedFrom).toBeUndefined();
  });

  it('omits `-b` flag when branch already exists (rev-parse succeeds)', async () => {
    // No throw on any call → rev-parse resolves → branchExists=true → no -b flag.
    const $mock = makeMockDollar();

    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'existing-branch', repoRoot },
      { $: $mock },
    );

    // 3 calls: worktree list (#1067 probe) + rev-parse (resolves) + worktree add
    expect($mock.mock.calls.length).toBe(3);

    // #579 Gap 2: command-token CAPTURE on the `worktree add` call.
    // Failure-mode guard: if a refactor re-created an EXISTING branch with `-b`,
    // git would error at runtime. This asserts the existing-branch path does NOT
    // pass `-b` (checkout-existing, not create-new).
    const addTokens = commandTokens(reconstructCommand($mock.mock.calls[2]));
    expect(addTokens).toContain('worktree');
    expect(addTokens).toContain('add');
    expect(addTokens).not.toContain('-b');
    expect(addTokens).toContain('existing-branch');
    // The existing-branch invocation form is `worktree add <wtPath> <branch>`:
    // no `-b`. The bare branch name (a ref to checkout) follows the path.
    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    expect(reconstructCommand($mock.mock.calls[2])).toBe(
      `git -C ${repoRoot} worktree add ${wtPath} existing-branch`,
    );
    expect(result.branch).toBe('existing-branch');
    expect(result.promotedFrom).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// #1067 — source branch already checked out → promote onto so/<sessionId>
// ---------------------------------------------------------------------------

describe('enterWorktree — source branch already checked out (#1067)', () => {
  it('creates the worktree on so/<sessionId> when <branch> is checked out by repoRoot', async () => {
    // The bug: Phase 0.5 passes the CURRENT HEAD (typically `main`), which
    // repoRoot itself has checked out, and git refuses the second checkout with
    // `fatal: 'main' is already used by worktree at '<repoRoot>'`. Before the
    // fix the SUT emitted exactly that invalid `worktree add <wtPath> main`.
    const $mock = makeMockDollar({
      worktreeList: porcelainListing([{ path: repoRoot, branch: 'main' }]),
      // `so/<id>` does not exist yet → the create-new arm.
      throwOnMatch: /rev-parse/,
    });

    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'main', repoRoot },
      { $: $mock },
    );

    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);

    // 3 calls: worktree list + the `so/<id>` existence probe + worktree add.
    // The SOURCE branch is not probed — a branch a worktree has checked out
    // exists by construction.
    expect($mock.mock.calls.length).toBe(3);
    expect(reconstructCommand($mock.mock.calls[0])).toBe(
      `git -C ${repoRoot} worktree list --porcelain`,
    );
    expect(reconstructCommand($mock.mock.calls[1])).toBe(
      `git -C ${repoRoot} rev-parse --verify --quiet refs/heads/so/${VALID_SESSION_ID}`,
    );
    // Exact argv — `main` is only the START POINT; the checkout lands on so/<id>.
    expect(reconstructCommand($mock.mock.calls[2])).toBe(
      `git -C ${repoRoot} worktree add -b so/${VALID_SESSION_ID} ${wtPath} main`,
    );

    expect(result).toEqual({
      wtPath,
      reused: false,
      branch: `so/${VALID_SESSION_ID}`,
      promotedFrom: 'main',
    });
  });

  it('WARN names the promotion branch and its source', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const $mock = makeMockDollar({
      worktreeList: porcelainListing([{ path: repoRoot, branch: 'main' }]),
      throwOnMatch: /rev-parse/,
    });

    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'main', repoRoot },
      { $: $mock },
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnMsg = warnSpy.mock.calls[0][0];
    expect(warnMsg).toContain(`branch=so/${VALID_SESSION_ID}`);
    expect(warnMsg).toContain('promoted from main');
  });

  it('keeps the plain checkout argv when a DIFFERENT branch is the checked-out one', async () => {
    // Discrimination guard: the decision is set-membership of `branch`, not
    // "any worktree exists". A blanket promotion would fail this test.
    const $mock = makeMockDollar({
      worktreeList: porcelainListing([
        { path: repoRoot, branch: 'main' },
        { path: path.join(basePath, 'other-wt'), branch: 'feat/other' },
      ]),
    });

    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'existing-branch', repoRoot },
      { $: $mock },
    );

    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    expect($mock.mock.calls.length).toBe(3);
    expect(reconstructCommand($mock.mock.calls[2])).toBe(
      `git -C ${repoRoot} worktree add ${wtPath} existing-branch`,
    );
    expect(result.branch).toBe('existing-branch');
    expect(result.promotedFrom).toBeUndefined();
  });

  it('falls back to the pre-#1067 argv when `git worktree list` itself fails', async () => {
    // Fail-direction: an unusable listing must degrade to git's own loud
    // `already used by worktree` error, never to a silently wrong branch.
    const $mock = makeMockDollar({ throwOnMatch: /worktree list/ });

    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'main', repoRoot },
      { $: $mock },
    );

    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    expect(reconstructCommand($mock.mock.calls[2])).toBe(
      `git -C ${repoRoot} worktree add ${wtPath} main`,
    );
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

// ---------------------------------------------------------------------------
// #1067 — real-git proof (no executor mock)
// ---------------------------------------------------------------------------

describe('enterWorktree — real git repository (#1067)', () => {
  it(
    'promotes onto so/<sessionId> against a real repo with main checked out',
    { timeout: 20_000 },
    async () => {
      // Issue #1067 AC: "Ein echter temporärer Git-Repository-Test deckt den Fall
      // 'Source-Branch bereits ausgecheckt' ab; kein reiner Executor-Mock."
      // The mocked suite above cannot catch a wrong argv that git itself rejects
      // — only a real `git worktree add` can.
      const git = (cwd, args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

      git(repoRoot, ['init', '-q']);
      git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      git(repoRoot, ['config', 'user.email', 'test@example.invalid']);
      git(repoRoot, ['config', 'user.name', 'Test']);
      git(repoRoot, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n');
      git(repoRoot, ['add', 'README.md']);
      git(repoRoot, ['commit', '-q', '-m', 'init']);

      expect(git(repoRoot, ['branch', '--show-current']).trim()).toBe('main');

      // Real zx executor (no opts.$) — this is the production call shape.
      const result = await enterWorktree({
        basePath,
        sessionId: VALID_SESSION_ID,
        branch: 'main',
        repoRoot,
      });

      expect(result.branch).toBe(`so/${VALID_SESSION_ID}`);
      expect(result.promotedFrom).toBe('main');
      expect(git(result.wtPath, ['branch', '--show-current']).trim()).toBe(
        `so/${VALID_SESSION_ID}`,
      );
      // Source worktree untouched: still on main, same commit.
      expect(git(repoRoot, ['branch', '--show-current']).trim()).toBe('main');
      expect(git(result.wtPath, ['rev-parse', 'HEAD']).trim()).toBe(
        git(repoRoot, ['rev-parse', 'HEAD']).trim(),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// `so/<sessionId>` already exists — three states, one table
//
// The bug: `git worktree remove` deletes the DIRECTORY, not the branch. A
// second promotion for the same session id then ran `worktree add -b so/<id>`
// against a branch that already existed and died with
// `fatal: a branch named 'so/<id>' already exists` — straight out of Phase 0.5,
// where the operator has no repair path in front of him.
// ---------------------------------------------------------------------------

describe('enterWorktree — promotion branch so/<sessionId> already exists', () => {
  const promoBranch = () => `so/${VALID_SESSION_ID}`;

  const states = [
    {
      name: '(a) absent → creates it at the source branch',
      otherWorktrees: [],
      revParseRejects: true,
      expectedAddArgv: (wtPath) => `worktree add -b ${promoBranch()} ${wtPath} main`,
      expectReusedBranch: undefined,
    },
    {
      name: '(b) exists but checked out nowhere → REUSES it (no -b)',
      otherWorktrees: [],
      revParseRejects: false,
      expectedAddArgv: (wtPath) => `worktree add ${wtPath} ${promoBranch()}`,
      expectReusedBranch: true,
    },
  ];

  it.each(states)('$name', async ({ otherWorktrees, revParseRejects, expectedAddArgv, expectReusedBranch }) => {
    const $mock = makeMockDollar({
      worktreeList: porcelainListing([
        { path: repoRoot, branch: 'main' },
        ...otherWorktrees,
      ]),
      ...(revParseRejects ? { throwOnMatch: /rev-parse/ } : {}),
    });

    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'main', repoRoot },
      { $: $mock },
    );

    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    const addCall = reconstructCommand($mock.mock.calls.at(-1));
    expect(addCall).toBe(`git -C ${repoRoot} ${expectedAddArgv(wtPath)}`);
    expect(result.branch).toBe(promoBranch());
    expect(result.promotedFrom).toBe('main');
    expect(result.reusedBranch).toBe(expectReusedBranch);
  });

  it('(c) checked out by ANOTHER worktree → refuses with WorktreePromotionBranchError', async () => {
    const foreignWt = path.join(basePath, 'someone-elses-worktree');
    const $mock = makeMockDollar({
      worktreeList: porcelainListing([
        { path: repoRoot, branch: 'main' },
        { path: foreignWt, branch: `so/${VALID_SESSION_ID}` },
      ]),
    });

    const thrown = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'main', repoRoot },
      { $: $mock },
    ).catch((e) => e);

    expect(thrown).toBeInstanceOf(WorktreePromotionBranchError);
    expect(thrown.name).toBe('WorktreePromotionBranchError');
    // The operator must be told WHERE — a refusal he cannot act on is a dead end.
    expect(thrown.message).toContain(foreignWt);
    expect(thrown.branch).toBe(`so/${VALID_SESSION_ID}`);
    expect(thrown.checkedOutAt).toBe(foreignWt);

    // Refusal means refusal: no worktree was added, no directory created.
    const issued = $mock.mock.calls.map((c) => reconstructCommand(c));
    expect(issued.some((c) => c.includes('worktree add'))).toBe(false);
    expect(existsSync(path.join(basePath, `myrepo-${VALID_SESSION_ID}`))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Promotion marker — the fact that survives the #1069 process boundary
// ---------------------------------------------------------------------------

describe('enterWorktree — promotion marker (#1069)', () => {
  function readMarker(wtPath) {
    return JSON.parse(readFileSync(path.join(wtPath, PROMOTION_MARKER_RELPATH), 'utf8'));
  }

  it('writes .orchestrator/promoted-from.json recording branch, session label and a HASHED source root', async () => {
    const $mock = makeMockDollar({
      worktreeList: porcelainListing([{ path: repoRoot, branch: 'main' }]),
      throwOnMatch: /rev-parse/,
    });

    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'main', repoRoot },
      { $: $mock },
    );

    const marker = readMarker(result.wtPath);
    expect(marker.branch).toBe(`so/${VALID_SESSION_ID}`);
    expect(marker.source_session_id).toBe(VALID_SESSION_ID);
    expect(marker.source_root_basename).toBe('myrepo');
    expect(marker.source_root_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Date.parse(marker.promoted_at)).not.toBeNaN();
    // No absolute path may appear in the payload — the hash exists precisely so
    // the operator's filesystem layout never lands in a shippable file.
    expect(JSON.stringify(marker)).not.toContain(repoRoot);
    expect(JSON.stringify(marker)).not.toContain(basePath);
  });

  it('records the plain branch (not so/…) when no promotion happened', async () => {
    const $mock = makeMockDollar(); // nothing checked out → non-promotion path
    const result = await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'existing-branch', repoRoot },
      { $: $mock },
    );
    expect(readMarker(result.wtPath).branch).toBe('existing-branch');
  });

  it('does NOT write a marker on the reuse path (no branch was chosen)', async () => {
    const wtPath = path.join(basePath, `myrepo-${VALID_SESSION_ID}`);
    mkdirSync(wtPath, { recursive: true });
    writeFileSync(path.join(wtPath, '.git'), 'gitdir: /tmp/elsewhere');

    await enterWorktree(
      { basePath, sessionId: VALID_SESSION_ID, branch: 'feat/x', repoRoot },
      { $: makeMockDollar() },
    );

    expect(existsSync(path.join(wtPath, PROMOTION_MARKER_RELPATH))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Real-git proof: enterWorktree → marker → session-end Phase 4a detection
//
// The mocked suites above cannot prove the round trip, because the thing under
// test is a file written by one module and read by another across a process
// boundary. This runs the real zx executor, the real git, and the real
// `detectAutoPromotedWorktree` with a session id that appears NOWHERE in the
// worktree's path or branch — the #1069 situation, verbatim.
// ---------------------------------------------------------------------------

describe('enterWorktree → detectAutoPromotedWorktree round trip (real git, #1069)', () => {
  it(
    'a session with a DIFFERENT id still detects the worktree, via the marker',
    { timeout: 20_000 },
    async () => {
      const git = (cwd, args) =>
        execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

      git(repoRoot, ['init', '-q']);
      git(repoRoot, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
      git(repoRoot, ['config', 'user.email', 'test@example.invalid']);
      git(repoRoot, ['config', 'user.name', 'Test']);
      git(repoRoot, ['config', 'commit.gpgsign', 'false']);
      writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n');
      // Reproduce THIS repo's `.orchestrator/` shape: partly tracked, so git
      // does NOT collapse the directory into a single `?? .orchestrator/` line
      // and the marker surfaces as its own untracked entry. That is the exact
      // configuration in which an unfiltered marker would make every promoted
      // worktree read dirty.
      mkdirSync(path.join(repoRoot, '.orchestrator'), { recursive: true });
      writeFileSync(path.join(repoRoot, '.orchestrator', 'keep.json'), '{}\n');
      git(repoRoot, ['add', 'README.md', '.orchestrator/keep.json']);
      git(repoRoot, ['commit', '-q', '-m', 'init']);

      // Real zx executor — the production call shape.
      const result = await enterWorktree({
        basePath,
        sessionId: VALID_SESSION_ID,
        branch: 'main',
        repoRoot,
      });

      const marker = JSON.parse(
        readFileSync(path.join(result.wtPath, PROMOTION_MARKER_RELPATH), 'utf8'),
      );
      expect(marker.branch).toBe(`so/${VALID_SESSION_ID}`);
      expect(git(result.wtPath, ['branch', '--show-current']).trim()).toBe(marker.branch);

      // The #1069 boundary: session-end runs under a session id that never
      // touched this worktree. The legacy basename key CANNOT match it.
      const newSessionId = 'main-2026-08-28-session-9';
      expect(path.basename(result.wtPath)).not.toContain(newSessionId);

      const detected = detectAutoPromotedWorktree(result.wtPath, newSessionId);
      expect(detected).toEqual({
        wtPath: result.wtPath,
        sessionId: VALID_SESSION_ID,
        branch: `so/${VALID_SESSION_ID}`,
        source: 'marker',
      });

      // Same call from the MAIN checkout must stay null — the marker lives only
      // in the promoted worktree, so the source repo is never a cleanup target.
      expect(detectAutoPromotedWorktree(repoRoot, newSessionId)).toBeNull();

      // …and the marker must not cost Phase 4a its clean path. Real git, real
      // porcelain: the ONLY untracked entry is the marker we just wrote.
      expect(git(result.wtPath, ['status', '--porcelain'])).toBe(
        '?? .orchestrator/promoted-from.json\n',
      );
      expect(isWorktreeClean(result.wtPath)).toBe(true);
    },
  );
});
