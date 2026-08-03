/**
 * tests/hooks/pre-bash-destructive-guard.test.mjs
 *
 * Vitest tests for hooks/pre-bash-destructive-guard.mjs.
 *
 * Strategy: spawn the hook as a subprocess, pipe JSON on stdin,
 * assert exit code and stderr for each behavioural case.
 *
 * Exit-code contract (#906): EVERY path exits 0. A deny is signalled by the
 * `hookSpecificOutput` envelope on stdout, never by exit 2 — Claude Code
 * discards stdout on exit 2, so the whole deny reason would be thrown away.
 * Because allow and deny now share exit 0, a bare `expect(code).toBe(0)` no
 * longer distinguishes them: use `expectDeny` / `expectAllow` below, which
 * assert on the stdout envelope. That distinction is the whole point of these
 * assertions — without it a regression that lost the envelope would read as a
 * silent ALLOW of a destructive command and the suite would stay green.
 *
 * Issue: #155 (deliverable 2), #906 (deny-envelope migration)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { unwritablePath } from '../_helpers/unwritable-path.mjs';

import { expectDeny, expectAllow } from '../_helpers/hook-decision.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HOOK = path.resolve(import.meta.dirname, '../../hooks/pre-bash-destructive-guard.mjs');
const EVENTS_REL = path.join('.orchestrator', 'metrics', 'events.jsonl');

/** Minimal policy fixture used by most tests (13 rules mirroring the spec). */
const FIXTURE_POLICY = {
  version: 1,
  rules: [
    {
      id: 'git-reset-hard',
      pattern: 'git reset --hard',
      severity: 'block',
      rationale: 'Destroys staged or committed work that may belong to another session.',
    },
    {
      id: 'git-push-force',
      pattern: 'git push --force',
      severity: 'block',
      rationale: 'Rewrites shared history.',
    },
    {
      id: 'git-push-force-short',
      pattern: 'git push -f',
      severity: 'block',
      rationale: 'Rewrites shared history (short form).',
    },
    {
      id: 'git-checkout-discard',
      pattern: 'git checkout -- .',
      severity: 'block',
      rationale: 'Discards uncommitted changes that another session may be building.',
    },
    {
      id: 'git-clean-force',
      pattern: 'git clean -f',
      severity: 'block',
      rationale: 'Deletes untracked files another session created.',
    },
    {
      id: 'git-stash-any',
      pattern: 'git stash',
      severity: 'warn',
      rationale: 'Captures another session\'s changes into a stash they cannot find.',
    },
    {
      id: 'rm-rf-destructive',
      pattern: 'rm -rf',
      severity: 'block',
      'path-allowlist': ['/tmp/', '/private/tmp/', '$TMPDIR'],
      rationale: 'Deletes files that may belong to another session.',
    },
    {
      id: 'git-revert-commit',
      pattern: 'git revert',
      severity: 'warn',
      rationale: 'May undo another session\'s completed work.',
    },
    {
      id: 'git-branch-delete',
      pattern: 'git branch -D',
      severity: 'block',
      rationale: 'Deletes branches that may contain another session\'s work.',
    },
    {
      id: 'git-branch-delete-lower',
      pattern: 'git branch -d',
      severity: 'warn',
      rationale: 'Deletes merged branches — confirm no parallel work.',
    },
    {
      id: 'git-restore-staged',
      pattern: 'git restore --staged',
      severity: 'warn',
      rationale: 'Unstages files that may belong to another session.',
    },
    {
      id: 'git-restore-worktree',
      pattern: 'git restore .',
      severity: 'block',
      rationale: 'Discards all tracked changes in the working tree.',
    },
    {
      id: 'git-push-force-lease',
      pattern: 'git push --force-with-lease',
      severity: 'warn',
      rationale: 'Force-with-lease is safer but still requires coordinator approval.',
    },
  ],
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn the hook, pipe stdin JSON, collect stdout/stderr, resolve with exit code.
 */
async function runHook({ projectDir, stdin, env = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: projectDir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, CLAUDE_PLUGIN_ROOT: projectDir, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

/**
 * Create a temporary project dir with:
 *   - CLAUDE.md containing an optional ## Session Config block
 *   - .orchestrator/policy/blocked-commands.json with the given policy
 *   - a git repo (for git-stash-any tests)
 */
async function mkProject({ policy = FIXTURE_POLICY, claudeMdExtra = '' } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-test-'));

  // CLAUDE.md
  const claudeMd = `# Test Project\n\n## Session Config\n\npersistence: true\n${claudeMdExtra}\n`;
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), claudeMd);

  // Policy file
  const policyDir = path.join(dir, '.orchestrator', 'policy');
  await fs.mkdir(policyDir, { recursive: true });
  await fs.writeFile(
    path.join(policyDir, 'blocked-commands.json'),
    JSON.stringify(policy, null, 2)
  );

  // Git init (needed for git-stash-any tests)
  const { $ } = await import('zx');
  $.verbose = false;
  $.quiet = true;
  await $`git -C ${dir} init -q`;
  await $`git -C ${dir} config user.email "test@test.com"`;
  await $`git -C ${dir} config user.name "Test"`;

  return dir;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

const tmpDirs = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function mkProjectTracked(opts) {
  const dir = await mkProject(opts);
  tmpDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Payload builders
// ---------------------------------------------------------------------------

function bashPayload(command) {
  return JSON.stringify({ tool_name: 'Bash', tool_input: { command } });
}

function nonBashPayload() {
  return JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'src/app.ts' } });
}

