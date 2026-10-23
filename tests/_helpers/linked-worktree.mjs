/**
 * tests/_helpers/linked-worktree.mjs
 *
 * A real git repo `<base>/main` (one commit) plus a LINKED worktree `<base>/wt`
 * of it. Every `.orchestrator/metrics/*.jsonl` is gitignored in this plugin
 * repo, so a ledger written inside a linked worktree disappears with the
 * worktree; repos that version their ledgers keep them on the branch instead
 * (`scripts/lib/ledger-path.mjs`). Tests that pin which copy a writer started
 * in a worktree reaches need exactly this pair (#1722).
 *
 * `files` (repo-relative path → content) are committed BEFORE the worktree is
 * added, so the worktree checks them out — a committed `.gitignore` makes a
 * ledger ignored there, a committed ledger makes it tracked.
 *
 * `base` is realpath'd so path comparisons hold on macOS (`/var` → `/private/var`).
 * The commit passes its identity with `-c`: CI containers have no git identity.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * @param {string} prefix  mkdtemp prefix
 * @param {{ files?: Record<string, string> }} [opts]
 * @returns {{ base: string, main: string, wt: string, mainMetrics: string, wtMetrics: string, cleanup: () => void }}
 */
export function makeLinkedWorktree(prefix, { files = {} } = {}) {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  const main = path.join(base, 'main');
  const wt = path.join(base, 'wt');
  mkdirSync(main, { recursive: true });
  const git = (...args) => {
    const r = spawnSync('git', args, { cwd: main, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  };
  git('init', '-q');
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
    writeFileSync(path.join(main, rel), content);
    git('add', '-f', '--', rel);
  }
  git('-c', 'user.email=t@example.org', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'init');
  git('worktree', 'add', '-q', '--detach', wt);
  const mainMetrics = path.join(main, '.orchestrator', 'metrics');
  mkdirSync(mainMetrics, { recursive: true });
  return {
    base,
    main,
    wt,
    mainMetrics,
    wtMetrics: path.join(wt, '.orchestrator', 'metrics'),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}
