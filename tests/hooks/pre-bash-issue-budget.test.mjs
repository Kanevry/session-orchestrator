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

  it('a non-create Bash command is a silent allow', () => {
    expectAllow(runHook('ls -la'));
    expect(ledger()).toBeNull();
  });
});
