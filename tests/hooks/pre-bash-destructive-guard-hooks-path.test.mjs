/**
 * Wiring tests for the `hooks-path-missing` rule of hooks/pre-bash-destructive-guard.mjs (#1732).
 *
 * The defect: a fresh linked worktree has no `.husky/_` (husky creates it via npm `prepare`, which
 * `ignore-scripts=true` suppresses), and `core.hooksPath=.husky/_` is relative — so every commit and
 * push from it runs no hook, exit 0, no output. On 2026-10-22 a push went out without its pre-push
 * full gate that way. The fixture builds that exact shape with real git: a main checkout with the
 * hooks directory and a linked worktree without it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectDeny, expectAllow } from '../_helpers/hook-decision.mjs';
import { installScriptCli, SCRIPT_CLI_SUPPORTED } from '../_helpers/executable-fixture.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../hooks/pre-bash-destructive-guard.mjs');
const LIVE_POLICY = path.resolve(import.meta.dirname, '../../.orchestrator/policy/blocked-commands.json');
const RULE_ID = 'git-hooks-missing-in-worktree';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** Build root/main (hooksPath `.husky/_`, directory present) and root/wt (linked, directory absent). */
function buildRepo({ hooksPath = '.husky/_', mainHasHooks = true } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'guard-hookspath-'));
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  mkdirSync(path.join(main, '.orchestrator', 'policy'), { recursive: true });
  // The live rule, not a copy of its text: the fixture judges what ships.
  const rule = JSON.parse(readFileSync(LIVE_POLICY, 'utf8')).rules.find((r) => r.id === RULE_ID);
  writeFileSync(path.join(main, '.orchestrator', 'policy', 'blocked-commands.json'), JSON.stringify({ version: 1, rules: [rule] }));
  writeFileSync(path.join(main, 'CLAUDE.md'), '# Fixture\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'config', 'user.email', 'test@example.org');
  git(main, 'config', 'user.name', 'Test');
  git(main, 'config', 'commit.gpgsign', 'false');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  if (hooksPath !== null) git(main, 'config', 'core.hooksPath', hooksPath);
  if (mainHasHooks) {
    mkdirSync(path.join(main, '.husky', '_'), { recursive: true });
    writeFileSync(path.join(main, '.husky', '_', 'pre-push'), '#!/bin/sh\n');
  }
  git(main, 'worktree', 'add', '-q', '-b', 'feature', wt);
  return { root, main, wt };
}

function runGuard({ main, cwd, command, pathPrefix }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: main,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: main,
        CLAUDE_PLUGIN_ROOT: main,
        ...(pathPrefix ? { PATH: `${pathPrefix}${path.delimiter}${process.env.PATH}` } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }));
  });
}