// ---------------------------------------------------------------------------
// Deny / allow assertions (#906 PreToolUse envelope contract)
// ---------------------------------------------------------------------------

/** Read + parse a project's events.jsonl records (skips blank lines). */
function readEvents(projectDir) {
  const p = path.join(projectDir, EVENTS_REL);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// G1 — tool filter
// ---------------------------------------------------------------------------

describe('tool filter', { timeout: 15000 }, () => {
  it('exits 0 for non-Bash tool (Edit)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: nonBashPayload() });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// G2 — missing policy → allow with warning
// ---------------------------------------------------------------------------

describe('missing policy file', { timeout: 15000 }, () => {
  it('exits 0 with stderr warning when policy file is absent', async () => {
    const dir = await mkProjectTracked();
    // Remove the policy file
    await fs.rm(path.join(dir, '.orchestrator', 'policy', 'blocked-commands.json'));
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expectAllow(result);
    expect(result.stderr).toContain('policy file not found');
  });
});

// ---------------------------------------------------------------------------
// G3 — bypass via allow-destructive-ops: true
// ---------------------------------------------------------------------------

describe('allow-destructive-ops bypass', { timeout: 15000 }, () => {
  it('exits 0 and emits bypass notice when allow-destructive-ops: true is set', async () => {
    const dir = await mkProjectTracked({
      claudeMdExtra: 'allow-destructive-ops: true',
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expectAllow(result);
    expect(result.stderr).toContain('bypassed');
  });

  it('blocks git reset --hard when allow-destructive-ops is absent (default)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// Severity: block — various patterns
// ---------------------------------------------------------------------------

describe('severity block — git reset --hard', { timeout: 15000 }, () => {
  it('exits 2 for "git reset --hard HEAD~1"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expectDeny(result);
  });

  it('deny reason references the pattern and rule id', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    const reason = expectDeny(result).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('git reset --hard');
    expect(reason).toContain('git-reset-hard');
  });

  it('deny reason includes Override hint', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expectDeny(result, 'allow-destructive-ops');
  });

  // #906 anti-regression anchor. The pre-#906 hook wrote a flat
  // `{permissionDecision, reason}` object to stdout and exited 2 — under which
  // Claude Code discards stdout and reads stderr, and this hook wrote NO
  // stderr. The operator therefore saw `hook error: … No stderr output`, i.e.
  // what reads as a crash, for a block that had in fact fired. No test caught
  // that because every assertion pinned `exit 2`, the defect itself. This test
  // pins the repaired contract end to end: the multi-line reason must survive
  // whole for Claude, AND the operator must get a visible headline.
  it('#906: denies via a single exit-0 envelope that keeps the full 4-line reason and an operator headline', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    const reason = expectDeny(result).hookSpecificOutput.permissionDecisionReason;

    // All four reason lines reach Claude verbatim through the JSON escaping.
    expect(reason.split('\n')).toEqual([
      "Destructive command blocked: 'git reset --hard' (rule: git-reset-hard)",
      'Reason: Destroys staged or committed work that may belong to another session.',
      'Override: Set `allow-destructive-ops: true` in Session Config if intentional.',
      'See: issue #155, .claude/rules/parallel-sessions.md (PSA-003)',
    ]);

    // The operator half: a short, visible headline derived from line 1.
    const out = JSON.parse(result.stdout);
    expect(out.systemMessage).toBe(
      "⛔ Destructive command blocked: 'git reset --hard' (rule: git-reset-hard)",
    );

    // The deprecated flat form must not come back alongside the envelope.
    expect(out.permissionDecision).toBeUndefined();
    expect(out.reason).toBeUndefined();
  });
});

describe('severity block — git push --force', { timeout: 15000 }, () => {
  it('exits 2 for "git push --force origin main"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push --force origin main'),
    });
    expectDeny(result);
  });

  it('exits 2 for "git push -f" short form', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git push -f origin main'),
    });
    expectDeny(result);
  });
});

