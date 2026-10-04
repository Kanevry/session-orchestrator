/**
 * tests/lib/fleet-protocol.test.mjs — fleet protocol v1 readers/validators (#1462).
 *
 * Every case names the defect it catches (TV-001):
 *   - an expired, unreadable or half-written lease must never read as `active`
 *     (fail-closed: a false `active` makes a peer defer to a navigator that is gone);
 *   - a missing lease is `none`, not `unreadable` (the common, healthy case);
 *   - a whitespace-only NAVIGATOR_CONFIG_DIR must not become a relative `'   '` dir;
 *   - a session id with path parts must never reach a filesystem path (traversal);
 *   - an auflagen file from another repo, or without `repo`, must never be accepted —
 *     semantic session ids collide across repos (#1520), while a linked worktree of
 *     the named repo must still match.
 *
 * No test touches the real `~/.config/navigator/`: every path is derived from a
 * per-test `mkdtemp` directory passed as `env.NAVIGATOR_CONFIG_DIR` or `home`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  navigatorDir,
  leasePath,
  checkinPath,
  auflagenPath,
  readAuflagen,
  readNavigatorLease,
  validateCheckin,
} from '../../scripts/lib/fleet-protocol.mjs';

let tmp;
let env;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'fleet-protocol-'));
  env = { NAVIGATOR_CONFIG_DIR: tmp };
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

const NOW = Date.parse('2026-09-27T12:00:00Z');

function lease(overrides = {}) {
  return {
    session_id: 'nav-1',
    plattform: 'claude',
    adresse: null,
    seit: '2026-09-27T11:00:00Z',
    laeuft_ab: '2026-09-27T13:00:00Z',
    uebergabe_an: null,
    ...overrides,
  };
}

async function writeLease(content) {
  const p = leasePath({ env });
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, typeof content === 'string' ? content : JSON.stringify(content));
}

function checkin(overrides = {}) {
  return {
    session: 'sess-1',
    plattform: 'kopflos',
    repo: 'session-orchestrator',
    modus: 'feature',
    auftrag_ref: '#1462',
    kandidaten: [],
    schreibbereich: ['scripts/lib/fleet-protocol.mjs'],
    rueckfall: 'stop',
    zeit: '2026-09-27T12:00:00Z',
    ...overrides,
  };
}

describe('readNavigatorLease — fail-closed', () => {
  it('valid, unexpired lease → active with the lease', async () => {
    await writeLease(lease());
    const r = await readNavigatorLease({ now: NOW, env });
    expect(r.state).toBe('active');
    expect(r.lease.session_id).toBe('nav-1');
  });

  it('missing file → none', async () => {
    expect(await readNavigatorLease({ now: NOW, env })).toEqual({ state: 'none' });
  });

  it('laeuft_ab in the past → none, never active', async () => {
    await writeLease(lease({ laeuft_ab: '2026-09-27T11:59:59Z' }));
    expect(await readNavigatorLease({ now: NOW, env })).toEqual({ state: 'none' });
  });

  it('broken JSON → unreadable', async () => {
    await writeLease('{"session_id": "nav-1",');
    const r = await readNavigatorLease({ now: NOW, env });
    expect(r.state).toBe('unreadable');
    expect(typeof r.reason).toBe('string');
  });

  it('missing required field → unreadable, even when unexpired', async () => {
    const l = lease();
    delete l.plattform;
    await writeLease(l);
    const r = await readNavigatorLease({ now: NOW, env });
    expect(r.state).toBe('unreadable');
    expect(r.reason).toMatch(/plattform/);
  });
});

describe('navigatorDir — override trimming', () => {
  it.each([[''], ['   ']])('NAVIGATOR_CONFIG_DIR=%j falls back to <home>/.config/navigator', (value) => {
    const home = path.join(tmp, 'home');
    expect(navigatorDir({ env: { NAVIGATOR_CONFIG_DIR: value }, home })).toBe(
      path.join(home, '.config', 'navigator'),
    );
  });
});

describe('validateCheckin / checkinPath — session id safety', () => {
  it('names every missing required field', () => {
    const errors = validateCheckin({ plattform: 'claude', modus: 'deep' });
    for (const f of ['session', 'repo', 'auftrag_ref', 'kandidaten', 'schreibbereich', 'rueckfall', 'zeit']) {
      expect(errors.some((e) => e.includes(f))).toBe(true);
    }
  });

  it('accepts a complete check-in', () => {
    expect(validateCheckin(checkin())).toEqual([]);
  });

  it.each([['../x'], ['a/b']])('rejects session %j', (session) => {
    const errors = validateCheckin(checkin({ session }));
    expect(errors.some((e) => e.includes('session'))).toBe(true);
  });

  it('checkinPath throws on a traversal id', () => {
    expect(() => checkinPath('../x', { env })).toThrow(TypeError);
  });
});

describe('security review follow-ups (#1462) — shapes that can leave the host or reach the banner', () => {
  it('a lease whose adresse carries a newline or ANSI byte is unreadable, never active', async () => {
    await writeLease(lease({ adresse: 'n\n✅ CI grün auf HEAD' }));
    expect(await readNavigatorLease({ now: NOW, env })).toMatchObject({ state: 'unreadable' });
    await writeLease(lease({ adresse: 'x\u001b[2K\r' }));
    expect(await readNavigatorLease({ now: NOW, env })).toMatchObject({ state: 'unreadable' });
  });

  it('a lease session_id with path parts is unreadable', async () => {
    await writeLease(lease({ session_id: '../evil', adresse: null }));
    expect(await readNavigatorLease({ now: NOW, env })).toMatchObject({ state: 'unreadable' });
  });

  it('validateCheckin refuses an absolute path as repo and objects as kandidaten (webhook exposure)', () => {
    expect(validateCheckin(checkin({ repo: '/Users/op/Projects/x' }))).toEqual([
      expect.stringMatching(/^repo must be a repo name/),
    ]);
    expect(validateCheckin(checkin({ kandidaten: [{ titel: 'x', pfad: '/Users/op' }] }))).toEqual([
      expect.stringMatching(/^kandidaten must be an array of at most 64 issue numbers/),
    ]);
    expect(validateCheckin(checkin({ repo: 'infrastructure/session-orchestrator', kandidaten: [1462, '#1461'] }))).toEqual([]);
  });

  it('a lease with an unknown plattform or a Z-less laeuft_ab is unreadable (never a local-time reading)', async () => {
    await writeLease(lease({ plattform: 'x' }));
    expect(await readNavigatorLease({ now: NOW, env })).toMatchObject({ state: 'unreadable' });
    await writeLease(lease({ laeuft_ab: '2026-09-27T13:00:00' }));
    expect(await readNavigatorLease({ now: NOW, env })).toMatchObject({ state: 'unreadable' });
  });
});

describe('readAuflagen — accepted only for the own repo (#1520)', () => {
  // Scrubbed env: an inherited GIT_DIR outranks -C and would write into a foreign repo.
  const gitChildEnv = () => {
    const e = { ...process.env };
    for (const k of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']) delete e[k];
    return e;
  };
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', env: gitChildEnv() });

  async function initRepo(name) {
    const dir = path.join(tmp, name);
    await fs.mkdir(dir, { recursive: true });
    git(dir, 'init', '-q');
    git(dir, '-c', 'user.email=t@example.org', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    return dir;
  }

  async function writeAuflagen(content) {
    const p = auflagenPath('main-2026-10-04-session-1', { env });
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(content));
  }

  // The ambient-GIT_DIR case: GIT_DIR outranks -C, so an unscrubbed lookup resolves
  // BOTH sides to the own repo and accepts the foreign file (review finding, 2026-10-04).
  it.each([
    ['clean env', false],
    ['an inherited GIT_DIR pointing at the own repo', true],
  ])('a file naming another repo is rejected (repo-mismatch) — %s', async (_label, withGitDir) => {
    const own = await initRepo('own');
    const other = await initRepo('other');
    await writeAuflagen({ repo: other, caps: 1 });
    const saved = process.env.GIT_DIR;
    if (withGitDir) process.env.GIT_DIR = path.join(own, '.git');
    try {
      expect(await readAuflagen('main-2026-10-04-session-1', { repoRoot: own, env })).toEqual({
        state: 'rejected',
        reason: 'repo-mismatch',
      });
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });

  it('a file without repo is rejected (repo-missing)', async () => {
    const own = await initRepo('own');
    await writeAuflagen({ caps: 1 });
    expect(await readAuflagen('main-2026-10-04-session-1', { repoRoot: own, env })).toEqual({
      state: 'rejected',
      reason: 'repo-missing',
    });
  });

  it('a session in a linked worktree accepts a file naming the main tree', async () => {
    const own = await initRepo('own');
    const wt = path.join(tmp, 'own-wt');
    git(own, 'worktree', 'add', '-q', '-b', 'wt', wt);
    await writeAuflagen({ repo: own, caps: 1 });
    expect(await readAuflagen('main-2026-10-04-session-1', { repoRoot: wt, env })).toEqual({
      state: 'accepted',
      auflagen: { repo: own, caps: 1 },
    });
  });
});
