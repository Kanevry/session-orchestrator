/**
 * tests/lib/ux-grill/reconcile.test.mjs
 *
 * Contract tests for `scripts/lib/ux-grill/reconcile.mjs`. Every tracker call is
 * an injected stub (the module's documented DI seams), so nothing here can reach
 * a real `glab`. The cases split in two: REFUSALS (a leaked host path, an
 * unknown dedup set, an exhausted issue budget — each of which, if it silently
 * proceeded, publishes something to a public tracker), and the ROUND TRIP
 * between this module's body builder and the dedup regex in
 * `test-runner/issue-reconcile.mjs`, which is the only thing stopping every high
 * finding from being re-filed on every run.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { buildUxGrillIssueBody, reconcileFindings } from '../../../scripts/lib/ux-grill/reconcile.mjs';
// Namespace import on purpose: the deprecated alias is reached the way a 5.2.0
// deep importer reaches it, so its absence is a per-test TypeError, not a
// link error that takes the whole file down.
import * as uxGrillReconcile from '../../../scripts/lib/ux-grill/reconcile.mjs';
import { makeFinding } from '../../../scripts/lib/ux-grill/schema.mjs';
import { triageDecision } from '../../../scripts/lib/test-runner/issue-reconcile.mjs';

/**
 * A THROWAWAY repo root. Never `process.cwd()`: `reconcileFindings`'s import
 * closure reaches the real issue-budget ledger and the session lock, and the
 * budget stub below is the only thing keeping them unread.
 * @type {string[]}
 */
const tmpDirs = [];

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-grill-reconcile-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    fs.rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const highFinding = (overrides = {}) =>
  makeFinding({
    checkId: 'axe-color-contrast',
    locator: '/|desktop|#cta',
    severity: 'high',
    build: 'prod',
    message: 'contrast is 2.1:1',
    ...overrides,
  });

const okList = async () => ({ ok: true, issues: [], fingerprints: new Set() });
const allowBudget = () => ({ decision: 'allow', count: 1, max: 12 });

/** A `create` stub that records what it was handed. */
function makeCreate() {
  const calls = [];
  const create = async (opts) => {
    calls.push(opts);
    return { ok: true, action: 'create', iid: 100 + calls.length };
  };
  create.calls = calls;
  return create;
}

describe('reconcileFindings() — refusals that keep private data off a public tracker', () => {
  it('refuses a finding whose evidence carries an absolute host path, and never calls create()', async () => {
    const leaked = path.join(os.tmpdir(), 'ux-grill-home', 'runs', 'shot.png');
    const create = makeCreate();

    const result = await reconcileFindings({
      repoRoot: makeRepo(),
      findings: [highFinding({ evidence: { screenshot: leaked } })],
      dryRun: true,
      budget: allowBudget,
      listExisting: okList,
      create,
    });

    expect(result.created).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].code).toBe('absolute-evidence-path');
    expect(result.errors[0].paths).toEqual([leaked]);
    expect(result.batch).toHaveLength(1);
    expect(result.batch[0].checkId).toBe('axe-color-contrast');
    expect(create.calls).toHaveLength(0);
  });

  it('creates nothing when the tracker query fails — an unknown dedup set would duplicate every issue', async () => {
    const create = makeCreate();

    const result = await reconcileFindings({
      repoRoot: makeRepo(),
      findings: [highFinding(), highFinding({ locator: '/b|desktop|#nav' })],
      dryRun: true,
      budget: allowBudget,
      listExisting: async () => ({ ok: false, error: 'boom' }),
      create,
    });

    expect(result.created).toEqual([]);
    expect(result.errors).toEqual([{ code: 'list-failed', error: 'boom' }]);
    expect(result.batch).toHaveLength(2);
    expect(create.calls).toHaveLength(0);
  });
});