describe('severity block — git clean -f', { timeout: 15000 }, () => {
  it('exits 2 for "git clean -f"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git clean -f'),
    });
    expectDeny(result);
  });
});

describe('severity block — git restore .', { timeout: 15000 }, () => {
  it('exits 2 for "git restore ."', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git restore .'),
    });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// rm -rf — path exception logic
// ---------------------------------------------------------------------------

describe('rm -rf path exception', { timeout: 15000 }, () => {
  it('exits 2 (blocked) for "rm -rf src/"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf src/'),
    });
    expectDeny(result);
  });

  it('exits 0 (allowed) for "rm -rf .orchestrator/tmp/foo"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(`rm -rf ${path.join(dir, '.orchestrator/tmp/foo')}`),
    });
    expectAllow(result);
  });

  it('exits 0 (allowed) for relative path .orchestrator/tmp/something', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf .orchestrator/tmp/something'),
    });
    expectAllow(result);
  });

  it('exits 0 (allowed) for "rm -rf node_modules"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf node_modules'),
    });
    expectAllow(result);
  });

  it('exits 2 (blocked) for "rm -rf /" (root)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /'),
    });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// #641 — /tmp allowlist false-positive fixes (exit 0)
// ---------------------------------------------------------------------------

describe('#641 rm -rf /tmp allowlist (exit 0)', { timeout: 15000 }, () => {
  it('allows "rm -rf /tmp/wondraiwork-632" (FP1 — agent tmp clone)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /tmp/wondraiwork-632'),
    });
    expectAllow(result);
  });

  it('allows "rm -rf /private/tmp/foo" (macOS canonical /tmp)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /private/tmp/foo'),
    });
    expectAllow(result);
  });

  it('allows a resolved os.tmpdir() target ($TMPDIR allowlist entry)', async () => {
    const dir = await mkProjectTracked();
    const target = path.join(os.tmpdir(), 'agent-scratch-641');
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(`rm -rf ${target}`),
    });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// #641 — quoted-payload guard false-positive fixes (exit 0)
// Blocked substrings are built from fragments so they never appear literally on
// the test-runner shell command line; they reach the hook only via stdin JSON.
// ---------------------------------------------------------------------------

