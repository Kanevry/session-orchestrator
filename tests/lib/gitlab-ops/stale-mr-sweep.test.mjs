/**
 * tests/lib/gitlab-ops/stale-mr-sweep.test.mjs
 *
 * Unit tests for scripts/lib/gitlab-ops/stale-mr-sweep.mjs.
 * All exec calls use vi.fn() mocks — zero real glab/gh subprocess invocations.
 *
 * Coverage:
 *   - filterStaleMRs: none/some/boundary/field-mode/empty/missing-date cases
 *   - findStaleMRs: glab + gh happy paths, vcs resolution (explicit/detected/
 *     default/unresolvable), malformed-JSON + exec-throw graceful handling
 *   - findStaleMRsMultiRepo: fan-out across vault-registered repos
 *   - main(): --help, bad-flag rejection, happy path, system-error exit code
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  DEFAULT_THRESHOLD_DAYS,
  filterStaleMRs,
  findStaleMRs,
  findStaleMRsMultiRepo,
  main,
} from '@lib/gitlab-ops/stale-mr-sweep.mjs';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

// Fixed reference "now" so age math is deterministic across runs.
const FIXED_NOW = Date.parse('2026-07-05T12:00:00.000Z');

const GITLAB_MRS_JSON = JSON.stringify([
  {
    iid: 101,
    title: 'Old MR',
    updated_at: '2026-06-01T12:00:00.000Z', // 34 days before FIXED_NOW
    created_at: '2026-06-01T12:00:00.000Z',
    web_url: 'https://gitlab.example.com/-/mr/101',
  },
  {
    iid: 102,
    title: 'Fresh MR',
    updated_at: '2026-07-01T12:00:00.000Z', // 4 days before FIXED_NOW
    created_at: '2026-07-01T12:00:00.000Z',
    web_url: 'https://gitlab.example.com/-/mr/102',
  },
]);

const GITHUB_PRS_JSON = JSON.stringify([
  {
    number: 55,
    title: 'Stale PR',
    url: 'https://github.com/org/repo/pull/55',
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-15T00:00:00.000Z', // ~51 days before FIXED_NOW
    author: { login: 'alice' },
    headRefName: 'feat/old',
  },
  {
    number: 56,
    title: 'Recent PR',
    url: 'https://github.com/org/repo/pull/56',
    createdAt: '2026-07-03T00:00:00.000Z',
    updatedAt: '2026-07-04T12:00:00.000Z', // 1 day before FIXED_NOW
    author: { login: 'bob' },
    headRefName: 'feat/new',
  },
]);

// ---------------------------------------------------------------------------
// filterStaleMRs — pure core
// ---------------------------------------------------------------------------

describe('filterStaleMRs', () => {
  it('returns an empty array for an empty input array', () => {
    expect(filterStaleMRs([], { thresholdDays: 14, now: FIXED_NOW })).toEqual([]);
  });

  it('returns [] when no MR exceeds the threshold (none stale)', () => {
    const mrs = [
      { iid: 1, updated_at: '2026-07-04T12:00:00.000Z' }, // 1 day old
      { iid: 2, updated_at: '2026-07-01T12:00:00.000Z' }, // 4 days old
    ];
    expect(filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW })).toEqual([]);
  });

  it('returns exactly the stale subset when some MRs exceed the threshold', () => {
    const mrs = [
      { iid: 1, updated_at: '2026-06-01T12:00:00.000Z' }, // 34 days old — stale
      { iid: 2, updated_at: '2026-07-01T12:00:00.000Z' }, // 4 days old — fresh
      { iid: 3, updated_at: '2026-05-01T12:00:00.000Z' }, // 65 days old — stale
    ];
    const result = filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW });
    expect(result.map((m) => m.iid)).toEqual([1, 3]);
  });

  // Boundary: an MR aged EXACTLY `thresholdDays` is NOT stale (exclusive —
  // age > thresholdMs, not >=). Mirrors aggregator.mjs's summarizeRepo.
  it('does NOT flag an MR exactly 14 days old as stale (inclusive-lower-bound-excluded)', () => {
    const mrs = [{ iid: 1, updated_at: '2026-06-21T12:00:00.000Z' }]; // exactly 14 days before FIXED_NOW
    expect(filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW })).toEqual([]);
  });

  it('DOES flag an MR one second past the 14-day threshold as stale', () => {
    const mrs = [{ iid: 1, updated_at: '2026-06-21T11:59:59.000Z' }]; // 14 days + 1s before FIXED_NOW
    const result = filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW });
    expect(result.map((m) => m.iid)).toEqual([1]);
  });

  it("field: 'created' flags an MR stale by its created_at even when recently updated", () => {
    const mrs = [
      {
        iid: 1,
        created_at: '2026-06-01T12:00:00.000Z', // 34 days old
        updated_at: '2026-07-01T12:00:00.000Z', // 4 days old
      },
    ];
    const result = filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW, field: 'created' });
    expect(result.map((m) => m.iid)).toEqual([1]);
  });

  it("field: 'updated' does NOT flag the same MR (recently updated) as stale", () => {
    const mrs = [
      {
        iid: 1,
        created_at: '2026-06-01T12:00:00.000Z', // 34 days old
        updated_at: '2026-07-01T12:00:00.000Z', // 4 days old
      },
    ];
    const result = filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW, field: 'updated' });
    expect(result).toEqual([]);
  });

  it('supports the camelCase date-field shape (createdAt/updatedAt) via ?? fallback', () => {
    const mrs = [{ number: 9, updatedAt: '2026-06-01T12:00:00.000Z' }]; // 34 days old
    const result = filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW });
    expect(result.map((m) => m.number)).toEqual([9]);
  });

  it('does not throw and excludes an item with no usable date field', () => {
    const mrs = [{ iid: 1, title: 'no dates here' }];
    expect(() => filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW })).not.toThrow();
    expect(filterStaleMRs(mrs, { thresholdDays: 14, now: FIXED_NOW })).toEqual([]);
  });

  it('returns [] for non-array input (defensive)', () => {
    expect(filterStaleMRs(null, { thresholdDays: 14, now: FIXED_NOW })).toEqual([]);
  });

  it('uses DEFAULT_THRESHOLD_DAYS (14) when thresholdDays is not provided', () => {
    expect(DEFAULT_THRESHOLD_DAYS).toBe(14);
    const mrs = [{ iid: 1, updated_at: '2026-06-01T12:00:00.000Z' }]; // 34 days old
    const result = filterStaleMRs(mrs, { now: FIXED_NOW });
    expect(result.map((m) => m.iid)).toEqual([1]);
  });
});

// ---------------------------------------------------------------------------
// findStaleMRs — glab happy path
// ---------------------------------------------------------------------------

describe('findStaleMRs — glab', () => {
  it('returns the exact stale subset when vcs is explicit gitlab', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: GITLAB_MRS_JSON, stderr: '' });
    const result = await findStaleMRs({
      vcs: 'gitlab',
      thresholdDays: 14,
      now: FIXED_NOW,
      exec: mockExec,
    });
    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.stale.map((m) => m.iid)).toEqual([101]);
  });

  it('calls exec with the expected glab mr list command and shell:false', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await findStaleMRs({ vcs: 'gitlab', exec: mockExec, now: FIXED_NOW });
    expect(mockExec).toHaveBeenCalledWith(
      'glab',
      ['mr', 'list', '--state', 'opened', '--output', 'json'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('defaults to the gitlab CLI when neither vcs nor repo is provided', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await findStaleMRs({ exec: mockExec, now: FIXED_NOW });
    expect(mockExec.mock.calls[0][0]).toBe('glab');
  });

  it('appends --repo <spec> when repo is provided (explicit vcs)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await findStaleMRs({ vcs: 'gitlab', repo: 'group/proj', exec: mockExec, now: FIXED_NOW });
    expect(mockExec).toHaveBeenCalledWith(
      'glab',
      ['mr', 'list', '--state', 'opened', '--output', 'json', '--repo', 'group/proj'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('resolves vcs via detectVcsForRepo from a gitlab-hostname repo spec', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const result = await findStaleMRs({
      repo: 'gitlab.example.com/group/proj',
      exec: mockExec,
      now: FIXED_NOW,
    });
    expect(result.vcs).toBe('gitlab');
    expect(mockExec.mock.calls[0][0]).toBe('glab');
  });
});

// ---------------------------------------------------------------------------
// findStaleMRs — gh happy path
// ---------------------------------------------------------------------------

describe('findStaleMRs — gh', () => {
  it('returns the exact stale subset when vcs is explicit github', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: GITHUB_PRS_JSON, stderr: '' });
    const result = await findStaleMRs({
      vcs: 'github',
      thresholdDays: 14,
      now: FIXED_NOW,
      exec: mockExec,
    });
    expect(result.ok).toBe(true);
    expect(result.total).toBe(2);
    expect(result.stale.map((p) => p.number)).toEqual([55]);
  });

  it('calls exec with the expected gh pr list command and shell:false', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    await findStaleMRs({ vcs: 'github', exec: mockExec, now: FIXED_NOW });
    expect(mockExec).toHaveBeenCalledWith(
      'gh',
      ['pr', 'list', '--state', 'open', '--json', 'number,title,url,createdAt,updatedAt,author,headRefName'],
      expect.objectContaining({ shell: false }),
    );
  });

  it('resolves vcs via detectVcsForRepo from a host-less org/repo shorthand (last-resort github)', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const result = await findStaleMRs({ repo: 'someorg/somerepo', exec: mockExec, now: FIXED_NOW });
    expect(result.vcs).toBe('github');
    expect(mockExec.mock.calls[0][0]).toBe('gh');
  });
});

// ---------------------------------------------------------------------------
// findStaleMRs — vcs resolution failure
// ---------------------------------------------------------------------------

describe('findStaleMRs — unresolvable vcs', () => {
  it('returns {ok: false} without calling exec when the repo spec cannot be resolved', async () => {
    const mockExec = vi.fn();
    const result = await findStaleMRs({ repo: 'not a valid repo spec!!', exec: mockExec, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.stale).toEqual([]);
    expect(result.total).toBe(0);
    expect(mockExec).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// findStaleMRs — graceful error handling (never throws)
// ---------------------------------------------------------------------------

describe('findStaleMRs — graceful error handling', () => {
  it('returns {ok: false, stale: [], total: 0} without throwing when exec rejects (CLI missing)', async () => {
    const enoentError = Object.assign(new Error('glab: command not found'), { code: 'ENOENT' });
    const mockExec = vi.fn().mockRejectedValue(enoentError);

    await expect(
      findStaleMRs({ vcs: 'gitlab', exec: mockExec, now: FIXED_NOW }),
    ).resolves.toEqual(
      expect.objectContaining({ ok: false, stale: [], total: 0 }),
    );
  });

  it('returns {ok: false} without throwing when exec resolves with malformed JSON', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: 'not valid json {{{', stderr: '' });
    const result = await findStaleMRs({ vcs: 'gitlab', exec: mockExec, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.stale).toEqual([]);
    expect(result.total).toBe(0);
    expect(typeof result.error).toBe('string');
  });

  it("returns {ok: false} without throwing when exec resolves with a non-array JSON value", async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '{"error":"unauthorized"}', stderr: '' });
    const result = await findStaleMRs({ vcs: 'github', exec: mockExec, now: FIXED_NOW });
    expect(result.ok).toBe(false);
    expect(result.stale).toEqual([]);
  });

  it('never rejects the returned promise on any exec failure mode', async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error('network timeout'));
    await expect(
      findStaleMRs({ vcs: 'gitlab', exec: mockExec, now: FIXED_NOW }),
    ).resolves.toBeTypeOf('object');
  });
});

// ---------------------------------------------------------------------------
// findStaleMRsMultiRepo — vault-wide fan-out
// ---------------------------------------------------------------------------

describe('findStaleMRsMultiRepo', () => {
  it('returns one result per discovered repo, tagged with its slug', async () => {
    const fakeDiscoverRepos = vi.fn().mockResolvedValue([
      { slug: 'proj-a', repo: 'group/proj-a', vcs: 'gitlab' },
      { slug: 'proj-b', repo: 'someorg/proj-b', vcs: 'github' },
    ]);
    const mockExec = vi.fn().mockImplementation((cmd) => {
      if (cmd === 'glab') return Promise.resolve({ stdout: GITLAB_MRS_JSON, stderr: '' });
      return Promise.resolve({ stdout: GITHUB_PRS_JSON, stderr: '' });
    });

    const results = await findStaleMRsMultiRepo({
      vaultDir: '~/Projects/vault',
      thresholdDays: 14,
      now: FIXED_NOW,
      exec: mockExec,
      discoverRepos: fakeDiscoverRepos,
    });

    expect(results.map((r) => r.slug)).toEqual(['proj-a', 'proj-b']);
    expect(results[0].stale.map((m) => m.iid)).toEqual([101]);
    expect(results[1].stale.map((p) => p.number)).toEqual([55]);
  });

  it('returns [] when discoverRepos finds no vault-registered repos', async () => {
    const fakeDiscoverRepos = vi.fn().mockResolvedValue([]);
    const mockExec = vi.fn();
    const results = await findStaleMRsMultiRepo({
      vaultDir: '~/Projects/vault',
      exec: mockExec,
      discoverRepos: fakeDiscoverRepos,
    });
    expect(results).toEqual([]);
    expect(mockExec).not.toHaveBeenCalled();
  });

  it('preserves a per-repo failure alongside successful siblings (no abort-on-error)', async () => {
    const fakeDiscoverRepos = vi.fn().mockResolvedValue([
      { slug: 'broken', repo: 'group/broken', vcs: 'gitlab' },
      { slug: 'ok', repo: 'group/ok', vcs: 'gitlab' },
    ]);
    const mockExec = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ stdout: '[]', stderr: '' });

    const results = await findStaleMRsMultiRepo({
      vaultDir: '~/Projects/vault',
      exec: mockExec,
      discoverRepos: fakeDiscoverRepos,
      now: FIXED_NOW,
    });

    expect(results[0]).toEqual(expect.objectContaining({ slug: 'broken', ok: false }));
    expect(results[1]).toEqual(expect.objectContaining({ slug: 'ok', ok: true }));
  });
});

// ---------------------------------------------------------------------------
// main() — CLI
// ---------------------------------------------------------------------------

describe('main — help and argument errors', () => {
  it('--help exits 0', async () => {
    const result = await main(['--help'], {});
    expect(result.exitCode).toBe(0);
  });

  it('an unknown flag exits 1', async () => {
    const result = await main(['--bogus-flag'], {});
    expect(result.exitCode).toBe(1);
  });

  it('--threshold-days with a non-numeric value exits 1', async () => {
    const result = await main(['--threshold-days', 'abc'], {});
    expect(result.exitCode).toBe(1);
  });

  it('--field with an invalid value exits 1', async () => {
    const result = await main(['--field', 'bogus'], {});
    expect(result.exitCode).toBe(1);
  });
});

describe('main — single-repo happy path', () => {
  it('exits 0 and does not throw on a successful fetch', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: '[]', stderr: '' });
    const result = await main(['--json'], { exec: mockExec, now: FIXED_NOW });
    expect(result.exitCode).toBe(0);
  });
});

describe('main — system error propagation', () => {
  it('exits 2 when the underlying fetch fails (CLI missing)', async () => {
    const mockExec = vi.fn().mockRejectedValue(new Error('glab not found'));
    const result = await main([], { exec: mockExec, now: FIXED_NOW });
    expect(result.exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// main() — output-shape coverage (stdout/stderr captured via spy)
// ---------------------------------------------------------------------------

/**
 * Spy on a stream's `write` and collect every chunk written to it, joined
 * into a single string via `.text()`. Mirrors the `written.push(chunk)`
 * pattern already used in tests/lib/io.test.mjs's emitSystemMessage suite.
 */
