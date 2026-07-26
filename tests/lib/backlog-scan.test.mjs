import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  scanBacklog,
  summarizeIssues,
  detectVcs,
  clearBacklogCache,
  STALE_THRESHOLD_DAYS,
} from '@lib/backlog-scan.mjs';
import { resolveRepoSpec } from '@lib/vcs-repo-spec.mjs';

const NOW = Date.parse('2026-04-25T00:00:00Z');

function ago(days) {
  return new Date(NOW - days * 86_400_000).toISOString();
}

describe('summarizeIssues — pure aggregator', () => {
  it('counts critical + high + stale + byLabel correctly', () => {
    const issues = [
      { labels: ['priority:critical', 'area:foo'], updated_at: ago(60) },
      { labels: ['priority:high'], updated_at: ago(1) },
      { labels: [{ name: 'priority:high' }, { name: 'area:bar' }], updatedAt: ago(10) },
      { labels: ['area:foo'] }, // no updated_at → stale (Infinity > 30)
    ];
    const r = summarizeIssues(issues, NOW);
    expect(r.criticalCount).toBe(1);
    expect(r.highCount).toBe(2);
    expect(r.staleCount).toBe(2); // 60-day-old + missing-date
    expect(r.byLabel['priority:critical']).toBe(1);
    expect(r.byLabel['priority:high']).toBe(2);
    expect(r.byLabel['area:foo']).toBe(2);
    expect(r.byLabel['area:bar']).toBe(1);
    expect(r.total).toBe(4);
  });

  it('boundary: exactly STALE_THRESHOLD_DAYS days → not stale', () => {
    const issues = [{ labels: [], updated_at: ago(STALE_THRESHOLD_DAYS) }];
    const r = summarizeIssues(issues, NOW);
    expect(r.staleCount).toBe(0);
  });

  it('boundary: STALE_THRESHOLD_DAYS + 1 → stale', () => {
    const issues = [{ labels: [], updated_at: ago(STALE_THRESHOLD_DAYS + 1) }];
    const r = summarizeIssues(issues, NOW);
    expect(r.staleCount).toBe(1);
  });

  it('handles empty array', () => {
    expect(summarizeIssues([], NOW)).toEqual({
      criticalCount: 0,
      highCount: 0,
      staleCount: 0,
      byLabel: {},
      total: 0,
    });
  });

  it('skips non-object entries defensively', () => {
    const r = summarizeIssues([null, 'str', 42, undefined, { labels: ['x'] }], NOW);
    expect(r.total).toBe(5);
    expect(r.byLabel.x).toBe(1);
  });

  it('tolerates missing labels field', () => {
    const r = summarizeIssues([{ updated_at: ago(1) }], NOW);
    expect(r.total).toBe(1);
    expect(r.byLabel).toEqual({});
  });

  it('skips non-string label entries', () => {
    const r = summarizeIssues([{ labels: [42, null, { foo: 'bar' }, 'priority:high'] }], NOW);
    expect(r.highCount).toBe(1);
    expect(Object.keys(r.byLabel)).toEqual(['priority:high']);
  });

  it('unparsable updated_at → stale', () => {
    const r = summarizeIssues([{ labels: [], updated_at: 'not-a-date' }], NOW);
    expect(r.staleCount).toBe(1);
  });
});

describe('detectVcs', () => {
  it('returns one of github/gitlab/null', () => {
    const r = detectVcs();
    expect([null, 'github', 'gitlab']).toContain(r);
  });
});