describe('#641 quoted-payload false positives (exit 0)', { timeout: 15000 }, () => {
  it('allows memory-propose with blocked substrings inside quoted args (FP2)', async () => {
    const dir = await mkProjectTracked();
    const insight = 'workaround used ' + 'rm ' + '-rf /tmp/x';
    const evidence = 'see ' + 'git ' + 'reset --hard note';
    const command = `node scripts/memory-propose.mjs --insight "${insight}" --evidence "${evidence}"`;
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectAllow(result);
  });

  it('allows node script with a force-push warning string in a quoted arg', async () => {
    const dir = await mkProjectTracked();
    const msg = 'do not run ' + 'git ' + 'push --force';
    const command = `node x.mjs --msg "${msg}"`;
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectAllow(result);
  });

  it('allows echo of a quoted destructive literal', async () => {
    const dir = await mkProjectTracked();
    const command = 'echo "' + 'rm ' + '-rf /"';
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// #641 — bypass vectors must STILL block (exit 2)
// ---------------------------------------------------------------------------

describe('#641 bypass vectors still blocked (exit 2)', { timeout: 30000 }, () => {
  const RMRF = 'rm ' + '-rf';
  const RESET = 'git ' + 'reset --hard';
  const vectors = [
    ['bash -c', `bash -c "${RMRF} /data"`],
    ['sh -c', `sh -c "${RMRF} /data"`],
    ['eval', `eval "${RMRF} /data"`],
    ['xargs', `echo /data | xargs ${RMRF}`],
    ['semicolon', `ls; ${RMRF} /data`],
    ['and-and', `true && ${RMRF} /data`],
    ['pipe-to-rm', `echo x | ${RMRF} /data`],
    ['env-assign', `FOO=1 ${RMRF} /data`],
    ['cmd-subst', `x=$(${RMRF} /data)`],
    ['command-prefix', `command ${RMRF} /data`],
    ['chained-reset', `ls && ${RESET} HEAD`],
    ['bare-reset', `${RESET} HEAD~1`],
  ];

  it.each(vectors)('blocks bypass vector: %s', async (_label, command) => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectDeny(result);
  });

  it('blocks mixed chain where one rm target is non-allowlisted', async () => {
    const dir = await mkProjectTracked();
    const command = `${RMRF} /tmp/x; ${RMRF} src/`;
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// #641 — /tmp allowlist path-traversal escape must STILL block (exit 2)
//
// isRmPathAllowed normalises `..` BEFORE the allowlist-prefix check, so a
// traversal target like `/tmp/../etc` collapses to `/etc` ∉ allowlist → block.
// These tests pin that SAFE behaviour: a future refactor that swapped the
// path.normalize+prefix check for a naive `startsWith('/tmp')` would re-open
// `rm -rf /tmp/../etc` → /etc deletion, and exactly these assertions would flip
// from exit 2 to exit 0 and fail.
// ---------------------------------------------------------------------------

describe('#641 rm -rf /tmp allowlist traversal escape (exit 2)', { timeout: 15000 }, () => {
  it.each([
    ['traversal escapes allowlist to /etc', 'rm -rf /tmp/../etc'],
    ['deeper traversal escapes to /etc', 'rm -rf /tmp/x/../../etc'],
    ['macOS canonical /tmp traversal escape', 'rm -rf /private/tmp/../etc'],
    ['one allowlisted + one non-allowlisted target', 'rm -rf /tmp/ /etc'],
  ])('blocks %s', async (_label, command) => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// #965 Risk C — a redirect TARGET is not an `rm` operand
//
// The bug: `tokenizeCommand` emits redirect operators as standalone tokens but
// leaves the target as an ordinary one (deliberately — dropping it inside the
// lexer would have changed rm-allowlist verdicts from a module that cannot see
// the allowlist). Both rm walkers here read that target as an rm TARGET, so
// `rm -rf /tmp/scratch > /tmp/out.log` was judged as TWO targets. Since the
// second is not on the rule's `path-allowlist`, `targets.every(allowed)` failed
// and four legitimate temp cleanups were DENIED — measured against the real
// policy file, not hypothesised.
//
// Both directions are pinned below, because this is a PERMISSIVE-direction fix:
// the allow half proves the false positives are gone, and the deny half proves
// the skip did not launder a non-allowlisted target past the allowlist. Without
// the deny half, deleting `parseRmTargets`' allowlist check entirely would keep
// the allow half green.
//
// ## The over-correction the second deny table pins
//
// The first cut of that skip was TARGET-BLIND: it dropped operator AND target
// unconditionally. Bash agrees `rm` has one operand there, so the rm verdict was
// right — but `>` TRUNCATES its target to zero bytes before rm ever runs, and no
// rule in blocked-commands.json covers a bare `>`. So `rm -rf /tmp/ok > CLAUDE.md`
// — an emptied CLAUDE.md, DENIED before the skip existed — became an ALLOW. Same
// for `> /etc/passwd`, `> src/important.ts` and the `>|` clobber form.
//
// The fix distinguishes WRITE redirects (`>`, `>>`, `>|`, with any fd prefix)
// from READ redirects (`<`, `<<`, `<<-`, `<<<`, which cannot truncate or create)
// and holds every write target to the SAME allowlist the rm operands face, with
// `/dev/null` carved out as the one non-destructible sink. The rows are grouped
// by that discriminator on purpose: a regression that re-blinds the check flips
// the write rows, and one that treats `<` like `>` flips the read rows.
// ---------------------------------------------------------------------------

describe('#965 rm redirect targets are not operands', { timeout: 30000 }, () => {
  // ALLOW: the only operand is /tmp/scratch; the rest is shell plumbing whose
  // target is either allowlisted, a null sink, or read-only (cannot truncate).
  it.each([
    ['stdout redirect', 'rm -rf /tmp/scratch > /tmp/out.log'],
    ['bare (control — no redirect)', 'rm -rf /tmp/scratch'],
    ['fd-prefixed stderr redirect to the null sink', 'rm -rf /tmp/scratch 2> /dev/null'],
    ['fd-prefixed stderr redirect to an allowlisted file', 'rm -rf /tmp/scratch 2> /tmp/err.log'],
    ['&> (lexes as chain-op & + >)', 'rm -rf /tmp/scratch &> /tmp/out.log'],
    ['append redirect', 'rm -rf /tmp/scratch >> /tmp/out.log'],
    ['clobber redirect to an allowlisted target', 'rm -rf /tmp/scratch >| /tmp/out.log'],
    // READ redirects never truncate — their target needs no allowlist check,
    // which is why these two keep a deliberately NON-allowlisted filename.
    ['stdin redirect', 'rm -rf /tmp/scratch < /etc/passwd'],
    ['here-string', 'rm -rf /tmp/scratch <<< /etc/passwd'],
    ['stdin redirect from an allowlisted file', 'rm -rf /tmp/scratch < /tmp/in.txt'],
    // `2>&1` lexes as `2>` `&` `1`: an fd DUPLICATION, no file target at all. A
    // fix that denied every write redirect lacking a resolvable file target
    // would break this extremely common shape.
    ['fd duplication after an allowlisted redirect', 'rm -rf /tmp/x > /tmp/log 2>&1'],
  ])('allows %s', async (_label, command) => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectAllow(result);
  });

  // DENY, group 1: the OPERAND is non-allowlisted. Each row pairs it with a
  // redirect whose target IS allowlisted — so a regression that counted the
  // redirect target again, or that skipped operand checking wholesale, flips these.
  it.each([
    ['non-allowlisted operand + allowlisted redirect target',
      'rm -rf /etc/passwd > /tmp/out.log'],
    ['non-allowlisted operand + allowlisted append target',
      'rm -rf src/ >> /tmp/out.log'],
    ['redirect must not swallow the chain operator',
      'rm -rf /tmp/scratch > /tmp/out.log; rm -rf /etc'],
    ['traversal escape survives a redirect',
      'rm -rf /tmp/../etc > /tmp/out.log'],
    ['redirect with NO operand is unparseable → conservative deny',
      'rm -rf > /tmp/out.log'],
    ['redirect operator cannot hide a trailing non-allowlisted operand',
      'rm -rf > x /etc'],
    ['redirect with an allowlisted target cannot hide a trailing operand',
      'rm -rf > /tmp/x /etc'],
    ['dangling redirect cannot swallow the chain into a second rm',
      'rm -rf /tmp/x > ; rm -rf src/'],
    ['fd-prefixed redirect cannot hide a trailing non-allowlisted operand',
      'rm -rf 2>/dev/null /etc'],
    ['fd-prefixed redirect after a non-allowlisted operand',
      'rm -rf /etc 2>/dev/null'],
  ])('blocks %s', async (_label, command) => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectDeny(result);
  });

  // DENY, group 2 — the target-blind-skip regression. The OPERAND is allowlisted
  // in every row; the WRITE-redirect target is not. Each command destroys the
  // named file's contents behind an exit-0 allow when the write target goes
  // unchecked, which is exactly what the first cut of the skip did.
  it.each([
    ['truncating /etc/passwd via stdout redirect', 'rm -rf /tmp/ok > /etc/passwd'],
    ['truncating project source via stdout redirect', 'rm -rf /tmp/ok > src/important.ts'],
    ['truncating CLAUDE.md via stdout redirect', 'rm -rf /tmp/ok > CLAUDE.md'],
    ['truncating a quoted project-file target', 'rm -rf /tmp/ok > "CLAUDE.md"'],
    ['clobbering /etc via >|', 'rm -rf /tmp/scratch >| /etc/out.log'],
    ['appending into /etc via fd-prefixed >>', 'rm -rf /tmp/ok 2>> /etc/log'],
  ])('blocks %s', async (_label, command) => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// #641 — gap closures: rm flag-form variants must block
// ---------------------------------------------------------------------------

describe('#641 rm flag-form gap closures (exit 2)', { timeout: 15000 }, () => {
  it.each([
    ['split flags', 'rm -r -f /data'],
    ['reordered combined flags', 'rm -fr /data'],
  ])('blocks %s', async (_label, command) => {
    const dir = await mkProjectTracked();
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// #642 — rm whitespace-obfuscation and TMPDIR allowlist hardening
// ---------------------------------------------------------------------------

describe('#642 rm whitespace-obfuscation gap closures (exit 2)', { timeout: 15000 }, () => {
  it.each([
    ['IFS braced', 'rm${IFS}-rf /data'],
    ['IFS bare', 'rm$IFS-rf /data'],
    ['IFS default', 'rm${IFS:- }-rf /data'],
    ['ANSI-C tab', "rm$'\\t'-rf /data"],
  ])('blocks obfuscated rm -rf via %s', async (_label, command) => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(command),
    });
    expectDeny(result);
  });
});

describe('#642 TMPDIR allowlist confinement', { timeout: 15000 }, () => {
  it('blocks inherited TMPDIR=/etc from allowlisting /etc targets', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf /etc/sneaky'),
      env: { TMPDIR: '/etc' },
    });
    expectDeny(result);
  });

  it('allows inherited TMPDIR when it stays under a canonical temp root', async () => {
    const dir = await mkProjectTracked();
    const tmp = '/var/folders/session-orchestrator-test/T';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(`rm -rf ${tmp}/scratch`),
      env: { TMPDIR: tmp },
    });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// #935 — $TMPDIR spelling + symlink canonicalisation
//
// Two independent reasons a legitimate agent scratch cleanup was blocked:
//   (1) the guard sees the UNEXPANDED shell string, so `${TMPDIR}scratch` reads
//       as a RELATIVE path to path.isAbsolute() and never reaches the /tmp-class
//       prefix check at all (it gets resolved against the project dir instead);
//   (2) `tempRoots` listed /var/folders but not its canonical macOS spelling
//       /private/var/folders, so a TMPDIR handed over already canonicalised was
//       dropped by the confinement check and contributed NO prefix whatsoever.
//
// The same fix CLOSES a hole the literal prefix match left open: a symlink under
// a temp root pointing OUT of it was allowlisted by its spelling alone. Measured
// pre-fix, `rm -rf <tmpdir>/link-to-etc/passwd-dir` was ALLOWED while the delete
// would have landed in /etc. The deny assertions below are the fake-regression
// anchor for that: drop canonicalizeRmTarget and they flip back to allow.
// ---------------------------------------------------------------------------

describe('#935 $TMPDIR token expansion (exit 0)', { timeout: 15000 }, () => {
  // TMPDIR is pinned per case instead of inherited. The braced forms concatenate
  // WITHOUT a separator — `${TMPDIR}so-x` — which is what the real incident looked
  // like, and it only lands inside the temp root when TMPDIR carries a trailing
  // slash. macOS exports exactly that (`/var/folders/…/T/`); a Linux CI container
  // leaves TMPDIR unset, so the fallback is `/tmp` and the same string becomes
  // `/tmpso-x` — outside every temp root and correctly DENIED. The hook is right in
  // both cases; inheriting the ambient value is what made the assertion
  // platform-dependent (CI red on 3a27817, macOS green). Pin the shape each case
  // actually means.
  it.each([
    ['bare $TMPDIR/', 'rm -rf $TMPDIR/so-ablation-eval-x', false],
    ['braced ${TMPDIR}', 'rm -rf ${TMPDIR}so-ablation-eval-x', true],
    ['braced + quoted "${TMPDIR}"', 'rm -rf "${TMPDIR}"so-ablation-eval-x', true],
  ])('allows an unexpanded %s target', async (_label, command, needsTrailingSlash) => {
    const dir = await mkProjectTracked();
    const tmp = realpathSync(os.tmpdir());
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(command),
      env: { TMPDIR: needsTrailingSlash ? `${tmp}/` : tmp },
    });
    expectAllow(result);
  });

  it('denies the braced form when TMPDIR has NO trailing slash (concatenation escapes the temp root)', async () => {
    // The counterpart to the pinning above: this is not a gap, it is the shell's
    // own semantics. `${TMPDIR}so-x` with TMPDIR=/tmp is /tmpso-x, and /tmpso-x is
    // not under /tmp/. Pinning it stops a future reader from "fixing" the guard to
    // accept a path bash itself would never have produced.
    const dir = await mkProjectTracked();
    const tmp = realpathSync(os.tmpdir());
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf ${TMPDIR}so-ablation-eval-x'),
      env: { TMPDIR: tmp },
    });
    expectDeny(result);
  });

  it('still blocks $TMPDIR expansion when TMPDIR points outside every temp root', async () => {
    // Expansion must not become a bypass: the expanded path still has to land
    // under a CONFINED prefix, so an inherited TMPDIR=/etc stays blocked (#642).
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf $TMPDIR/sneaky'),
      env: { TMPDIR: '/etc' },
    });
    expectDeny(result);
  });

  it('does not expand $TMPDIRX (no word boundary → stays a relative target)', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('rm -rf $TMPDIRX/y'),
    });
    expectDeny(result);
  });
});

describe('#935 canonical vs lexical temp spelling (exit 0)', { timeout: 15000 }, () => {
  it('allows the lexical os.tmpdir() spelling', async () => {
    const dir = await mkProjectTracked();
    const target = path.join(os.tmpdir(), 'agent-scratch-935');
    const result = await runHook({ projectDir: dir, stdin: bashPayload(`rm -rf ${target}`) });
    expectAllow(result);
  });

  it('allows the canonical realpath spelling of the SAME dir (/private/var/folders on macOS)', async () => {
    const dir = await mkProjectTracked();
    const target = path.join(realpathSync.native(os.tmpdir()), 'agent-scratch-935');
    const result = await runHook({ projectDir: dir, stdin: bashPayload(`rm -rf ${target}`) });
    expectAllow(result);
  });

  it('allows a TMPDIR inherited in canonical /private/var/folders spelling', async () => {
    const dir = await mkProjectTracked();
    const tmp = '/private/var/folders/session-orchestrator-test/T';
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload(`rm -rf ${tmp}/scratch`),
      env: { TMPDIR: tmp },
    });
    expectAllow(result);
  });
});