function captureWrite(stream) {
  const chunks = [];
  vi.spyOn(stream, 'write').mockImplementation((chunk) => {
    chunks.push(chunk);
    return true;
  });
  return { text: () => chunks.join('') };
}

describe('main — --all-vault vaultDir resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('expands the default vaultDir from homedir() when --vault-dir is not passed', async () => {
    let captured;
    const discoverRepos = vi.fn(async ({ vaultDir }) => {
      captured = vaultDir;
      return [];
    });

    await main(['--all-vault'], {
      discoverRepos,
      homedir: () => '/Users/fixture',
      exec: vi.fn(),
      now: FIXED_NOW,
    });

    expect(captured).toBe('/Users/fixture/Projects/vault');
  });

  it('--vault-dir overrides the homedir()-derived default and homedir() is never called', async () => {
    let captured;
    const discoverRepos = vi.fn(async ({ vaultDir }) => {
      captured = vaultDir;
      return [];
    });
    const homedirSpy = vi.fn(() => '/Users/fixture');

    await main(['--all-vault', '--vault-dir', '/custom/vault'], {
      discoverRepos,
      homedir: homedirSpy,
      exec: vi.fn(),
      now: FIXED_NOW,
    });

    expect(captured).toBe('/custom/vault');
    expect(homedirSpy).not.toHaveBeenCalled();
  });
});

