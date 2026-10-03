/**
 * tests/hooks/post-tool-batch-wave-signal-session-root.test.mjs
 *
 * #1511 point a — the wave's git facts (`wave_start_sha`, `files_changed`) are
 * read in the tree the session WORKS in (the session root), not in the launch
 * dir. After EnterWorktree, `$CLAUDE_PROJECT_DIR` still names the launch
 * checkout, whose HEAD and working tree say nothing about the wave.
 *
 * `current-session.json` stays at the launch dir on purpose — on-session-start
 * writes it there — so the fixture keeps it in `launch`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixtureGit, makeTmpDir, removeTree } from '../_helpers/tmp-fixture.mjs';

const HOOK = new URL('../../hooks/post-tool-batch-wave-signal.mjs', import.meta.url).pathname;
const MINE = '44444444-4444-4444-8444-444444444444';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) if (existsSync(d)) removeTree(d);
});

/** A git repo with one commit whose content differs per `tag`; returns { dir, head }. */
function mkRepo(prefix, tag) {
  const dir = makeTmpDir(prefix);
  dirs.push(dir);
  const git = (args) => fixtureGit(args, dir).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  writeFileSync(join(dir, '.gitignore'), '.orchestrator/\n.claude/\n', 'utf8');
  writeFileSync(join(dir, 'a.txt'), `${tag}\n`, 'utf8');
  git(['add', '.gitignore', 'a.txt']);
  git(['commit', '-q', '-m', `init ${tag}`]);
  return { dir, head: git(['rev-parse', 'HEAD']) };
}

describe('post-tool-batch wave git facts — session root (#1511 point a)', () => {
  it('measures files_changed and stamps wave_start_sha in the entered worktree, not the launch dir', () => {
    // Bug caught: countFilesChangedSince(getProjectDir()) and
    // readHeadSha(getProjectDir()) ran git in the LAUNCH checkout. The wave's
    // start sha is unknown there (git diff fails → files_changed omitted) and
    // the next wave's start sha was the launch checkout's HEAD.
    const launch = mkRepo('ptb-launch-', 'launch');
    const wt = mkRepo('ptb-wt-', 'worktree');
    writeFileSync(join(wt.dir, 'a.txt'), 'changed\n', 'utf8');
    writeFileSync(join(wt.dir, 'new.txt'), 'new\n', 'utf8'); // untracked
    mkdirSync(join(wt.dir, '.claude'), { recursive: true });
    writeFileSync(join(wt.dir, '.claude', 'wave-scope.json'), JSON.stringify({ wave: 2 }), 'utf8');
    mkdirSync(join(launch.dir, '.orchestrator'), { recursive: true });
    writeFileSync(
      join(launch.dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({ session_id: MINE, last_wave: 1, wave_start_sha: wt.head }),
      'utf8',
    );

    const result = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: MINE, batch_id: 'b1', cwd: wt.dir }),
      encoding: 'utf8',
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: launch.dir,
        SO_HOOK_PROFILE: 'full',
        SO_DISABLED_HOOKS: '',
      },
      timeout: 15_000,
    });
    expect(result.status).toBe(0);

    const eventsFile = join(launch.dir, '.orchestrator', 'metrics', 'events.jsonl');
    const completed = readFileSync(eventsFile, 'utf8').trim().split('\n')
      .map((l) => JSON.parse(l))
      .filter((e) => e.event === 'orchestrator.wave.completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].files_changed).toBe(2);

    const session = JSON.parse(
      readFileSync(join(launch.dir, '.orchestrator', 'current-session.json'), 'utf8'),
    );
    expect(session.last_wave).toBe(2);
    expect(session.wave_start_sha).toBe(wt.head);
  });
});
