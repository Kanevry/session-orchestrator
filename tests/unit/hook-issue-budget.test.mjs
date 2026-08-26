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

import {
  matchVcsCreate,
  isIssueCreate,
  extractTitle,
  matchesBypass,
} from '../../hooks/_lib/vcs-create-matcher.mjs';

import { expectDeny, expectAllow, expectWarn } from '../_helpers/hook-decision.mjs';
// The counter file is one-per-session since #1141 (`.orchestrator/runtime/
// issue-budget/<sha256(sessionId)[0..16]>.json`). The test asks the production
// helper for the path instead of re-spelling the layout — a hand-written path
// here would pin the OLD single-slot shape and pass while the split regressed.
import { budgetStatePath, reapStaleBudgetFiles } from '@lib/issue-budget.mjs';

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

// The bug this deletion prevents (#1151): the child inherits `...process.env`,
// and a live operator session exports `CLAUDE_CODE_SESSION_ID`. The hook reads
// that as its session-id fallback (`hooks/pre-bash-issue-budget.mjs:92`), so
// every case that means "no session id" silently ran WITH one — keyed to the
// operator's real session — and the suite's verdict depended on whether it was
// run from inside a Claude Code session or from a bare shell. Deleted by
// default; a test that needs the fallback opts in via `extraEnv`, which is
// applied AFTER the deletion.
async function runHook({ projectDir, stdin, extraEnv = {} }) {
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: projectDir,
    CLAUDE_PLUGIN_ROOT: path.resolve(import.meta.dirname, '../..'),
    SO_HOOK_PROFILE: 'full',
  };
  delete env.CLAUDE_CODE_SESSION_ID;
  Object.assign(env, extraEnv);

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      cwd: projectDir,
      env,
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

  // #1106 — the bug: the matcher was anchored at the START of the whole command
  // string, so every form that does not BEGIN with the CLI name was invisible.
  // Measured 2026-08-23 in a live session: four issues were created as
  // `cd <repo>\nglab issue create …` and the runtime ledger recorded `count: 0`.
  // The cap was not circumvented — for that command form it never existed.
  it('sees a create call that is not the first statement in the chain (#1106)', () => {
    expect(isIssueCreate('cd /repo\nglab issue create --title x')).toBe(true);
    expect(isIssueCreate('cd /repo && glab issue create --title x')).toBe(true);
    expect(isIssueCreate('cd /repo; glab issue create')).toBe(true);
    expect(isIssueCreate('cd /repo || glab issue create')).toBe(true);
    expect(isIssueCreate('echo body | glab issue create -F -')).toBe(true);
    expect(matchVcsCreate('cd /repo && gh pr create --title x')).toEqual({
      host: 'github', kind: 'pr', verb: 'create',
    });
  });

  // The other direction of the same change: splitting on `\n`/`&&`/`;` must not
  // start matching the WORDS where they are data rather than a command. A naive
  // splitter cuts inside quotes and here-doc bodies and turns each of these into
  // a phantom create call — which in strict mode is a DENY on a command that
  // creates nothing.
  it('still ignores the create words when they are data, not a command (#1106)', () => {
    expect(isIssueCreate('echo "glab issue create"')).toBe(false);
    expect(isIssueCreate("echo 'a; glab issue create'")).toBe(false);
    expect(isIssueCreate('echo "cd /x && glab issue create"')).toBe(false);
    expect(isIssueCreate('# glab issue create')).toBe(false);
    expect(isIssueCreate('cd /x  # && glab issue create')).toBe(false);
    expect(isIssueCreate('grep -rn "glab issue create" docs/')).toBe(false);
    expect(isIssueCreate('cat > f <<EOF\nglab issue create --title x\nEOF')).toBe(false);
    // ONE token that merely contains the words runs a binary of that literal
    // name; the lexer strips quotes, so token boundaries are the only evidence.
    expect(isIssueCreate('"glab issue create" --title x')).toBe(false);
  });

  it('a widened matcher must not widen the kind: mr/pr and list/note stay out', () => {
    expect(isIssueCreate('cd /repo && glab mr create --title x')).toBe(false);
    expect(isIssueCreate('cd /repo && glab issue list')).toBe(false);
    expect(isIssueCreate('cd /repo && glab issue note 5 -m x')).toBe(false);
  });

  it('extractTitle handles quoted, single-quoted, = and bare forms', () => {
    expect(extractTitle('glab issue create --title "a b c"')).toBe('a b c');
    expect(extractTitle("glab issue create --title 'a b'")).toBe('a b');
    expect(extractTitle('glab issue create --title=short')).toBe('short');
    expect(extractTitle('glab issue create --description x')).toBeNull();
  });

  // #1106 — reading `--title` off the WHOLE command picks up a neighbouring
  // statement's flag, so the parked overflow record is labelled with a title
  // that belongs to a different command. Silent: the wrong label still looks
  // like a plausible one.
  it('extractTitle reads the title off the create statement, not a neighbour (#1106)', () => {
    expect(extractTitle('cd /r && glab issue create --title "real"')).toBe('real');
    expect(
      extractTitle('glab issue list --search "--title decoy" ; glab issue create --title "real"'),
    ).toBe('real');
    expect(extractTitle('echo --title decoy && glab issue create --title real')).toBe('real');
  });

  // The bypass list is the operator's escape hatch for the templates-first
  // guard. Statement-splitting newly GATES `cd /r && gh pr create --dry-run`,
  // so a bypass still matched against the whole command string would be dead
  // exactly for the shapes the widening added.
  it('matchesBypass is statement-scoped and keeps the token boundary (#1106)', () => {
    expect(matchesBypass('cd /r && gh pr create --dry-run', ['gh pr create --dry-run'])).toBe(true);
    expect(matchesBypass('gh issue create --label bot', ['gh issue create --label bot'])).toBe(true);
    // Prefix-inclusion must not bypass: `bot` !== `botanical`.
    expect(matchesBypass('gh issue create --label botanical', ['gh issue create --label bot'])).toBe(false);
    // A pattern that lexes to nothing must not prefix-match every statement.
    expect(matchesBypass('gh pr create --title x', ['   '])).toBe(false);
    expect(matchesBypass('gh pr create --title x', [])).toBe(false);
  });

  it('an APPENDED bypass statement must not exempt a different create call (#1106 regression)', () => {
    // The named bug: scoping the MATCH to statements while leaving the BYPASS a
    // boolean over the whole command let a decoy lift the gate for a real call.
    // Reproduced against the live policy on 2026-08-23 — `glab issue create --label ci`
    // is a real bypass_patterns entry, so this is the shape an agent would actually
    // type, not a synthetic one. The pre-#1106 code was NOT vulnerable (it
    // prefix-matched the whole command, so a TRAILING pattern could not match);
    // widening the matcher without narrowing the bypass opened it.
    const patterns = ['glab issue create --label ci', 'gh issue create --label bot'];

    // The create the operator actually makes carries no bypass pattern …
    expect(matchesBypass('glab issue create --title REAL', patterns)).toBe(false);
    // … and appending one as a second statement must not change that.
    expect(
      matchesBypass('glab issue create --title REAL; glab issue create --label ci --title junk', patterns),
    ).toBe(false);
    // Same shape through the other separators the lexer splits on.
    expect(
      matchesBypass('glab issue create --title REAL && glab issue create --label ci', patterns),
    ).toBe(false);
    expect(
      matchesBypass('glab issue create --title REAL\nglab issue create --label ci', patterns),
    ).toBe(false);

    // The documented intent is preserved: when the CREATE STATEMENT itself is the
    // bypass, it still exempts — including behind a `cd` chain.
    expect(matchesBypass('glab issue create --label ci --title x', patterns)).toBe(true);
    expect(matchesBypass('cd /r && glab issue create --label ci --title x', patterns)).toBe(true);
    // And a leading decoy is no more effective than a trailing one.
    expect(
      matchesBypass('glab issue create --label ci --title junk; glab issue create --title REAL', patterns),
    ).toBe(true); // the FIRST statement is the create, and it IS the bypass — correct.
  });

  it('isIssueCreate is issue-only — pr/mr creation is not budgeted', () => {
    expect(isIssueCreate('glab issue create --title x')).toBe(true);
    expect(isIssueCreate('glab mr create --title x')).toBe(false);
    expect(isIssueCreate('gh pr create --title x')).toBe(false);
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

  // #1106 end-to-end through the REAL hook, not the matcher alone. The live
  // failure was invisible precisely because every unit test fed the hook a
  // command starting at column 0, which is the one shape the old anchor saw.
  it('charges and denies a `cd`-prefixed create — the live bypass shape (#1106)', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });

    const first = await runHook({
      projectDir: dir,
      stdin: bashPayload(`cd ${dir}\nglab issue create --title "chained first"`),
    });
    expectAllow(first);

    const blocked = await runHook({
      projectDir: dir,
      stdin: bashPayload(`cd ${dir} && glab issue create --title "chained second"`),
    });
    expectDeny(blocked, 'issue-budget');

    const state = JSON.parse(
      await fs.readFile(budgetStatePath(dir, 'budget-session-001'), 'utf8'),
    );
    // count 1, not 0: the first chained call was actually charged.
    expect(state.count).toBe(1);
    // The parked record carries the create statement's own title, not the
    // `cd` statement's text or a neighbouring flag.
    expect(state.overflow).toHaveLength(1);
    expect(state.overflow[0].title).toBe('chained second');
  });

  it('uses the bound semantic key across repeated native stdin calls', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });
    await fs.mkdir(path.join(dir, '.orchestrator'), { recursive: true });
    await fs.writeFile(
      path.join(dir, '.orchestrator', 'current-session.json'),
      JSON.stringify({
        session_id: 'native-hook-raw',
        semantic_session_id: 'main-2026-08-20-deep-1',
      }),
      'utf8',
    );

    expectAllow(await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "first"', 'native-hook-raw'),
    }));
    const repeated = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "second"', 'native-hook-raw'),
    });

    expectDeny(repeated, 'issue-budget');
    const state = JSON.parse(
      await fs.readFile(budgetStatePath(dir, 'main-2026-08-20-deep-1'), 'utf8'),
    );
    expect(state.sessionId).toBe('main-2026-08-20-deep-1');
  });

  it('allows a payload without a native session id without attributing overflow to a spent prior session', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });
    expectAllow(await fill(dir, 1, 'prior-session'));

    const noIdPayload = {
      tool_name: 'Bash',
      tool_input: { command: 'glab issue create --title "identity-less"' },
    };
    // Truly identity-less: no stdin id, and `runHook` deletes the inherited
    // CLAUDE_CODE_SESSION_ID the hook would otherwise fall back to (#1151).
    expectAllow(await runHook({ projectDir: dir, stdin: noIdPayload }));
    // A SECOND identity-less charge is still allowed at max-per-session: 1 —
    // the observable signature of "no identity ⇒ nothing persisted, so nothing
    // accumulates". This is also what makes the #1151 env deletion falsifiable:
    // measured 2026-08-24 with the deletion removed and
    // CLAUDE_CODE_SESSION_ID exported, a leaked env keys BOTH calls to that one
    // session and this line goes RED (`AssertionError: expected
    // '{"hookSpecificOutput":{"hookEventName…' to be ''`) instead of silently
    // exercising the env-keyed path under an identity-less name.
    expectAllow(await runHook({ projectDir: dir, stdin: noIdPayload }));
    // Allowed, but it must leave the shared ledger alone: persisting its fresh
    // state would clear prior-session's spent cap and delete parked overflow.
    expect(JSON.parse(
      await fs.readFile(budgetStatePath(dir, 'prior-session'), 'utf8'),
    )).toEqual({
      sessionId: 'prior-session',
      count: 1,
      exempt: 0,
      overflow: [],
    });
  });

  // #1141 — a PreToolUse payload without `session_id` used to resolve to `null`,
  // and an identity-less charge neither reads nor persists: for that payload
  // shape the cap was silently OFF. The harness exports CLAUDE_CODE_SESSION_ID
  // (same native id as the stdin one), so the fallback restores enforcement.
  it('falls back to CLAUDE_CODE_SESSION_ID when stdin carries no session id (#1141)', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });
    const noStdinId = { tool_name: 'Bash', tool_input: { command: 'glab issue create --title "env-keyed"' } };

    expectAllow(await runHook({
      projectDir: dir,
      stdin: noStdinId,
      extraEnv: { CLAUDE_CODE_SESSION_ID: 'env-session-001' },
    }));
    // Before the fallback BOTH calls were allowed forever — nothing persisted.
    expectDeny(await runHook({
      projectDir: dir,
      stdin: noStdinId,
      extraEnv: { CLAUDE_CODE_SESSION_ID: 'env-session-001' },
    }), 'issue-budget');

    const state = JSON.parse(await fs.readFile(budgetStatePath(dir, 'env-session-001'), 'utf8'));
    expect(state).toMatchObject({ sessionId: 'env-session-001', count: 1 });
  });

  it('prefers the stdin session id over the env one when both are present', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 5\n  mode: strict' });
    expectAllow(await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "stdin wins"', 'stdin-session'),
      extraEnv: { CLAUDE_CODE_SESSION_ID: 'env-session-002' },
    }));

    expect(JSON.parse(await fs.readFile(budgetStatePath(dir, 'stdin-session'), 'utf8')))
      .toMatchObject({ sessionId: 'stdin-session', count: 1 });
    await expect(fs.access(budgetStatePath(dir, 'env-session-002'))).rejects.toThrow();
  });

  // #1151 — the bug a `??`-refactor would introduce: `session_id: ''` is a
  // PRESENT but empty key, and `input.session_id ?? process.env.CLAUDE_CODE_
  // SESSION_ID` keeps the empty string (`??` only falls through on nullish).
  // The charge would then be identity-less — never read, never persisted — and
  // the cap silently OFF for that payload shape, exactly the #1141 defect. The
  // hook's length check is what prevents it; nothing pinned that until now.
  it('treats an EMPTY stdin session id as absent and still enforces via the env id (#1151)', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });
    const emptyStdinId = {
      session_id: '',
      tool_name: 'Bash',
      tool_input: { command: 'glab issue create --title "empty stdin id"' },
    };

    expectAllow(await runHook({
      projectDir: dir,
      stdin: emptyStdinId,
      extraEnv: { CLAUDE_CODE_SESSION_ID: 'env-session-003' },
    }));
    expectDeny(await runHook({
      projectDir: dir,
      stdin: emptyStdinId,
      extraEnv: { CLAUDE_CODE_SESSION_ID: 'env-session-003' },
    }), 'issue-budget');

    // Keyed to the env id — an identity-less charge would have written nothing
    // at all, and the second call would have been allowed.
    expect(JSON.parse(await fs.readFile(budgetStatePath(dir, 'env-session-003'), 'utf8')))
      .toMatchObject({ sessionId: 'env-session-003', count: 1 });
  });

  it('names the overflow store in the deny reason so the agent knows where the item went', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });
    await fill(dir, 1);
    const blocked = await runHook({
      projectDir: dir,
      stdin: bashPayload('glab issue create --title "parked"'),
    });
    const reason = expectDeny(blocked).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain('.orchestrator/runtime/issue-budget/');
    expect(reason).toContain('Backlog-Sammel');
  });

  it('emits a deny envelope on stdout with a short operator headline', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const blocked = await runHook({ projectDir: dir, stdin: bashPayload('glab issue create --title "x"') });
    // The operator half of the #906 repair: first line only, not the whole
    // 8-line reason, and not silence.
    expectDeny(blocked, {
      systemMessage: '⛔ issue-budget: session cap reached — 0/0 issues already created.',
    });
  });

  it('records the blocked request in the counter file (lossless overflow)', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    await runHook({ projectDir: dir, stdin: bashPayload('glab issue create --title "lost?"') });
    const state = JSON.parse(
      await fs.readFile(budgetStatePath(dir, 'budget-session-001'), 'utf8'),
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
      fs.access(path.join(dir, '.orchestrator', 'runtime')),
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

// ---------------------------------------------------------------------------
// Compound + wrapped statements — the forms that were allowed with NO
// accounting at all (#1145)
// ---------------------------------------------------------------------------
//
// THE BUG (TV-001), measured end-to-end against this hook on 2026-08-26 with
// `max-per-session: 1, mode: strict`:
//
//   A) glab issue create --title a                → allow, count 1
//   B) glab issue create --title b                → DENY ("cap reached — 1/1")
//   C) for t in a b c; do glab issue create …done → allow, exit 0, NO accounting
//   D) { glab issue create --title d; }           → allow, exit 0, NO accounting
//
// C and D are not "cap circumvented"; for those command forms the cap had never
// existed. `isIssueCreate()` was likewise false for `if …; then glab issue
// create; fi`, `( glab issue create )`, `nohup glab issue create`, and
// `/opt/homebrew/bin/glab issue create`.
//
// These assert the ACCOUNTING, not just the matcher verdict — a matcher unit
// test cannot tell whether the counter file was actually written, and the whole
// defect is a counter that reads 0 while issues exist.

/** The session's counter state, or `null` when no counter file was written. */
async function readCount(dir, sessionId = 'budget-session-001') {
  try {
    return JSON.parse(await fs.readFile(budgetStatePath(dir, sessionId), 'utf8'));
  } catch {
    return null;
  }
}

describe('compound + wrapped create statements (#1145)', { timeout: 30000 }, () => {
  // D, and the three shapes measured false alongside it. Each files exactly one
  // issue, so each must be charged exactly one.
  it.each([
    ['brace group (form D)', '{ glab issue create --title d; }'],
    ['if/then branch', 'if true; then glab issue create --title e; fi'],
    ['spaced subshell', '( glab issue create --title f )'],
    ['nohup wrapper', 'nohup glab issue create --title g'],
    ['absolute path', '/opt/homebrew/bin/glab issue create --title h'],
    ['leading env assignment', 'GITLAB_HOST=example.test glab issue create --title i'],
  ])('%s is allowed AND charged exactly 1', async (_label, command) => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 3\n  mode: strict' });
    const r = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectAllow(r);
    expect((await readCount(dir))?.count).toBe(1);
  });

  // The gate has to bite on the compound form too, not merely count it: a shape
  // that is counted but never denied is a ledger, not a cap.
  it('a compound create is DENIED once the cap is spent', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });
    await fill(dir, 1);
    const r = await runHook({ projectDir: dir, stdin: bashPayload('{ glab issue create --title d; }') });
    expectDeny(r);
    const state = await readCount(dir);
    expect(state.count).toBe(1); // the blocked creation is not counted …
    expect(state.overflow).toHaveLength(1); // … it is parked, per the standing promise
  });

  // Form C. The decision and its reasoning live in the block comment above
  // `formatLoopDenyReason` in the hook: charging 1 for an N-issue loop would
  // leave the cap nominally armed and actually uncapped, and N is not
  // computable before the shell expands the word list — so a quantity gate that
  // cannot count the quantity refuses instead of guessing.
  it('form C — a loop create is DENIED in strict mode, and nothing is charged', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 3\n  mode: strict' });
    const r = await runHook({
      projectDir: dir,
      stdin: bashPayload('for t in a b c; do glab issue create --title "$t"; done'),
    });
    expectDeny(r);
    expect(r.stdout).toContain('UNKNOWN number of issues');
    expect(r.stdout).toContain('SEPARATE commands');
    // Not parked either — the command is handed back whole, so the deny text
    // must not promise an overflow entry that does not exist.
    expect(await readCount(dir)).toBeNull();
  });

  // The deny is bounded by the operator's declared enforcement level, and the
  // undercount it permits there must be stated out loud rather than emerge.
  it('form C under mode: warn is charged 1 with an explicit UNDERCOUNT notice', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 3\n  mode: warn' });
    const r = await runHook({
      projectDir: dir,
      stdin: bashPayload('for t in a b c; do glab issue create --title "$t"; done'),
    });
    // expectWarn, not expectAllow: allow-with-notice rides ONE `systemMessage`
    // envelope on stdout (#916), and the helper's key-set assertion is what
    // proves the notice did not regress into a deny.
    expectWarn(r, ['UNDERCOUNT', 'charged as 1']);
    expect((await readCount(dir))?.count).toBe(1);
  });

  // The exemption promise outranks the bulk deny: session-end may sweep
  // carryover issues in a loop, and those are never deferred.
  it('an exempt loop create is not denied', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 0\n  mode: strict' });
    const r = await runHook({
      projectDir: dir,
      stdin: bashPayload(
        'for t in a b; do glab issue create --title "$t" --label "priority::critical"; done',
      ),
    });
    expectAllow(r);
    expect((await readCount(dir))?.exempt).toBe(1);
  });

  // An UNROLLED bulk create is not a loop and must still be charged per call —
  // the named ceiling, asserted so it is visibly a decision rather than a gap.
  it('unrolled chained creates are charged per statement, not denied', async () => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 3\n  mode: strict' });
    for (const t of ['a', 'b']) {
      expectAllow(await runHook({
        projectDir: dir,
        stdin: bashPayload(`glab issue create --title ${t}`),
      }));
    }
    expect((await readCount(dir))?.count).toBe(2);
  });

  // THE SECURITY HALF. The widening must not make a NON-creating command charge
  // the cap: every one of these creates nothing, so a counter file must not
  // exist at all afterwards.
  it.each([
    ['glab issue list', 'glab issue list'],
    ['create --help (creates nothing — prints help)', 'glab issue create --help'],
    ['the words inside an echo', 'echo "glab issue create"'],
    ['a grep for the words', 'grep -rn "glab issue create" docs/'],
    ['mr create — a different kind', 'glab mr create --title x'],
    ['a loop that creates no issue', 'for t in a b; do echo "$t"; done'],
  ])('near-miss: %s is not counted', async (_label, command) => {
    const dir = await mkProject({ budgetBlock: 'issue-budget:\n  max-per-session: 1\n  mode: strict' });
    const r = await runHook({ projectDir: dir, stdin: bashPayload(command) });
    expectAllow(r);
    expect(await readCount(dir)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Counter-file lifecycle — the other half of the per-session split (#1151)
// ---------------------------------------------------------------------------
//
// The bug: `.orchestrator/runtime/issue-budget/` had a writer and no reaper —
// zero unlink sites repo-wide — so every session in a working copy left a
// permanent artefact behind. Placed in this file because it is the one test
// file in this task's declared scope; the function under test is the sibling
// export of `budgetStatePath`, which this file already imports.

describe('reapStaleBudgetFiles', () => {
  /** Write a counter file for `sessionId` and backdate it by `ageDays`. */
  async function seed(dir, sessionId, ageDays) {
    const file = budgetStatePath(dir, sessionId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ sessionId, count: 1, exempt: 0, overflow: [] }), 'utf8');
    const at = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
    await fs.utimes(file, at, at);
    return file;
  }

  it('removes files past the age cutoff, keeps young ones and the current session', async () => {
    const dir = await mkProject();
    const stale = await seed(dir, 'long-gone-session', 30);
    const young = await seed(dir, 'yesterdays-session', 1);
    // The current session's file is exempt REGARDLESS of age — a long-running
    // session must not have its own live counter reaped mid-flight.
    const ownAndOld = await seed(dir, 'current-session', 30);

    const { removed, kept } = reapStaleBudgetFiles({ repoRoot: dir, sessionId: 'current-session' });

    expect(removed).toEqual([stale]);
    expect(kept.sort()).toEqual([ownAndOld, young].sort());
    await expect(fs.access(stale)).rejects.toThrow();
    await expect(fs.access(young)).resolves.toBeUndefined();
    await expect(fs.access(ownAndOld)).resolves.toBeUndefined();
  });

  it('leaves unrecognised files in the directory alone', async () => {
    const dir = await mkProject();
    await seed(dir, 'seed-to-create-the-dir', 1);
    const foreign = path.join(dir, '.orchestrator/runtime/issue-budget/NOTES.md');
    await fs.writeFile(foreign, 'hand-written', 'utf8');
    const at = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await fs.utimes(foreign, at, at);

    const { removed, kept } = reapStaleBudgetFiles({ repoRoot: dir, sessionId: null });

    // Not part of the reaper's population at all: neither removed nor kept.
    expect(removed).toEqual([]);
    expect(kept).not.toContain(foreign);
    await expect(fs.access(foreign)).resolves.toBeUndefined();
  });

  it('never throws on a missing directory (best-effort contract)', async () => {
    const dir = await mkProject();
    expect(reapStaleBudgetFiles({ repoRoot: dir })).toEqual({ removed: [], kept: [] });
    expect(reapStaleBudgetFiles({ repoRoot: path.join(dir, 'does', 'not', 'exist') }))
      .toEqual({ removed: [], kept: [] });
  });
});
