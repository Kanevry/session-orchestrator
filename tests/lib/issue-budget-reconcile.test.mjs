/**
 * tests/lib/issue-budget-reconcile.test.mjs
 *
 * Tests for scripts/lib/issue-budget-reconcile.mjs — the close-time cross-check
 * between a session's recorded issue creations and the issue-budget ledger.
 *
 * THE BUG THESE CATCH (TV-001). `readBudgetState` returns a ZEROED state for a
 * MISSING counter file, so "the hook never ran" and "the session created
 * nothing" are byte-identical in its return value. Measured 2026-09-09 on a
 * real session record: 26 issues in `issues_created`, 0 charged, and no counter
 * file under EITHER accounting key — a reader that trusts the zero reports
 * "under the cap, all good" for a session where the cap was entirely off.
 * `verdict: 'no-ledger'` is the discriminator, and the `found` flag per ledger
 * is what makes it possible.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, isAbsolute } from 'node:path';

import {
  reconcileIssueBudget,
  formatIssueBudgetReconcileWarn,
  emitIssueBudgetReconciled,
  ISSUE_BUDGET_RECONCILED_EVENT,
} from '@lib/issue-budget-reconcile.mjs';
import { budgetStatePath, budgetStateRel } from '@lib/issue-budget.mjs';

const SEM = 'deep-1';
const RAW = '11111111-2222-3333-4444-555555555555';

let repo;

/** Write a counter file for one accounting key. */
function writeLedger(sessionId, { count = 0, exempt = 0, overflow = [] } = {}) {
  const file = budgetStatePath(repo, sessionId);
  mkdirSync(join(repo, '.orchestrator', 'runtime', 'issue-budget'), { recursive: true });
  writeFileSync(file, JSON.stringify({ sessionId, count, exempt, overflow }));
  return file;
}

/** A session record with N recorded creations. */
function record(n) {
  return { issues_created: Array.from({ length: n }, (_, i) => `#${i + 1}`) };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'ib-reconcile-'));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('reconcileIssueBudget', () => {
  it('verdict no-ledger when the record has issues and neither key has a file', () => {
    const res = reconcileIssueBudget({
      repoRoot: repo,
      record: record(26),
      sessionId: SEM,
      rawSessionId: RAW,
    });
    expect(res.verdict).toBe('no-ledger');
    expect(res.recorded).toBe(26);
    expect(res.charged).toBe(0);
    // The discriminator: a zeroed READ is not a found ledger.
    expect(res.sources.map((s) => s.found)).toEqual([false, false]);
    expect(res.sources.map((s) => s.key)).toEqual(['semantic', 'raw']);
  });

  it('sums the semantic AND the raw ledger', () => {
    writeLedger(SEM, { count: 4, exempt: 1 });
    writeLedger(RAW, { count: 3, exempt: 2 });
    const res = reconcileIssueBudget({
      repoRoot: repo,
      record: record(10),
      sessionId: SEM,
      rawSessionId: RAW,
    });
    expect(res.charged).toBe(7);
    expect(res.exempt).toBe(3);
    expect(res.verdict).toBe('match');
  });

  it('reads only ONE ledger when both keys are the same string', () => {
    writeLedger(SEM, { count: 4 });
    const res = reconcileIssueBudget({
      repoRoot: repo,
      record: record(4),
      sessionId: SEM,
      rawSessionId: SEM,
    });
    expect(res.sources).toHaveLength(1);
    expect(res.charged).toBe(4);
  });

  it('escaped = recorded − charged − exempt, and never goes negative', () => {
    writeLedger(SEM, { count: 5, exempt: 2 });
    const escaped = reconcileIssueBudget({ repoRoot: repo, record: record(9), sessionId: SEM });
    expect(escaped.escaped).toBe(2);
    expect(escaped.verdict).toBe('escaped');

    const over = reconcileIssueBudget({ repoRoot: repo, record: record(3), sessionId: SEM });
    expect(over.escaped).toBe(0);
    expect(over.verdict).toBe('match');
  });

  it('verdict stale-record when a ledger charged but the record lists nothing', () => {
    writeLedger(SEM, { count: 3 });
    const res = reconcileIssueBudget({ repoRoot: repo, record: {}, sessionId: SEM });
    expect(res.verdict).toBe('stale-record');
    expect(res.recorded).toBe(0);
  });

  it('a zero-spend ledger that EXISTS is a match, not a no-ledger', () => {
    writeLedger(SEM, { count: 0 });
    const res = reconcileIssueBudget({ repoRoot: repo, record: record(0), sessionId: SEM });
    expect(res.verdict).toBe('match');
    expect(res.sources[0].found).toBe(true);
  });

  // THE BUG (TV-001): a ledger with `{"count":"3"}` normalises to `charged: 0`
  // via `readBudgetState`'s fail-open path, so the old logic called it `escaped`
  // and printed the whole escape-route list — sending the operator after a
  // matcher gap for what is a broken file.
  it('a ledger whose count is not an integer reports corrupt-ledger, not escape', () => {
    const file = budgetStatePath(repo, SEM);
    mkdirSync(join(repo, '.orchestrator', 'runtime', 'issue-budget'), { recursive: true });
    writeFileSync(file, JSON.stringify({ sessionId: SEM, count: '3', exempt: 0, overflow: [] }));

    const res = reconcileIssueBudget({ repoRoot: repo, record: record(3), sessionId: SEM });
    expect(res.verdict).toBe('corrupt-ledger');
    expect(res.sources[0].found).toBe(true);
    expect(res.sources[0].corrupt).toBe(true);

    const text = formatIssueBudgetReconcileWarn(res);
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('UNKNOWN, not 0');
    expect(text).not.toContain('escape');
  });

  it('never throws on an unreadable or malformed ledger, or on missing input', () => {
    const file = writeLedger(SEM, { count: 2 });
    writeFileSync(file, '{ not json');
    expect(() => reconcileIssueBudget({ repoRoot: repo, record: record(2), sessionId: SEM })).not.toThrow();
    const res = reconcileIssueBudget({ repoRoot: repo, record: record(2), sessionId: SEM });
    // The file IS there but unreadable — that is a corrupt ledger, not an
    // escape: `charged: 0` here is a normalisation artefact, not a measurement.
    expect(res.charged).toBe(0);
    expect(res.verdict).toBe('corrupt-ledger');

    expect(reconcileIssueBudget({}).verdict).toBe('match');
    expect(reconcileIssueBudget({ repoRoot: repo }).recorded).toBe(0);
    expect(reconcileIssueBudget({ repoRoot: repo, record: { issues_created: 'nope' } }).recorded).toBe(0);
  });
});

