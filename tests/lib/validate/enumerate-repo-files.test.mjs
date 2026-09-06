/**
 * tests/lib/validate/enumerate-repo-files.test.mjs
 *
 * Tests for `scripts/lib/validate/enumerate-repo-files.mjs` (GitLab #1248).
 *
 * THE BUG each case catches, stated before it is written (TV-001):
 *
 *   1. An existence-checking validator enumerating via the bare git index
 *      cannot see an UNTRACKED file, so a doc/checker written but not yet
 *      staged is invisible to it — clean report on the tree that carries the
 *      defect (#1248). `listRepoFiles()` fails this; `enumerateRepoFiles()`
 *      must not.
 *   2. The naive repair (a bare `readdirSync` walk) reintroduces #1143: a
 *      gitignored tree — a worktree under `.claude/worktrees/`, a private
 *      `docs/specs/*.md` — enters the census as repository content.
 *      `listOnDiskFiles()` fails this; `enumerateRepoFiles()` must not.
 *   3. A prune entry expressed as a path PREFIX (`docs/scratch`) is not a
 *      directory basename, so a basename-only exclusion set silently keeps it.
 *   4. On a non-git root (tarball export, vendored copy) the enumerator must
 *      still answer rather than return nothing.
 *   5. An EACCES file counts as ABSENT. A bare `catch { continue }` on the
 *      stat cannot tell "git lists it, the checkout lacks it" from "the file
 *      is there and this process may not open it", so an unreadable file
 *      silently leaves the census. Measured downstream: with `README.md`
 *      unreadable, `collectDriftHits()` swept ZERO files, returned `status 1`
 *      = no-match, and `evaluateDriftSweep()` said `ok: true` — the release
 *      drift gate passing on a file it could not open. `enumerateRepoFiles()`
 *      must THROW there so the sweep is inconclusive (status 128), while
 *      ENOENT keeps skipping.
 */

import { describe, expect, it, afterEach } from 'vitest';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PRUNE,
  RepoEnumerationError,
  enumerateRepoFiles,
} from '../../../scripts/lib/validate/enumerate-repo-files.mjs';
import { listOnDiskFiles, listRepoFiles } from '../../../scripts/lib/validate/repo-files.mjs';
import { fixtureGit, makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';

const roots = [];

/**
 * `git` in a fixture, routed through {@link fixtureGit} — see that module's
 * header for why both the background-writer flags and the config-isolation
 * env are needed.
 *
 * @param {string} cwd
 * @param {string[]} args
 */
function git(cwd, args) {
  fixtureGit(args, cwd, { stdio: ['ignore', 'ignore', 'ignore'] });
}

/** @param {string} root @param {string} rel @param {string} [body] */
function write(root, rel, body = 'x\n') {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body, 'utf8');
  return abs;
}

/** A tmp git repo with one tracked file and a `.gitignore`. */
function gitFixture() {
  const root = makeTmpDir('enumerate-repo-files-');
  roots.push(root);
  write(root, '.gitignore', 'ignored/\n.orchestrator/tmp/\n');
  write(root, 'docs/tracked.md');
  git(root, ['init', '-q']);
  git(root, [
    '-c',
    'user.email=t@example.com',
    '-c',
    'user.name=t',
    'add',
    '.gitignore',
    'docs/tracked.md',
  ]);
  git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'base']);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    removeTree(root);
  }
});

