/**
 * tests/unit/hook-issue-budget.test.mjs
 *
 * Vitest unit tests for hooks/pre-bash-issue-budget.mjs.
 *
 * Strategy mirrors tests/unit/hook-templates-first.test.mjs: spawn the real
 * hook as a subprocess, pipe JSON on stdin, assert exit code + stderr. No
 * mocking of production logic.
 *
 * Exit-code contract (#906): EVERY path exits 0. A deny is signalled by the
 * `hookSpecificOutput` envelope on stdout, never by exit 2 — Claude Code
 * discards stdout on exit 2. Because allow (under cap, exempt, warn mode, off
 * mode, non-issue command) and deny (over cap in strict mode) now share exit 0,
 * a bare `expect(code).toBe(0)` no longer distinguishes them: use `expectDeny`
 * / `expectAllow`, which assert on the stdout envelope.
 *
 * Channel note (#906): formatBlockReason's guidance — the overflow store path,
 * the [Backlog-Sammel] fold-in promise, the exemption list — used to be written
 * to stderr. It now travels inside the envelope's `permissionDecisionReason`,
 * which is what reaches Claude, the actor that must re-file or defer. The
 * assertions below moved with it; the CONTENT requirement is unchanged.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { matchVcsCreate, isIssueCreate, extractTitle } from '../../hooks/_lib/vcs-create-matcher.mjs';

import { expectDeny, expectAllow } from '../_helpers/hook-decision.mjs';

const HOOK = path.resolve(import.meta.dirname, '../../hooks/pre-bash-issue-budget.mjs');

const tmpDirs = [];

afterEach(async () => {
  while (tmpDirs.length) {
    const d = tmpDirs.pop();
    await fs.rm(d, { recursive: true, force: true }).catch(() => {});
  }
});

async function mkProject({ budgetBlock } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'issue-budget-hook-'));
  tmpDirs.push(dir);
  const body = ['# Fixture repo', '', '## Session Config', '', 'waves: 5', ''];
  if (budgetBlock) body.push(budgetBlock, '');
  await fs.writeFile(path.join(dir, 'CLAUDE.md'), body.join('\n'), 'utf8');
  return dir;
}

async function runHook({ projectDir, stdin, extraEnv = {} }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: projectDir,
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: projectDir,
        CLAUDE_PLUGIN_ROOT: path.resolve(import.meta.dirname, '../..'),
        SO_HOOK_PROFILE: 'full',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  });
}

function bashPayload(command, sessionId = 'budget-session-001') {
  return { session_id: sessionId, tool_name: 'Bash', tool_input: { command } };
}

/** Fill the budget with N plain creations, returning the last result. */
async function fill(dir, n, sessionId = 'budget-session-001') {
  let last;
  for (let i = 0; i < n; i++) {
    last = await runHook({
      projectDir: dir,
      stdin: bashPayload(`glab issue create --title "plain ${i}" --label "type::chore,priority::low"`, sessionId),
    });
  }
  return last;
}

// ---------------------------------------------------------------------------
// Shared matcher — reused from pre-bash-templates-first, not duplicated
// ---------------------------------------------------------------------------

