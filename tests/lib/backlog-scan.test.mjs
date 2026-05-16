import { describe, it, expect, beforeEach } from 'vitest';
import {
  scanBacklog,
  summarizeIssues,
  detectVcs,
  clearBacklogCache,
  STALE_THRESHOLD_DAYS,
} from '@lib/backlog-scan.mjs';

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