describe('#935 symlink laundering must STILL block (exit 2)', { timeout: 15000 }, () => {
  it('blocks a temp-rooted symlink that points OUT of every temp root', async () => {
    const dir = await mkProjectTracked();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-935-link-'));
    tmpDirs.push(scratch);
    const link = path.join(scratch, 'link-to-etc');
    await fs.symlink('/etc', link);
    try {
      // Lexically this sits under $TMPDIR; canonically it is /etc/passwd-dir.
      const result = await runHook({
        projectDir: dir,
        stdin: bashPayload(`rm -rf ${link}/passwd-dir`),
      });
      expectDeny(result);
    } finally {
      await fs.unlink(link);
    }
  });

  it('blocks a PROJECT-RELATIVE symlink that points INTO a temp root', async () => {
    // The relative branch is deliberately NOT symlink-resolved: resolving it
    // would make `rm -rf link-to-tmp` — which destroys a project entry — read as
    // a safe temp delete.
    const dir = await mkProjectTracked();
    const link = path.join(dir, 'link-to-tmp');
    await fs.symlink(os.tmpdir(), link);
    try {
      const result = await runHook({ projectDir: dir, stdin: bashPayload('rm -rf link-to-tmp') });
      expectDeny(result);
    } finally {
      await fs.unlink(link);
    }
  });

  it('blocks a TMPDIR that is itself a temp-rooted symlink out of the temp area', async () => {
    // addTemp confines the value BOTH as written and after symlink resolution;
    // the lexical half alone would promote /etc to an allowlisted prefix here.
    const dir = await mkProjectTracked();
    const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'guard-935-tmpdir-'));
    tmpDirs.push(scratch);
    const link = path.join(scratch, 'tmpdir-escape');
    await fs.symlink('/etc', link);
    try {
      const result = await runHook({
        projectDir: dir,
        stdin: bashPayload(`rm -rf ${link}/sneaky`),
        env: { TMPDIR: link },
      });
      expectDeny(result);
    } finally {
      await fs.unlink(link);
    }
  });
});