describe('hooks-path-missing: a linked worktree without its hooks directory', () => {
  let repo;
  beforeAll(() => { repo = buildRepo(); });
  afterAll(() => { rmSync(repo.root, { recursive: true, force: true }); });

  // Catches: the silent hookless push and commit — the call's directory is the worktree, by the
  // payload cwd, by a literal `cd` before it (the shape that hit on 2026-10-22), or by `git -C`.
  it.each([
    ['push from the worktree cwd', 'wt', 'git push -o ci.skip -u origin feature'],
    ['commit from the worktree cwd', 'wt', 'git commit -m "x"'],
    ['cd into the worktree, wrapped push', 'main', 'cd {wt} && SO_GATE_HOSTS=m5 timeout 600 git push -u origin feature'],
    ['git -C the worktree', 'main', 'git -C {wt} push origin feature'],
    // Review of 9204e61a (M2): a `)` in a conventional commit message must not hide the `cd` — the
    // first version read any `)` as a subshell and never judged a `cd`-led commit.
    ['cd into the worktree, conventional commit', 'main', 'cd {wt} && git commit -m "fix(hooks): x"'],
    ['cd into the worktree, heredoc commit message', 'main', "cd {wt} && git commit -m \"$(cat <<'EOF'\nfix(hooks): x\nEOF\n)\""],
    // #1736: merge (pre-merge-commit, commit-msg), rebase (pre-rebase, post-rewrite) and am
    // (applypatch-msg, pre-applypatch) skip their hooks just as silently; train merges use --no-edit.
    ['a train merge', 'wt', 'git merge --no-edit main'],
    ['a merge with -n, which is --no-stat there, not --no-verify', 'wt', 'git merge -n main'],
    ['a rebase', 'wt', 'git rebase main'],
    ['an am', 'wt', 'git am 0001-x.patch'],
    // REFUTE review 2026-10-25 L2: quotes are gone before git runs; a quoted message is still a value.
    ['a quoted git and subcommand', 'wt', '"git" "push" origin feature'],
    // Codex review 2026-10-25 C1: a redirect between git and its subcommand is gone before git runs.
    ['a redirect between git and its subcommand', 'wt', 'git 2>/dev/null push origin feature'],
    ['a commit whose message is "--no-verify"', 'wt', 'git commit -m "--no-verify"'],
    // #1736: `env -C <dir>` moves the git call like `cd` does.
    ['env -C the worktree', 'main', 'env -C {wt} git commit -m "x"'],
    ['env --chdir= the worktree', 'main', 'env --chdir={wt} git push origin feature'],
  ])('denies %s', async (_name, cwdKey, template) => {
    const command = template.replaceAll('{wt}', repo.wt);
    const result = await runGuard({ main: repo.main, cwd: repo[cwdKey], command });
    // Review of f261a798 (M2): the way out installs from the lockfile first; a bare `npx husky` in a worktree
    // without node_modules fetches husky from the public registry and leaves hooks that fail on missing tools.
    const reason = expectDeny(result, [RULE_ID, 'npm ci', 'npx husky']).hookSpecificOutput.permissionDecisionReason;
    // Review of f261a798 (M1): the deny must not advertise the forms the rule lets through — no other rule
    // blocks `--no-verify`, so naming it turns the refused push into an ungated one on the next try.
    expect(reason).not.toMatch(/--no-verify|HUSKY=0|commit -n/);
  });

  // Catches false positives: each call either runs where hooks exist, skips them explicitly, or sits
  // behind a directory the guard cannot read — none of them may be blocked.
  it.each([
    ['a push from the main checkout', 'main', 'git push origin main'],
    ['an explicit --no-verify push', 'wt', 'git push --no-verify origin feature'],
    ['an explicit commit -n', 'wt', 'git commit -n -m "x"'],
    ['an explicit -n inside a short-flag group', 'wt', 'git commit -nm "x"'],
    ['an explicit HUSKY=0', 'wt', 'HUSKY=0 git commit -m "x"'],
    ['a cd inside a subshell, push outside it', 'main', '(cd {wt} && ls) && git push origin main'],
    ['a cd inside a command substitution, push outside it', 'main', 'echo "$(cd {wt} && pwd)"; git push origin main'],
    ['a cd to a variable', 'main', 'cd "$WT" && git push origin feature'],
    ['an unrelated git call in the worktree', 'wt', 'git status'],
    ['an overridden hooksPath', 'wt', 'git -c core.hooksPath=/elsewhere push origin feature'],
    // #1736: a hooksPath taken from an env var is as unknowable as an inline one.
    ['a hooksPath from --config-env=', 'wt', 'git --config-env=core.hooksPath=HP commit -m "x"'],
    ['a hooksPath from --config-env <value>', 'wt', 'git --config-env core.hooksPath=HP push origin feature'],
    // #1736: forms that run no hook at all, and the explicit skips of the new subcommands.
    ['commit --dry-run', 'wt', 'git commit --dry-run -m "x"'],
    ['merge --abort', 'wt', 'git merge --abort'],
    ['merge --quit', 'wt', 'git merge --quit'],
    ['rebase --abort', 'wt', 'git rebase --abort'],
    ['rebase --quit', 'wt', 'git rebase --quit'],
    ['am --abort', 'wt', 'git am --abort'],
    ['am --quit', 'wt', 'git am --quit'],
    ['am --show-current-patch=diff', 'wt', 'git am --show-current-patch=diff'],
    ['an explicit merge --no-verify', 'wt', 'git merge --no-verify --no-edit main'],
    ['an explicit am -n', 'wt', 'git am -n 0001-x.patch'],
  ])('allows %s', async (_name, cwdKey, template) => {
    const command = template.replaceAll('{wt}', repo.wt);
    const result = await runGuard({ main: repo.main, cwd: repo[cwdKey], command });
    expectAllow(result);
  });
});

describe('hooks-path-missing: repos where the hooks directory is not the worktree’s to have', () => {
  // Catches the rule firing outside its narrow case: no hooksPath at all, a main checkout that has
  // no hooks directory either (the repo installs none), and an absolute (global-style) hooksPath.
  it.each([
    ['no core.hooksPath', { hooksPath: null }],
    ['main checkout without the directory too', { mainHasHooks: false }],
    ['an absolute hooksPath', { hooksPath: '/nonexistent/hooks' }],
  ])('allows a worktree push with %s', async (_name, opts) => {
    const repo = buildRepo(opts);
    try {
      const result = await runGuard({ main: repo.main, cwd: repo.wt, command: 'git push origin feature' });
      expectAllow(result);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });

  // Catches a guard that stays shut after the fix it names: once `npx husky` created the directory
  // in the worktree, the same push is allowed.
  it('allows the push once the worktree has its hooks directory', async () => {
    const repo = buildRepo();
    try {
      mkdirSync(path.join(repo.wt, '.husky', '_'), { recursive: true });
      const result = await runGuard({ main: repo.main, cwd: repo.wt, command: 'git push origin feature' });
      expectAllow(result);
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});

describe('hooks-path-missing: cost per hook run', () => {
  // Catches the per-call re-measurement of #1736: `git commit && git push` in one directory spawned
  // the up-to-three git reads twice. A PATH shim counts the guard's git processes without timing.
  it.skipIf(!SCRIPT_CLI_SUPPORTED)('measures one directory once for two hooked calls', async () => {
    const repo = buildRepo();
    try {
      const realGit = process.env.PATH.split(path.delimiter).map((d) => path.join(d, 'git')).find((p) => existsSync(p));
      const binDir = path.join(repo.root, 'bin');
      const log = path.join(repo.root, 'git-calls.log');
      mkdirSync(binDir);
      installScriptCli(binDir, 'git', [
        "import { appendFileSync } from 'node:fs';",
        "import { spawnSync } from 'node:child_process';",
        `appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
        `const r = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });`,
        'process.exit(r.status ?? 1);',
      ].join('\n'));
      const result = await runGuard({
        main: repo.main,
        cwd: repo.main,
        command: 'git commit -m "x" && git push origin main',
        pathPrefix: binDir,
      });
      expectAllow(result);
      // hooksPath + show-toplevel (the main checkout has its hooks directory, so the read stops there) —
      // once for the directory, not once per call (4 before #1736).
      expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(2); // integrity-anchor: missingWorktreeHooks reads twice before it finds the hooks directory
    } finally {
      rmSync(repo.root, { recursive: true, force: true });
    }
  });
});