describe('main — --all-vault --json output shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints a JSON array of per-repo results tagged with slug', async () => {
    const discoverRepos = vi.fn().mockResolvedValue([
      { slug: 'proj-a', repo: 'group/proj-a', vcs: 'gitlab' },
      { slug: 'proj-b', repo: 'someorg/proj-b', vcs: 'github' },
    ]);
    const mockExec = vi.fn().mockImplementation((cmd) => {
      if (cmd === 'glab') return Promise.resolve({ stdout: GITLAB_MRS_JSON, stderr: '' });
      return Promise.resolve({ stdout: GITHUB_PRS_JSON, stderr: '' });
    });
    const out = captureWrite(process.stdout);

    const result = await main(['--all-vault', '--json'], {
      discoverRepos,
      exec: mockExec,
      now: FIXED_NOW,
      homedir: () => '/Users/fixture',
    });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed).toEqual([
      {
        slug: 'proj-a',
        ok: true,
        repo: 'group/proj-a',
        vcs: 'gitlab',
        total: 2,
        stale: [
          {
            iid: 101,
            title: 'Old MR',
            updated_at: '2026-06-01T12:00:00.000Z',
            created_at: '2026-06-01T12:00:00.000Z',
            web_url: 'https://gitlab.example.com/-/mr/101',
          },
        ],
      },
      {
        slug: 'proj-b',
        ok: true,
        repo: 'someorg/proj-b',
        vcs: 'github',
        total: 2,
        stale: [
          {
            number: 55,
            title: 'Stale PR',
            url: 'https://github.com/org/repo/pull/55',
            createdAt: '2026-05-01T00:00:00.000Z',
            updatedAt: '2026-05-15T00:00:00.000Z',
            author: { login: 'alice' },
            headRefName: 'feat/old',
          },
        ],
      },
    ]);
  });
});

