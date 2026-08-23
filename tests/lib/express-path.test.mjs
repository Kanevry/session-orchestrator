/**
 * express-path.test.mjs — scripts/lib/express-path.mjs
 *
 * Every test below names the bug it catches (TV-001). The short version of all
 * of them: on 2026-08-23 the whole `.orchestrator/metrics/events.jsonl` history
 * contained ZERO records mentioning express-path, so "did the fast path ever
 * fire?" was unanswerable. These tests pin the two halves of the answer — the
 * decision, and the fact that the decision records itself even when it says no.
 *
 * LEDGER SAFETY. No test here may append to the operator's real telemetry.
 * Two independent guards:
 *   1. every emitting test passes an explicit `repoRoot` under `mkdtemp`;
 *   2. `CLAUDE_PROJECT_DIR` is pinned to a throwaway SENTINEL tree before the
 *      first `import('./events.mjs')` can happen, so if the repoRoot guard ever
 *      regresses the stray write lands in the sentinel — where a test asserts on
 *      it — instead of in the real repo. `SO_PROJECT_DIR` is a module-level const
 *      computed at `platform.mjs` load, which is why this is set at file scope
 *      rather than inside a `beforeEach`.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// --- must run before any lazy import of events.mjs → platform.mjs ------------
const SENTINEL = mkdtempSync(join(tmpdir(), 'express-path-sentinel-'));
process.env.CLAUDE_PROJECT_DIR = SENTINEL;

const { _parseExpressPath, evaluateExpressPath, EXPRESS_PATH_EVENT, EXPRESS_PATH_MAX_TASKS } =
  await import('@lib/express-path.mjs');

const SENTINEL_LEDGER = join(SENTINEL, '.orchestrator', 'metrics', 'events.jsonl');

/** Read every event record a tmp repoRoot received. */
function readLedger(repoRoot) {
  const file = join(repoRoot, '.orchestrator', 'metrics', 'events.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l));
}

// ---------------------------------------------------------------------------
// _parseExpressPath
// ---------------------------------------------------------------------------

describe('_parseExpressPath', () => {
  it('applies the documented default enabled=true when no block is present', () => {
    // Bug: the two neighbouring conventions disagree — config/state-md-lock.mjs
    // defaults `enabled` to true, config/discovery-validator.mjs to false.
    // Picking the wrong one silently switches the express path off for every
    // repo that never declared the block (i.e. all of them today), while
    // docs/session-config-reference.md:1528 promises "opt-in by default".
    expect(_parseExpressPath('# Project\n\nsome prose\n')).toEqual({ enabled: true });
  });

  it('honours an explicit enabled: false written in the block', () => {
    // Bug (#1119, the measured one): the key was discarded even when it stood in
    // the file. Probe on 2026-08-23 — a config carrying exactly these two lines
    // produced 88 top-level keys, none of them `express-path`, so the operator's
    // opt-out did nothing at all.
    const content = ['# Project', '', 'express-path:', '  enabled: false', ''].join('\n');
    expect(_parseExpressPath(content)).toEqual({ enabled: false });
  });

  it('enters the block through a bold-bullet header (- **express-path:**)', () => {
    // Bug (#830 class): a strict /^express-path:\s*$/ header regex misses the
    // markdown-bold rendering, skips the whole block, and turns an explicit
    // `false` back into the `true` default with nothing reported anywhere.
    const content = ['- **express-path:**', '  enabled: false', ''].join('\n');
    expect(_parseExpressPath(content)).toEqual({ enabled: false });
  });
});

// ---------------------------------------------------------------------------
// evaluateExpressPath — the decision
// ---------------------------------------------------------------------------

describe('evaluateExpressPath — decision', () => {
  let repoRoot;
  beforeAll(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'express-path-decide-'));
  });
  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('activates when all three documented conditions hold', async () => {
    const verdict = await evaluateExpressPath({
      repoRoot,
      config: { 'express-path': { enabled: true } },
      sessionType: 'housekeeping',
      taskCount: 2,
      parallelAgentsRequired: false,
    });
    expect(verdict).toEqual({
      activated: true,
      reasons: ['enabled', 'session-type-housekeeping', 'scope-within-limit', 'no-parallel-agents'],
    });
  });

  it.each([
    {
      why: 'condition 1 — express-path.enabled: false opts out',
      input: { config: { 'express-path': { enabled: false } }, sessionType: 'housekeeping', taskCount: 2, parallelAgentsRequired: false },
      reasons: ['disabled-by-config'],
    },
    {
      why: 'condition 2 — a feature session is not housekeeping',
      input: { config: { 'express-path': { enabled: true } }, sessionType: 'feature', taskCount: 2, parallelAgentsRequired: false },
      reasons: ['session-type-not-housekeeping'],
    },
    {
      why: 'condition 3a — scope above the documented 3-issue ceiling',
      input: { config: { 'express-path': { enabled: true } }, sessionType: 'housekeeping', taskCount: 4, parallelAgentsRequired: false },
      reasons: ['scope-exceeds-limit'],
    },
    {
      why: 'condition 3b — parallel agents are required',
      input: { config: { 'express-path': { enabled: true } }, sessionType: 'housekeeping', taskCount: 3, parallelAgentsRequired: true },
      reasons: ['parallel-agents-required'],
    },
  ])('blocks and names the failing condition: $why', async ({ input, reasons }) => {
    // Bug: a verdict of "no" with no reason is exactly the state #1119 found —
    // 22 wave-less housekeeping sessions and no way to tell which condition
    // (or whether the path was even consulted) produced them.
    const verdict = await evaluateExpressPath({ repoRoot, ...input });
    expect(verdict).toEqual({ activated: false, reasons });
  });

  it('reports EVERY blocking condition, not only the first', async () => {
    // Bug: short-circuiting on the first failure hides that fixing the named
    // condition would not have helped. Here scope is one of four blockers;
    // trimming the issue list changes nothing.
    const verdict = await evaluateExpressPath({
      repoRoot,
      config: { 'express-path': { enabled: false } },
      sessionType: 'feature',
      taskCount: 7,
      parallelAgentsRequired: true,
    });
    expect(verdict).toEqual({
      activated: false,
      reasons: [
        'disabled-by-config',
        'session-type-not-housekeeping',
        'scope-exceeds-limit',
        'parallel-agents-required',
      ],
    });
  });

  it('fails closed on unmeasured session type and task count', async () => {
    // Bug: defaulting an unknown scope to 0 would activate the fast path — which
    // skips every inter-wave quality gate — on data nobody supplied.
    const verdict = await evaluateExpressPath({ repoRoot });
    expect(verdict).toEqual({
      activated: false,
      reasons: ['session-type-unknown', 'task-count-unknown'],
    });
  });

  it('treats exactly EXPRESS_PATH_MAX_TASKS as within scope (boundary)', async () => {
    // Bug: an off-by-one at the ceiling silently disables the path for the
    // 3-issue session the spec's own condition matrix lists as activating.
    expect(EXPRESS_PATH_MAX_TASKS).toBe(3);
    const verdict = await evaluateExpressPath({
      repoRoot,
      config: { 'express-path': { enabled: true } },
      sessionType: 'housekeeping',
      taskCount: 3,
      parallelAgentsRequired: false,
    });
    expect(verdict.activated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// evaluateExpressPath — the record
// ---------------------------------------------------------------------------

describe('evaluateExpressPath — telemetry', () => {
  it('emits a record on NON-activation carrying the blocking reason', async () => {
    // THE bug this module exists for: an emitter that fires only on the
    // activation path leaves "did the express path apply?" unanswerable for
    // every session where it did not. Measured 2026-08-23:
    //   grep -c "express" .orchestrator/metrics/events.jsonl → 0
    const repoRoot = mkdtempSync(join(tmpdir(), 'express-path-noact-'));
    try {
      await evaluateExpressPath({
        repoRoot,
        config: { 'express-path': { enabled: true } },
        sessionType: 'housekeeping',
        taskCount: 9,
        parallelAgentsRequired: false,
      });
      const records = readLedger(repoRoot);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        event: 'orchestrator.express_path.evaluated',
        activated: false,
        reasons: ['scope-exceeds-limit'],
        enabled: true,
        session_type: 'housekeeping',
        task_count: 9,
        parallel_agents_required: false,
      });
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('emits a record on activation too', async () => {
    // Bug: recording only the refusals answers "why not" but never "how often
    // did it help", which is the other half of the #1119 question.
    const repoRoot = mkdtempSync(join(tmpdir(), 'express-path-act-'));
    try {
      await evaluateExpressPath({
        repoRoot,
        config: { 'express-path': { enabled: true } },
        sessionType: 'housekeeping',
        taskCount: 1,
        parallelAgentsRequired: false,
      });
      const records = readLedger(repoRoot);
      expect(records).toHaveLength(1);
      expect(records[0].event).toBe(EXPRESS_PATH_EVENT);
      expect(records[0].activated).toBe(true);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('OMITS unmeasured fields instead of writing them as 0 / false', async () => {
    // Bug: `task_count: 0` for an unsupplied scope is indistinguishable from a
    // real zero-task session, and `enabled: false` for an unread config would
    // read as an operator opt-out that never happened. Absent is not zero.
    const repoRoot = mkdtempSync(join(tmpdir(), 'express-path-absent-'));
    try {
      await evaluateExpressPath({ repoRoot });
      const [record] = readLedger(repoRoot);
      expect(record.activated).toBe(false);
      expect(record).not.toHaveProperty('enabled');
      expect(record).not.toHaveProperty('session_type');
      expect(record).not.toHaveProperty('task_count');
      expect(record).not.toHaveProperty('parallel_agents_required');
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('returns the verdict even when the emitter throws', async () => {
    // Bug: telemetry that can throw takes session-start Phase 8.5 down with it.
    // Real emitter, real failure — /dev/null/<sub> yields a fast ENOTDIR for
    // every uid including CI's root (tests/_helpers/unwritable-path.mjs, #685).
    if (process.platform === 'win32') return;
    const verdict = await evaluateExpressPath({
      repoRoot: '/dev/null/express-path-unwritable',
      config: { 'express-path': { enabled: true } },
      sessionType: 'housekeeping',
      taskCount: 2,
      parallelAgentsRequired: false,
    });
    expect(verdict).toEqual({
      activated: true,
      reasons: ['enabled', 'session-type-housekeeping', 'scope-within-limit', 'no-parallel-agents'],
    });
  });

  it('refuses the ambient project-dir destination when no repoRoot is given', async () => {
    // Bug (measured in wave 1 of this session): `emitEvent` without an explicit
    // repoRoot resolves the destination from SO_PROJECT_DIR, which put a
    // synthetic record into the operator's real fleet ledger. The verdict must
    // still be returned, and the refusal must be visible on stderr.
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const verdict = await evaluateExpressPath({
        config: { 'express-path': { enabled: true } },
        sessionType: 'housekeeping',
        taskCount: 2,
        parallelAgentsRequired: false,
      });
      expect(verdict.activated).toBe(true);
      expect(existsSync(SENTINEL_LEDGER)).toBe(false);
      expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(
        'express-path: skipped orchestrator.express_path.evaluated',
      );
    } finally {
      stderr.mockRestore();
    }
  });
});

afterAll(() => {
  rmSync(SENTINEL, { recursive: true, force: true });
});