// ---------------------------------------------------------------------------
// git-stash-any — warn only when non-empty stash
// ---------------------------------------------------------------------------

describe('git-stash-any — conditional warn', { timeout: 30000 }, () => {
  it('exits 0 silently when git stash is empty', async () => {
    const dir = await mkProjectTracked();
    // No stash entries in fresh repo
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git stash'),
    });
    expectAllow(result);
    // Should be silent (no ⚠ stash warning)
    expect(result.stderr).not.toContain('git-stash-any');
  });

  it('exits 0 with warning when git stash is non-empty', async () => {
    const dir = await mkProjectTracked();
    // Create a stash entry
    const { $ } = await import('zx');
    $.verbose = false;
    $.quiet = true;
    // Need a tracked file + modification to create a stash
    await fs.writeFile(path.join(dir, 'README.md'), 'init');
    await $`git -C ${dir} add README.md`;
    await $`git -C ${dir} commit -m "init"`;
    await fs.writeFile(path.join(dir, 'README.md'), 'modified');
    await $`git -C ${dir} stash`;

    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git stash'),
    });
    expectAllow(result);
    expect(result.stderr).toContain('git-stash-any');
  });
});

// ---------------------------------------------------------------------------
// Malformed policy — allow with warning
// ---------------------------------------------------------------------------

