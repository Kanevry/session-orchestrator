/**
 * tests/lib/spiral-carryover.test.mjs
 *
 * Unit tests for scripts/lib/spiral-carryover.mjs (issue #261).
 *
 * Isolation strategy:
 *   - `node:child_process` is mocked at the module level via vi.mock.
 *   - Each test sets a per-call behavior on the mocked `execFileSync` so we
 *     simulate `glab`/`gh` stdout/stderr without ever shelling out.
 *   - IMPORTANT: if any test accidentally calls the real CLI, it could create
 *     a real GitLab issue. The mock is applied at import-time and never
 *     released, and every `execFileSync` call is routed through a per-test
 *     implementation set in beforeEach.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { readBudgetState } from '@lib/issue-budget.mjs';

// ---------------------------------------------------------------------------
// Mock node:child_process BEFORE importing the module under test.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => {
  return {
    execFileSync: vi.fn(() => {
      throw new Error(
        'spiral-carryover test: execFileSync was called without a per-test mock implementation. ' +
          'This would have shelled out to a real CLI (glab/gh) — failing fast to prevent side effects.',
      );
    }),
  };
});

// Import AFTER the mock is registered so the module picks up the mocked symbol.
const { execFileSync } = await import('node:child_process');
const {
  computeTaskHash,
  findExistingCarryover: findExistingCarryoverReal,
  findExistingBrokenWindow: findExistingBrokenWindowReal,
  createSpiralCarryoverIssue: createSpiralCarryoverIssueReal,
  createBrokenWindowIssue: createBrokenWindowIssueReal,
} = await import('@lib/spiral-carryover.mjs');

// ---------------------------------------------------------------------------
// #839 host-pinning shim
//
// Every exported creator/finder in spiral-carryover.mjs now resolves a
// `-R`/`--repo` spec via an injectable `resolveRepoSpecFn` (default: the real
// `resolveRepoSpec`, which shells out to `git remote -v`). The tests
// below this shim block predate #839 and assert an EXACT execFileSync call
// sequence for just the glab/gh calls — so these local wrappers inject a
// no-op resolver (`() => undefined`, matching pre-#839 "no -R appended"
// behaviour) as the DEFAULT, keeping every existing test's call sequence
// byte-for-byte identical without editing a single one of them. The
// "#839 host pinning" describe block at the end of this file calls the
// `*Real` functions directly to exercise the real behaviour.
//
// Live-ledger containment (#1058 follow-on)
//
// `repoRoot` defaults to `process.cwd()` in production, and under vitest that
// is THIS repository. 13 of the 14 creator call sites below pass no `repoRoot`,
// so every issue-create in this file charged the REAL
// `.orchestrator/runtime/issue-budget.json` — measured 2026-08-23 with
// `CLAUDE_PROJECT_DIR=$(mktemp -d) npx vitest run tests/lib/spiral-carryover.test.mjs`:
// `{"sessionId":"1c2e5507-…","count":0,"exempt":15}`, 15 bookings per run
// carrying the live session id. Same class as the session-6 incident where a
// test harness wrote 22 synthetic records into a live store.
//
// The containment is a DEFAULT in the shim, not 13 edits: it covers every
// existing call site and every future one, and `...opts` still lets a test
// name its own root (the budget-bridge test below does exactly that).
// ---------------------------------------------------------------------------
const SANDBOX_ROOT = mkdtempSync(path.join(tmpdir(), 'spiral-carryover-sandbox-'));

function findExistingCarryover(opts) {
  return findExistingCarryoverReal({
    resolveRepoSpecFn: () => undefined,
    repoRoot: SANDBOX_ROOT,
    ...opts,
  });
}
function findExistingBrokenWindow(opts) {
  return findExistingBrokenWindowReal({
    resolveRepoSpecFn: () => undefined,
    repoRoot: SANDBOX_ROOT,
    ...opts,
  });
}
function createSpiralCarryoverIssue(opts) {
  return createSpiralCarryoverIssueReal({
    resolveRepoSpecFn: () => undefined,
    repoRoot: SANDBOX_ROOT,
    ...opts,
  });
}
function createBrokenWindowIssue(opts) {
  return createBrokenWindowIssueReal({
    resolveRepoSpecFn: () => undefined,
    repoRoot: SANDBOX_ROOT,
    ...opts,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cliError(stderr = 'boom', stdout = '', status = 1) {
  const err = new Error(`Command failed: ${stderr}`);
  err.stderr = stderr;
  err.stdout = stdout;
  err.status = status;
  return err;
}

function setCliResponses(responses) {
  let i = 0;
  execFileSync.mockImplementation((cmd, args) => {
    const spec = typeof responses === 'function' ? responses(cmd, args, i++) : responses[i++];
    if (!spec) {
      throw new Error(
        `spiral-carryover test: unexpected extra execFileSync call #${i} (${cmd} ${(args || []).join(' ')})`,
      );
    }
    if (spec.ok === false) {
      throw cliError(spec.stderr ?? 'cli failure', spec.stdout ?? '', spec.status ?? 1);
    }
    return spec.stdout ?? '';
  });
}

beforeEach(() => {
  execFileSync.mockReset();
  execFileSync.mockImplementation(() => {
    throw new Error(
      'spiral-carryover test: execFileSync called but no per-test responses were configured',
    );
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. computeTaskHash
// ---------------------------------------------------------------------------

describe('computeTaskHash', () => {
  it('returns the same 8-char hex hash for identical input (stability)', () => {
    const a = computeTaskHash('implement carryover module');
    const b = computeTaskHash('implement carryover module');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
  });

  it('returns different hashes for different inputs (collision resistance)', () => {
    const a = computeTaskHash('fix bug in state-md parser');
    const b = computeTaskHash('add vault-backfill CLI');
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    expect(b).toMatch(/^[0-9a-f]{8}$/);
  });

  it('coerces null/undefined/empty to a stable 8-hex hash (of empty string)', () => {
    const empty = computeTaskHash('');
    const nullish = computeTaskHash(null);
    const undef = computeTaskHash(undefined);
    expect(empty).toMatch(/^[0-9a-f]{8}$/);
    expect(nullish).toBe(empty);
    expect(undef).toBe(empty);
  });
});

// ---------------------------------------------------------------------------
// 2. findExistingCarryover (gitlab)
// ---------------------------------------------------------------------------

describe('findExistingCarryover (gitlab)', () => {
  it('returns exists:true with issueId+url when a body contains the task-hash marker', async () => {
    const taskHash = 'abc12345';
    const fakeList = [
      {
        iid: 77,
        web_url: 'https://gitlab.example.com/grp/proj/-/issues/77',
        description: `## Carryover\n<!-- task-hash: ${taskHash} -->\nbody`,
      },
    ];
    setCliResponses([{ ok: true, stdout: JSON.stringify(fakeList) }]);

    const res = await findExistingCarryover({ taskHash, vcs: 'gitlab' });

    expect(res).toEqual({
      exists: true,
      issueId: 77,
      issueUrl: 'https://gitlab.example.com/grp/proj/-/issues/77',
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
    const [cmd, args] = execFileSync.mock.calls[0];
    expect(cmd).toBe('glab');
    expect(args).toContain('issue');
    expect(args).toContain('list');
    expect(args).toContain('type:carryover');
  });

  // Four former tests, one table: each differs only in what `glab` returns and
  // all four assert the same fail-open miss. A dedup lookup that THROWS on any
  // of these rows aborts the carryover write it was only meant to guard.
  it.each([
    { why: 'glab returns an empty array', response: { ok: true, stdout: '[]' } },
    {
      why: 'no issue body contains the marker',
      response: {
        ok: true,
        stdout: JSON.stringify([
          { iid: 1, web_url: 'u1', description: 'no marker here' },
          { iid: 2, web_url: 'u2', description: '<!-- task-hash: 99999999 -->' },
        ]),
      },
    },
    { why: 'the glab CLI errors', response: { ok: false, stderr: 'glab: not authenticated' } },
    { why: 'glab returns non-JSON stdout', response: { ok: true, stdout: '<<not json>>' } },
  ])('returns exists:false without throwing when $why', async ({ response }) => {
    setCliResponses([response]);
    const res = await findExistingCarryover({ taskHash: 'abc12345', vcs: 'gitlab' });
    expect(res).toEqual({ exists: false });
  });

  it('returns exists:false when taskHash is missing or invalid', async () => {
    const r1 = await findExistingCarryover({ vcs: 'gitlab' });
    const r2 = await findExistingCarryover({ taskHash: '', vcs: 'gitlab' });
    const r3 = await findExistingCarryover({ taskHash: 123, vcs: 'gitlab' });
    expect(r1).toEqual({ exists: false });
    expect(r2).toEqual({ exists: false });
    expect(r3).toEqual({ exists: false });
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. createSpiralCarryoverIssue
// ---------------------------------------------------------------------------

describe('createSpiralCarryoverIssue', () => {
  it('uses the bound semantic key from the native environment session id', async () => {
    const repoRoot = mkdtempSync(path.join(tmpdir(), 'spiral-carryover-budget-'));
    try {
      mkdirSync(path.join(repoRoot, '.orchestrator'), { recursive: true });
      writeFileSync(
        path.join(repoRoot, '.orchestrator', 'current-session.json'),
        JSON.stringify({
          session_id: 'native-spiral-raw',
          semantic_session_id: 'main-2026-08-20-deep-1',
        }),
        'utf8',
      );
      // CLAUDE_CODE_SESSION_ID is the name the harness actually exports; the
      // earlier CLAUDE_SESSION_ID stub was an unfaithful double that kept a
      // dead code path green (nothing sets that name in production).
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'native-spiral-raw');
      setCliResponses([
        { ok: true, stdout: '[]' },
        { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/42\n' },
      ]);

      await createSpiralCarryoverIssue({
        taskDescription: 'semantic budget bridge through spiral carryover',
        kind: 'SPIRAL',
        context: 'ctx',
        vcs: 'gitlab',
        // Names its own ledger root explicitly, overriding the shim's sandbox
        // default. This replaces a `CLAUDE_PROJECT_DIR` stub: since the ledger
        // root is now the caller's `repoRoot`, the argument IS the contract
        // under test — the env stub only worked while the module re-derived
        // the root from ambient state behind the caller's back.
        repoRoot,
      });

      expect(readBudgetState(repoRoot, 'main-2026-08-20-deep-1')).toMatchObject({
        sessionId: 'main-2026-08-20-deep-1',
        exempt: 1,
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('charges the caller\'s repoRoot ledger, never the ambient CLAUDE_PROJECT_DIR one (#1058)', async () => {
    // The bug: `runCli` derived the budget-ledger root from
    // `process.env.CLAUDE_PROJECT_DIR || process.cwd()` while the SAME call
    // resolved its `-R` host-pinning spec from the caller's `repoRoot`. One
    // call could therefore file an issue into repo A and charge repo B's
    // ledger — and under vitest "repo B" was this live repository, which is how
    // 15 synthetic bookings per test run reached the real
    // `.orchestrator/runtime/issue-budget.json` carrying the live session id.
    const named = mkdtempSync(path.join(tmpdir(), 'spiral-carryover-named-'));
    const ambient = mkdtempSync(path.join(tmpdir(), 'spiral-carryover-ambient-'));
    try {
      vi.stubEnv('CLAUDE_PROJECT_DIR', ambient);
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'ledger-binding-raw');
      setCliResponses([
        { ok: true, stdout: '[]' },
        { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/7\n' },
      ]);

      await createSpiralCarryoverIssue({
        taskDescription: 'ledger binding follows the named repoRoot',
        kind: 'SPIRAL',
        context: 'ctx',
        vcs: 'gitlab',
        repoRoot: named,
      });

      expect(readBudgetState(named, 'ledger-binding-raw')).toMatchObject({
        sessionId: 'ledger-binding-raw',
        exempt: 1,
      });
      // The ambient root must be untouched — no ledger was created there at
      // all. Asserting the RUNTIME DIRECTORY is absent, not one filename:
      // since #1141 the ledger is `runtime/issue-budget/<hash>.json`, so a
      // check pinned to the old flat name would now be vacuously true.
      expect(existsSync(path.join(ambient, '.orchestrator', 'runtime'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(named, { recursive: true, force: true });
      rmSync(ambient, { recursive: true, force: true });
    }
  });

  it('returns skipped:duplicate when a carryover already exists', async () => {
    const desc = 'retry flaky wave-executor path';
    const hash = computeTaskHash(desc);
    const fakeList = [
      {
        iid: 42,
        web_url: 'https://gitlab.example.com/g/p/-/issues/42',
        description: `body\n<!-- task-hash: ${hash} -->\nmore`,
      },
    ];
    setCliResponses([{ ok: true, stdout: JSON.stringify(fakeList) }]);

    const res = await createSpiralCarryoverIssue({
      taskDescription: desc,
      kind: 'SPIRAL',
      context: 'wave 2 spiraled twice',
      vcs: 'gitlab',
    });

    expect(res).toEqual({
      created: false,
      skipped: 'duplicate',
      issueId: 42,
      issueUrl: 'https://gitlab.example.com/g/p/-/issues/42',
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('creates a fresh gitlab issue and returns {created:true, issueId, issueUrl}', async () => {
    const desc = 'a medium-length task description that should become the title';
    const createdUrl = 'https://gitlab.example.com/foo/bar/-/issues/42';
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: `${createdUrl}\n` },
    ]);

    const res = await createSpiralCarryoverIssue({
      taskDescription: desc,
      kind: 'SPIRAL',
      context: 'wave 3 retry context',
      vcs: 'gitlab',
    });

    expect(res).toEqual({
      created: true,
      issueId: 42,
      issueUrl: createdUrl,
    });

    expect(execFileSync).toHaveBeenCalledTimes(2);
    const [createCmd, createArgs] = execFileSync.mock.calls[1];
    expect(createCmd).toBe('glab');
    expect(createArgs[0]).toBe('issue');
    expect(createArgs[1]).toBe('create');

    const titleIdx = createArgs.indexOf('--title');
    expect(titleIdx).toBeGreaterThan(-1);
    const title = createArgs[titleIdx + 1];
    expect(title).toContain('[Carryover]');
    expect(title).toContain('[SPIRAL]');

    const labelIdx = createArgs.indexOf('--label');
    expect(labelIdx).toBeGreaterThan(-1);
    const labels = createArgs[labelIdx + 1];
    expect(labels).toContain('type:carryover');
    expect(labels).toContain('priority::high');
    expect(labels).toContain('status:ready');

    const descIdx = createArgs.indexOf('--description');
    expect(descIdx).toBeGreaterThan(-1);
    const body = createArgs[descIdx + 1];
    const expectedHash = computeTaskHash(desc);
    expect(body).toContain(`<!-- task-hash: ${expectedHash} -->`);
  });

  it('returns skipped:error when the CLI create invocation fails (does not throw)', async () => {
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: false, stderr: 'glab: rate limited' },
    ]);

    const res = await createSpiralCarryoverIssue({
      taskDescription: 'something',
      kind: 'FAILED',
      context: 'ctx',
      vcs: 'gitlab',
    });

    expect(res.created).toBe(false);
    expect(res.skipped).toBe('error');
    expect(typeof res.error).toBe('string');
    expect(res.error).toContain('rate limited');
  });

  it('truncates long task descriptions when building the issue title', async () => {
    const longDesc = 'x'.repeat(200);
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/1\n' },
    ]);

    await createSpiralCarryoverIssue({
      taskDescription: longDesc,
      kind: 'SPIRAL',
      context: '',
      vcs: 'gitlab',
    });

    const [, createArgs] = execFileSync.mock.calls[1];
    const titleIdx = createArgs.indexOf('--title');
    const title = createArgs[titleIdx + 1];
    // Prefix '[Carryover] [SPIRAL] ' is 21 chars + truncated ≤80 chars = ≤101.
    expect(title.length).toBeLessThanOrEqual(101);
    expect(title).not.toContain('x'.repeat(100));
    expect(title.startsWith('[Carryover] [SPIRAL] ')).toBe(true);
  });

  it('routes to gh (not glab) when vcs is github', async () => {
    const createdUrl = 'https://github.com/org/repo/issues/7';
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: `${createdUrl}\n` },
    ]);

    const res = await createSpiralCarryoverIssue({
      taskDescription: 'gh path task',
      kind: 'FAILED',
      context: 'gh ctx',
      vcs: 'github',
    });

    expect(res.created).toBe(true);
    expect(res.issueId).toBe(7);
    expect(res.issueUrl).toBe(createdUrl);
    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execFileSync.mock.calls[0][0]).toBe('gh');
    expect(execFileSync.mock.calls[1][0]).toBe('gh');
    const createArgs = execFileSync.mock.calls[1][1];
    expect(createArgs).toContain('--body');
    expect(createArgs).not.toContain('--description');
  });

  it('returns skipped:error for an invalid kind (does not shell out)', async () => {
    const res = await createSpiralCarryoverIssue({
      taskDescription: 'x',
      kind: 'BOGUS',
      context: '',
      vcs: 'gitlab',
    });
    expect(res.created).toBe(false);
    expect(res.skipped).toBe('error');
    expect(res.error).toContain('invalid kind');
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. findExistingBrokenWindow — greps the `broken-window` label
// ---------------------------------------------------------------------------

describe('findExistingBrokenWindow (gitlab)', () => {
  it('lists issues with the broken-window label and matches the task-hash marker', async () => {
    const taskHash = 'cafe1234';
    const fakeList = [
      {
        iid: 91,
        web_url: 'https://gitlab.example.com/g/p/-/issues/91',
        description: `## [Broken-Window]\n<!-- task-hash: ${taskHash} -->\nbody`,
      },
    ];
    setCliResponses([{ ok: true, stdout: JSON.stringify(fakeList) }]);

    const res = await findExistingBrokenWindow({ taskHash, vcs: 'gitlab' });

    expect(res).toEqual({
      exists: true,
      issueId: 91,
      issueUrl: 'https://gitlab.example.com/g/p/-/issues/91',
    });
    const [cmd, args] = execFileSync.mock.calls[0];
    expect(cmd).toBe('glab');
    expect(args).toContain('broken-window');
    expect(args).not.toContain('type:carryover');
  });
});

// ---------------------------------------------------------------------------
// 4b. github dedup-hit branch (W4-Q3 GAP-1) — the `gh issue list --json`
//     hit-extraction path (number/url/body) is the idempotency guarantee on
//     GitHub repos; a wrong field name would silently file duplicates.
// ---------------------------------------------------------------------------

describe('findExisting* (github dedup-hit — GAP-1)', () => {
  it('findExistingCarryover extracts number/url from a gh list hit whose body carries the marker', async () => {
    const taskHash = 'abc12345';
    const fakeList = [
      { number: 12, url: 'https://github.com/org/repo/issues/12', body: 'no marker' },
      {
        number: 34,
        url: 'https://github.com/org/repo/issues/34',
        body: `## Carryover\n<!-- task-hash: ${taskHash} -->\nbody`,
      },
    ];
    setCliResponses([{ ok: true, stdout: JSON.stringify(fakeList) }]);

    const res = await findExistingCarryover({ taskHash, vcs: 'github' });

    expect(res).toEqual({
      exists: true,
      issueId: 34,
      issueUrl: 'https://github.com/org/repo/issues/34',
    });
    const [cmd, args] = execFileSync.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toContain('number,url,body');
  });

  it('findExistingBrokenWindow extracts number/url from a gh list hit', async () => {
    const taskHash = 'cafe1234';
    const fakeList = [
      {
        number: 91,
        url: 'https://github.com/org/repo/issues/91',
        body: `## [Broken-Window]\n<!-- task-hash: ${taskHash} -->\nbody`,
      },
    ];
    setCliResponses([{ ok: true, stdout: JSON.stringify(fakeList) }]);

    const res = await findExistingBrokenWindow({ taskHash, vcs: 'github' });

    expect(res).toEqual({
      exists: true,
      issueId: 91,
      issueUrl: 'https://github.com/org/repo/issues/91',
    });
    const [cmd, args] = execFileSync.mock.calls[0];
    expect(cmd).toBe('gh');
    expect(args).toContain('broken-window');
  });

  it('gitlab id-fallback: uses hit.id when iid is absent (GAP-3)', async () => {
    const taskHash = 'beef7777';
    const fakeList = [
      { id: 5, web_url: 'https://gitlab.example.com/g/p/-/issues/5', description: `<!-- task-hash: ${taskHash} -->` },
    ];
    setCliResponses([{ ok: true, stdout: JSON.stringify(fakeList) }]);

    const res = await findExistingCarryover({ taskHash, vcs: 'gitlab' });

    expect(res).toEqual({
      exists: true,
      issueId: 5,
      issueUrl: 'https://gitlab.example.com/g/p/-/issues/5',
    });
  });
});

// ---------------------------------------------------------------------------
// 5. createBrokenWindowIssue (#730/H5)
// ---------------------------------------------------------------------------

describe('createBrokenWindowIssue', () => {
  // Deterministic clock so the computed due-date is a hardcoded literal.
  // 2026-07-10 + 7 days (default) = 2026-07-17.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates a gitlab issue with the [Broken-Window] title, labels, and native --due-date', async () => {
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/50\n' },
    ]);

    const res = await createBrokenWindowIssue({
      item: {
        title: 'echo-stub shipped in Phase 2.0a',
        source: 'phase-2.0a-stub',
        description: 'Stubbed migration guard shipped under enforcement: warn.',
        sessionId: 'main-2026-07-10-deep-1',
      },
      vcs: 'gitlab',
    });

    expect(res).toEqual({
      created: true,
      issueId: 50,
      issueUrl: 'https://gitlab.example.com/g/p/-/issues/50',
      due: '2026-07-17',
    });

    expect(execFileSync).toHaveBeenCalledTimes(2);
    const [createCmd, createArgs] = execFileSync.mock.calls[1];
    expect(createCmd).toBe('glab');
    expect(createArgs[0]).toBe('issue');
    expect(createArgs[1]).toBe('create');

    const title = createArgs[createArgs.indexOf('--title') + 1];
    expect(title).toBe('[Broken-Window] echo-stub shipped in Phase 2.0a');

    const labels = createArgs[createArgs.indexOf('--label') + 1];
    expect(labels).toContain('broken-window');
    expect(labels).toContain('priority::high');

    const dueIdx = createArgs.indexOf('--due-date');
    expect(dueIdx).toBeGreaterThan(-1);
    expect(createArgs[dueIdx + 1]).toBe('2026-07-17');

    // Body carries the dedup marker and the source.
    const body = createArgs[createArgs.indexOf('--description') + 1];
    const expectedHash = computeTaskHash('phase-2.0a-stub::echo-stub shipped in Phase 2.0a');
    expect(body).toContain(`<!-- task-hash: ${expectedHash} -->`);
    expect(body).toContain('phase-2.0a-stub');
  });

  it('honours a custom due-days (14) in the gitlab --due-date flag', async () => {
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/51\n' },
    ]);

    const res = await createBrokenWindowIssue({
      item: { title: 'overridden reviewer finding', source: 'wave-override' },
      dueDays: 14,
      vcs: 'gitlab',
    });

    expect(res.due).toBe('2026-07-24');
    const createArgs = execFileSync.mock.calls[1][1];
    const dueIdx = createArgs.indexOf('--due-date');
    expect(createArgs[dueIdx + 1]).toBe('2026-07-24');
  });

  it('routes to gh with no --due-date flag and a "Due:" first body line (github fallback)', async () => {
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://github.com/org/repo/issues/8\n' },
    ]);

    const res = await createBrokenWindowIssue({
      item: { title: 'WARN-lint shipped', source: 'lint-warn', sessionId: 's1' },
      vcs: 'github',
    });

    expect(res.created).toBe(true);
    expect(res.issueId).toBe(8);
    expect(res.due).toBe('2026-07-17');

    const [createCmd, createArgs] = execFileSync.mock.calls[1];
    expect(createCmd).toBe('gh');
    expect(createArgs).toContain('--body');
    expect(createArgs).not.toContain('--description');
    expect(createArgs).not.toContain('--due-date');

    const body = createArgs[createArgs.indexOf('--body') + 1];
    expect(body.split('\n')[0]).toBe('Due: 2026-07-17');
  });

  it('returns skipped:duplicate on a re-run (idempotent per task-hash) without a second create', async () => {
    const item = { title: 'dup broken window', source: 'override-2.3' };
    const hash = computeTaskHash('override-2.3::dup broken window');
    const fakeList = [
      {
        iid: 60,
        web_url: 'https://gitlab.example.com/g/p/-/issues/60',
        description: `body\n<!-- task-hash: ${hash} -->\nmore`,
      },
    ];
    setCliResponses([{ ok: true, stdout: JSON.stringify(fakeList) }]);

    const res = await createBrokenWindowIssue({ item, vcs: 'gitlab' });

    expect(res).toEqual({
      created: false,
      skipped: 'duplicate',
      issueId: 60,
      issueUrl: 'https://gitlab.example.com/g/p/-/issues/60',
    });
    expect(execFileSync).toHaveBeenCalledTimes(1);
  });

  it('fails open (skipped:error, does not throw) when the create CLI invocation fails', async () => {
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: false, stderr: 'glab: rate limited' },
    ]);

    const res = await createBrokenWindowIssue({
      item: { title: 'flaky broken window', source: 'override-2.5' },
      vcs: 'gitlab',
    });

    expect(res.created).toBe(false);
    expect(res.skipped).toBe('error');
    expect(res.error).toContain('rate limited');
  });

  it('returns skipped:error when item.title is missing (does not shell out)', async () => {
    const res = await createBrokenWindowIssue({
      item: { source: 'unresolved-1.8' },
      vcs: 'gitlab',
    });
    expect(res.created).toBe(false);
    expect(res.skipped).toBe('error');
    expect(res.error).toContain('missing item.title');
    expect(execFileSync).not.toHaveBeenCalled();
  });

  // #794 GAP-4: the config-parsing path (`_parseBrokenWindow`) now rejects
  // due-days above MAX_DUE_DAYS before it ever reaches this module — but
  // `createBrokenWindowIssue` accepts `dueDays` directly as a call argument,
  // a path the MAX-boundary guard does NOT cover (it lives only in the parser).
  // `computeDueDate` overflows `Date#setUTCDate` for a wildly out-of-range
  // value, and `.toISOString()` throws a RangeError — caught by the outer
  // try/catch here and surfaced as a fail-open `skipped:'error'`, never a crash.
  it('fails open (skipped:error) for a wildly out-of-range dueDays passed directly (#794 GAP-4)', async () => {
    const res = await createBrokenWindowIssue({
      item: { title: 'direct-API dueDays overflow', source: 'gap-4-direct' },
      dueDays: 999999999,
      vcs: 'gitlab',
    });
    expect(res.created).toBe(false);
    expect(res.skipped).toBe('error');
    expect(typeof res.error).toBe('string');
    // Fails before the dedup lookup ever shells out (computeDueDate throws first).
    expect(execFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// #839 — host pinning: -R/--repo on both the dedup lookup AND the write
// (`issue create`) call. Uses the `*Real` functions directly (bypassing the
// no-op shim above) with an explicit resolveRepoSpecFn.
// ---------------------------------------------------------------------------

describe('createSpiralCarryoverIssue — #839 host pinning (gitlab)', () => {
  it('pins both the dedup `glab issue list` call and the `glab issue create` call to -R <spec>', async () => {
    const spec = 'https://gitlab.example.com/group/session-orchestrator.git';
    setCliResponses([
      { ok: true, stdout: '[]' }, // glab issue list (dedup — no hit)
      { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/70\n' }, // glab issue create
    ]);

    const res = await createSpiralCarryoverIssueReal({
      repoRoot: SANDBOX_ROOT,   // #1058: never charge the live issue-budget ledger
      taskDescription: 'host-pinned carryover',
      kind: 'SPIRAL',
      context: 'ctx',
      vcs: 'gitlab',
      resolveRepoSpecFn: () => spec,
    });

    expect(res.created).toBe(true);
    expect(res.issueId).toBe(70);

    const [listCmd, listArgs] = execFileSync.mock.calls[0];
    expect(listCmd).toBe('glab');
    expect(listArgs).toEqual(['issue', 'list', '--label', 'type:carryover', '--per-page', '100', '--output', 'json', '-R', spec]);

    const [createCmd, createArgs] = execFileSync.mock.calls[1];
    expect(createCmd).toBe('glab');
    expect(createArgs).toContain('-R');
    expect(createArgs[createArgs.indexOf('-R') + 1]).toBe(spec);
  });

  it('resolves the -R spec exactly ONCE per call, reusing it for the dedup lookup (no second git spawn)', async () => {
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/71\n' },
    ]);
    const spy = vi.fn(() => 'https://gitlab.example.com/group/session-orchestrator.git');

    await createSpiralCarryoverIssueReal({
      repoRoot: SANDBOX_ROOT,   // #1058: never charge the live issue-budget ledger
      taskDescription: 'resolve-once check',
      kind: 'SPIRAL',
      context: 'ctx',
      vcs: 'gitlab',
      resolveRepoSpecFn: spy,
    });

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('appends no -R at all when resolveRepoSpecFn returns undefined (graceful degradation)', async () => {
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/72\n' },
    ]);

    await createSpiralCarryoverIssueReal({
      repoRoot: SANDBOX_ROOT,   // #1058: never charge the live issue-budget ledger
      taskDescription: 'no remote resolves',
      kind: 'SPIRAL',
      context: 'ctx',
      vcs: 'gitlab',
      resolveRepoSpecFn: () => undefined,
    });

    expect(execFileSync).toHaveBeenCalledTimes(2);
    expect(execFileSync.mock.calls[0][1]).not.toContain('-R');
    expect(execFileSync.mock.calls[1][1]).not.toContain('-R');
  });
});

describe('createSpiralCarryoverIssue — #839 host pinning (github)', () => {
  it('pins both the dedup `gh issue list` call and the `gh issue create` call to -R <spec>', async () => {
    const spec = 'https://github.com/org/repo.git';
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://github.com/org/repo/issues/9\n' },
    ]);

    const res = await createSpiralCarryoverIssueReal({
      repoRoot: SANDBOX_ROOT,   // #1058: never charge the live issue-budget ledger
      taskDescription: 'gh host-pinned carryover',
      kind: 'FAILED',
      context: 'ctx',
      vcs: 'github',
      resolveRepoSpecFn: () => spec,
    });

    expect(res.created).toBe(true);
    expect(res.issueId).toBe(9);

    const [listCmd, listArgs] = execFileSync.mock.calls[0];
    expect(listCmd).toBe('gh');
    expect(listArgs).toContain('-R');
    expect(listArgs[listArgs.indexOf('-R') + 1]).toBe(spec);

    const [createCmd, createArgs] = execFileSync.mock.calls[1];
    expect(createCmd).toBe('gh');
    expect(createArgs).toContain('-R');
    expect(createArgs[createArgs.indexOf('-R') + 1]).toBe(spec);
  });
});

describe('createBrokenWindowIssue — #839 host pinning (gitlab)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T00:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins both the dedup `glab issue list` call and the `glab issue create` call to -R <spec>, keeping --due-date', async () => {
    const spec = 'https://gitlab.example.com/group/session-orchestrator.git';
    setCliResponses([
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/52\n' },
    ]);

    const res = await createBrokenWindowIssueReal({
      repoRoot: SANDBOX_ROOT,   // #1058: never charge the live issue-budget ledger
      item: { title: 'host-pinned broken window', source: 'gap-839' },
      vcs: 'gitlab',
      resolveRepoSpecFn: () => spec,
    });

    expect(res.created).toBe(true);
    expect(res.due).toBe('2026-07-17');

    const [listCmd, listArgs] = execFileSync.mock.calls[0];
    expect(listCmd).toBe('glab');
    expect(listArgs).toContain('-R');
    expect(listArgs[listArgs.indexOf('-R') + 1]).toBe(spec);

    const [createCmd, createArgs] = execFileSync.mock.calls[1];
    expect(createCmd).toBe('glab');
    expect(createArgs).toContain('--due-date');
    expect(createArgs[createArgs.indexOf('--due-date') + 1]).toBe('2026-07-17');
    expect(createArgs).toContain('-R');
    expect(createArgs[createArgs.indexOf('-R') + 1]).toBe(spec);
  });
});

// ---------------------------------------------------------------------------
// Gap 3 (QA follow-up) — every *Real(...) call above injects an explicit
// resolveRepoSpecFn stub, so a mis-wired production DEFAULT (e.g. the wrong
// import, or a default that silently swallows its own vcs argument) would
// pass every test in this file without detection. Mirrors the pattern in
// tests/lib/issue-close-strip-labels.test.mjs's "#839 wrong-host regression"
// block: call the *Real function with resolveRepoSpecFn OMITTED so the
// production default (`resolveRepoSpec`, imported at module top) runs for
// real — through to the mocked `execFileSync('git', ...)` call.
// ---------------------------------------------------------------------------

describe('createSpiralCarryoverIssue — default resolveRepoSpecFn wires the REAL module (Gap 3)', () => {
  it('derives the -R spec through the real resolveRepoSpec → git remote -v chain when resolveRepoSpecFn is omitted', async () => {
    const remoteUrl = 'https://gitlab.example.com/example-group/example-project.git';
    // A second remote with a DIFFERENT URL keeps the "queries the GITLAB
    // remote" half of this test alive: since #1039 the resolver runs ONE
    // `git remote -v` and names no remote in its argv, so the preference order
    // is now only observable in the resolved value — `origin` must lose.
    const originUrl = 'https://gitlab.example.com/example-group/origin-must-lose.git';
    const createdUrl = 'https://gitlab.example.com/example-group/example-project/-/issues/99';
    setCliResponses([
      {
        ok: true,
        // `git remote -v` stdout shape: `<name>\t<url> (fetch|push)`.
        stdout:
          `gitlab\t${remoteUrl} (fetch)\ngitlab\t${remoteUrl} (push)\n` +
          `origin\t${originUrl} (fetch)\norigin\t${originUrl} (push)\n`,
      },
      { ok: true, stdout: '[]' },
      { ok: true, stdout: `${createdUrl}\n` },
    ]);

    const res = await createSpiralCarryoverIssueReal({
      repoRoot: SANDBOX_ROOT,   // #1058: never charge the live issue-budget ledger
      taskDescription: 'gap-3 default-resolver task',
      kind: 'SPIRAL',
      context: 'ctx',
      vcs: 'gitlab',
      // resolveRepoSpecFn intentionally OMITTED — exercises the production default.
    });

    expect(res).toEqual({ created: true, issueId: 99, issueUrl: createdUrl });

    // The real chain actually shelled out to `git remote -v` — proof the
    // default parameter is wired to the real module, not a no-op. The exact
    // argv still pins the repo root the probe runs against; the remote NAME
    // left this argv with #1039 and is pinned below instead, on the `-R` value
    // the two glab calls carry.
    //
    // This expectation was `process.cwd()` while the call above passed no
    // `repoRoot` — the DEFAULT happened to be cwd, so the assertion could not
    // tell "follows the caller's repoRoot" from "happens to equal cwd". Naming
    // the root explicitly (#1058) makes it discriminate.
    const gitCalls = execFileSync.mock.calls.filter(([cmd]) => cmd === 'git');
    expect(gitCalls).toHaveLength(1);
    expect(gitCalls[0][1]).toEqual(['-C', SANDBOX_ROOT, 'remote', '-v']);

    // Both the dedup `glab issue list` call and the `glab issue create` call
    // carry the -R spec resolved through that real chain.
    const [listCmd, listArgs] = execFileSync.mock.calls.find(([cmd, args]) => cmd === 'glab' && args.includes('list'));
    expect(listCmd).toBe('glab');
    expect(listArgs).toContain('-R');
    expect(listArgs[listArgs.indexOf('-R') + 1]).toBe(remoteUrl);

    const [createCmd, createArgs] = execFileSync.mock.calls.find(([cmd, args]) => cmd === 'glab' && args.includes('create'));
    expect(createCmd).toBe('glab');
    expect(createArgs).toContain('-R');
    expect(createArgs[createArgs.indexOf('-R') + 1]).toBe(remoteUrl);
  });

  it('appends no -R at all when the real chain finds no matching remote (graceful degradation, default resolver)', async () => {
    setCliResponses([
      {
        ok: true,
        // TWO remotes, neither of them in the gitlab preference order
        // (`gitlab`, `origin`) — the shape that actually produces the
        // `no-matching-remote` state this test's name claims. A single
        // odd-named remote would be resolved by the sole-remote fallback; a
        // git-level throw would be the query-FAILURE branch instead (covered
        // by tests/lib/issue-close-strip-labels.test.mjs's "fails entirely").
        stdout:
          'fork\thttps://gitlab.example.com/example-group/fork.git (fetch)\n' +
          'upstream\thttps://gitlab.example.com/other-group/upstream.git (fetch)\n',
      },
      { ok: true, stdout: '[]' },
      { ok: true, stdout: 'https://gitlab.example.com/example-group/example-project/-/issues/100\n' },
    ]);

    await createSpiralCarryoverIssueReal({
      repoRoot: SANDBOX_ROOT,   // #1058: never charge the live issue-budget ledger
      taskDescription: 'gap-3 no-remote task',
      kind: 'SPIRAL',
      context: 'ctx',
      vcs: 'gitlab',
    });

    const glabCalls = execFileSync.mock.calls.filter(([cmd]) => cmd === 'glab');
    expect(glabCalls).toHaveLength(2);
    expect(glabCalls[0][1]).not.toContain('-R');
    expect(glabCalls[1][1]).not.toContain('-R');
  });
});

// ---------------------------------------------------------------------------
// #1105 — structural VITEST guard: repoRoot-less issue-create must not charge
// the ambient working-copy issue-budget ledger. Uses a synthetic mkdtemp
// fixture as the only ledger root that may be written.
// ---------------------------------------------------------------------------

describe('createSpiralCarryoverIssue — VITEST ambient-ledger guard (#1105)', () => {
  it('refuses repoRoot-less issue-create under VITEST and charges only an explicit synthetic repoRoot', async () => {
    const sandbox = mkdtempSync(path.join(tmpdir(), 'spiral-carryover-guard-'));
    const decoy = mkdtempSync(path.join(tmpdir(), 'spiral-carryover-guard-decoy-'));
    try {
      vi.stubEnv('CLAUDE_CODE_SESSION_ID', 'vitest-guard-raw');
      setCliResponses([
        { ok: true, stdout: '[]' },
        { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/88\n' },
      ]);

      const refused = await createSpiralCarryoverIssueReal({
        taskDescription: 'repoRoot-less must not charge ambient ledger',
        kind: 'SPIRAL',
        context: 'ctx',
        vcs: 'gitlab',
        resolveRepoSpecFn: () => undefined,
      });

      expect(refused).toEqual({
        created: false,
        skipped: 'error',
        error:
          'spiral-carryover: refusing to charge the issue-budget ledger at the ambient ' +
          'repo root under VITEST — pass an explicit synthetic repoRoot',
      });
      const createCalls = execFileSync.mock.calls.filter(
        ([, args]) => args[0] === 'issue' && (args[1] === 'create' || args[1] === 'new'),
      );
      expect(createCalls).toHaveLength(0);
      expect(existsSync(path.join(sandbox, '.orchestrator', 'runtime'))).toBe(false);
      expect(existsSync(path.join(decoy, '.orchestrator', 'runtime'))).toBe(false);

      execFileSync.mockClear();
      setCliResponses([
        { ok: true, stdout: '[]' },
        { ok: true, stdout: 'https://gitlab.example.com/g/p/-/issues/89\n' },
      ]);

      const allowed = await createSpiralCarryoverIssueReal({
        repoRoot: sandbox,
        taskDescription: 'explicit synthetic repoRoot is charged here only',
        kind: 'SPIRAL',
        context: 'ctx',
        vcs: 'gitlab',
        resolveRepoSpecFn: () => undefined,
      });

      expect(allowed.created).toBe(true);
      expect(readBudgetState(sandbox, 'vitest-guard-raw')).toMatchObject({
        sessionId: 'vitest-guard-raw',
        exempt: 1,
      });
      expect(existsSync(path.join(decoy, '.orchestrator', 'runtime'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      rmSync(sandbox, { recursive: true, force: true });
      rmSync(decoy, { recursive: true, force: true });
    }
  });
});

describe('findExistingCarryover / findExistingBrokenWindow — #839 host pinning', () => {
  it('findExistingCarryover appends -R <spec> to the glab issue list call', async () => {
    const spec = 'https://gitlab.example.com/group/session-orchestrator.git';
    setCliResponses([{ ok: true, stdout: '[]' }]);

    await findExistingCarryoverReal({ taskHash: 'abc12345', vcs: 'gitlab', resolveRepoSpecFn: () => spec });

    const [, args] = execFileSync.mock.calls[0];
    expect(args).toContain('-R');
    expect(args[args.indexOf('-R') + 1]).toBe(spec);
  });

  it('findExistingBrokenWindow appends no -R when resolveRepoSpecFn returns undefined (graceful degradation)', async () => {
    setCliResponses([{ ok: true, stdout: '[]' }]);

    await findExistingBrokenWindowReal({ taskHash: 'cafe1234', vcs: 'gitlab', resolveRepoSpecFn: () => undefined });

    const [, args] = execFileSync.mock.calls[0];
    expect(args).not.toContain('-R');
  });
});
