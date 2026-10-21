/**
 * tests/lib/session-work-trees.test.mjs — #1659.
 *
 * Named bug (TV-001): a session that commits in several of its own worktrees
 * (`cd <wt> && git commit`, `git -C <wt> commit`) has those commits attributed
 * to no tree, because `session-start-ref` is one sha in one tree. This suite
 * drives the REAL hook (hooks/pre-bash-staging-fence.mjs) over stdin against a
 * real repo with two linked worktrees, then proves the reader returns both
 * trees with their pre-commit HEADs for the own session only, and that the
 * per-tree diff never mixes trees or picks up a foreign session's commit.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { readSessionWorkTrees, sessionCommitFiles } from '@lib/session-work-trees.mjs';
import { SESSION_WORK_TREE_EVENT } from '@lib/events-schema.mjs';

const HOOK = resolve(import.meta.dirname, '../..', 'hooks/pre-bash-staging-fence.mjs');
const OWN = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';

let root;
let ledgerDir;
let repo;
let wtA;
let wtB;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Commit one new file in `tree` (the hook runs BEFORE, as PreToolUse does). */
function commitFile(tree, name) {
  writeFileSync(join(tree, name), `${name}\n`);
  git(tree, 'add', name);
  git(tree, 'commit', '-q', '-m', name);
}

function runHook({ sessionId, cwd, command }) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_name: 'Bash', session_id: sessionId, cwd, tool_input: { command } }),
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: ledgerDir,
      SO_DISABLED_HOOKS: '',
      SO_HOOK_PROFILE: '',
      SO_WAVE_AGENT: '',
    },
  });
  expect(r.status).toBe(0);
  return r;
}

const eventsFile = () => join(ledgerDir, '.orchestrator', 'metrics', 'events.jsonl');

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'so-work-trees-')));
  ledgerDir = join(root, 'ledger');
  mkdirSync(ledgerDir);
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.org');
  git(repo, 'config', 'commit.gpgsign', 'false');
  commitFile(repo, 'base.txt');
  wtA = join(root, 'wt-a');
  wtB = join(root, 'wt-b');
  git(repo, 'worktree', 'add', '-q', '-b', 'a', wtA);
  git(repo, 'worktree', 'add', '-q', '-b', 'b', wtB);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('work-tree recorder + reader (#1659, real git)', () => {
  it('attributes commits in two worktrees to the own session only, first ref per tree, never across trees', () => {
    // A foreign session commits in wt-b BEFORE the own session touches it.
    runHook({ sessionId: FOREIGN, cwd: wtB, command: 'git commit -m foreign' });
    commitFile(wtB, 'foreign.txt');

    // Own session, launched in the main checkout: `cd <wt> &&` form.
    const startA = git(wtA, 'rev-parse', 'HEAD');
    runHook({ sessionId: OWN, cwd: repo, command: `cd ${wtA} && git commit -m one` });
    commitFile(wtA, 'a1.txt');

    // `git -C <wt>` form, from the main checkout.
    const startB = git(wtB, 'rev-parse', 'HEAD');
    runHook({ sessionId: OWN, cwd: repo, command: `git -C ${wtB} commit -m two` });
    commitFile(wtB, 'b1.txt');

    // A second commit in wt-a records a LATER ref — the reader must keep the first.
    runHook({ sessionId: OWN, cwd: join(wtA), command: 'git commit -m three' });
    commitFile(wtA, 'a2.txt');

    const own = readSessionWorkTrees({ sessionId: OWN, eventsFile: eventsFile() });
    expect(own.malformed).toBe(0);
    expect(own.invalid).toBe(0);
    expect(own.trees).toEqual([
      { tree: wtA, start_ref: startA },
      { tree: wtB, start_ref: startB },
    ]);

    const files = sessionCommitFiles({ trees: own.trees });
    expect(files.skipped).toEqual([]);
    expect(files.perTree).toEqual([
      { tree: wtA, start_ref: startA, files: ['a1.txt', 'a2.txt'] },
      { tree: wtB, start_ref: startB, files: ['b1.txt'] },
    ]);
    expect(files.union).toEqual(['a1.txt', 'a2.txt', 'b1.txt']);
    expect(files.union).not.toContain('foreign.txt');

    const foreign = readSessionWorkTrees({ sessionId: FOREIGN, eventsFile: eventsFile() });
    expect(foreign.trees.map((t) => t.tree)).toEqual([wtB]);
  });

  it('records nothing for a cd whose operand needs a shell to resolve', () => {
    runHook({ sessionId: OWN, cwd: repo, command: 'cd "$WT" && git commit -m x' });
    const r = readSessionWorkTrees({ sessionId: OWN, eventsFile: eventsFile() });
    expect(r.trees).toEqual([]);
  });
});

describe('readSessionWorkTrees — ledger honesty', () => {
  it('counts unreadable lines and invalid records instead of skipping them silently', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    mkdirSync(join(ledgerDir, '.orchestrator', 'metrics'), { recursive: true });
    const line = (o) => JSON.stringify({ timestamp: '2026-10-17T10:00:00.000Z', event: SESSION_WORK_TREE_EVENT, ...o });
    appendFileSync(eventsFile(), [
      line({ session_id: OWN, tree: repo, start_ref: head }),
      '{"timestamp": "2026-10-17T10:00:01.000Z", "event": "orchestr', // torn tail
      line({ session_id: OWN, tree: 'relative/path', start_ref: head }),
      '',
    ].join('\n'));
    const r = readSessionWorkTrees({ sessionId: OWN, eventsFile: eventsFile() });
    expect(r.trees).toEqual([{ tree: repo, start_ref: head }]);
    expect(r.malformed).toBe(1);
    expect(r.invalid).toBe(1);
  });
});

describe('sessionCommitFiles — unusable trees are skipped with a reason', () => {
  it('marks a vanished tree and an unresolvable ref as skipped', () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    const r = sessionCommitFiles({
      trees: [
        { tree: join(root, 'gone'), start_ref: head },
        { tree: repo, start_ref: 'f'.repeat(40) },
      ],
    });
    expect(r.perTree).toEqual([]);
    expect(r.skipped.map((s) => s.reason)).toEqual(['tree-missing', 'ref-unresolvable']);
  });
});
