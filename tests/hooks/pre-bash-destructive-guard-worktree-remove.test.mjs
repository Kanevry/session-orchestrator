/**
 * Wiring tests for the `worktree-remove-unsafe` rule of hooks/pre-bash-destructive-guard.mjs (#1789).
 *
 * The defect: `git worktree remove` (no `--force`) deletes gitignored files with the worktree —
 * STATE.md, handover files, fleet train manifests — and "clean" per `git status --porcelain` does
 * not protect them; `--force` deletes untracked and modified files too. Two sessions lost state that
 * way (2026-10-15, 2026-10-24). The fixture is a real main checkout plus a LINKED worktree whose
 * committed `.gitignore` makes the valuable files ignored there. The guard only measures — no test
 * here runs `git worktree remove` itself.
 */

import { describe, it, beforeEach, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectDeny, expectAllow } from '../_helpers/hook-decision.mjs';
import { makeLinkedWorktree } from '../_helpers/linked-worktree.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../hooks/pre-bash-destructive-guard.mjs');
const LIVE_POLICY = path.resolve(import.meta.dirname, '../../.orchestrator/policy/blocked-commands.json');
const RULE_ID = 'worktree-remove-unsafe';
const GITIGNORE = '.orchestrator/\n.claude/STATE.md\nnode_modules/\n';

function writeIn(root, rel, content = 'x\n') {
  mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  writeFileSync(path.join(root, rel), content);
}

