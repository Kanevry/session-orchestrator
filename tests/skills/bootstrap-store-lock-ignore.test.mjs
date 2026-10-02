/**
 * tests/skills/bootstrap-store-lock-ignore.test.mjs — runs the shell block of
 * `skills/bootstrap/_shared-template.md` § #store-lock-ignore, the production
 * call shape (TV-005): the block is extracted from the template at test time and
 * executed by `/bin/bash` in temp dirs, so the test judges the text agents run.
 *
 * Defects caught (each landed or was found only by review, #1487/#1489):
 *   - the append fusing its comment onto a last line without a newline
 *     (`.env` + `# …` → `.env# …`), which UN-ignores `.env`;
 *   - a second run appending the block again;
 *   - a CRLF `.gitignore` whose `pattern\r` lines read as missing → duplicates;
 *   - a write through a symlinked `.gitignore`, or into a write-only one the
 *     presence check cannot read;
 *   - with REPO_ROOT unset outside any repo, falling back to `/.gitignore`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fencedBlocksMentioning } from '../_helpers/markdown-fences.mjs';

const TEMPLATE = resolve(import.meta.dirname, '..', '..', 'skills', 'bootstrap', '_shared-template.md');
const LOCK_PATTERN = '.orchestrator/metrics/*.jsonl.lock*';
/** Every line the block appends, in order (#1487 store locks, #1500 store backups, #1495 runtime locks and state). */
const ALL_PATTERNS = [
  LOCK_PATTERN,
  '.file.lock.*',
  '.orchestrator/metrics/*.jsonl.bak-*',
  '.orchestrator/session.lock',
  '.orchestrator/.session.lock.*',
  '.orchestrator/runtime/',
  '.orchestrator/current-session.json',
  '.orchestrator/.current-session.*',
  '.orchestrator/host.json*',
  '.orchestrator/state.lock*',
  '.orchestrator/.state.lock.*',
  '.orchestrator/rules.lock*',
  '.orchestrator/wave-dispatch-scopes.*',
  '.orchestrator/.wave-dispatch-scopes.*',
  '.orchestrator/wave-transcript-tail.lock*',
  '.orchestrator/.wave-transcript-tail.lock.*',
  '.orchestrator/metrics/proposals-write.lock*',
  '.orchestrator/metrics/.proposals-write.lock.*',
  '.orchestrator/staging-fence/',
  '.orchestrator/tmp/',
];

/** The one bash block of the template that appends the store-lock patterns — loud failure otherwise. */
function loadSnippet() {
  const blocks = fencedBlocksMentioning(readFileSync(TEMPLATE, 'utf8'), LOCK_PATTERN, { lang: 'bash' });
  if (blocks.length !== 1) {
    throw new Error(`expected exactly one bash block mentioning ${LOCK_PATTERN} in ${TEMPLATE}, found ${blocks.length}`);
  }
  return blocks[0];
}

const SNIPPET = loadSnippet();

const tmpRoots = [];
afterEach(() => {
  while (tmpRoots.length > 0) {
    const root = tmpRoots.pop();
    // A write-only fixture must be readable again before rm can be sure of it.
    try {
      chmodSync(join(root, 'repo', '.gitignore'), 0o600);
    } catch {
      // not every fixture has one
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/** A fresh temp root (realpath: macOS tmpdir is behind the /var symlink). */
function tmpRoot() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'so-store-lock-')));
  tmpRoots.push(root);
  return root;
}

/**
 * Explicit minimal environment: never the caller's REPO_ROOT, PATH or git config.
 * @param {string} root temp root (HOME, and the ceiling git never searches above)
 * @param {Record<string, string>} [extra]
 */
function minimalEnv(root, extra = {}) {
  return {
    PATH: '/usr/bin:/bin',
    HOME: root,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CEILING_DIRECTORIES: root,
    ...extra,
  };
}

/** A `git init` repo under a new temp root, with `.gitignore` content when given. */
function repoWith(gitignore) {
  const root = tmpRoot();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const init = spawnSync('git', ['init', '-q', repo], { env: minimalEnv(root), encoding: 'utf8' });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  if (gitignore !== undefined) writeFileSync(join(repo, '.gitignore'), gitignore);
  return { root, repo, gi: join(repo, '.gitignore') };
}

