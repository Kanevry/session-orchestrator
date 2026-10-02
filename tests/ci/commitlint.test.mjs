import { describe, it, expect, afterEach } from 'vitest';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';

const ROOT = process.cwd();
const doc = loadYaml(readFileSync(resolve(ROOT, '.gitlab-ci.yml'), 'utf8'));

const JOB_NAME = 'commitlint';
const job = doc[JOB_NAME];

// The bugs this file exists to catch, stated once:
//  1. `commitlint --from X --to Y` exits 0 over an EMPTY range and when nothing
//     matched (measured 2026-09-29, 19.8.1) — a job that only forwards commitlint's
//     exit code goes green while having checked zero commits. The job must fail
//     closed itself.
//  2. The project default clone depth is 20, so the range base may be absent;
//     that must be a red job, never a silent pass.
//  3. A squash merge commits the MR TITLE, which no linted range contains — the
//     only pipeline that saw it was main's, after the merge (#1477 item 1). An
//     MR that will squash must lint its title; one that will not must not.
// These are behavioral tests: the committed script block is lifted out of the
// YAML and executed against a real git repo with the CI variables set by hand.

/** The job's single folded script block — the exact string the runner executes. */
const scriptBlock = (job?.script ?? [])[0] ?? '';

const ZERO_SHA = '0'.repeat(40);

/** Tmp dirs created by any test below; drained after each test. */
const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

/**
 * Run git in `cwd`, failing loudly so a broken fixture never masquerades as a
 * job verdict.
 * @param {string} cwd
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
function git(cwd, args) {
  const res = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

/**
 * Build a temp repo: an initial `chore: base` commit, then one empty commit per
 * message. commitlint resolves from the worktree's node_modules (symlinked) and
 * the committed config (copied), exactly the two things `npm ci` + checkout give CI.
 * @param {string[]} messages commit messages after the base commit
 * @returns {{dir: string, base: string, head: string}}
 */