describe('malformed policy', { timeout: 15000 }, () => {
  it('exits 0 with warning when policy JSON is invalid', async () => {
    const dir = await mkProjectTracked();
    // Overwrite with invalid JSON
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'policy', 'blocked-commands.json'),
      'not valid json {'
    );
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expectAllow(result);
    expect(result.stderr).toContain('malformed');
  });

  it('exits 0 with warning when policy is missing .rules array', async () => {
    const dir = await mkProjectTracked({
      policy: { version: 1 }, // no rules array
    });
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
    });
    expectAllow(result);
    expect(result.stderr).toContain('rules');
  });
});

// ---------------------------------------------------------------------------
// No match → allow
// ---------------------------------------------------------------------------

describe('no match → allow', { timeout: 15000 }, () => {
  it('exits 0 for a benign command like "git status"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git status'),
    });
    expectAllow(result);
  });

  it('exits 0 for "ls -la"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls -la'),
    });
    expectAllow(result);
  });
});

// ---------------------------------------------------------------------------
// Severity warn — git revert (non-stash)
// ---------------------------------------------------------------------------

describe('severity warn — git revert', { timeout: 15000 }, () => {
  it('exits 0 with ⚠ on stderr for "git revert HEAD"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git revert HEAD'),
    });
    expectAllow(result);
    expect(result.stderr).toContain('⚠');
    expect(result.stderr).toContain('git-revert-commit');
  });
});

// ---------------------------------------------------------------------------
// Shell-operator bypass — conservative blocking
// ---------------------------------------------------------------------------

describe('shell-operator bypass — conservative blocking', { timeout: 15000 }, () => {
  it('exits 2 for semicolon-chained: "ls; git reset --hard HEAD"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('ls; git reset --hard HEAD'),
    });
    expectDeny(result);
  });

  it('exits 2 for subshell: "(git reset --hard HEAD)"', async () => {
    const dir = await mkProjectTracked();
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('(git reset --hard HEAD)'),
    });
    expectDeny(result);
  });
});