function runGuard({ main, cwd, command }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: main,
      env: { ...process.env, CLAUDE_PROJECT_DIR: main, CLAUDE_PLUGIN_ROOT: main },
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

describe('worktree-remove-unsafe: git worktree remove over state git does not track', () => {
  let repo;
  beforeEach(() => {
    repo = makeLinkedWorktree('guard-wt-remove-', { files: { '.gitignore': GITIGNORE, 'CLAUDE.md': '# Fixture\n' } });
    // The live rule, not a copy of its text: the fixture judges what ships. Written after the
    // worktree was added, and ignored, so the main checkout stays a plain repo.
    const rule = JSON.parse(readFileSync(LIVE_POLICY, 'utf8')).rules.find((r) => r.id === RULE_ID);
    writeIn(repo.main, '.orchestrator/policy/blocked-commands.json', JSON.stringify({ version: 1, rules: [rule] }));
  });
  afterEach(() => { repo.cleanup(); });

  // Catches the lost-handover incident: a plain removal of a worktree that git calls clean while an
  // ignored train manifest, STATE.md or session lock sits in it. The reason names the file.
  it.each([
    ['a fleet train manifest', '.orchestrator/runtime/fleet/x.md'],
    ['a harness STATE.md', '.claude/STATE.md'],
    ['a top-level session lock', '.orchestrator/session.lock'],
  ])('denies a plain removal over %s', async (_name, rel) => {
    writeIn(repo.wt, rel);
    const result = await runGuard({ main: repo.main, cwd: repo.main, command: `git worktree remove ${repo.wt}` });
    expectDeny(result, [RULE_ID, rel]);
  });

  // Catches the target resolving against the wrong directory: `-C`, a literal `cd`, a relative
  // operand and a chain must all measure the real worktree.
  it.each([
    ['git -C the main checkout, relative target', '/', 'git -C {main} worktree remove ../wt'],
    ['cd into the main checkout first', '/', 'cd {main} && git worktree remove ../wt'],
    ['relative target from the payload cwd', 'main', 'git worktree remove ../wt'],
    ['later segment of a chain', 'main', 'git status; git worktree remove {wt}'],
    // H3: git finds a worktree by a unique trailing path component, from anywhere in the repo.
    ['the worktree name alone from the main checkout', 'main', 'git worktree remove wt'],
  ])('denies via %s', async (_name, cwdKey, template) => {
    writeIn(repo.wt, '.orchestrator/runtime/fleet/x.md');
    const command = template.replaceAll('{main}', repo.main).replaceAll('{wt}', repo.wt);
    const cwd = cwdKey === '/' ? os.homedir() : repo[cwdKey];
    const result = await runGuard({ main: repo.main, cwd, command });
    expectDeny(result, [RULE_ID, '.orchestrator/runtime/fleet/x.md']);
  });

  // Catches a forced removal slipping through because the worktree is clean: force is never the agent's.
  it.each([
    ['--force', 'git worktree remove --force {wt}'],
    ['-f', 'git worktree remove -f {wt}'],
    ['-ff', 'git worktree remove -ff {wt}'],
    ['--force --force after the target', 'git worktree remove {wt} --force --force'],
    // REFUTE review 2026-10-25 H1: the shell strips quotes before git sees the word.
    ['a quoted --force before the target', 'git worktree remove "--force" {wt}'],
    ['a quoted --force after the target', 'git worktree remove {wt} "--force"'],
    ['a quoted git', '"git" worktree remove --force {wt}'],
    ['a quoted subcommand', 'git "worktree" remove --force {wt}'],
    // H2: git accepts unambiguous abbreviations of long options.
    ['the abbreviation --forc', 'git worktree remove --forc {wt}'],
    ['the abbreviation --fo', 'git worktree remove --fo {wt}'],
    // M1: a call inside a command substitution or a shell -c payload still runs.
    ['inside a command substitution', 'echo $(git worktree remove --force {wt})'],
    ['inside a bash -c payload', 'bash -c "git worktree remove --force {wt}"'],
    // Codex review 2026-10-25 C1: the shell removes redirects before git builds argv.
    ['a redirect between git and its subcommand', 'git >/dev/null worktree remove --force {wt}'],
    ['a redirect between worktree and remove', 'git worktree >/dev/null remove --force {wt}'],
    // C2: `c` anywhere in an option group, and options after -c, still make the first operand the command string.
    ['inside a bash -ce payload', 'bash -ce "git worktree remove --force {wt}"'],
    ['inside a bash -c -e payload', 'bash -c -e "git worktree remove --force {wt}"'],
    ['inside a sh -o errexit -c payload', 'sh -o errexit -c "git worktree remove --force {wt}"'],
  ])('denies %s on a clean worktree', async (_name, template) => {
    const result = await runGuard({ main: repo.main, cwd: repo.main, command: template.replaceAll('{wt}', repo.wt) });
    expectDeny(result, [RULE_ID, '--force', 'own terminal']);
  });

  // Catches fail-open on a target the guard cannot read: a variable, a substitution, an unknown
  // directory after `cd "$X"`, and an existing directory that is no worktree root.
  it.each([
    ['a variable target', 'git worktree remove "$WT"'],
    ['a substitution target', 'git worktree remove $(pwd)/x'],
    ['an unreadable cd before it', 'cd "$X" && git worktree remove wt'],
    ['a subdirectory, not a worktree root', 'git worktree remove {wt}/sub'],
    ['a plain removal inside a bash -c payload', 'bash -c "git worktree remove {wt}"'],
  ])('denies %s as not measurable', async (_name, template) => {
    writeIn(repo.wt, 'sub/keep.txt');
    const result = await runGuard({ main: repo.main, cwd: repo.main, command: template.replaceAll('{wt}', repo.wt) });
    expectDeny(result, [RULE_ID, 'not measurable']);
  });

  // Catches false positives: nothing valuable in the worktree, nothing to remove, other worktree
  // verbs, a `~` target that does not exist, and quoted words that are no call.
  it.each([
    ['a clean worktree', 'git worktree remove {wt}'],
    ['a worktree whose only ignored files are node_modules', 'git worktree remove {wt}', 'node_modules/pkg/index.js'],
    ['a missing target', 'git worktree remove {wt}-gone'],
    ['a missing ~ target', 'git worktree remove ~/no-such-worktree-1789'],
    ['worktree prune', 'git worktree prune'],
    ['worktree list', 'git worktree list'],
    ['worktree move', 'git worktree move {wt} {wt}-moved'],
  ])('allows %s', async (_name, template, extra) => {
    if (extra) writeIn(repo.wt, extra);
    const result = await runGuard({ main: repo.main, cwd: repo.main, command: template.replaceAll('{wt}', repo.wt) });
    expectAllow(result);
  });

  // Catches a guard that stays shut after the safe route: once the valuable file is moved out,
  // the same removal is allowed.
  it('allows the removal once the valuable file is gone', async () => {
    const command = `git worktree remove ${repo.wt}`;
    writeIn(repo.wt, '.claude/STATE.md');
    expectDeny(await runGuard({ main: repo.main, cwd: repo.main, command }), [RULE_ID, '.claude/STATE.md']);
    rmSync(path.join(repo.wt, '.claude'), { recursive: true, force: true });
    expectAllow(await runGuard({ main: repo.main, cwd: repo.main, command }));
  });
});
