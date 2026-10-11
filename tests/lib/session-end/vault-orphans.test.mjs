/**
 * tests/lib/session-end/vault-orphans.test.mjs
 *
 * findVaultOrphans (#1563) over a REAL temporary git repo. Never the real vault:
 * `vaultDir` is always a fresh tmp repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { findVaultOrphans } from '../../../scripts/lib/session-end/vault-orphans.mjs';
import { fixtureGit, makeTmpDir, removeTree } from '../../_helpers/tmp-fixture.mjs';

let tmp;

beforeEach(() => {
  tmp = makeTmpDir('so-vault-orphans-');
});

afterEach(() => {
  removeTree(tmp);
});

function write(root, rel, content = 'x\n') {
  mkdirSync(join(root, rel, '..'), { recursive: true });
  writeFileSync(join(root, rel), content);
}

describe('findVaultOrphans', () => {
  // Bugs caught: a file older than the session start, a gitignored file, or a
  // generator-owned file reported as ours; a hand-written note in 50-sessions/
  // hidden by a directory exclusion (it blocks the mirror auto-commit); a name
  // with a space or umlaut mangled by git's quoted (non -z) output.
  it('reports only untracked, non-generator files modified since the session start', () => {
    const vault = join(tmp, 'vault');
    mkdirSync(vault);
    fixtureGit(['init', '-q'], vault);
    fixtureGit(['config', 'user.name', 'Fixture'], vault);
    fixtureGit(['config', 'user.email', 'fixture@example.org'], vault);
    write(vault, '.gitignore', 'ignored.md\n');
    write(vault, 'tracked.md');
    fixtureGit(['add', '.gitignore', 'tracked.md'], vault);
    fixtureGit(['commit', '-q', '-m', 'init'], vault);

    const sinceMs = Date.now() - 60_000;
    write(vault, 'tracked.md', 'changed\n'); // modified, but tracked
    write(vault, 'ignored.md');
    write(vault, 'old.md');
    const oldSec = sinceMs / 1000 - 3600;
    utimesSync(join(vault, 'old.md'), oldSec, oldSec);
    write(vault, 'new.md');
    write(vault, 'new note \u00fc.md');
    write(vault, '50-sessions/repo-x/hand.md', '# hand-written\n');
    write(vault, '50-sessions/repo-x/mirror.md', '---\nid: s1\n_generator: session-orchestrator-vault-mirror@1\n---\n');
    write(
      vault,
      '01-projects/repo-x/_session-narrative.md',
      '---\ntype: narrative\n_generator: session-orchestrator-vault-status-narrative@1\n---\n',
    );
    write(vault, 'quotes-marker.md', 'Notes say `_generator: session-orchestrator-vault-mirror@1` marks mirror files.\n');

    const r = findVaultOrphans({ vaultDir: vault, sinceMs });

    expect(r.status).toBe('ok');
    expect(r.candidates.map((c) => c.path.normalize('NFC'))).toEqual([
      '50-sessions/repo-x/hand.md',
      'new note \u00fc.md',
      'new.md',
      'quotes-marker.md',
    ]);
    expect(r.total).toBe(4);
    expect(r.truncated).toBe(false);
    // old.md + the two generator-owned files are untracked too, just filtered.
    expect(r.untracked).toBe(7);
  });

  // Bug caught: a vault that cannot be measured reported as a clean, empty
  // result - "could not look" read as "nothing there".
  it('returns status unavailable, not an empty ok result, for a non-repo dir', () => {
    const r = findVaultOrphans({ vaultDir: tmp, sinceMs: 0 });

    expect(r.status).toBe('unavailable');
    expect(r.reason).toBe('not-a-git-repo');
    expect(r.candidates).toEqual([]);
    expect(r).not.toHaveProperty('total');
  });
});
