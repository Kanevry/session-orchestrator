/**
 * tests/scripts/session-commit-files.test.mjs — #1659.
 *
 * Named bug (TV-001): the CLI is the one operator surface for "what did this
 * session commit across its own trees". A wiring slip (wrong ledger, env id
 * ignored, foreign session not filtered, data on stderr) would leave the docs
 * pointing at a command that answers a different question. One real-spawn
 * smoke test pins the contract: default ledger via CLAUDE_PROJECT_DIR (a tmp
 * dir, so the real ledger is never read), id from $CLAUDE_CODE_SESSION_ID,
 * per-tree line + union on stdout, and exit 2 without an id.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { SESSION_WORK_TREE_EVENT } from '@lib/events-schema.mjs';

const CLI = resolve(import.meta.dirname, '../..', 'scripts/session-commit-files.mjs');
const OWN = '11111111-1111-4111-8111-111111111111';
const FOREIGN = '22222222-2222-4222-8222-222222222222';

let root;
let ledgerDir;
let repo;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function commitFile(tree, name) {
  writeFileSync(join(tree, name), `${name}\n`);
  git(tree, 'add', name);
  git(tree, 'commit', '-q', '-m', name);
}

function record(sessionId, tree, startRef) {
  const file = join(ledgerDir, '.orchestrator', 'metrics', 'events.jsonl');
  appendFileSync(file, `${JSON.stringify({
    timestamp: '2026-10-17T10:00:00.000Z',
    event: SESSION_WORK_TREE_EVENT,
    session_id: sessionId,
    tree,
    start_ref: startRef,
  })}\n`);
}

function run(args, env = {}) {
  return spawnSync('node', [CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: ledgerDir, CLAUDE_CODE_SESSION_ID: '', ...env },
  });
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'so-commit-files-')));
  ledgerDir = join(root, 'ledger');
  mkdirSync(join(ledgerDir, '.orchestrator', 'metrics'), { recursive: true });
  repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.org');
  git(repo, 'config', 'commit.gpgsign', 'false');
  commitFile(repo, 'base.txt');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('session-commit-files CLI (#1659)', () => {
  it('lists own trees and the union for the env session id; exit 2 without an id', () => {
    const wt = join(root, 'wt');
    git(repo, 'worktree', 'add', '-q', '-b', 'wt', wt);
    const start = git(wt, 'rev-parse', 'HEAD');
    record(OWN, wt, start);
    record(FOREIGN, repo, start);
    commitFile(wt, 'own.txt');
    commitFile(repo, 'foreign.txt');

    const ok = run([], { CLAUDE_CODE_SESSION_ID: OWN });
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe(`${wt}\t${start}\t1 files\n\nown.txt\n`);

    const json = run(['--json', '--session-id', OWN]);
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual({
      trees: [{ tree: wt, start_ref: start }],
      perTree: [{ tree: wt, start_ref: start, files: ['own.txt'] }],
      skipped: [],
      union: ['own.txt'],
      malformed: 0,
      invalid: 0,
      complete: true,
    });

    const noId = run([]);
    expect(noId.status).toBe(2);
    expect(noId.stdout).toBe('');
    expect(noId.stderr).toContain('no session id');
  });

  // #1659 review — `--json` dropped `complete`, so a missing ledger read like
  // "zero trees recorded"; the no-ledger note only reached human mode.
  it('reports a missing ledger as complete:null in --json and on stderr', () => {
    rmSync(join(ledgerDir, '.orchestrator'), { recursive: true, force: true });
    const r = run(['--json', '--session-id', OWN]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.complete).toBe(null);
    expect(out.trees).toEqual([]);
    expect(r.stderr).toContain('session-commit-files: no events ledger found');
  });
});