// ---------------------------------------------------------------------------
// Policy cache mtime-invalidation contract — #250
// ---------------------------------------------------------------------------

describe('policy cache mtime-invalidation — #250', { timeout: 15000 }, () => {
  it('honors policy edits between hook invocations (mtime invalidation contract, issue #250)', async () => {
    // Arrange: policy that only warns on `git revert` (no block rules for `foo` patterns).
    // We use a distinctive custom pattern so we can observe behavior change.
    const permissivePolicy = {
      version: 1,
      rules: [
        {
          id: 'foo-marker',
          pattern: 'foo-destructive-marker',
          severity: 'warn',
          rationale: 'Initially only warns.',
        },
      ],
    };
    const dir = await mkProjectTracked({ policy: permissivePolicy });

    // Act 1: spawn hook with a command matching pattern → warn (exit 0).
    const first = await runHook({
      projectDir: dir,
      stdin: bashPayload('foo-destructive-marker --yes'),
    });
    expectAllow(first);

    // Modify policy on disk: same pattern now blocks. Advance mtime to ensure
    // the cache-invalidation contract (mtime comparison) would trigger a reload
    // in any persistent-process model. In the subprocess-spawn model, the
    // observable contract is simply "edits on disk are honored on the next
    // invocation" — which any mtime-invalidating cache must preserve.
    const strictPolicy = {
      version: 1,
      rules: [
        {
          id: 'foo-marker',
          pattern: 'foo-destructive-marker',
          severity: 'block',
          rationale: 'Now blocks after policy edit.',
        },
      ],
    };
    const policyPath = path.join(dir, '.orchestrator', 'policy', 'blocked-commands.json');
    await fs.writeFile(policyPath, JSON.stringify(strictPolicy, null, 2));
    // Force mtime forward so a naive mtime-based cache cannot stale-serve.
    const future = new Date(Date.now() + 10_000);
    await fs.utimes(policyPath, future, future);

    // Act 2: spawn hook again with same command.
    const second = await runHook({
      projectDir: dir,
      stdin: bashPayload('foo-destructive-marker --yes'),
    });

    // Assert: hook now denies.
    expectDeny(second, 'foo-marker');
  });
});

// ---------------------------------------------------------------------------
// Guard-event telemetry (Epic #803 process-safety dimension)
// ---------------------------------------------------------------------------

describe('destructive-guard telemetry — orchestrator.destructive_guard.blocked/warned', { timeout: 15000 }, () => {
  it('emits exactly one orchestrator.destructive_guard.blocked event with rule + command_hash, no raw command', async () => {
    const dir = await mkProjectTracked();
    const command = 'git reset --hard HEAD~1';
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectDeny(result);

    const events = readEvents(dir).filter((e) => e.event === 'orchestrator.destructive_guard.blocked');
    expect(events).toHaveLength(1);
    expect(events[0].rule).toBe('git-reset-hard');
    expect(events[0].command_hash).toMatch(/^[0-9a-f]{16}$/);

    // The raw command text must never appear anywhere in the events.jsonl file.
    const raw = readFileSync(path.join(dir, EVENTS_REL), 'utf8');
    expect(raw).not.toContain(command);
    expect(raw).not.toContain('reset --hard');
  });

  it('emits exactly one orchestrator.destructive_guard.warned event with rule + command_hash, no raw command', async () => {
    const dir = await mkProjectTracked();
    const command = 'git revert HEAD';
    const result = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectAllow(result);

    const events = readEvents(dir).filter((e) => e.event === 'orchestrator.destructive_guard.warned');
    expect(events).toHaveLength(1);
    expect(events[0].rule).toBe('git-revert-commit');
    expect(events[0].command_hash).toMatch(/^[0-9a-f]{16}$/);

    const raw = readFileSync(path.join(dir, EVENTS_REL), 'utf8');
    expect(raw).not.toContain(command);
  });

  it('still denies when the events.jsonl destination is unwritable', async () => {
    const dir = await mkProjectTracked();
    // Route SO_PROJECT_DIR (events.mjs resolution) at an unwritable path so
    // emitEvent's fs.mkdir throws — the block-decision path (found via
    // resolvePolicyPath's process.cwd() candidate, unaffected by this env
    // override) must still fire.
    const result = await runHook({
      projectDir: dir,
      stdin: bashPayload('git reset --hard HEAD~1'),
      env: { CLAUDE_PROJECT_DIR: unwritablePath('destructive-guard-events') },
    });
    expectDeny(result, 'git-reset-hard');
  });
});
