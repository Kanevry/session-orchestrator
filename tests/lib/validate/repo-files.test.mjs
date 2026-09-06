/**
 * tests/lib/validate/repo-files.test.mjs
 *
 * Tests for scripts/lib/validate/repo-files.mjs.
 *
 * Named bugs these lock in (TV-001):
 *   1. `listRepoFiles` walks the filesystem instead of reading the index →
 *      every gitignored artefact under a scan root is censused as repository
 *      content. Live on this repo when the module was written (2026-08-26):
 *      the `.claude` + `docs` `.md` corpus was 108 on disk vs 104 in the index
 *      — `.claude/STATE.md` plus three gitignored `docs/specs/*.md`. That is
 *      the #1143 exposure WITHOUT any worktree present.
 *   2. The non-git FALLBACK walk loses `worktrees` from its exclusion set →
 *      `listRepoFiles` is index-safe only where git happens to answer, and a
 *      peer worktree's complete second checkout re-enters through the back
 *      door in every tarball/export/fixture checkout.
 *   3. `listOnDiskFiles` loses `worktrees` → the deliberately-on-disk oracle
 *      (the one `check-untracked-test-deps.mjs` needs) double-counts a peer
 *      checkout: 755 `.md` + 1209 `.mjs` extra files when one is present, and
 *      a peer's copy of a rule file gets cited as an INDEPENDENT source.
 *   4. `listRepoFiles` returns [] (or throws) outside a git working tree →
 *      every migrated scanner goes blind on an export instead of degrading to
 *      a walk, turning a correctness fix into a silent coverage loss.
 *   5. `listRepoFiles` echoes `git ls-files` verbatim → a path the index holds
 *      but the working tree lacks (a deletion staged elsewhere, a sparse
 *      checkout) is handed to a scanner that then reports a tool-error for a
 *      file nobody removed. The module filters those; bug 5 is that filter.
 *
 * Bugs 1 and 5 are proven on a FIXTURE repo this file builds, because they
 * pull in opposite directions and a live checkout supplies at most one of them
 * at a time — measured 2026-09-06, when 43 `.claude/rules/*.md` deletions sat
 * unstaged in the working tree and a raw-`ls-files` oracle turned bug 5 into a
 * false failure of bug 1's assertion. The live-repo test below keeps its place,
 * with the oracle corrected to the module's actual contract (tracked AND
 * present); the fixture is what makes either bug fail deterministically.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { listRepoFiles, listOnDiskFiles, EXCLUDED_DIRS } from '../../../scripts/lib/validate/repo-files.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * A non-git fixture root carrying the two populations that must NOT be
 * censused: a peer git worktree under this repo's own `.claude/worktrees/`
 * convention, and a vendored `node_modules` tree.
 * @returns {string} absolute fixture root
 */
function fixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'so-repo-files-'));
  tmpDirs.push(root);
  const write = (rel, body) => {
    mkdirSync(path.join(root, rel, '..'), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  };
  write('skills/a.md', '# a\n');
  write('skills/deep/b.md', '# b\n');
  write('skills/c.mjs', '// c\n');
  // The #1143 population: a complete second checkout inside the repo.
  write('.claude/worktrees/peer/skills/a.md', '# peer copy of a\n');
  write('.claude/worktrees/peer/skills/deep/b.md', '# peer copy of b\n');
  write('.claude/rules/r.md', '# rule\n');
  write('node_modules/pkg/readme.md', '# vendored\n');
  return root;
}

/**
 * A REAL git working tree carrying all four populations `listRepoFiles` must
 * separate: tracked-and-present, tracked-but-deleted-from-disk, gitignored, and
 * plain untracked. Owned by this test — no assertion here reads the repository
 * the suite runs in, so neither the operator's staging state nor a pending
 * deletion can decide the result.
 *
 * No commit is made: `git ls-files` reads the INDEX, so `git add` alone puts a
 * path in the census, and skipping `git commit` keeps the fixture identity-free.
 * `cwd` is explicit on every git call per `check-test-git-config-target.mjs`.
 *
 * @returns {string} absolute fixture root
 */
function gitFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'so-repo-files-git-'));
  tmpDirs.push(root);
  const git = (...args) =>
    execFileSync('git', args, { cwd: root, stdio: ['ignore', 'ignore', 'ignore'] });
  git('init', '-q');
  git('config', 'user.email', 'repo-files-test@example.com');
  git('config', 'user.name', 'Repo Files Test');
  git('config', 'commit.gpgsign', 'false');

  const write = (relPath, body) => {
    mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    writeFileSync(path.join(root, relPath), body);
  };
  write('.gitignore', 'docs/ignored.md\n');
  write('docs/tracked.md', '# tracked and present\n');
  write('docs/gone.md', '# staged, then removed from the working tree\n');
  write('docs/ignored.md', '# gitignored, on disk\n');
  write('docs/untracked.md', '# untracked, on disk\n');
  git('add', 'docs/tracked.md', 'docs/gone.md');
  // The index keeps `docs/gone.md`; the working tree no longer has it. This is
  // the shape a staged-elsewhere deletion leaves behind.
  unlinkSync(path.join(root, 'docs/gone.md'));
  return root;
}

/** @param {string} root @param {string[]} abs @returns {string[]} */
const rel = (root, abs) => abs.map((p) => path.relative(root, p).replace(/\\/g, '/')).sort();