/** Run the template's block once, the way the Upgrade / Refresh-Lock flows do. */
function runSnippet({ root, cwd, repoRoot }) {
  const env = minimalEnv(root, repoRoot === undefined ? {} : { REPO_ROOT: repoRoot });
  return spawnSync('/bin/bash', ['-c', SNIPPET], { cwd, env, encoding: 'utf8', timeout: 10_000 });
}

/** `git check-ignore --no-index` exit code per path: 0 ignored, 1 not ignored. */
function ignoreStatus(root, repo, paths) {
  return Object.fromEntries(
    paths.map((p) => [
      p,
      spawnSync('git', ['check-ignore', '--no-index', '-q', p], { cwd: repo, env: minimalEnv(root) }).status,
    ]),
  );
}

const isRoot = process.getuid?.() === 0;

describe('bootstrap template § store-lock-ignore — the shell block as agents run it', () => {
  it('keeps `.env` ignored when the .gitignore ends without a newline, and adds every pattern', () => {
    const { root, repo, gi } = repoWith('node_modules/\n.env');

    const r = runSnippet({ root, cwd: repo, repoRoot: repo });

    expect(r.status, r.stderr).toBe(0);
    const patterns = readFileSync(gi, 'utf8').split('\n').filter((l) => !l.startsWith('#'));
    expect(patterns).toEqual(['node_modules/', '.env', ...ALL_PATTERNS, '']);
    expect(
      ignoreStatus(root, repo, [
        '.env',
        '.orchestrator/metrics/learnings.jsonl.lock',
        '.orchestrator/metrics/.file.lock.ab12',
        '.orchestrator/metrics/learnings.jsonl.bak-2026-10-02T16-54-33-971Z',
        '.orchestrator/metrics/learnings.pre-drop-malformed.jsonl.bak-2026-10-02T16-54-33-971Z',
        '.orchestrator/metrics/learnings.jsonl',
        '.orchestrator/metrics/sessions.jsonl',
      ]),
    ).toEqual({
      '.env': 0,
      '.orchestrator/metrics/learnings.jsonl.lock': 0,
      '.orchestrator/metrics/.file.lock.ab12': 0,
      // #1500 F5: the keep-3 rewrite backups and the --drop-malformed snapshot
      // copy a whole store each; a `git add -A` committed them in consumer repos.
      '.orchestrator/metrics/learnings.jsonl.bak-2026-10-02T16-54-33-971Z': 0,
      '.orchestrator/metrics/learnings.pre-drop-malformed.jsonl.bak-2026-10-02T16-54-33-971Z': 0,
      // The ledgers themselves are durable project data and stay versioned.
      '.orchestrator/metrics/learnings.jsonl': 1,
      '.orchestrator/metrics/sessions.jsonl': 1,
    });
  });

  it('appends the block once across two runs', () => {
    const { root, repo, gi } = repoWith('node_modules/\n');

    expect(runSnippet({ root, cwd: repo, repoRoot: repo }).status).toBe(0);
    const afterFirst = readFileSync(gi, 'utf8');
    expect(runSnippet({ root, cwd: repo, repoRoot: repo }).status).toBe(0);

    expect(readFileSync(gi, 'utf8')).toBe(afterFirst);
    expect(afterFirst.split('\n').filter((l) => l === '.file.lock.*')).toEqual(['.file.lock.*']);
  });

  it('a repo upgraded from the two store-lock lines ignores the runtime locks and state, never the committed files (#1495)', () => {
    // Bug: bootstrap ignored only the ledger store locks, so a `git add -A` in a
    // consumer repo committed the session lock rewritten on every SessionStart,
    // the owner proof, current-session.json and the other runtime locks. Every
    // repo bootstrapped since #1487 carries exactly the two old lines, so the
    // block must append the rest without repeating those.
    const { root, repo, gi } = repoWith(`node_modules/\n${LOCK_PATTERN}\n.file.lock.*\n`);

    const r = runSnippet({ root, cwd: repo, repoRoot: repo });

    expect(r.status, r.stderr).toBe(0);
    const lines = readFileSync(gi, 'utf8').split('\n');
    expect(lines.filter((l) => l === LOCK_PATTERN || l === '.file.lock.*')).toEqual([LOCK_PATTERN, '.file.lock.*']);
    expect(
      ignoreStatus(root, repo, [
        '.orchestrator/session.lock',
        '.orchestrator/.session.lock.reclaim.0a1b',
        '.orchestrator/runtime/lock-owner-proof.json',
        '.orchestrator/current-session.json',
        '.orchestrator/host.json',
        '.orchestrator/state.lock',
        '.orchestrator/state.lock.acquire',
        '.orchestrator/.state.lock.tmp.create.tmp.0a1b',
        '.orchestrator/rules.lock',
        '.orchestrator/wave-dispatch-scopes.json',
        '.orchestrator/wave-dispatch-scopes.lock',
        '.orchestrator/.wave-dispatch-scopes.lock.create.tmp.0a1b',
        '.orchestrator/wave-transcript-tail.lock',
        '.orchestrator/metrics/proposals-write.lock',
        '.orchestrator/staging-fence/.commit.lock',
        '.orchestrator/tmp/reaped-locks/session.lock.20261002T120000Z',
        '.orchestrator/bootstrap.lock',
        '.orchestrator/policy/quality-gates.json',
        '.orchestrator/steering/tech.md',
        '.orchestrator/metrics/sessions.jsonl',
      ]),
    ).toEqual({
      '.orchestrator/session.lock': 0,
      '.orchestrator/.session.lock.reclaim.0a1b': 0,
      '.orchestrator/runtime/lock-owner-proof.json': 0,
      '.orchestrator/current-session.json': 0,
      '.orchestrator/host.json': 0,
      '.orchestrator/state.lock': 0,
      '.orchestrator/state.lock.acquire': 0,
      '.orchestrator/.state.lock.tmp.create.tmp.0a1b': 0,
      '.orchestrator/rules.lock': 0,
      '.orchestrator/wave-dispatch-scopes.json': 0,
      '.orchestrator/wave-dispatch-scopes.lock': 0,
      '.orchestrator/.wave-dispatch-scopes.lock.create.tmp.0a1b': 0,
      '.orchestrator/wave-transcript-tail.lock': 0,
      '.orchestrator/metrics/proposals-write.lock': 0,
      '.orchestrator/staging-fence/.commit.lock': 0,
      // F8: reaped lock copies carry host name, pid and session ids.
      '.orchestrator/tmp/reaped-locks/session.lock.20261002T120000Z': 0,
      // Durable project data consumers commit — must stay versioned.
      '.orchestrator/bootstrap.lock': 1,
      '.orchestrator/policy/quality-gates.json': 1,
      '.orchestrator/steering/tech.md': 1,
      '.orchestrator/metrics/sessions.jsonl': 1,
    });
  });

  it('leaves a CRLF .gitignore that already holds every pattern byte-identical', () => {
    const before = `node_modules/\r\n${ALL_PATTERNS.join('\r\n')}\r\n`;
    const { root, repo, gi } = repoWith(before);

    const r = runSnippet({ root, cwd: repo, repoRoot: repo });

    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(gi, 'utf8')).toBe(before);
  });

  it('does not write through a symlinked .gitignore', () => {
    const { root, repo, gi } = repoWith();
    const target = join(root, 'elsewhere.gitignore');
    writeFileSync(target, 'node_modules/\n');
    symlinkSync(target, gi);

    const r = runSnippet({ root, cwd: repo, repoRoot: repo });

    expect(r.status, r.stderr).toBe(0);
    expect(lstatSync(gi).isSymbolicLink()).toBe(true);
    expect(readlinkSync(gi)).toBe(target);
    expect(readFileSync(target, 'utf8')).toBe('node_modules/\n');
  });

  it.skipIf(isRoot)('does not touch a write-only .gitignore it cannot read (mode 0200)', () => {
    const { root, repo, gi } = repoWith('node_modules/\n.env');
    chmodSync(gi, 0o200);

    const r = runSnippet({ root, cwd: repo, repoRoot: repo });

    chmodSync(gi, 0o600);
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(gi, 'utf8')).toBe('node_modules/\n.env');
  });

  it('with REPO_ROOT unset outside any repo: exit 0, one stderr line, no write', () => {
    const root = tmpRoot();
    const cwd = join(root, 'not-a-repo');
    mkdirSync(cwd);
    const rootGitignoreBefore = existsSync('/.gitignore');

    const r = runSnippet({ root, cwd });

    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/^store-lock-ignore: .*skipped\n$/);
    expect(readdirSync(cwd)).toEqual([]);
    expect(existsSync('/.gitignore')).toBe(rootGitignoreBefore);
  });
});