describe('main — --all-vault human summary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('WARNs on stderr for a failed repo and prints the stale/open summary on stdout for a succeeding sibling', async () => {
    const discoverRepos = vi.fn().mockResolvedValue([
      { slug: 'repo-a', repo: 'group/repo-a', vcs: 'gitlab' },
      { slug: 'repo-b', repo: 'group/repo-b', vcs: 'gitlab' },
    ]);
    const mockExec = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ stdout: GITLAB_MRS_JSON, stderr: '' });

    const out = captureWrite(process.stdout);
    const err = captureWrite(process.stderr);

    const result = await main(['--all-vault'], {
      discoverRepos,
      exec: mockExec,
      now: FIXED_NOW,
      homedir: () => '/Users/fixture',
    });

    expect(result.exitCode).toBe(0);
    expect(err.text()).toContain('stale-mr-sweep: WARN: repo-a — boom');
    expect(out.text()).toContain('repo-b (gitlab): 1 stale / 2 open');
  });
});

describe('main — single-repo human summary output', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the stale MR and omits the fresh one', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: GITLAB_MRS_JSON, stderr: '' });
    const out = captureWrite(process.stdout);

    const result = await main([], { exec: mockExec, now: FIXED_NOW, repoRoot: '/fixture/repo' });

    expect(result.exitCode).toBe(0);
    expect(out.text()).toContain('  !101 — Old MR');
    expect(out.text()).not.toContain('!102');
  });
});

describe('main — single-repo --json output shape', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints the full findStaleMRs result envelope as JSON', async () => {
    const mockExec = vi.fn().mockResolvedValue({ stdout: GITLAB_MRS_JSON, stderr: '' });
    const out = captureWrite(process.stdout);

    const result = await main(['--json'], { exec: mockExec, now: FIXED_NOW, repoRoot: '/fixture/repo' });

    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(out.text());
    expect(parsed).toEqual({
      ok: true,
      repo: '/fixture/repo',
      vcs: 'gitlab',
      total: 2,
      stale: [
        {
          iid: 101,
          title: 'Old MR',
          updated_at: '2026-06-01T12:00:00.000Z',
          created_at: '2026-06-01T12:00:00.000Z',
          web_url: 'https://gitlab.example.com/-/mr/101',
        },
      ],
    });
  });
});
