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
  findExistingCarryover,
  findExistingBrokenWindow,
  createSpiralCarryoverIssue,
  createBrokenWindowIssue,
} = await import('@lib/spiral-carryover.mjs');

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

  it('output format is always exactly 8 lowercase hex chars', () => {
    const inputs = ['a', 'hello world', 'x'.repeat(500), 'japanese-task-name', '{"json": true}'];
    for (const s of inputs) {
      const h = computeTaskHash(s);
      expect(h).toMatch(/^[0-9a-f]{8}$/);
      expect(h).toHaveLength(8);
    }
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

  it('returns exists:false when glab returns an empty array', async () => {
    setCliResponses([{ ok: true, stdout: '[]' }]);
    const res = await findExistingCarryover({ taskHash: 'deadbeef', vcs: 'gitlab' });
    expect(res).toEqual({ exists: false });
  });

  it('returns exists:false when no issue body contains the marker', async () => {
    const fakeList = [
      { iid: 1, web_url: 'u1', description: 'no marker here' },
      { iid: 2, web_url: 'u2', description: '<!-- task-hash: 99999999 -->' },
    ];
    setCliResponses([{ ok: true, stdout: JSON.stringify(fakeList) }]);
    const res = await findExistingCarryover({ taskHash: 'abc12345', vcs: 'gitlab' });
    expect(res).toEqual({ exists: false });
  });

  it('fails open (returns exists:false, does not throw) when glab CLI errors', async () => {
    setCliResponses([{ ok: false, stderr: 'glab: not authenticated' }]);
    const res = await findExistingCarryover({ taskHash: 'abc12345', vcs: 'gitlab' });
    expect(res).toEqual({ exists: false });
  });

  it('fails open when glab returns non-JSON stdout', async () => {
    setCliResponses([{ ok: true, stdout: '<<not json>>' }]);
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
    expect(labels).toContain('priority:high');
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
    expect(labels).toContain('priority:high');

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
});
