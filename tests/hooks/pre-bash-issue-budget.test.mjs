/**
 * tests/hooks/pre-bash-issue-budget.test.mjs
 *
 * End-to-end tests for hooks/pre-bash-issue-budget.mjs — the PreToolUse issue
 * QUANTITY gate — driven as a child process with a real stdin payload against a
 * throwaway repo.
 *
 * WHY THIS FILE EXISTS (TV-001 / TV-005). Measured 2026-09-09:
 * `ls tests/hooks | grep issue` was EMPTY — the hook had unit coverage of its
 * matcher (`vcs-create-matcher.test.mjs`) and of its accounting core
 * (`tests/unit/hook-issue-budget.test.mjs`), and NONE of the wiring between
 * them. The bug that slipped through is exactly a wiring bug: the hook called
 * `chargeIssueBudget` ONCE per Bash tool call with the whole command string, so
 *
 *     glab issue create --title A && glab issue create --title B
 *
 * charged the cap 1 for 2 issues while a comment in the same file claimed it
 * charged 2. Both unit layers were green throughout. These tests read the
 * LEDGER FILE the hook wrote — the production artefact — not a return value.
 *
 * Fake-regression proof for the first test: with the pre-#1163 single-charge
 * hook, `count` after the chained command is 1, and `expect(count).toBe(2)`
 * fails.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { expectAllow, expectDeny, expectWarn } from '../_helpers/hook-decision.mjs';

const HOOK = resolve(import.meta.dirname, '../..', 'hooks/pre-bash-issue-budget.mjs');
const RAW_SESSION_ID = '11111111-2222-3333-4444-555555555555';
const BUDGET_DIR = ['.orchestrator', 'runtime', 'issue-budget'];

let repo;

/**
 * A minimal repo whose CLAUDE.md carries just the `issue-budget` block the hook
 * parses, plus the `current-session.json` the accounting key resolves through.
 */
function makeRepo({ mode = 'strict', max = 12 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'issue-budget-hook-'));
  mkdirSync(join(dir, '.orchestrator'), { recursive: true });
  writeFileSync(
    join(dir, 'CLAUDE.md'),
    [
      '# Test repo',
      '',
      '## Session Config',
      '',
      'issue-budget:',
      `  max-per-session: ${max}`,
      `  mode: ${mode}`,
      '  overflow: collect-issue',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(dir, '.orchestrator', 'current-session.json'),
    JSON.stringify({ session_id: RAW_SESSION_ID, semantic_session_id: 'deep-1' }),
  );
  return dir;
}

/** Spawn the hook with a PreToolUse Bash payload. */
function runHook(command, { projectDir = repo, env = {} } = {}) {
  return spawnSync('node', [HOOK], {
    input: JSON.stringify({
      session_id: RAW_SESSION_ID,
      tool_name: 'Bash',
      tool_input: { command },
    }),
    encoding: 'utf-8',
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectDir,
      SO_PROJECT_DIR: projectDir,
      SO_DISABLED_HOOKS: '',
      SO_HOOK_PROFILE: '',
      ...env,
    },
  });
}

/** The single per-session counter file the hook wrote, parsed — or `null`. */
function ledger(projectDir = repo) {
  const dir = join(projectDir, ...BUDGET_DIR);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(dir, files[0]), 'utf-8'));
}