describe('enumerateRepoFiles — population', () => {
  it('sees an UNTRACKED file the git index cannot (the #1248 bug)', () => {
    const root = gitFixture();
    write(root, 'docs/untracked.md');

    const seen = enumerateRepoFiles({ repoRoot: root, dirs: ['docs'], exts: ['.md'] });
    expect(seen).toContain(path.join(root, 'docs/untracked.md'));
    expect(seen).toContain(path.join(root, 'docs/tracked.md'));

    // The fake regression, executed rather than asserted in prose: the
    // enumerator this replaces misses exactly that file.
    expect(listRepoFiles(root, { dirs: ['docs'], exts: ['.md'] })).not.toContain(
      path.join(root, 'docs/untracked.md'),
    );
  });

  it('does NOT see a gitignored file, where a bare filesystem walk does (#1143)', () => {
    const root = gitFixture();
    write(root, 'ignored/secret.md');

    expect(enumerateRepoFiles({ repoRoot: root, exts: ['.md'] })).not.toContain(
      path.join(root, 'ignored/secret.md'),
    );
    // The naive repair would have: the walk cannot read `.gitignore`.
    expect(listOnDiskFiles(root, { exts: ['.md'] })).toContain(
      path.join(root, 'ignored/secret.md'),
    );
  });

  it('prunes a caller-supplied path-PREFIX, which a basename-only exclusion set would keep', () => {
    const root = gitFixture();
    write(root, 'docs/scratch/note.md');
    write(root, 'docs/keep.md');

    const prune = [...DEFAULT_PRUNE, 'docs/scratch'];
    const seen = enumerateRepoFiles({ repoRoot: root, exts: ['.md'], prune });
    expect(seen).not.toContain(path.join(root, 'docs/scratch/note.md'));
    expect(seen).toContain(path.join(root, 'docs/keep.md'));
    // Without the prefix entry the same tree IS enumerated — the fake regression.
    expect(enumerateRepoFiles({ repoRoot: root, exts: ['.md'] })).toContain(
      path.join(root, 'docs/scratch/note.md'),
    );
  });

  it('prunes node_modules by segment, at any depth', () => {
    const root = gitFixture();
    write(root, 'skills/demo/node_modules/dep/README.md');
    expect(enumerateRepoFiles({ repoRoot: root, exts: ['.md'] })).not.toContain(
      path.join(root, 'skills/demo/node_modules/dep/README.md'),
    );
  });

  it('still enumerates on a NON-git root, applying the same prune list', () => {
    const root = makeTmpDir('enumerate-repo-files-nogit-');
    roots.push(root);
    write(root, 'docs/plain.md');
    write(root, 'docs/node_modules/dep/README.md');
    write(root, 'scratch/tmp/note.md');

    const seen = enumerateRepoFiles({
      repoRoot: root,
      exts: ['.md'],
      prune: [...DEFAULT_PRUNE, 'scratch/tmp'],
    });
    expect(seen).toEqual([path.join(root, 'docs/plain.md')]);
  });

  it('filters by extension and returns sorted absolute paths', () => {
    const root = gitFixture();
    write(root, 'docs/b.md');
    write(root, 'docs/a.md');
    write(root, 'docs/c.txt');

    const seen = enumerateRepoFiles({ repoRoot: root, dirs: ['docs'], exts: ['md'] });
    expect(seen.every((f) => path.isAbsolute(f))).toBe(true);
    expect(seen).toEqual([...seen].sort());
    expect(seen.some((f) => f.endsWith('.txt'))).toBe(false);
  });
});

describe('enumerateRepoFiles — resolution failures (absent vs unreadable)', () => {
  /**
   * A `stat` seam that fails for ONE path with a given errno code and defers
   * to the real `statSync` for everything else — the same injection shape
   * `collectDriftHits()` uses for its `enumerate`/`read` seams.
   *
   * A seam rather than `chmod`: under root (the CI executor runs as uid 0 —
   * `.claude/rules/testing.md` § Root-as-uid-0) permission bits are not
   * enforced, so a chmod-based EACCES is unobservable there.
   *
   * @param {string} failing absolute path that must fail
   * @param {string} code errno code to raise
   */
  function statFailingFor(failing, code) {
    return (target) => {
      if (target === failing) {
        const err = new Error(`${code}: injected, stat '${target}'`);
        err.code = code;
        err.path = target;
        throw err;
      }
      return statSync(target);
    };
  }

  it('THROWS RepoEnumerationError for an EACCES path — an unreadable file is not an absent one', () => {
    const root = gitFixture();
    const unreadable = path.join(root, 'docs/tracked.md');

    let thrown;
    try {
      enumerateRepoFiles({
        repoRoot: root,
        dirs: ['docs'],
        exts: ['.md'],
        stat: statFailingFor(unreadable, 'EACCES'),
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(RepoEnumerationError);
    expect(thrown.code).toBe('EACCES');
    expect(thrown.path).toBe(unreadable);
    // Not swallowed into the non-git fallback walk: that walk would have
    // returned the file and hidden the failure behind a plausible census.
    expect(thrown.message).toContain('inconclusive');
  });

  it('THROWS for EPERM and ELOOP too — the skip set is two codes, not "anything that failed"', () => {
    const root = gitFixture();
    const target = path.join(root, 'docs/tracked.md');

    for (const code of ['EPERM', 'ELOOP', 'EIO']) {
      expect(() =>
        enumerateRepoFiles({
          repoRoot: root,
          dirs: ['docs'],
          exts: ['.md'],
          stat: statFailingFor(target, code),
        }),
      ).toThrow(RepoEnumerationError);
    }
  });

  it('SKIPS an ENOENT/ENOTDIR path and still returns every other file', () => {
    const root = gitFixture();
    write(root, 'docs/present.md');
    const missing = path.join(root, 'docs/tracked.md');

    for (const code of ['ENOENT', 'ENOTDIR']) {
      const seen = enumerateRepoFiles({
        repoRoot: root,
        dirs: ['docs'],
        exts: ['.md'],
        stat: statFailingFor(missing, code),
      });
      expect(seen).toEqual([path.join(root, 'docs/present.md')]);
    }
  });

  it('defaults to the real statSync when no seam is injected', () => {
    const root = gitFixture();
    expect(enumerateRepoFiles({ repoRoot: root, dirs: ['docs'], exts: ['.md'] })).toEqual([
      path.join(root, 'docs/tracked.md'),
    ]);
  });
});