describe('formatIssueBudgetReconcileWarn', () => {
  it('no-ledger says the hook never ran, lists BOTH paths and names the escape routes', () => {
    const res = reconcileIssueBudget({
      repoRoot: repo,
      record: record(26),
      sessionId: SEM,
      rawSessionId: RAW,
    });
    const text = formatIssueBudgetReconcileWarn(res);
    expect(text).toContain('the hook never ran');
    expect(text).toContain(budgetStatePath(repo, SEM));
    expect(text).toContain(budgetStatePath(repo, RAW));
    expect(text).toContain('MISSING');
    for (const route of ['gh api', 'bash -c', '$( … )', 'xargs', 'foreign-channel']) {
      expect(text).toContain(route);
    }
  });

  it('match is ONE info line', () => {
    writeLedger(SEM, { count: 2 });
    const res = reconcileIssueBudget({ repoRoot: repo, record: record(2), sessionId: SEM });
    const text = formatIssueBudgetReconcileWarn(res);
    expect(text.split('\n')).toHaveLength(1);
    expect(text.startsWith('ℹ')).toBe(true);
  });

  it('escaped names the gap', () => {
    writeLedger(SEM, { count: 1 });
    const res = reconcileIssueBudget({ repoRoot: repo, record: record(4), sessionId: SEM });
    expect(formatIssueBudgetReconcileWarn(res)).toContain('3 issue(s) escaped the cap');
  });
});

describe('emitIssueBudgetReconciled', () => {
  it('writes an event carrying the verdict and both ledger paths', async () => {
    writeLedger(SEM, { count: 1 });
    const res = reconcileIssueBudget({
      repoRoot: repo,
      record: record(4),
      sessionId: SEM,
      rawSessionId: RAW,
    });
    await emitIssueBudgetReconciled(repo, res);

    const { readFileSync: read, existsSync } = await import('node:fs');
    const ledgerFile = join(repo, '.orchestrator', 'metrics', 'events.jsonl');
    expect(existsSync(ledgerFile)).toBe(true);
    const lines = read(ledgerFile, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const rec = lines.find((l) => l.event === ISSUE_BUDGET_RECONCILED_EVENT);
    expect(rec).toBeTruthy();
    expect(rec.verdict).toBe('escaped');
    expect(rec.escaped).toBe(3);
    // Repo-RELATIVE paths only: this payload travels over the optional Clank
    // webhook, and an absolute ledger path names the operator's home directory
    // and the private repo slug.
    expect(rec.ledgers.every((l) => !isAbsolute(l.path))).toBe(true);
    expect(rec.ledgers.map((l) => l.path)).toEqual([
      budgetStateRel(SEM),
      budgetStateRel(RAW),
    ]);
    expect(rec.ledgers.map((l) => l.found)).toEqual([true, false]);

    // …while the LOCAL warn text still shows the absolute path, which is what
    // answers the operator's first question ("which file did you look at?").
    const warn = formatIssueBudgetReconcileWarn(res);
    expect(warn).toContain(budgetStatePath(repo, SEM));
  });

  it('skips the emit rather than falling back to the ambient project dir', async () => {
    const errs = [];
    const orig = process.stderr.write;
    process.stderr.write = (chunk) => { errs.push(String(chunk)); return true; };
    try {
      await emitIssueBudgetReconciled('', { verdict: 'match' });
    } finally {
      process.stderr.write = orig;
    }
    expect(errs.join('')).toContain(`skipped ${ISSUE_BUDGET_RECONCILED_EVENT}`);
  });
});
