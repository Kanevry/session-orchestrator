/**
 * issue-budget.test.mjs — decision-core tests for scripts/lib/issue-budget.mjs.
 *
 * Covers the cap itself, the mode matrix (strict/warn/off), the load-bearing
 * exemptions (priority::critical + the SPIRAL/FAILED auto-carry class), and
 * the lossless-overflow guarantee: a blocked creation must be PARKED, never
 * dropped.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  classifyExemption,
  loadIssueBudgetConfig,
  resolveIssueBudgetSessionId,
  chargeIssueBudget,
  readBudgetState,
  budgetStatePath,
  budgetStateRel,
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
// Accounting session identity
// ---------------------------------------------------------------------------

describe('resolveIssueBudgetSessionId', () => {
  it('uses the semantic accounting key only when the recorded raw id matches', () => {
    expect(
      resolveIssueBudgetSessionId('native-raw-1', {
        session_id: 'native-raw-1',
        semantic_session_id: 'main-2026-08-20-deep-1',
      }),
    ).toBe('main-2026-08-20-deep-1');
  });

  it('keeps the native raw id when the record belongs to another raw session', () => {
    expect(
      resolveIssueBudgetSessionId('native-raw-2', {
        session_id: 'native-raw-1',
        semantic_session_id: 'foreign-semantic',
      }),
    ).toBe('native-raw-2');
  });

  it('keeps a missing native raw id missing instead of adopting a semantic id', () => {
    expect(
      resolveIssueBudgetSessionId(null, {
        session_id: 'native-raw-1',
        semantic_session_id: 'foreign-semantic',
      }),
    ).toBeNull();
  });

  it('keeps the native raw id when the current-session record is malformed', () => {
    expect(resolveIssueBudgetSessionId('native-raw-1', 'not-a-record')).toBe('native-raw-1');
  });

  it('keeps the native raw id when the matching record lacks a semantic id', () => {
    expect(resolveIssueBudgetSessionId('native-raw-1', { session_id: 'native-raw-1' })).toBe('native-raw-1');
  });
});

describe('semantic issue-budget accounting continuity', () => {
  const config = { 'max-per-session': 1, mode: 'strict', overflow: 'collect-issue' };

  it('preserves a spent cap across matching native calls', () => {
    const currentSession = {
      session_id: 'native-raw-1',
      semantic_session_id: 'main-2026-08-20-deep-1',
    };
    const sessionId = resolveIssueBudgetSessionId('native-raw-1', currentSession);
    chargeIssueBudget({ repoRoot, sessionId, command: 'glab issue create --title "first"', config });
    const repeated = chargeIssueBudget({ repoRoot, sessionId, command: 'glab issue create --title "second"', config });

    expect(repeated).toMatchObject({ decision: 'block', count: 1 });
  });

  it('starts fresh when both the raw and semantic identities rotate', () => {
    const firstId = resolveIssueBudgetSessionId('native-raw-1', {
      session_id: 'native-raw-1',
      semantic_session_id: 'main-2026-08-20-deep-1',
    });
    const secondId = resolveIssueBudgetSessionId('native-raw-2', {
      session_id: 'native-raw-2',
      semantic_session_id: 'main-2026-08-20-deep-2',
    });
    chargeIssueBudget({ repoRoot, sessionId: firstId, command: 'glab issue create --title "first"', config });
    const next = chargeIssueBudget({ repoRoot, sessionId: secondId, command: 'glab issue create --title "second"', config });

    expect(next).toMatchObject({ decision: 'allow', count: 1 });
  });

  it('does not inherit a foreign older semantic budget through a raw mismatch', () => {
    chargeIssueBudget({
      repoRoot,
      sessionId: 'main-2026-08-20-deep-1',
      command: 'glab issue create --title "older session"',
      config,
    });
    const sessionId = resolveIssueBudgetSessionId('native-raw-new', {
      session_id: 'native-raw-old',
      semantic_session_id: 'main-2026-08-20-deep-1',
    });
    const incoming = chargeIssueBudget({ repoRoot, sessionId, command: 'glab issue create --title "incoming"', config });

    expect(incoming).toMatchObject({ decision: 'allow', count: 1 });
  });

  it('uses a fresh identity-less state rather than preserving cross-invocation budget continuity', () => {
    chargeIssueBudget({ repoRoot, sessionId: 'prior-session', command: 'glab issue create --title "prior"', config });

    const first = chargeIssueBudget({
      repoRoot,
      sessionId: null,
      command: 'glab issue create --title "identity-less first"',
      config,
    });
    const second = chargeIssueBudget({
      repoRoot,
      sessionId: null,
      command: 'glab issue create --title "identity-less second"',
      config,
    });

    // Each identity-less call reads a fresh state, so both are allowed -- and
    // because neither PERSISTS, the second sees the same fresh state as the
    // first rather than the other's spend.
    expect(first).toMatchObject({ decision: 'allow', count: 1, overflowCount: 0 });
    expect(second).toMatchObject({ decision: 'allow', count: 1, overflowCount: 0 });
    // `prior-session`'s own ledger is untouched, and no identity-less write
    // landed on the legacy flat path either.
    expect(existsSync(budgetStatePath(repoRoot, null))).toBe(false);
    expect(JSON.parse(readFileSync(budgetStatePath(repoRoot, 'prior-session'), 'utf8'))).toEqual({
      sessionId: 'prior-session',
      count: 1,
      exempt: 0,
      overflow: [],
    });
  });

  it('does not let an identity-less charge clear a spent strict cap or drop parked overflow', () => {
    // prior-session spends its cap (max 1) and parks one overflow record.
    chargeIssueBudget({ repoRoot, sessionId: 'prior-session', command: 'glab issue create --title "prior"', config });
    const parked = chargeIssueBudget({
      repoRoot,
      sessionId: 'prior-session',
      command: 'glab issue create --title "parked"',
      title: 'parked',
      config,
    });
    expect(parked).toMatchObject({ decision: 'block', count: 1, overflowCount: 1 });

    chargeIssueBudget({ repoRoot, sessionId: null, command: 'glab issue create --title "identity-less"', config });

    // Without the write-side guard this returned `allow` with count 1 -- one
    // identity-less call was enough to hand a capped session a fresh budget
    // and delete the overflow record session-end is supposed to file.
    const after = chargeIssueBudget({
      repoRoot,
      sessionId: 'prior-session',
      command: 'glab issue create --title "after"',
      title: 'after',
      config,
    });
    expect(after).toMatchObject({ decision: 'block', count: 1, overflowCount: 2 });
    expect(
      JSON.parse(readFileSync(budgetStatePath(repoRoot, 'prior-session'), 'utf8')).overflow,
    ).toHaveLength(2);
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
    expect(existsSync(budgetStatePath(repoRoot, 's1'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// State file
// ---------------------------------------------------------------------------

describe('budget state file', () => {
  it('lives at .orchestrator/runtime/issue-budget/<hash>.json, one file per session', () => {
    expect(budgetStateRel('s1')).toMatch(
      /^\.orchestrator\/runtime\/issue-budget\/[0-9a-f]{16}\.json$/,
    );
    // Two ids never share a slot; one id is stable across calls.
    expect(budgetStateRel('s1')).not.toBe(budgetStateRel('s2'));
    expect(budgetStateRel('s1')).toBe(budgetStateRel('s1'));
    // Identity-less callers keep the legacy flat path (they never read or
    // persist — they only need a stable name for messages).
    expect(budgetStateRel(null)).toBe(BUDGET_STATE_REL);
    expect(BUDGET_STATE_REL).toBe('.orchestrator/runtime/issue-budget.json');

    chargeN(1, { 'max-per-session': 5, mode: 'strict', overflow: 'collect-issue' });
    const raw = JSON.parse(readFileSync(budgetStatePath(repoRoot, 's1'), 'utf8'));
    expect(raw).toMatchObject({ sessionId: 's1', count: 1 });
    expect(Array.isArray(raw.overflow)).toBe(true);
  });

  // #1141 — the bug this split exists for. The counter used to be ONE slot per
  // WORKING COPY, and `readBudgetState` zeroes a state whose `sessionId` does
  // not match the reader. Two sessions sharing a working copy therefore reset
  // each other on every charge: with a cap of 3 both ran forever at count 1,
  // i.e. the cap was silently OFF FOR BOTH. Measured 2026-08-23 in the live
  // repo, where the single file was owned by a session started 11 h earlier.
  it('does not let two sessions in one working copy reset each other (#1141)', () => {
    const config = { 'max-per-session': 3, mode: 'strict', overflow: 'collect-issue' };

    // Interleaved, which is the shape that made the old single slot fail —
    // sequential runs would have hidden it.
    for (let i = 0; i < 3; i++) {
      chargeN(1, config, 'session-A');
      chargeN(1, config, 'session-B');
    }

    // Two distinct files, each holding its own full spend.
    const fileA = budgetStatePath(repoRoot, 'session-A');
    const fileB = budgetStatePath(repoRoot, 'session-B');
    expect(fileA).not.toBe(fileB);
    expect(existsSync(fileA)).toBe(true);
    expect(existsSync(fileB)).toBe(true);

    // Before the fix this was [1, 1]: each charge re-zeroed the other's count.
    expect([
      readBudgetState(repoRoot, 'session-A').count,
      readBudgetState(repoRoot, 'session-B').count,
    ]).toEqual([3, 3]);

    // And the cap now actually bites — for BOTH, independently.
    expect(chargeN(1, config, 'session-A')).toMatchObject({ decision: 'block', count: 3 });
    expect(chargeN(1, config, 'session-B')).toMatchObject({ decision: 'block', count: 3 });
  });

  it('seeds a session-scoped file from the legacy flat file it still owns (one-time migration)', () => {
    const config = { 'max-per-session': 3, mode: 'strict', overflow: 'collect-issue' };
    // A session that started before the split has its spend in the flat file.
    mkdirSync(path.join(repoRoot, '.orchestrator', 'runtime'), { recursive: true });
    writeFileSync(
      budgetStatePath(repoRoot, null),
      JSON.stringify({ sessionId: 's1', count: 2, exempt: 4, overflow: [{ title: 'parked' }] }),
      'utf8',
    );

    expect(readBudgetState(repoRoot, 's1')).toMatchObject({ count: 2, exempt: 4 });
    // Without the seed the split itself would hand the in-flight session a
    // fresh cap — this third charge would be `allow`, not `block`.
    expect(chargeN(1, config, 's1')).toMatchObject({ decision: 'allow', count: 3 });
    expect(chargeN(1, config, 's1')).toMatchObject({ decision: 'block' });
    // The seed is read-only: the new spend lands in the per-session file.
    expect(JSON.parse(readFileSync(budgetStatePath(repoRoot, 's1'), 'utf8')).count).toBe(3);
    expect(JSON.parse(readFileSync(budgetStatePath(repoRoot, null), 'utf8')).count).toBe(2);
  });

  it('does not seed from a legacy flat file owned by a different session', () => {
    mkdirSync(path.join(repoRoot, '.orchestrator', 'runtime'), { recursive: true });
    writeFileSync(
      budgetStatePath(repoRoot, null),
      JSON.stringify({ sessionId: 'foreign', count: 9, exempt: 0, overflow: [] }),
      'utf8',
    );
    expect(readBudgetState(repoRoot, 's1')).toEqual({
      sessionId: 's1', count: 0, exempt: 0, overflow: [],
    });
  });

  it('starts a different sessionId at zero without touching the first', () => {
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
    expect(readBudgetState(repoRoot, 's1').count).toBe(2);
  });

  it('treats a malformed counter file as a fresh state (fail-open)', () => {
    const p = budgetStatePath(repoRoot, 's1');
    writeFileSync(path.join(repoRoot, 'CLAUDE.md'), '## Session Config\n', 'utf8');
    // create dir + garbage
    chargeN(1, { 'max-per-session': 5, mode: 'strict', overflow: 'collect-issue' });
    writeFileSync(p, '{not json', 'utf8');
    expect(readBudgetState(repoRoot, 's1')).toEqual({ sessionId: 's1', count: 0, exempt: 0, overflow: [] });
  });
});
