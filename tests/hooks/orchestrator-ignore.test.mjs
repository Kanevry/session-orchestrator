/**
 * tests/hooks/orchestrator-ignore.test.mjs — #1515 Pkt 5.
 *
 * Wiring test through the real SessionStart hook in a throwaway `git init`
 * repo. Bug it catches: on HEAD 644743cc one SessionStart left five untracked
 * files under `.orchestrator/` in an un-bootstrapped repo; and the inverse
 * regressions — a bootstrapped repo (this one tracks bootstrap.lock) getting an
 * ignore-all file, or the file blocking the same-session bootstrap commit.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { telemetryIsolationEnv } from '../_helpers/telemetry-isolation.mjs';
import { GENERATED_IGNORE } from '../../hooks/_lib/orchestrator-ignore.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../hooks/on-session-start.mjs');
const tmpDirs = [];

function tmp(prefix) {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function git(repo, ...args) {
  return spawnSync('git', ['-c', 'user.email=t@example.org', '-c', 'user.name=t', ...args], {
    cwd: repo,
    encoding: 'utf8',
  });
}

function freshRepo() {
  const repo = tmp('so-orch-ignore-');
  git(repo, 'init', '-q');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
  return repo;
}

function runHook(repo) {
  const r = spawnSync(process.execPath, [HOOK], {
    cwd: repo,
    input: JSON.stringify({ session_id: '11111111-2222-4333-8444-555555555555', source: 'startup' }),
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      SO_SESSION_REGISTRY_DIR: tmp('so-orch-ignore-reg-'),
      SO_DISABLE_UPDATE_CHECK: '1',
      CLANK_EVENT_SECRET: '',
      CLANK_EVENT_URL: '',
      CLAUDE_CODE_SESSION_ID: undefined,
      ...telemetryIsolationEnv(),
    },
  });
  expect(r.status).toBe(0);
}

const status = (repo) => git(repo, 'status', '--porcelain', '--untracked-files=all').stdout;
const ignoreFile = (repo) => path.join(repo, '.orchestrator', '.gitignore');

afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop(), { recursive: true, force: true });
});

describe('SessionStart keeps .orchestrator/ runtime state out of git status (#1515 Pkt 5)', () => {
  it('un-bootstrapped repo: writes the ignore file, status stays clean, bootstrap can still stage its files', () => {
    const repo = freshRepo();
    runHook(repo);
    expect(readFileSync(ignoreFile(repo), 'utf8')).toBe(GENERATED_IGNORE);
    // the hook did write runtime state — it is just not visible
    expect(existsSync(path.join(repo, '.orchestrator', 'session.lock'))).toBe(true);
    expect(status(repo)).toBe('');

    // Same-session bootstrap: every .orchestrator path a template stages with
    // `git add -- <file>` must not be refused as ignored.
    const files = ['bootstrap.lock', 'metrics/learnings.jsonl', 'metrics/sessions.jsonl', 'metrics/README.md', 'policy/quality-gates.json'];
    for (const f of files) {
      mkdirSync(path.dirname(path.join(repo, '.orchestrator', f)), { recursive: true });
      writeFileSync(path.join(repo, '.orchestrator', f), '');
      const add = git(repo, 'add', '--', `.orchestrator/${f}`);
      expect(add.status, add.stderr).toBe(0);
    }
    expect(status(repo)).not.toMatch(/events\.jsonl|session\.lock|host\.json/);

    // Next session start in the now-bootstrapped repo removes the file again.
    git(repo, 'commit', '-q', '-m', 'bootstrap');
    runHook(repo);
    expect(existsSync(ignoreFile(repo))).toBe(false);
  });

  it('bootstrapped repo (bootstrap.lock present): no ignore file is created', () => {
    const repo = freshRepo();
    mkdirSync(path.join(repo, '.orchestrator'));
    writeFileSync(path.join(repo, '.orchestrator', 'bootstrap.lock'), 'tier: fast\n');
    runHook(repo);
    expect(existsSync(ignoreFile(repo))).toBe(false);
  });

  it('existing .orchestrator/.gitignore is left byte-identical', () => {
    const repo = freshRepo();
    mkdirSync(path.join(repo, '.orchestrator'));
    writeFileSync(ignoreFile(repo), 'session.lock\n');
    runHook(repo);
    expect(readFileSync(ignoreFile(repo), 'utf8')).toBe('session.lock\n');
  });

  it('repo that already tracks something under .orchestrator/: no ignore file', () => {
    const repo = freshRepo();
    mkdirSync(path.join(repo, '.orchestrator', 'policy'), { recursive: true });
    writeFileSync(path.join(repo, '.orchestrator', 'policy', 'x.json'), '{}');
    git(repo, 'add', '.orchestrator/policy/x.json');
    git(repo, 'commit', '-q', '-m', 'track');
    runHook(repo);
    expect(existsSync(ignoreFile(repo))).toBe(false);
  });
});

// Census, not a hand-typed list: every `.orchestrator/` path a bootstrap
// template stages must stay un-ignored, or `/bootstrap` in a fresh repo fails
// at `git add` on an ignored path. A new template entry turns this red.
describe('orchestrator-ignore exceptions cover every bootstrap-staged path', () => {
  it('excepts each literal .orchestrator path from skills/bootstrap/*-template.md', async () => {
    const { readdirSync } = await import('node:fs');
    const dir = path.resolve(import.meta.dirname, '../../skills/bootstrap');
    const templates = readdirSync(dir).filter((f) => f.endsWith('-template.md'));
    expect(templates.length).toBeGreaterThan(0);
    const literal = new Set();
    let variable = 0;
    for (const f of templates) {
      const text = readFileSync(path.join(dir, f), 'utf8');
      for (const m of text.matchAll(/BOOTSTRAP_FILES\+=\("?\.orchestrator\/([^)"]+)"?\)/g)) {
        if (m[1].includes('$')) variable++;
        else literal.add(m[1]);
      }
    }
    expect(literal.size).toBeGreaterThan(0);
    const text = Array.isArray(GENERATED_IGNORE) ? GENERATED_IGNORE.join('\n') : String(GENERATED_IGNORE);
    for (const p of literal) expect(text).toContain(`!/${p}`);
    // The one variable entry stages metrics/$_file (sessions.jsonl and its
    // siblings); its expansion is excepted by name in the helper. A second
    // variable entry needs a human look before it can pass.
    expect(variable).toBeLessThanOrEqual(templates.length);
  });
});

// Review finding (2026-10-08): untracked project data under .orchestrator/
// (steering/, peers/, policy/) vanished from `git status` without a word.
describe('ensureOrchestratorIgnore leaves project data and symlinks alone', () => {
  const made = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const repo = () => {
    const d = mkdtempSync(path.join(os.tmpdir(), 'so-orch-ign-'));
    made.push(d);
    spawnSync('git', ['init', '-q'], { cwd: d });
    return d;
  };
  it.each(['steering', 'peers', 'policy'])('writes nothing when .orchestrator/%s exists', async (sub) => {
    const { ensureOrchestratorIgnore } = await import('../../hooks/_lib/orchestrator-ignore.mjs');
    const d = repo();
    mkdirSync(path.join(d, '.orchestrator', sub), { recursive: true });
    writeFileSync(path.join(d, '.orchestrator', sub, 'x.md'), 'mine\n');
    expect(await ensureOrchestratorIgnore(d)).toBe('project-data');
    expect(existsSync(path.join(d, '.orchestrator', '.gitignore'))).toBe(false);
  });
  it('writes nothing through a symlinked .orchestrator', async () => {
    const { ensureOrchestratorIgnore } = await import('../../hooks/_lib/orchestrator-ignore.mjs');
    const { symlinkSync } = await import('node:fs');
    const d = repo();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'so-orch-out-'));
    made.push(outside);
    symlinkSync(outside, path.join(d, '.orchestrator'));
    expect(await ensureOrchestratorIgnore(d)).toBe('symlink');
    expect(existsSync(path.join(outside, '.gitignore'))).toBe(false);
  });
});
