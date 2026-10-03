/**
 * tests/skills/bootstrap-store-lock-ignore.test.mjs — runs the shell block of
 * `skills/bootstrap/_shared-template.md` § #store-lock-ignore, the production
 * call shape (TV-005): the block is extracted from the template at test time and
 * executed by `/bin/bash` in temp dirs, so the test judges the text agents run.
 *
 * Defects caught (each landed or was found only by review, #1487/#1489):
 *   - a runtime file the plugin writes, named "never commit" in this repo's own
 *     `.gitignore`, missing from the consumer block (the pinned list this test
 *     carried before could not see it: it compared the block with itself) —
 *     e.g. `pending-dream.md`, a full body of the operator's private MEMORY.md;
 *     or covered here only by a root line (`*.log`) the census cannot read;
 *   - the reverse drift: a block pattern this repo's own `.gitignore` lacks;
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
const REPO_GITIGNORE = resolve(import.meta.dirname, '..', '..', '.gitignore');
const LOCK_PATTERN = '.orchestrator/metrics/*.jsonl.lock*';

/**
 * Durable project data consumers commit — the block must leave it versioned.
 * The ledgers are ignored in THIS repo only; the other four are the files
 * `git ls-files .orchestrator` lists here (bootstrap.lock, peers/, policy/, steering/).
 */
const CONSUMER_VERSIONED = [
  '.orchestrator/metrics/sessions.jsonl',
  '.orchestrator/metrics/learnings.jsonl',
  '.orchestrator/bootstrap.lock',
  '.orchestrator/peers/AGENT.md',
  '.orchestrator/policy/quality-gates.json',
  '.orchestrator/steering/tech.md',
];

/**
 * `.orchestrator/` lines of this repo's own `.gitignore` deliberately NOT in the
 * consumer block, each with its reason. A NEW line there fails the census until
 * it is either added to the block or classified here.
 */
const NOT_IN_CONSUMER_BLOCK = {
  '.orchestrator/metrics/*.jsonl': 'the ledgers — consumers version them',
  '.orchestrator/STATE.md': 'no writer — STATE.md lives under .claude/',
  '.orchestrator/metrics/sweep.log': 'no writer — the registry sweep log lives in the private config dir',
  '.orchestrator/metrics/context-overhead-*.json': 'a hand-made measurement artifact of this repo',
  '.orchestrator/audits/': 'this repo\'s own session drafts — no plugin writer',
  '.orchestrator/drafts/': 'this repo\'s own session drafts — no plugin writer',
  '.orchestrator/scratch/': 'this repo\'s own session scratch — no plugin writer',
  '.orchestrator/session-artifacts/': 'this repo\'s own session scratch — no plugin writer',
  '.orchestrator/research/': 'this repo\'s own research scratch — no plugin writer',
  '.orchestrator/session-notes/': 'this repo\'s internal design notes — no plugin writer',
};

/**
 * Plugin runtime files this repo's `.gitignore` covers only through a line
 * OUTSIDE `.orchestrator/` — the root `*.log` — so the census, which reads the
 * `.orchestrator/` lines, cannot see them. The writers: `session-close-backfill.mjs`
 * (its `error` text carries fs messages with absolute paths), `reconcile/writer.mjs`
 * and `memory-proposals/sink.mjs` (the declined-proposal archives).
 */
const RUNTIME_COVERED_BY_ROOT_LINE = [
  '.orchestrator/metrics/session-close-backfill.log',
  '.orchestrator/reconcile.rejected.log',
  '.orchestrator/proposals.rejected.log',
];

/** The `.orchestrator/` files this repo tracks (`git ls-files .orchestrator`) — its own `.gitignore` must leave them versioned. */
const REPO_VERSIONED = [
  '.orchestrator/bootstrap.lock',
  '.orchestrator/peers/AGENT.md',
  '.orchestrator/policy/blocked-commands.json',
  '.orchestrator/steering/tech.md',
];

/** The `.orchestrator/` ignore lines of this repo's own `.gitignore`. */
function repoOrchestratorIgnoreLines() {
  return readFileSync(REPO_GITIGNORE, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('.orchestrator/'));
}

/** One concrete path an ignore pattern matches: `[0-9]` → `0`, `*`/`?` → `x`, a directory gets a file. */
function samplePath(pattern) {
  const p = pattern.replace(/\[(.)[^\]]*\]/g, '$1').replace(/[*?]/g, 'x');
  return p.endsWith('/') ? `${p}sample` : p;
}