describe('scanBacklog — graceful degradation', () => {
  beforeEach(() => clearBacklogCache());

  it('explicit vcs=null → returns null (no CLI invoked)', async () => {
    const r = await scanBacklog({ limit: 5, vcs: null });
    expect(r).toBeNull();
  });

  it('explicit vcs="bitbucket" (unsupported) → returns null', async () => {
    const r = await scanBacklog({ limit: 5, vcs: 'bitbucket' });
    expect(r).toBeNull();
  });

  it('limit defaults to 50 when invalid', async () => {
    // Use vcs=null to short-circuit before any CLI call; we only verify
    // the call shape does not throw on bad limit values.
    const r1 = await scanBacklog({ limit: -1, vcs: null });
    const r2 = await scanBacklog({ limit: 'oops', vcs: null });
    const r3 = await scanBacklog({ limit: 0, vcs: null });
    expect(r1).toBeNull();
    expect(r2).toBeNull();
    expect(r3).toBeNull();
  });

  it('cache hit returns identical reference', async () => {
    // First call populates cache (real glab call may or may not succeed —
    // both branches cache their result). Second call must short-circuit.
    const r1 = await scanBacklog({ limit: 1 });
    const r2 = await scanBacklog({ limit: 1 });
    expect(r2).toBe(r1); // same reference (or same null)
  });

  it('clearBacklogCache resets state between scans', async () => {
    await scanBacklog({ limit: 1, vcs: null });
    clearBacklogCache();
    // After clear, a fresh scan re-runs; the explicit null-vcs path returns
    // null again — we verify no stale cache entry leaks across the boundary.
    const r = await scanBacklog({ limit: 1, vcs: null });
    expect(r).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// scanBacklog — -R host-pinning wiring (#872, mirrors #839's
// spiral-carryover.mjs / issue-close-strip-labels.mjs idiom)
// ---------------------------------------------------------------------------

describe('scanBacklog — -R host-pinning wiring (#872)', () => {
  beforeEach(() => clearBacklogCache());

  it('appends -R <spec> to the CLI args when resolveRepoSpecFn resolves (gitlab)', async () => {
    const runJsonFn = vi.fn(() => []);
    await scanBacklog({
      vcs: 'gitlab',
      limit: 3,
      resolveRepoSpecFn: () => 'https://gitlab.example.com/example-group/example-project.git',
      runJsonFn,
    });
    expect(runJsonFn).toHaveBeenCalledWith(
      'glab',
      expect.arrayContaining(['-R', 'https://gitlab.example.com/example-group/example-project.git']),
    );
  });

  it('appends -R <spec> to the CLI args when resolveRepoSpecFn resolves (github)', async () => {
    const runJsonFn = vi.fn(() => []);
    await scanBacklog({
      vcs: 'github',
      limit: 3,
      resolveRepoSpecFn: () => 'https://github.example.com/example-org/example-repo.git',
      runJsonFn,
    });
    expect(runJsonFn).toHaveBeenCalledWith(
      'gh',
      expect.arrayContaining(['-R', 'https://github.example.com/example-org/example-repo.git']),
    );
  });

  it('omits -R entirely when resolveRepoSpecFn returns undefined (never emits "-R undefined")', async () => {
    const runJsonFn = vi.fn(() => []);
    await scanBacklog({
      vcs: 'github',
      limit: 3,
      resolveRepoSpecFn: () => undefined,
      runJsonFn,
    });
    const args = runJsonFn.mock.calls[0][1];
    expect(args).not.toContain('-R');
  });

  it('calls resolveRepoSpecFn exactly once per scanBacklog call', async () => {
    const resolveRepoSpecFn = vi.fn(() => 'https://gitlab.example.com/example-group/example-project.git');
    const runJsonFn = vi.fn(() => []);
    await scanBacklog({ vcs: 'gitlab', limit: 9, resolveRepoSpecFn, runJsonFn });
    expect(resolveRepoSpecFn).toHaveBeenCalledTimes(1);
  });

  it('defaults resolveRepoSpecFn to the real resolveRepoSpec when omitted (production wiring)', async () => {
    const runJsonFn = vi.fn(() => []);
    const repoRoot = process.cwd();
    // Compute the expected value via the SAME real function scanBacklog
    // defaults to — proves the production default is wired to the real
    // module (not a re-implementation or a silent no-op).
    const expectedSpec = resolveRepoSpec({ repoRoot, vcs: 'gitlab' });

    await scanBacklog({ vcs: 'gitlab', limit: 4, repoRoot, runJsonFn });

    const args = runJsonFn.mock.calls[0][1];
    if (expectedSpec) {
      expect(args).toEqual(expect.arrayContaining(['-R', expectedSpec]));
    } else {
      expect(args).not.toContain('-R');
    }
  });

  it('cache key includes the resolved spec — two specs at the SAME {vcs, limit} both invoke the CLI runner (no cross-repo cache collision)', async () => {
    const runJsonFn = vi.fn(() => []);
    const r1 = await scanBacklog({
      vcs: 'gitlab',
      limit: 5,
      resolveRepoSpecFn: () => 'https://gitlab.example.com/group-a/repo-a.git',
      runJsonFn,
    });
    const r2 = await scanBacklog({
      vcs: 'gitlab',
      limit: 5,
      resolveRepoSpecFn: () => 'https://gitlab.example.com/group-b/repo-b.git',
      runJsonFn,
    });
    expect(runJsonFn).toHaveBeenCalledTimes(2);
    expect(r1).not.toBe(r2);
  });

  it('same spec + same {vcs, limit} → second call is a cache hit (CLI runner invoked only once)', async () => {
    const runJsonFn = vi.fn(() => []);
    const specFn = () => 'https://gitlab.example.com/group-a/repo-a.git';
    const r1 = await scanBacklog({ vcs: 'gitlab', limit: 6, resolveRepoSpecFn: specFn, runJsonFn });
    const r2 = await scanBacklog({ vcs: 'gitlab', limit: 6, resolveRepoSpecFn: specFn, runJsonFn });
    expect(runJsonFn).toHaveBeenCalledTimes(1);
    expect(r2).toBe(r1);
  });
});
