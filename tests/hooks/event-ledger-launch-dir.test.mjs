/**
 * #1514 point 1 — ONE event ledger per repo: the main checkout's.
 *
 * Bugs caught, both over the real hook binaries:
 *   1. The same event (`orchestrator.scope.foreign_session_ignored`) went to a
 *      linked worktree's own `.orchestrator/metrics/events.jsonl`, so a session
 *      that entered a worktree split its ledger in two, and the worktree half
 *      vanished with the worktree.
 *   2. (REFUTE MED-1 on the first fix) routing every hook to the env launch dir
 *      instead put a session that `cd`-ed into ANOTHER clone onto repo A's
 *      ledger while reading repo B's manifest — `scope-echo --verify` run in B
 *      then found 0 records.
 *
 * Fixture: repo B with a LINKED worktree holding the manifest (the hook root the
 * payload `cwd` names), and `$CLAUDE_PROJECT_DIR` = an unrelated repo A. Each
 * hook must write its event into B's MAIN checkout — not into A, not into the
 * worktree. For the three `foreign_session_ignored` rows the event existing at
 * all also proves the manifest was read at the worktree (neither A nor B's
 * main checkout has one).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshotPathFor } from '../../hooks/post-bash-write-verify.mjs';

const HOOKS = path.resolve(import.meta.dirname, '../../hooks');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');
const OWN = 'OWN-UUID-2222';
const tmpDirs = [];
const snapshotRoots = [];

function mkTmp(prefix) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of snapshotRoots.splice(0)) {
    const snap = snapshotPathFor(dir);
    if (existsSync(snap)) rmSync(snap, { force: true });
  }
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function readEvents(dir) {
  const file = path.join(dir, EVENTS_REL);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

/** Repo B (main checkout) plus a LINKED worktree carrying `.claude/wave-scope.json` = `scope`. */
function mkRepoWithWorktree(scope) {
  const root = mkTmp('ev-ledger-b-');
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  execFileSync('git', ['init', '-q', main], { stdio: 'ignore' });
  execFileSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'seed'], { cwd: main, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', '-q', '--detach', wt], { cwd: main, stdio: 'ignore' });
  mkdirSync(path.join(wt, '.claude'));
  writeFileSync(path.join(wt, '.claude', 'wave-scope.json'), JSON.stringify(scope));
  snapshotRoots.push(wt);
  return { main, wt };
}

/** Repo A — the dir the session was launched in. */
function mkLaunchRepo() {
  const dir = mkTmp('ev-ledger-a-');
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

function run(hook, payload, launch) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: launch,
    CLAUDE_CODE_SESSION_ID: OWN,
    SO_HOOK_PROFILE: 'full',
    SO_DISABLED_HOOKS: '',
  };
  return spawnSync(process.execPath, [path.join(HOOKS, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    cwd: launch,
    env,
    timeout: 20_000,
  });
}

/** A manifest bound to a PEER session: every scope hook stands down with an event. */
const PEER_SCOPE = {
  wave: 4,
  role: 'impl',
  enforcement: 'strict',
  session_id: 'PEER-UUID-1111',
  allowedPaths: ['hooks/**'],
  blockedCommands: ['npm test'],
};

const FOREIGN = 'orchestrator.scope.foreign_session_ignored';

describe('event ledger root (#1514 point 1)', () => {
  it.each([
    ['enforce-commands.mjs', FOREIGN, (wt) => ({ tool_name: 'Bash', tool_input: { command: 'npm test' }, cwd: wt, session_id: OWN })],
    ['enforce-scope.mjs', FOREIGN, (wt) => ({ tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'src', 'x.mjs') }, cwd: wt, session_id: OWN })],
    ['post-bash-write-verify.mjs', FOREIGN, (wt) => ({ tool_name: 'Bash', tool_input: { command: 'echo x > y.mjs' }, cwd: wt, session_id: OWN })],
    ['pre-task-scope-disjoint.mjs', 'orchestrator.wave_dispatch.scope_checked', (wt) => ({
      hook_event_name: 'PreToolUse', tool_name: 'Agent', session_id: OWN, cwd: wt,
      tool_input: { description: 'A', subagent_type: 'code-implementer', prompt: '## DEIN DATEI-SCOPE\n```\nhooks/a.mjs\n```\n' },
    })],
  ])("%s writes %s into the hook root's MAIN checkout ledger — not the worktree, not $CLAUDE_PROJECT_DIR", (hook, event, payloadOf) => {
    const { main, wt } = mkRepoWithWorktree(PEER_SCOPE);
    const launch = mkLaunchRepo();

    const res = run(hook, payloadOf(wt), launch);

    expect(res.status).toBe(0);
    expect(readEvents(main).filter((e) => e.event === event)).toHaveLength(1);
    expect(existsSync(path.join(wt, EVENTS_REL))).toBe(false);
    expect(readEvents(launch).filter((e) => e.event === event)).toEqual([]);
  });
});