function makeRepo(messages) {
  const dir = mkdtempSync(join(tmpdir(), 'so-commitlint-'));
  tmpDirs.push(dir);
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'user.email', 'test@example.org']);
  copyFileSync(join(ROOT, 'commitlint.config.mjs'), join(dir, 'commitlint.config.mjs'));
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  git(dir, ['commit', '-q', '--allow-empty', '-m', 'chore: base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  for (const m of messages) git(dir, ['commit', '-q', '--allow-empty', '-m', m]);
  return { dir, base, head: git(dir, ['rev-parse', 'HEAD']) };
}

/**
 * Execute the committed script block with an explicit CI environment. The range
 * and MR-title variables are always set (empty string = unset) so a real GitLab
 * runner running this suite cannot leak its own values in.
 * @param {string} dir
 * @param {{mrBase?: string, before?: string, sha: string, squash?: string, title?: string}} ci
 * @returns {{status: number|null, out: string}}
 */
function runJob(dir, { mrBase = '', before = '', sha, squash = '', title = '' }) {
  const res = spawnSync('sh', ['-c', scriptBlock], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      CI_MERGE_REQUEST_DIFF_BASE_SHA: mrBase,
      CI_COMMIT_BEFORE_SHA: before,
      CI_COMMIT_SHA: sha,
      CI_MERGE_REQUEST_SQUASH_ON_MERGE: squash,
      CI_MERGE_REQUEST_TITLE: title,
    },
  });
  return { status: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

describe('commitlint job is wired as a hard, non-scheduled gate', () => {
  it('exists with a single script block', () => {
    // Absent job = no commit-message gate at all (and a pipeline-creation error via pipeline-gate).
    expect(job).toBeDefined();
    expect(job.script).toHaveLength(1);
  });

  it('is a plain (hard) need of pipeline-gate', () => {
    // #933 Loch 3: a gate not in the fan-in can vanish without turning the pipeline red.
    // Plain string, not `{job, optional: true}` — optional would let its absence pass.
    expect(doc['pipeline-gate'].needs).toContain(JOB_NAME);
  });

  it('uses the shared gate rules (schedules never run it) and is not allowed to fail', () => {
    // A scheduled pipeline exists only for vault-watcher; a divergent rule set would
    // either drag commitlint into schedules or silently drop it from MR pipelines.
    expect(job.rules).toEqual(doc['lint'].rules);
    expect(job.allow_failure).toBe(false);
  });

  it('clones full history, or the range base is missing from the default depth-20 clone', () => {
    expect(job.variables.GIT_DEPTH).toBe('0');
  });
});

describe('commitlint job lints the merge-request range', () => {
  // Every MR case passes `before: head`, the shape real MR pipelines carry (27 of the
  // last 40 had before_sha == sha, measured 2026-09-29): it pins the MR-base-first
  // precedence — checked the other way round, those pipelines would see an empty range.
  // Boundary of header-max-length 120 in commitlint.config.mjs: proves the job runs the
  // repo's config over the range instead of just exiting 0.
  it.each([
    ['120-char header', `feat: ${'x'.repeat(114)}`, 0],
    ['121-char header', `feat: ${'x'.repeat(115)}`, 1],
  ])('%s -> exit %i', (_label, header, expected) => {
    expect(header.length).toBe(expected === 0 ? 120 : 121);
    const { dir, base, head } = makeRepo(['fix: fine', header]);
    const { status, out } = runJob(dir, { mrBase: base, before: head, sha: head });
    expect(status, out).toBe(expected);
    // Red for the right reason, not via the empty-range exit a wrong precedence gives.
    if (expected !== 0) expect(out).toContain('header-max-length');
  });

  it('a non-conventional type in the middle of the range fails the job', () => {
    // Catches a job that lints only the tip commit (`build` is not in type-enum).
    const { dir, base, head } = makeRepo(['build: bump', 'fix: fine']);
    const { status, out } = runJob(dir, { mrBase: base, before: head, sha: head });
    expect(status, out).not.toBe(0);
    expect(out).toContain('type-enum');
  });

  it('valid commits plus a GitLab merge commit and a Revert pass', () => {
    // Catches a config that starts rejecting the merge commits GitLab itself creates
    // (commitlint's built-in default ignores, @commitlint/is-ignored; measured 2026-09-29).
    const { dir, base, head } = makeRepo([
      'fix: fine',
      "Merge branch 'fix/x' into 'main'",
      'Revert "fix: fine"',
    ]);
    const { status, out } = runJob(dir, { mrBase: base, before: head, sha: head });
    expect(status, out).toBe(0);
    expect(out).toContain('[commitlint] range');
  });
});

describe('commitlint job lints the MR title when the MR will squash (#1477 item 1)', () => {
  // GitLab renders CI_MERGE_REQUEST_SQUASH_ON_MERGE as "true"/"false" (`squash_on_merge?.to_s`).
  // Every case uses a valid commit range, so a red job is the TITLE's verdict.
  /** @param {{squash: string, title: string}} mr */
  function runMr(mr) {
    const { dir, base, head } = makeRepo(['fix: fine']);
    return runJob(dir, { mrBase: base, before: head, sha: head, ...mr });
  }

  it('fails a squash MR whose title is not conventional', () => {
    const { status, out } = runMr({ squash: 'true', title: 'Update the readme' });
    expect(status, out).toBe(1);
    expect(out).toContain('type-empty');
  });

  it('passes a squash MR whose title is conventional, having linted it', () => {
    const { status, out } = runMr({ squash: 'true', title: 'feat: add x' });
    expect(status, out).toBe(0);
    expect(out).toContain('linting it: feat: add x');
  });

  it('ignores the title of an MR that will not squash', () => {
    // Its commits are what lands, so a free-form title must not block it.
    const { status, out } = runMr({ squash: 'false', title: 'Update the readme' });
    expect(status, out).toBe(0);
    expect(out).toContain('MR title not linted');
  });

  // Unstripped, each title parses as type "Draft"/"[Draft]"/"(draft)" and fails type-enum.
  it.each(['Draft: ', '[Draft] ', '(draft) ', 'Draft: [Draft] '])(
    'strips the GitLab draft prefix %j before linting',
    (prefix) => {
      const { status, out } = runMr({ squash: 'true', title: `${prefix}feat: add x` });
      expect(status, out).toBe(0);
      expect(out).toContain('linting it: feat: add x');
    },
  );
});

describe('commitlint job fails closed', () => {
  it('rejects an empty range even though commitlint alone exits 0', () => {
    // The core bug: `commitlint --from HEAD --to HEAD` exits 0 having checked nothing.
    const { dir, head } = makeRepo(['fix: fine']);
    const { status, out } = runJob(dir, { mrBase: head, sha: head });
    expect(status, out).toBe(1);
    expect(out).toContain('FAIL: empty range');
  });

  it('rejects a range base that is not in the clone', () => {
    // Shallow clone (default depth 20) missing the base: must be red, not "nothing to lint".
    const { dir, head } = makeRepo(['fix: fine']);
    const { status, out } = runJob(dir, { mrBase: 'ab'.repeat(20), sha: head });
    expect(status).toBe(1);
    expect(out).toContain('is not in this clone');
  });
});

describe('commitlint job range fallbacks on non-MR pipelines', () => {
  it('uses the push before-sha when present', () => {
    // Branch pipeline: only commits new in this push are linted, not the whole history —
    // the non-conforming commit sits just below the range and must not turn it red.
    const { dir, head } = makeRepo(['not conventional', 'fix: fine']);
    const before = git(dir, ['rev-parse', 'HEAD~1']);
    const { status, out } = runJob(dir, { before, sha: head });
    expect(status, out).toBe(0);
    expect(out).toContain('push before-sha');
  });

  it('falls back to HEAD^1..HEAD on a new branch (zero before-sha) and lints the tip', () => {
    // First push of a branch has before-sha 0000…; without the fallback the range is garbage.
    const bad = `feat: ${'x'.repeat(115)}`;
    const { dir, head } = makeRepo(['fix: fine', bad]);
    const res = runJob(dir, { before: ZERO_SHA, sha: head });
    expect(res.status, res.out).not.toBe(0);
    expect(res.out).toContain('first parent of the pipeline commit');
  });

  it('passes on the fallback when the tip is valid', () => {
    const { dir, head } = makeRepo(['fix: fine']);
    const { status, out } = runJob(dir, { before: ZERO_SHA, sha: head });
    expect(status, out).toBe(0);
  });
});