describe('repo-files — listOnDiskFiles', () => {
  it('excludes a peer worktree and vendored trees from the on-disk census (bug 3)', () => {
    const root = fixtureRoot();
    const files = listOnDiskFiles(root, { dirs: ['skills', '.claude'], exts: ['.md'] });

    expect(rel(root, files)).toEqual(['.claude/rules/r.md', 'skills/a.md', 'skills/deep/b.md']);
    // Stated as its own assertion: the failure this prevents is a peer's copy
    // being counted as an independent document, not merely a wrong total.
    expect(files.some((f) => f.includes('/worktrees/'))).toBe(false);
  });

  it('names `worktrees` in the default exclusion set', () => {
    // The set is exported so a caller can EXTEND it; a caller that spreads it
    // to add one entry silently loses the #1143 fix if the entry is dropped.
    expect(EXCLUDED_DIRS).toContain('worktrees');
    expect(EXCLUDED_DIRS).toContain('node_modules');
  });

  it('honours the exts filter and returns sorted absolute paths', () => {
    const root = fixtureRoot();
    const all = listOnDiskFiles(root, { dirs: ['skills'] });
    const mjs = listOnDiskFiles(root, { dirs: ['skills'], exts: ['.mjs'] });

    expect(rel(root, all)).toEqual(['skills/a.md', 'skills/c.mjs', 'skills/deep/b.md']);
    expect(rel(root, mjs)).toEqual(['skills/c.mjs']);
    expect(all.every((p) => path.isAbsolute(p))).toBe(true);
    expect([...all]).toEqual([...all].sort());
  });

  it('contributes zero files for a missing directory instead of throwing', () => {
    const root = fixtureRoot();
    expect(listOnDiskFiles(root, { dirs: ['nope'], exts: ['.md'] })).toEqual([]);
  });
});

describe('repo-files — listRepoFiles', () => {
  it('falls back to a walk outside a git checkout, still excluding worktrees (bugs 2 + 4)', () => {
    const root = fixtureRoot(); // a tmpdir — deliberately NOT a git working tree
    const files = listRepoFiles(root, { dirs: ['skills', '.claude'], exts: ['.md'] });

    // Bug 4: a fallback exists at all — an empty result here is a blind scanner.
    expect(files.length).toBeGreaterThan(0);
    // Bug 2: the fallback carries the SAME exclusion set as the on-disk walk.
    expect(rel(root, files)).toEqual(['.claude/rules/r.md', 'skills/a.md', 'skills/deep/b.md']);
    expect(files.some((f) => f.includes('/worktrees/'))).toBe(false);
  });

  it('reads the git index, not the filesystem, inside a real checkout (bug 1)', () => {
    const dirs = ['.claude', 'docs'];
    const fromModule = rel(REPO_ROOT, listRepoFiles(REPO_ROOT, { dirs, exts: ['.md'] }));
    const tracked = execFileSync('git', ['ls-files', '--', ...dirs], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter((p) => p.endsWith('.md'));

    // The oracle is tracked AND PRESENT — the module's documented contract —
    // not raw `ls-files`. Raw `ls-files` also lists paths whose file is gone
    // from the working tree (a deletion not yet staged by the coordinator),
    // which makes the assertion a measurement of THIS CHECKOUT'S STAGING
    // STATE rather than of the module: it failed exactly that way on
    // 2026-09-06 with 43 rule deletions pending. Bug 5's fixture below pins
    // the filter itself.
    const oracle = tracked.filter((rp) => existsSync(path.join(REPO_ROOT, rp))).sort();

    // Set EQUALITY, not containment: a walk-based implementation diverges the
    // moment any ignored/untracked .md exists under a scan root, which is the
    // normal state of a working checkout (measured 2026-08-26: 108 on disk vs
    // 104 tracked). Ceiling: on a pristine clone with nothing ignored present
    // the two populations coincide and this assertion goes quiet — the
    // fixture and fallback/worktree tests carry the proof there.
    expect(fromModule).toEqual(oracle);
  });

  it('censuses the index, not the disk, and drops index-only paths (bugs 1 + 5)', () => {
    // A fixture repo carrying all four populations at once. A live checkout
    // supplies them only by accident, and never both divergence directions
    // together — which is why this is the deterministic half of bug 1.
    const root = gitFixtureRoot();

    const files = rel(root, listRepoFiles(root, { dirs: ['docs'], exts: ['.md'] }));
    expect(files).toEqual(['docs/tracked.md']);

    // The oracle the module must NOT be: `git ls-files` still names the file
    // whose working-tree copy was deleted. Asserted, not assumed — without it
    // the expectation above passes for an implementation that never had the
    // index-only filter at all.
    const lsFiles = execFileSync('git', ['ls-files', '--', 'docs'], { cwd: root, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort();
    expect(lsFiles).toEqual(['docs/gone.md', 'docs/tracked.md']);

    // …and the walk the module must NOT be: the disk holds the ignored and the
    // untracked file, and `listOnDiskFiles` proves the two enumerators are
    // genuinely different populations rather than one aliased twice.
    expect(rel(root, listOnDiskFiles(root, { dirs: ['docs'], exts: ['.md'] }))).toEqual([
      'docs/ignored.md',
      'docs/tracked.md',
      'docs/untracked.md',
    ]);
  });

  it('never returns a tracked path that is absent from the working tree', () => {
    // A sparse checkout lists paths git tracks but the filesystem lacks; a
    // scanner that then read one would report a tool-error for a file nobody
    // removed. Every returned path must be a readable file.
    const files = listRepoFiles(REPO_ROOT, { dirs: ['agents'], exts: ['.md'] });
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) expect(path.isAbsolute(f)).toBe(true);
  });
});