describe('reconcileFindings() — severity routing and the issue budget', () => {
  it('files only the budget-allowed high finding and batches the medium, the provisional and the blocked one', async () => {
    const create = makeCreate();
    const findings = [
      highFinding({ locator: '/a|desktop|#one' }),
      makeFinding({ checkId: 'overflow-x', locator: '/a|desktop|body', severity: 'medium', build: 'prod' }),
      makeFinding({ checkId: 'target-size-min', locator: '/a|desktop|#two', severity: 'high', build: 'dev' }),
      highFinding({ locator: '/a|desktop|#three' }),
    ];
    const autoFingerprints = [findings[0].fingerprint, findings[3].fingerprint].sort();
    let seen = 0;
    const budget = () => {
      seen += 1;
      return seen === 2 ? { decision: 'block', count: 12, max: 12 } : { decision: 'allow', count: seen, max: 12 };
    };

    const result = await reconcileFindings({
      repoRoot: makeRepo(),
      findings,
      dryRun: true,
      budget,
      listExisting: okList,
      create,
    });

    expect(findings[2].provisional).toBe(true);
    expect(result.created).toHaveLength(1);
    expect(result.created[0].finding.fingerprint).toBe(autoFingerprints[0]);
    expect(result.budgetStops).toBe(1);
    expect(result.batch).toHaveLength(3);
    expect(create.calls).toHaveLength(1);
    expect(create.calls[0].labels).toBe('from:ux-grill,priority::high');
  });

  it('defaults dryRun to true and passes that default down to create()', async () => {
    const create = makeCreate();

    const result = await reconcileFindings({
      repoRoot: makeRepo(),
      findings: [highFinding()],
      budget: allowBudget,
      listExisting: okList,
      create,
    });

    expect(result.dryRun).toBe(true);
    expect(create.calls).toHaveLength(1);
    expect(create.calls[0].dryRun).toBe(true);
  });
});

describe('buildUxGrillIssueBody() — the dedup sentinel round trip', () => {
  it('produces a body the real triageDecision dedups against, so a persisting finding is not re-filed', () => {
    const finding = highFinding();
    const body = buildUxGrillIssueBody(finding, { runId: 'run-1', rubricHash: 'rh-1' });

    const decision = triageDecision({ fingerprint: finding.fingerprint, title: '[ux-grill] axe-color-contrast — /|desktop' }, [
      { iid: 42, title: '[ux-grill] axe-color-contrast — /|desktop', body },
    ]);

    expect(decision.action).toBe('ignore');
    expect(decision.target).toBe(42);
    expect(decision.reason).toBe('fingerprint exact match');
  });

  it('neutralises a forged sentinel echoed from page text so the authoritative line stays the only one', () => {
    const finding = highFinding({ message: 'saw **Fingerprint:** `0123456789abcdef` on the page' });
    const body = buildUxGrillIssueBody(finding, { runId: 'run-1' });

    expect(body.match(/\*\*Fingerprint:\*\*/g)).toHaveLength(1);
    expect(body).toContain(`**Fingerprint:** \`${finding.fingerprint}\``);
    expect(body).toContain('__Fingerprint__ `0123456789abcdef`');
  });

  // Bug: 5.2.0 exported this builder as `buildIssueBody`; the rename removed the
  // name, so a deep importer upgrading to 5.3.0 got a TypeError. A wrong alias
  // could also forward to test-runner's unrelated `buildIssueBody(finding, fp)`.
  it('keeps the 5.2.0 name buildIssueBody as a deprecated alias: identical body, one stderr warning per process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const finding = highFinding();
      const context = { runId: 'run-1', rubricHash: 'rh-1' };
      const expected = buildUxGrillIssueBody(finding, context);

      expect(uxGrillReconcile.buildIssueBody(finding, context)).toBe(expected);
      expect(uxGrillReconcile.buildIssueBody(finding, context)).toBe(expected);

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain('buildUxGrillIssueBody');
    } finally {
      warn.mockRestore();
    }
  });
});