/** The one bash block of the template that appends the store-lock patterns — loud failure otherwise. */
function loadSnippet() {
  const blocks = fencedBlocksMentioning(readFileSync(TEMPLATE, 'utf8'), LOCK_PATTERN, { lang: 'bash' });
  if (blocks.length !== 1) {
    throw new Error(`expected exactly one bash block mentioning ${LOCK_PATTERN} in ${TEMPLATE}, found ${blocks.length}`);
  }
  return blocks[0];
}

const SNIPPET = loadSnippet();

/** The block's `_GI_PATTERNS`, as bash itself expands the array — loud failure when the array is gone. */
function blockPatterns() {
  const array = SNIPPET.match(/^_GI_PATTERNS=\([\s\S]*?^\)$/m)?.[0];
  if (!array) throw new Error(`no _GI_PATTERNS=( … ) array in the store-lock-ignore block of ${TEMPLATE}`);
  const r = spawnSync('/bin/bash', ['-c', `${array}\nprintf '%s\\n' "\${_GI_PATTERNS[@]}"`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`bash could not expand _GI_PATTERNS: ${r.stderr}`);
  return r.stdout.split('\n').filter(Boolean);
}

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
  it('ignores every runtime path this repo\'s own .gitignore names, keeps consumer data and `.env` (census)', () => {
    // Bug: four runtime files the plugin writes — the auto-dream sidecar (a full
    // body of the private MEMORY.md), the dialectic sidecar and its timestamp,
    // the worktree-promotion marker — were "never commit" here and missing from
    // the consumer block; a `git add -A` in a consumer repo committed them.
    const census = repoOrchestratorIgnoreLines().filter((l) => !Object.hasOwn(NOT_IN_CONSUMER_BLOCK, l));
    const { root, repo, gi } = repoWith('node_modules/\n.env');

    const r = runSnippet({ root, cwd: repo, repoRoot: repo });

    expect(r.status, r.stderr).toBe(0);
    // A last line without a newline must not fuse with the comment (`.env# …` un-ignores `.env`).
    expect(readFileSync(gi, 'utf8').split('\n').slice(0, 2)).toEqual(['node_modules/', '.env']);
    // The diagnostic logs (MED-1 on b57e572c) were missed this way: covered here
    // by the root `*.log`, invisible to a census of `.orchestrator/` lines.
    const mustIgnore = ['.env', ...census.map(samplePath), ...RUNTIME_COVERED_BY_ROOT_LINE];
    const status = ignoreStatus(root, repo, [...mustIgnore, ...CONSUMER_VERSIONED]);
    expect(mustIgnore.filter((p) => status[p] !== 0)).toEqual([]);
    expect(CONSUMER_VERSIONED.filter((p) => status[p] !== 1)).toEqual([]);
  });

  it('this repo\'s own .gitignore ignores every pattern the block writes, and none of its tracked files (reverse census)', () => {
    // Bug (LOW-1 on b57e572c): the block grew runtime classes — #1494's
    // `.session.lock.reclaim.<x>` tombstone, the `.acquire` guards, the lock
    // temp files — that this repo's own `.gitignore` never got, so a `git add -A`
    // HERE committed what consumers were already protected from. The tracked
    // half catches the opposite slip: a widened glob here swallowing a marker
    // this repo versions (`bootstrap.lock`).
    const patterns = blockPatterns();
    expect(patterns).toContain(LOCK_PATTERN);
    const { root, repo } = repoWith(readFileSync(REPO_GITIGNORE, 'utf8'));

    const samples = patterns.map(samplePath);
    const status = ignoreStatus(root, repo, [...samples, ...REPO_VERSIONED]);

    expect(samples.filter((p) => status[p] !== 0)).toEqual([]);
    expect(REPO_VERSIONED.filter((p) => status[p] !== 1)).toEqual([]);
  });

  it('classifies only lines this repo\'s .gitignore still carries', () => {
    // A stale exemption would silently shelter a pattern re-added later under its name.
    const lines = new Set(repoOrchestratorIgnoreLines());
    expect(Object.keys(NOT_IN_CONSUMER_BLOCK).filter((l) => !lines.has(l))).toEqual([]);
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
    const lf = repoWith('node_modules/\n');
    expect(runSnippet({ root: lf.root, cwd: lf.repo, repoRoot: lf.repo }).status).toBe(0);
    const before = readFileSync(lf.gi, 'utf8').replaceAll('\n', '\r\n');
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
