import { describe, it, expect, vi } from 'vitest';
import { main } from '@lib/gitlab-portfolio/cli.mjs';

// ── Fixture helpers ────────────────────────────────────────────────────────────

function makeMinimalConfig(overrides = {}) {
  return {
    'vault-integration': { 'vault-dir': '/vault' },
    'gitlab-portfolio': { enabled: true, mode: 'warn', 'stale-days': 30, 'critical-labels': ['priority:critical'] },
    ...overrides,
  };
}

function makeSuccessfulDeps(extraOverrides = {}) {
  const summaryFixture = {
    openCount: 5,
    criticalCount: 1,
    staleCount: 0,
    nextMilestone: null,
    lastActivity: '2026-01-14T00:00:00Z',
    topThree: [],
  };

  return {
    parseConfig: vi.fn().mockReturnValue(makeMinimalConfig()),
    readConfig: vi.fn().mockResolvedValue('# mock config'),
    discoverRepos: vi.fn().mockResolvedValue([
      { slug: 'repo-a', repo: 'org/repo-a', vcs: 'gitlab', overviewPath: '/vault/01-projects/repo-a/_overview.md' },
      { slug: 'repo-b', repo: 'org/repo-b', vcs: 'github', overviewPath: '/vault/01-projects/repo-b/_overview.md' },
    ]),
    fetchIssues: vi.fn().mockResolvedValue(new Map([
      ['org/repo-a', { ok: true, issues: [] }],
      ['org/repo-b', { ok: true, issues: [] }],
    ])),
    summarize: vi.fn().mockReturnValue(summaryFixture),
    render: vi.fn().mockReturnValue('---\n_generator: session-orchestrator-gitlab-portfolio@1\n---\n# Portfolio\n'),
    write: vi.fn().mockReturnValue({ action: 'written', path: '/vault/01-projects/_PORTFOLIO.md' }),
    now: () => new Date('2026-01-15T00:00:00Z'),
    fs: {
      readFile: vi.fn().mockRejectedValue(new Error('ENOENT')), // No existing file
      readdir: vi.fn(),
      stat: vi.fn(),
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      existsSync: vi.fn().mockReturnValue(false),
    },
    ...extraOverrides,
  };
}

// ── --help ─────────────────────────────────────────────────────────────────────

describe('main — --help flag', () => {
  it('returns exitCode 0 and action help', async () => {
    const result = await main(['--help'], {});

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('help');
    expect(result.reposScanned).toBe(0);
  });

  it('returns exitCode 0 and action help for -h alias', async () => {
    const result = await main(['-h'], {});

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('help');
  });
});

// ── Unknown argument ───────────────────────────────────────────────────────────

describe('main — unknown argument', () => {
  it('returns exitCode 1 for an unrecognized flag', async () => {
    const result = await main(['--unknown-flag'], {});

    expect(result.exitCode).toBe(1);
    expect(result.action).toBe('error');
  });

  it('returns exitCode 1 for positional argument', async () => {
    const result = await main(['notaflag'], {});

    expect(result.exitCode).toBe(1);
    expect(result.action).toBe('error');
  });
});

// ── Disabled feature ───────────────────────────────────────────────────────────

describe('main — gitlab-portfolio.enabled: false', () => {
  it('returns exitCode 0 and action disabled when feature is disabled', async () => {
    const deps = {
      parseConfig: vi.fn().mockReturnValue({
        'vault-integration': { 'vault-dir': '/vault' },
        'gitlab-portfolio': { enabled: false },
      }),
      readConfig: vi.fn().mockResolvedValue('# mock config'),
    };

    const result = await main([], deps);

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('disabled');
    expect(result.reposScanned).toBe(0);
    expect(result.reposFailed).toBe(0);
  });
});

// ── Missing vault-dir ──────────────────────────────────────────────────────────

describe('main — missing vault-integration.vault-dir', () => {
  it('returns exitCode 2 when vault-dir is not configured', async () => {
    const deps = {
      parseConfig: vi.fn().mockReturnValue({
        'vault-integration': {},
        'gitlab-portfolio': { enabled: true },
      }),
      readConfig: vi.fn().mockResolvedValue('# mock config'),
    };

    const result = await main([], deps);

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('error');
    expect(result.reposScanned).toBe(0);
  });

  it('returns exitCode 2 when vault-integration block is absent', async () => {
    const deps = {
      parseConfig: vi.fn().mockReturnValue({
        'gitlab-portfolio': { enabled: true },
      }),
      readConfig: vi.fn().mockResolvedValue('# mock config'),
    };

    const result = await main([], deps);

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('error');
  });
});

