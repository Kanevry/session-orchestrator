/**
 * issue-budget.test.mjs — decision-core tests for scripts/lib/issue-budget.mjs.
 *
 * Covers the cap itself, the mode matrix (strict/warn/off), the load-bearing
 * exemptions (priority::critical + the SPIRAL/FAILED auto-carry class), and
 * the lossless-overflow guarantee: a blocked creation must be PARKED, never
 * dropped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  classifyExemption,
  loadIssueBudgetConfig,
  chargeIssueBudget,
  readBudgetState,
  budgetStatePath,
  BUDGET_STATE_REL,
} from '@lib/issue-budget.mjs';

let repoRoot;

function writeConfig(body) {
  writeFileSync(path.join(repoRoot, 'CLAUDE.md'), body, 'utf8');
}

/** Charge N plain (non-exempt) creations and return the last verdict. */
function chargeN(n, config, sessionId = 's1') {
  let last;
  for (let i = 0; i < n; i++) {
    last = chargeIssueBudget({
      repoRoot,
      sessionId,
      command: `glab issue create --title "plain ${i}" --label "type::feature,priority::medium"`,
      title: `plain ${i}`,
      config,
    });
  }
  return last;
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'issue-budget-'));
  writeConfig('# Repo\n\n## Session Config\n\nwaves: 5\n');
});

afterEach(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
  repoRoot = undefined;
});

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