beforeEach(() => {
  repo = makeRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('pre-bash-issue-budget — per-statement charging (#1163 BUG-1)', () => {
  it('charges N for N chained create statements', () => {
    expectAllow(runHook('glab issue create --title A && glab issue create --title B'));
    // 1 here is the pre-#1163 behaviour — the fake-regression this test pins.
    expect(ledger().count).toBe(2);
  });

  it('charges N for N newline-separated create statements', () => {
    expectAllow(runHook('cd /repo\nglab issue create --title A\nglab issue create --title B'));
    expect(ledger().count).toBe(2);
  });

  it('charges an exemption per statement, not per command', () => {
    // The exempt neighbour must NOT cover the real create: 1 charged + 1 exempt.
    expectAllow(
      runHook(
        'glab issue create --title REAL && glab issue create --label carryover --title X',
      ),
    );
    const state = ledger();
    expect(state.count).toBe(1);
    expect(state.exempt).toBe(1);
  });

  it('charges the REST-API route the matcher newly sees (#1163 BUG-2)', () => {
    expectAllow(runHook('glab api --method POST projects/1/issues -f title=X'));
    expect(ledger().count).toBe(1);
  });

  it('leaves an API LIST call uncharged and unledgered', () => {
    expectAllow(runHook('gh api repos/o/r/issues'));
    expect(ledger()).toBeNull();
  });
});

describe('pre-bash-issue-budget — the cap itself', () => {
  it('denies the whole chain when it does not fit, and charges NOTHING', () => {
    repo = makeRepo({ max: 2 });
    expectAllow(runHook('glab issue create --title A'));
    expect(ledger().count).toBe(1);

    const res = runHook('glab issue create --title B && glab issue create --title C');
    expectDeny(res, 'issue-budget: session cap reached');
    const state = ledger();
    // A denied command runs NOTHING, so the count must not move — and both
    // requests are parked so session-end can fold them into one collector issue.
    expect(state.count).toBe(1);
    expect(state.overflow).toHaveLength(2);
    expect(state.overflow.map((o) => o.title)).toEqual(['B', 'C']);
  });

  it('loop form is still denied in strict mode', () => {
    const res = runHook('for t in a b c; do glab issue create --title "$t"; done');
    expectDeny(res, 'UNKNOWN number of issues');
    expect(ledger()).toBeNull();
  });

  it('mode: off writes no ledger and allows', () => {
    repo = makeRepo({ mode: 'off' });
    expectAllow(runHook('glab issue create --title A && glab issue create --title B'));
    expect(ledger()).toBeNull();
  });

  it('mode: warn allows past the cap and keeps counting every statement', () => {
    repo = makeRepo({ mode: 'warn', max: 1 });
    expectAllow(runHook('glab issue create --title A && glab issue create --title B'));
    expect(ledger().count).toBe(2);
  });

  // THE BUG (TV-001): the loop-body UNDERCOUNT report was moved onto the
  // decision channel (`emitWarn`, stdout JSON) precisely because under exit 0 a
  // stderr write reaches only the debug log (#916). Allow and warn share exit
  // 0, so a regression back to `process.stderr.write` would be invisible to
  // every other test in this file — `expectAllow` asserts stdout is EMPTY, and
  // that is the only assertion that can tell the two apart.
  it('mode: warn on a loop emits the UNDERCOUNT warning on the decision channel (stdout JSON), not stderr', () => {
    repo = makeRepo({ mode: 'warn', max: 12 });
    const res = runHook('for t in a b c; do glab issue create --title "$t"; done');
    // expectWarn is the discriminator: exactly ONE stdout line whose only key
    // is `systemMessage`. A regression to a bare `process.stderr.write` leaves
    // stdout EMPTY and fails here — while still exiting 0 like an allow.
    // (`emitWarn` MIRRORS the text to stderr on purpose, `scripts/lib/io.mjs:520`
    // — the debug channel — so "not on stderr" is NOT the contract and was
    // measured false: the stderr copy is present by design.)
    expectWarn(res, ['UNDERCOUNT', 'charged as 1']);
    // The bulk create is charged ONCE — the undercount the warning names.
    expect(ledger().count).toBe(1);
  });

  // THE BUG (TV-001), reproduced 2026-09-17 @ `9e8146b4` through this very hook
  // binary in a throwaway `mode: warn` repo: the UNDERCOUNT notice was gated on
  // the LAST statement's verdict being `allow`, so ONE exempt statement written
  // AFTER an uncountable loop silenced the notice entirely — ledger count=1,
  // exempt=1, stdout EMPTY, while the loop files an unknowable number of issues.
  // Dropping the trailing exempt statement made the very same loop report the
  // UNDERCOUNT, which is what pins this on the gate and not on the loop lane.
  // A silent 1-for-N is exactly what the deny exists to prevent and what the
  // comment above this branch says `warn` must not reintroduce quietly.
  //
  // Fake-regression proof: re-gate the notice on `verdict.decision === 'allow'`
  // (the last verdict) and this test goes red with an EMPTY stdout.
  it('mode: warn still reports the undercount when a TRAILING statement is exempt', () => {
    repo = makeRepo({ mode: 'warn', max: 12 });
    const res = runHook(
      'for i in 1 2; do glab issue create --title j$i; done; '
        + 'glab issue create --title "[Carryover] z"',
    );
    expectWarn(res, ['UNDERCOUNT', 'charged as 1']);
    const state = ledger();
    expect(state.count).toBe(1);
    expect(state.exempt).toBe(1);
  });

  it('a non-create Bash command is a silent allow', () => {
    expectAllow(runHook('ls -la'));
    expect(ledger()).toBeNull();
  });
});

describe('pre-bash-issue-budget — xargs-driven bulk create (#1289 Befund 1)', () => {
  // THE BUG (TV-001), measured 2026-09-16: these three shapes reached the hook
  // with ZERO issue-create statements, so G3 short-circuited at
  // `statements.length === 0` BEFORE the loop-deny at G3b — the cap never
  // charged, the deny never fired, and an unbounded `xargs` word list filed
  // issues against a count of 0. A fix inside `isLoopedIssueCreate` alone could
  // never run, which is why the matcher AND this wiring both changed.
  // Fake regression: drop the `statements.some((s) => s.bulk)` disjunct and
  // every row below comes back ALLOW with no ledger.
  it.each([
    ['bare xargs', 'xargs glab issue create --title X'],
    ['-I% replacement', 'echo X | xargs -I% glab issue create --title %'],
    ['REST lane through xargs', 'seq 1 50 | xargs -I% gh api -X POST repos/o/r/issues -f title=%'],
  ])('denies %s in strict mode and charges nothing', (_label, command) => {
    const res = runHook(command);
    expectDeny(res, 'UNKNOWN number of issues');
    expect(ledger()).toBeNull();
  });

  // THE BUG (TV-001): `formatLoopDenyReason` hardcoded "sits inside a shell loop
  // body (`do … done`)" for BOTH lanes, so an xargs deny — where no loop exists
  // anywhere in the command — told the operator to look for a loop it does not
  // have. The deny must describe the lane it actually fired on.
  it('the xargs-lane deny text does not claim a shell loop body', () => {
    const res = runHook('echo b | xargs -I% glab issue create --title junk%');
    expectDeny(res, 'UNKNOWN number of issues');
    expect(res.stdout).not.toContain('do … done');
    expect(res.stdout).toContain('xargs');
  });

  // Direction guard: an xargs call that creates nothing must stay invisible to
  // this gate — the widening reports a bulk CREATE, never "xargs is suspicious".
  it('allows a non-create xargs call', () => {
    expectAllow(runHook('echo a | xargs echo'));
    expect(ledger()).toBeNull();
  });

  // Mode-respecting, exactly like the loop lane: `warn` reports the undercount
  // on the decision channel and charges ONCE, it does not deny.
  it('mode: warn reports the undercount instead of denying', () => {
    repo = makeRepo({ mode: 'warn', max: 12 });
    expectWarn(runHook('echo X | xargs -I% glab issue create --title %'), ['UNDERCOUNT']);
    expect(ledger().count).toBe(1);
  });

  // THE BUG (TV-001), reproduced 2026-09-17 @ `9e8146b4` through this very hook
  // binary in a throwaway `mode: warn` repo: the UNDERCOUNT notice names "bulk
  // create inside a loop body" on BOTH lanes, so the xargs notice — where no
  // loop exists anywhere in the command — sends the operator looking for a loop
  // the command does not have. Same defect class the xargs DENY text already
  // fixed (`formatLoopDenyReason` lanes, #1379); only the warn sentence was left
  // behind. Measured stdout on the old code:
  //   "bulk create inside a loop body charged as 1 (1/12) …"
  //
  // Fake-regression proof: hardcode the loop phrase in the warn text again and
  // the `not.toContain('loop body')` assertion below goes red.
  it('the xargs-lane UNDERCOUNT notice does not claim a loop body', () => {
    repo = makeRepo({ mode: 'warn', max: 12 });
    const res = runHook('echo b | xargs -I% glab issue create --title junk%');
    expectWarn(res, ['UNDERCOUNT', 'charged as 1', 'xargs']);
    expect(res.stdout).not.toContain('loop body');
  });
});

describe('pre-bash-issue-budget — an exempt NEIGHBOUR must not lift a bulk deny (#1106 class)', () => {
  // THE BUG (TV-001), measured live 2026-09-16 through this very hook binary in
  // a throwaway strict-mode repo: G3b classified the exemption on
  // `statements[0].text` while the bulk source was ANY statement, so ONE exempt
  // create written FIRST lifted the deny for an unrelated uncountable create in
  // the same chain. Both lanes were affected — the `xargs` lane since #1289 and
  // the LOOP lane since #1145 (there the first-create-only scan in
  // `isLoopedIssueCreate` reported `false` outright). Each of the two tests
  // below files an unknowable number of UNTEMPLATED issues on the old code.
  //
  // Fake-regression proof: rebind G3b to `classifyExemption(statements[0].text)`
  // → the xargs row goes ALLOW; additionally restore the first-create-only scan
  // in `findLoopedIssueCreate` → the loop row goes ALLOW too.
  it('an exempt first statement does not lift the xargs bulk deny', () => {
    const res = runHook(
      'glab issue create --title "[Carryover] real"; echo X | xargs -I% glab issue create --title %',
    );
    expectDeny(res, 'UNKNOWN number of issues');
    expect(ledger()).toBeNull();
  });

  it('an exempt first statement does not lift the loop deny (#1106 class, pre-existing)', () => {
    const res = runHook(
      'glab issue create --title "[Carryover] real"; for i in 1 2 3; do glab issue create --title junk$i; done',
    );
    expectDeny(res, 'UNKNOWN number of issues');
    expect(ledger()).toBeNull();
  });

  // The documented behaviour that is DELIBERATELY kept: an exempt statement that
  // is ITSELF the bulk one still passes. session-end promises the carryover /
  // priority::critical classes are never deferred, and that promise holds inside
  // a loop or an xargs word list too.
  it('a bulk statement that is ITSELF exempt keeps its unconditional pass', () => {
    expectAllow(runHook('echo X | xargs -I% glab issue create --label carryover --title %'));
    expect(ledger().count).toBe(0);
    expect(ledger().exempt).toBe(1);
  });

  // THE BUG (TV-001), reproduced 2026-09-17 @ 9e8146b4 through this very hook
  // binary: the LOOP lane enumerated only ONE loop. `findLoopedIssueCreate`
  // `return`ed on the FIRST create head found at depth > 0, so G3b built
  // `bulkTexts` from at most one loop — an EXEMPT first loop was then the only
  // loop classified, and every later loop went unjudged. Ledger on the old
  // code: count=1 exempt=1, verdict ALLOW, while the second loop files an
  // unknowable number of UNTEMPLATED issues.
  //
  // Fake-regression proof: restore the early `return` in
  // `findLoopedIssueCreates` (or drop the spread in G3b) and all three rows
  // below come back ALLOW.
  it.each([
    [
      'a carryover loop does not lift the deny for a SECOND plain loop',
      'for i in 1 2 3; do glab issue create --label carryover --title x$i; done; '
        + 'for j in 1 2 3; do glab issue create --title junk$j; done',
    ],
    [
      'a priority::critical loop does not lift the deny for a SECOND plain loop',
      'for i in 1 2; do glab issue create --label priority::critical --title c$i; done; '
        + 'for j in 1 2; do glab issue create --title junk$j; done',
    ],
    [
      'an exempt while-read loop does not lift the deny for a SECOND while-read loop',
      'while read t; do glab issue create --label carryover --title "$t"; done < a; '
        + 'while read u; do glab issue create --title "$u"; done < b',
    ],
  ])('%s', (_label, command) => {
    const res = runHook(command);
    expectDeny(res, 'UNKNOWN number of issues');
    expect(ledger()).toBeNull();
  });

  // The kept promise, LOOP lane: a LONE exempt loop still passes unconditionally
  // (session-end's "carryover is never deferred"). This is the direction guard
  // for the fix above — spreading every loop must not start denying this one.
  it('a LONE exempt loop keeps its unconditional pass', () => {
    expectAllow(runHook('for i in 1 2 3; do glab issue create --label carryover --title x$i; done'));
    expect(ledger().count).toBe(0);
    expect(ledger().exempt).toBe(1);
  });

  // Counter-test (direction guard): nothing bulk in the chain at all — the
  // exempt create still exempts only itself and the plain one still charges,
  // exactly as before this change.
  it('an exempt create beside a single NON-bulk create still charges and allows', () => {
    expectAllow(runHook('glab issue create --title "[Carryover] real"; glab issue create --title plain'));
    const state = ledger();
    expect(state.count).toBe(1);
    expect(state.exempt).toBe(1);
  });
});
