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
  it('keeps `.env` ignored when the .gitignore ends without a newline, and adds both patterns', () => {
    const { root, repo, gi } = repoWith('node_modules/\n.env');

    const r = runSnippet({ root, cwd: repo, repoRoot: repo });

    expect(r.status, r.stderr).toBe(0);
    const patterns = readFileSync(gi, 'utf8').split('\n').filter((l) => !l.startsWith('#'));
    expect(patterns).toEqual(['node_modules/', '.env', LOCK_PATTERN, '.file.lock.*', '']);
    expect(
      ignoreStatus(root, repo, [
        '.env',
        '.orchestrator/metrics/learnings.jsonl.lock',
        '.orchestrator/metrics/.file.lock.ab12',
        '.orchestrator/metrics/learnings.jsonl',
      ]),
    ).toEqual({
      '.env': 0,
      '.orchestrator/metrics/learnings.jsonl.lock': 0,
      '.orchestrator/metrics/.file.lock.ab12': 0,
      // The ledger itself is durable project data and stays versioned.
      '.orchestrator/metrics/learnings.jsonl': 1,
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

  it('leaves a CRLF .gitignore that already holds both patterns byte-identical', () => {
    const before = `node_modules/\r\n${LOCK_PATTERN}\r\n.file.lock.*\r\n`;
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