describe('loadIssueBudgetConfig', () => {
  it('returns the documented defaults when no block is present', () => {
    expect(loadIssueBudgetConfig(repoRoot)).toEqual({
      'max-per-session': 12,
      mode: 'strict',
      overflow: 'collect-issue',
    });
  });

  it('reads the block out of CLAUDE.md', () => {
    writeConfig('## Session Config\n\nissue-budget:\n  max-per-session: 2\n  mode: warn\n');
    expect(loadIssueBudgetConfig(repoRoot)).toEqual({
      'max-per-session': 2,
      mode: 'warn',
      overflow: 'collect-issue',
    });
  });

  it('falls back to defaults when the repo has no instruction file', () => {
    rmSync(path.join(repoRoot, 'CLAUDE.md'));
    expect(loadIssueBudgetConfig(repoRoot)['max-per-session']).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Exemptions — the load-bearing half
// ---------------------------------------------------------------------------

describe('classifyExemption', () => {
  it('exempts priority::critical (scoped)', () => {
    const r = classifyExemption('glab issue create --title "x" --label "type::bug,priority::critical"');
    expect(r).toEqual({ exempt: true, reason: 'priority::critical' });
  });

  it('exempts the legacy unscoped priority:critical during the label migration', () => {
    expect(classifyExemption('gh issue create --label "priority:critical"').exempt).toBe(true);
  });

  it('exempts the SPIRAL/FAILED auto-carry title template', () => {
    expect(
      classifyExemption('glab issue create --title "[Carryover] [SPIRAL] flaky auth task"').reason,
    ).toBe('spiral-failed-auto-carry');
    expect(
      classifyExemption('glab issue create --title "[Carryover] [FAILED] db migration"').reason,
    ).toBe('spiral-failed-auto-carry');
  });

  it('exempts the carryover label class', () => {
    expect(classifyExemption('glab issue create --label "carryover,priority::high"').reason).toBe(
      'carryover-class',
    );
    expect(classifyExemption('gh issue create --label "type::carryover"').reason).toBe('carryover-class');
  });

  it('exempts broken-window closure issues', () => {
    expect(classifyExemption('glab issue create --label "broken-window,priority::high"').reason).toBe(
      'broken-window-closure',
    );
  });

  it('exempts the overflow collector itself so it always lands at count == max', () => {
    expect(classifyExemption('glab issue create --title "[Backlog-Sammel] s1, 4 zurückgestellte Punkte"').exempt).toBe(true);
  });

  it('does NOT exempt an ordinary discovery/plan issue', () => {
    expect(
      classifyExemption('glab issue create --title "[Discovery] dead export" --label "type::discovery,priority::low"'),
    ).toEqual({ exempt: false, reason: null });
  });

  it('does NOT exempt on a lowercase "failed" appearing in prose', () => {
    expect(classifyExemption('gh issue create --title "login failed on retry"').exempt).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The cap
// ---------------------------------------------------------------------------

describe('chargeIssueBudget — strict mode', () => {
  const config = { 'max-per-session': 3, mode: 'strict', overflow: 'collect-issue' };

  it('allows creations up to and including the cap', () => {
    const last = chargeN(3, config);
    expect(last.decision).toBe('allow');
    expect(last.count).toBe(3);
  });

  it('blocks the creation that would exceed the cap', () => {
    chargeN(3, config);
    const v = chargeIssueBudget({
      repoRoot,
      sessionId: 's1',
      command: 'glab issue create --title "one too many" --label "type::chore,priority::low"',
      title: 'one too many',
      config,
    });
    expect(v.decision).toBe('block');
    expect(v.count).toBe(3); // blocked creations are NOT counted — they never happened
    expect(v.max).toBe(3);
  });

  it('parks the blocked request in overflow[] instead of dropping it', () => {
    chargeN(3, config);
    chargeIssueBudget({
      repoRoot,
      sessionId: 's1',
      command: 'glab issue create --title "parked A"',
      title: 'parked A',
      config,
    });
    chargeIssueBudget({
      repoRoot,
      sessionId: 's1',
      command: 'glab issue create --title "parked B"',
      title: 'parked B',
      config,
    });

    const state = readBudgetState(repoRoot, 's1');
    expect(state.count).toBe(3);
    expect(state.overflow).toHaveLength(2);
    expect(state.overflow.map((o) => o.title)).toEqual(['parked A', 'parked B']);
    expect(state.overflow[0].command).toContain('glab issue create');
    expect(typeof state.overflow[0].at).toBe('string');
  });

  it('lets an EXEMPT creation through even when the budget is fully spent', () => {
    chargeN(3, config);
    const v = chargeIssueBudget({
      repoRoot,
      sessionId: 's1',
      command: 'glab issue create --title "[Carryover] [SPIRAL] wedged task" --label "type::carryover,priority::high"',
      config,
    });
    expect(v.decision).toBe('exempt');
    expect(v.reason).toBe('spiral-failed-auto-carry');
    expect(readBudgetState(repoRoot, 's1').overflow).toHaveLength(0);
  });

  it('lets priority::critical through when the budget is fully spent', () => {
    chargeN(3, config);
    const v = chargeIssueBudget({
      repoRoot,
      sessionId: 's1',
      command: 'gh issue create --title "prod down" --label "priority::critical"',
      config,
    });
    expect(v.decision).toBe('exempt');
    expect(v.reason).toBe('priority::critical');
  });

  it('max-per-session: 0 blocks the very first non-exempt creation', () => {
    const zero = { 'max-per-session': 0, mode: 'strict', overflow: 'collect-issue' };
    const v = chargeIssueBudget({ repoRoot, sessionId: 's1', command: 'glab issue create --title "x"', config: zero });
    expect(v.decision).toBe('block');
  });
});

describe('chargeIssueBudget — warn and off modes do not enforce', () => {
  it('warn allows the over-cap creation and keeps counting', () => {
    const config = { 'max-per-session': 2, mode: 'warn', overflow: 'collect-issue' };
    chargeN(2, config);
    const v = chargeIssueBudget({
      repoRoot,
      sessionId: 's1',
      command: 'glab issue create --title "over cap"',
      config,
    });
    expect(v.decision).toBe('warn');
    expect(v.count).toBe(3);
    expect(readBudgetState(repoRoot, 's1').overflow).toHaveLength(0);
  });

  it('off short-circuits: no verdict, no counter file written', () => {
    const config = { 'max-per-session': 0, mode: 'off', overflow: 'collect-issue' };
    const v = chargeIssueBudget({
      repoRoot,
      sessionId: 's1',
      command: 'glab issue create --title "anything"',
      config,
    });
    expect(v.decision).toBe('off');
    expect(existsSync(budgetStatePath(repoRoot))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

describe('budget state file', () => {
  it('lives at .orchestrator/runtime/issue-budget.json', () => {
    expect(BUDGET_STATE_REL).toBe('.orchestrator/runtime/issue-budget.json');
    chargeN(1, { 'max-per-session': 5, mode: 'strict', overflow: 'collect-issue' });
    const raw = JSON.parse(readFileSync(budgetStatePath(repoRoot), 'utf8'));
    expect(raw).toMatchObject({ sessionId: 's1', count: 1 });
    expect(Array.isArray(raw.overflow)).toBe(true);
  });

  it('resets when a different sessionId shows up', () => {
    const config = { 'max-per-session': 2, mode: 'strict', overflow: 'collect-issue' };
    chargeN(2, config, 's1');
    const v = chargeIssueBudget({
      repoRoot,
      sessionId: 's2',
      command: 'glab issue create --title "new session"',
      config,
    });
    expect(v.decision).toBe('allow');
    expect(v.count).toBe(1);
  });

  it('treats a malformed counter file as a fresh state (fail-open)', () => {
    const p = budgetStatePath(repoRoot);
    writeFileSync(path.join(repoRoot, 'CLAUDE.md'), '## Session Config\n', 'utf8');
    // create dir + garbage
    chargeN(1, { 'max-per-session': 5, mode: 'strict', overflow: 'collect-issue' });
    writeFileSync(p, '{not json', 'utf8');
    expect(readBudgetState(repoRoot, 's1')).toEqual({ sessionId: 's1', count: 0, exempt: 0, overflow: [] });
  });
});