// ── Happy path ─────────────────────────────────────────────────────────────────

describe('main — happy path with all deps mocked', () => {
  it('returns exitCode 0 and action written when pipeline succeeds', async () => {
    const deps = makeSuccessfulDeps();

    const result = await main([], deps);

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('written');
    expect(result.reposScanned).toBe(2);
    expect(result.reposFailed).toBe(0);
  });

  it('calls discoverRepos, fetchIssues, render, and write exactly once each', async () => {
    const deps = makeSuccessfulDeps();

    await main([], deps);

    expect(deps.discoverRepos).toHaveBeenCalledOnce();
    expect(deps.fetchIssues).toHaveBeenCalledOnce();
    expect(deps.render).toHaveBeenCalledOnce();
    expect(deps.write).toHaveBeenCalledOnce();
  });
});

// ── --dry-run ──────────────────────────────────────────────────────────────────

describe('main — --dry-run flag', () => {
  it('returns exitCode 0 and action dry-run when write returns dry-run', async () => {
    const deps = makeSuccessfulDeps({
      write: vi.fn().mockReturnValue({ action: 'dry-run', path: '/vault/01-projects/_PORTFOLIO.md' }),
    });

    const result = await main(['--dry-run'], deps);

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('dry-run');
  });

  it('passes dryRun:true to the write dep when --dry-run is set', async () => {
    const mockWrite = vi.fn().mockReturnValue({ action: 'dry-run', path: '/vault/01-projects/_PORTFOLIO.md' });
    const deps = makeSuccessfulDeps({ write: mockWrite });

    await main(['--dry-run'], deps);

    expect(mockWrite).toHaveBeenCalledWith(
      expect.objectContaining({ dryRun: true }),
    );
  });
});

// ── strict mode with failed repos ─────────────────────────────────────────────

describe('main — strict mode with failed repos', () => {
  it('returns exitCode 2 when mode is strict and 1 repo fetch fails', async () => {
    const deps = makeSuccessfulDeps({
      parseConfig: vi.fn().mockReturnValue({
        'vault-integration': { 'vault-dir': '/vault' },
        'gitlab-portfolio': { enabled: true, mode: 'strict', 'stale-days': 30, 'critical-labels': [] },
      }),
      fetchIssues: vi.fn().mockResolvedValue(new Map([
        ['org/repo-a', { ok: true, issues: [] }],
        ['org/repo-b', { ok: false, error: 'network error' }],
      ])),
    });

    const result = await main([], deps);

    expect(result.exitCode).toBe(2);
    expect(result.reposFailed).toBe(1);
  });

  it('returns exitCode 0 when mode is warn and 1 repo fetch fails', async () => {
    const deps = makeSuccessfulDeps({
      parseConfig: vi.fn().mockReturnValue({
        'vault-integration': { 'vault-dir': '/vault' },
        'gitlab-portfolio': { enabled: true, mode: 'warn', 'stale-days': 30, 'critical-labels': [] },
      }),
      fetchIssues: vi.fn().mockResolvedValue(new Map([
        ['org/repo-a', { ok: true, issues: [] }],
        ['org/repo-b', { ok: false, error: 'network error' }],
      ])),
    });

    const result = await main([], deps);

    expect(result.exitCode).toBe(0);
    expect(result.reposFailed).toBe(1);
  });
});

// ── No repos discovered ────────────────────────────────────────────────────────

describe('main — no repos discovered', () => {
  it('returns exitCode 0 and action no-repos when vault has no configured repos', async () => {
    const deps = makeSuccessfulDeps({
      discoverRepos: vi.fn().mockResolvedValue([]),
    });

    const result = await main([], deps);

    expect(result.exitCode).toBe(0);
    expect(result.action).toBe('no-repos');
    expect(result.reposScanned).toBe(0);
  });
});

// ── Config load failure ────────────────────────────────────────────────────────

describe('main — config load failure', () => {
  it('returns exitCode 2 when readConfig throws', async () => {
    const deps = {
      readConfig: vi.fn().mockRejectedValue(new Error('ENOENT: config not found')),
    };

    const result = await main([], deps);

    expect(result.exitCode).toBe(2);
    expect(result.action).toBe('error');
  });
});