describe('shared vcs-create matcher', () => {
  it('matches the same create shapes the templates-first hook gates', () => {
    expect(matchVcsCreate('glab issue create --title x')).toEqual({ host: 'gitlab', kind: 'issue', verb: 'create' });
    expect(matchVcsCreate('gh issue new --title x')).toEqual({ host: 'github', kind: 'issue', verb: 'new' });
    expect(matchVcsCreate('  gh pr create --title x')).toEqual({ host: 'github', kind: 'pr', verb: 'create' });
    expect(matchVcsCreate('glab mr create --title x')).toEqual({ host: 'gitlab', kind: 'mr', verb: 'create' });
  });

  it('does not match edit verbs or lookalike tokens', () => {
    expect(matchVcsCreate('gh issue edit 12 --add-label x')).toBeNull();
    expect(matchVcsCreate('glab issue created')).toBeNull();
    expect(matchVcsCreate('echo glab issue create')).toBeNull();
  });

  it('isIssueCreate is issue-only — pr/mr creation is not budgeted', () => {
    expect(isIssueCreate('glab issue create --title x')).toBe(true);
    expect(isIssueCreate('glab mr create --title x')).toBe(false);
    expect(isIssueCreate('gh pr create --title x')).toBe(false);
  });

  it('extractTitle handles quoted, single-quoted, = and bare forms', () => {
    expect(extractTitle('glab issue create --title "a b c"')).toBe('a b c');
    expect(extractTitle("glab issue create --title 'a b'")).toBe('a b');
    expect(extractTitle('glab issue create --title=short')).toBe('short');
    expect(extractTitle('glab issue create --description x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Pass-through gates
// ---------------------------------------------------------------------------

describe('pass-through', { timeout: 20000 }, () => {
  it('allows a non-Bash tool', async () => {
    const dir = await mkProject();
    const r = await runHook({
      projectDir: dir,
      stdin: { session_id: 's', tool_name: 'Edit', tool_input: { file_path: 'README.md' } },
    });
    expectAllow(r);
  });

  it('allows an unrelated shell command', async () => {
    const dir = await mkProject();
    const r = await runHook({ projectDir: dir, stdin: bashPayload('git status') });
    expectAllow(r);
  });

  it('allows MR creation even when the issue budget is 0', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const r = await runHook({ projectDir: dir, stdin: bashPayload('glab mr create --title "x"') });
    expectAllow(r);
  });
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

describe('cap enforcement', { timeout: 30000 }, () => {
  it('allows up to the cap, then denies', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 2\n  mode: strict' });
    expectAllow(await fill(dir, 2));
    const blocked = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "third" --label "type::chore,priority::low"'),
    });
    expectDeny(blocked, 'issue-budget');
  });

  it('names the overflow store in the deny reason so the agent knows where the item went', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });
    await fill(dir, 1);
    const blocked = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "parked"'),
    });
    const reason = expectDeny(blocked).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('.orchestrator/runtime/issue-budget.json');
    expect(reason).toContain('Backlog-Sammel');
  });

  it('emits a deny envelope on stdout with a short operator headline', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const blocked = await runHook({ projectDir: dir, stdin: bashPayload('glab issue create --title "x"') });
    expectDeny(blocked);
    // The operator half of the #906 repair: first line only, not the whole
    // 8-line reason, and not silence.
    expect(JSON.parse(blocked.stdout).systemMessage).toBe(
      '⛔ issue-budget: session cap reached — 0/0 issues already created.',
    );
  });

  it('records the blocked request in the counter file (lossless overflow)', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    await runHook({ projectDir: dir, stdin: bashPayload('glab issue create --title "lost?"') });
    const state = JSON.parse(
      await fs.readFile(path.join(dir, '.orchestrator', 'runtime', 'issue-budget.json'), 'utf8'),
    );
    expect(state.overflow).toHaveLength(1);
    expect(state.overflow[0].title).toBe('lost?');
  });
});

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

describe('modes', { timeout: 30000 }, () => {
  it('warn allows the over-cap creation with a stderr notice', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: warn' });
    await fill(dir, 1);
    const r = await runHook({ projectDir: dir, stdin: bashPayload('glab issue create --title "over"') });
    expectAllow(r);
    expect(r.stderr).toContain('cap exceeded');
  });

  it('off is a full no-op — no counter file, no block', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: off' });
    const r = await runHook({ projectDir: dir, stdin: bashPayload('glab issue create --title "x"') });
    expectAllow(r);
    await expect(
      fs.access(path.join(dir, '.orchestrator', 'runtime', 'issue-budget.json')),
    ).rejects.toThrow();
  });

  it('SO_DISABLED_HOOKS opts the hook out entirely', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const r = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "x"'),
      extraEnv: { SO_DISABLED_HOOKS: 'pre-bash-issue-budget' },
    });
    expectAllow(r);
  });
});

// ---------------------------------------------------------------------------
// Exemptions — the promise-keeping half
// ---------------------------------------------------------------------------

describe('exemptions', { timeout: 30000 }, () => {
  it('priority::critical bypasses a fully spent budget', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const r = await runHook({
      projectDir: dir,
      stdin: bashPayload('gh issue create --title "prod down" --label "type::bug,priority::critical"'),
    });
    expectAllow(r);
    expect(r.stderr).toContain('exempt');
  });

  it('the SPIRAL/FAILED auto-carry class bypasses a fully spent budget', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const r = await runHook({
      projectDir: dir,
      stdin: bashPayload(
        'glab issue create --title "[Carryover] [SPIRAL] wedged task" --label "type::carryover,priority::high"',
      ),
    });
    expectAllow(r);
    expect(r.stderr).toContain('exempt');
  });

  it('the [Backlog-Sammel] collector issue itself is never blocked', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const r = await runHook({
      projectDir: dir,
      stdin: bashPayload(
        'glab issue create --title "[Backlog-Sammel] s1, 4 zurückgestellte Punkte" --label "type::backlog,priority::low"',
      ),
    });
    expectAllow(r);
  });

  it('an ordinary discovery issue is NOT exempt', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const r = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "[Discovery] dead export" --label "type::discovery,priority::low"'),
    });
    expectDeny(r);
  });
});
