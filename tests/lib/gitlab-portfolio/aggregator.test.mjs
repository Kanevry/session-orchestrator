import { describe, it, expect, vi } from 'vitest';
import {
  normalizeIssue,
  fetchRepoIssues,
  fetchIssuesMultiRepo,
  summarizeRepo,
} from '@lib/gitlab-portfolio/aggregator.mjs';

// Fixed reference time: 2026-01-15T00:00:00Z
const NOW = new Date('2026-01-15T00:00:00Z');

// ── normalizeIssue ─────────────────────────────────────────────────────────────

describe('normalizeIssue — GitLab shape', () => {
  it('maps GitLab fields to canonical shape', () => {
    const raw = {
      iid: 42,
      title: 'Fix memory leak',
      description: 'Details here',
      labels: [{ name: 'priority:high' }, { name: 'area:core' }],
      updated_at: '2026-01-10T12:00:00Z',
      milestone: { title: 'v2.0', due_date: '2026-02-01' },
      state: 'opened',
      web_url: 'https://gitlab.gotzendorfer.at/org/repo/-/issues/42',
    };

    const result = normalizeIssue(raw, 'gitlab', 'org/repo');

    expect(result.iid).toBe(42);
    expect(result.title).toBe('Fix memory leak');
    expect(result.body).toBe('Details here');
    expect(result.labels).toEqual(['priority:high', 'area:core']);
    expect(result.updated_at).toBe('2026-01-10T12:00:00Z');
    expect(result.state).toBe('opened');
    expect(result.url).toBe('https://gitlab.gotzendorfer.at/org/repo/-/issues/42');
    expect(result.vcs).toBe('gitlab');
    expect(result.repo).toBe('org/repo');
  });
});

describe('normalizeIssue — GitHub shape', () => {
  it('maps GitHub fields to canonical shape', () => {
    const raw = {
      number: 17,
      title: 'Add dark mode',
      body: 'Users want dark mode.',
      labels: ['enhancement', 'good first issue'],
      updatedAt: '2026-01-12T08:30:00Z',
      milestone: null,
      state: 'open',
      url: 'https://github.com/org/repo/issues/17',
    };

    const result = normalizeIssue(raw, 'github', 'org/repo');

    expect(result.iid).toBe(17);
    expect(result.title).toBe('Add dark mode');
    expect(result.body).toBe('Users want dark mode.');
    expect(result.labels).toEqual(['enhancement', 'good first issue']);
    expect(result.updated_at).toBe('2026-01-12T08:30:00Z');
    expect(result.state).toBe('open');
    expect(result.url).toBe('https://github.com/org/repo/issues/17');
    expect(result.vcs).toBe('github');
    expect(result.repo).toBe('org/repo');
  });
});

describe('normalizeIssue — mixed label shapes', () => {
  it('normalizes object labels ({name}) and string labels together', () => {
    const raw = {
      iid: 1,
      title: 'Mixed labels',
      labels: [{ name: 'priority:critical' }, 'bug', { name: 'area:api' }, null, 42],
      updated_at: '2026-01-01T00:00:00Z',
      state: 'opened',
      web_url: 'https://example.com/1',
    };

    const result = normalizeIssue(raw, 'gitlab', 'org/repo');

    // null and 42 get filtered by the .filter(Boolean)
    expect(result.labels).toEqual(['priority:critical', 'bug', 'area:api']);
  });

  it('returns empty labels array when labels field is absent', () => {
    const raw = {
      iid: 2,
      title: 'No labels',
      state: 'opened',
      web_url: 'https://example.com/2',
    };

    const result = normalizeIssue(raw, 'gitlab', 'org/repo');

    expect(result.labels).toEqual([]);
  });
});

// ── fetchRepoIssues ────────────────────────────────────────────────────────────

describe('fetchRepoIssues — happy path', () => {
  it('returns ok:true with normalized issues on successful CLI output', async () => {
    const glabOutput = JSON.stringify([
      {
        iid: 5,
        title: 'Bug #5',
        description: '',
        labels: [{ name: 'bug' }],
        updated_at: '2026-01-10T00:00:00Z',
        milestone: null,
        state: 'opened',
        web_url: 'https://gitlab.example.com/org/repo/-/issues/5',
      },
    ]);
    const mockExecFile = vi.fn().mockResolvedValue({ stdout: glabOutput, stderr: '' });

    const result = await fetchRepoIssues({
      repo: 'org/repo',
      vcs: 'gitlab',
      execFile: mockExecFile,
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].iid).toBe(5);
    expect(result.issues[0].title).toBe('Bug #5');
    expect(result.issues[0].labels).toEqual(['bug']);
    expect(result.issues[0].vcs).toBe('gitlab');
    expect(result.issues[0].repo).toBe('org/repo');
  });

  it('filters out closed issues from CLI output', async () => {
    const ghOutput = JSON.stringify([
      {
        number: 1,
        title: 'Open issue',
        body: '',
        labels: [],
        updatedAt: '2026-01-10T00:00:00Z',
        milestone: null,
        state: 'open',
        url: 'https://github.com/org/repo/issues/1',
      },
      {
        number: 2,
        title: 'Closed issue',
        body: '',
        labels: [],
        updatedAt: '2026-01-09T00:00:00Z',
        milestone: null,
        state: 'closed',
        url: 'https://github.com/org/repo/issues/2',
      },
    ]);
    const mockExecFile = vi.fn().mockResolvedValue({ stdout: ghOutput, stderr: '' });

    const result = await fetchRepoIssues({
      repo: 'org/repo',
      vcs: 'github',
      execFile: mockExecFile,
    });

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].iid).toBe(1);
  });
});

describe('fetchRepoIssues — error paths', () => {
  it('returns ok:false when CLI throws (no exception propagated)', async () => {
    const mockExecFile = vi.fn().mockRejectedValue(new Error('glab: command not found'));

    const result = await fetchRepoIssues({
      repo: 'org/repo',
      vcs: 'gitlab',
      execFile: mockExecFile,
    });

    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error).toContain('org/repo');
  });

  it('returns ok:false when CLI returns empty stdout', async () => {
    const mockExecFile = vi.fn().mockResolvedValue({ stdout: '', stderr: '' });

    const result = await fetchRepoIssues({
      repo: 'org/repo',
      vcs: 'gitlab',
      execFile: mockExecFile,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('empty output');
  });

  it('returns ok:false when CLI returns invalid JSON', async () => {
    const mockExecFile = vi.fn().mockResolvedValue({ stdout: 'not-json', stderr: '' });

    const result = await fetchRepoIssues({
      repo: 'org/repo',
      vcs: 'gitlab',
      execFile: mockExecFile,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('JSON parse failure');
  });

  it('returns ok:false for invalid vcs value', async () => {
    const result = await fetchRepoIssues({
      repo: 'org/repo',
      vcs: 'bitbucket',
      execFile: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('vcs must be');
  });

  it('returns ok:false for missing repo', async () => {
    const result = await fetchRepoIssues({
      repo: '',
      vcs: 'gitlab',
      execFile: vi.fn(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('repo must be a non-empty string');
  });
});

// ── fetchIssuesMultiRepo ───────────────────────────────────────────────────────

describe('fetchIssuesMultiRepo — parallel batch', () => {
  it('returns a Map with ok:true and ok:false entries when one repo fails', async () => {
    const successOutput = JSON.stringify([
      {
        iid: 10,
        title: 'Issue A',
        description: '',
        labels: [],
        updated_at: '2026-01-01T00:00:00Z',
        state: 'opened',
        web_url: 'https://gitlab.example.com/a/repo/-/issues/10',
      },
    ]);

    // First call succeeds (a/repo), second call throws (b/repo)
    const mockExecFile = vi.fn()
      .mockResolvedValueOnce({ stdout: successOutput, stderr: '' })
      .mockRejectedValueOnce(new Error('network error'));

    const resultMap = await fetchIssuesMultiRepo({
      repos: [
        { repo: 'a/repo', vcs: 'gitlab' },
        { repo: 'b/repo', vcs: 'gitlab' },
      ],
      execFile: mockExecFile,
    });

    expect(resultMap).toBeInstanceOf(Map);
    expect(resultMap.size).toBe(2);

    const aResult = resultMap.get('a/repo');
    expect(aResult.ok).toBe(true);
    expect(aResult.issues).toHaveLength(1);

    const bResult = resultMap.get('b/repo');
    expect(bResult.ok).toBe(false);
    expect(typeof bResult.error).toBe('string');
  });

  it('returns empty Map when repos array is empty', async () => {
    const result = await fetchIssuesMultiRepo({
      repos: [],
      execFile: vi.fn(),
    });

    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
  });

  it('batch never aborts: all repos get processed even with failures (Promise.allSettled semantics)', async () => {
    const mockExecFile = vi.fn().mockRejectedValue(new Error('always fails'));

    const resultMap = await fetchIssuesMultiRepo({
      repos: [
        { repo: 'repo-1', vcs: 'gitlab' },
        { repo: 'repo-2', vcs: 'gitlab' },
        { repo: 'repo-3', vcs: 'gitlab' },
      ],
      execFile: mockExecFile,
    });

    // All 3 repos must appear in the map, each with ok:false
    expect(resultMap.size).toBe(3);
    expect(resultMap.get('repo-1').ok).toBe(false);
    expect(resultMap.get('repo-2').ok).toBe(false);
    expect(resultMap.get('repo-3').ok).toBe(false);
  });
});

// ── summarizeRepo ──────────────────────────────────────────────────────────────

describe('summarizeRepo — empty issues', () => {
  it('returns all-zero counts, null milestone, null lastActivity, empty topThree', () => {
    const result = summarizeRepo([], {
      now: NOW,
      staleDays: 30,
      criticalLabels: ['priority:critical'],
    });

    expect(result.openCount).toBe(0);
    expect(result.criticalCount).toBe(0);
    expect(result.staleCount).toBe(0);
    expect(result.nextMilestone).toBeNull();
    expect(result.lastActivity).toBeNull();
    expect(result.topThree).toEqual([]);
  });
});

describe('summarizeRepo — staleness threshold', () => {
  it('marks 0 issues stale when all are within staleDays', () => {
    const recentDate = new Date(NOW.getTime() - 5 * 86_400_000).toISOString();
    const issues = [
      { iid: 1, title: 'A', labels: [], updated_at: recentDate, url: 'u1' },
      { iid: 2, title: 'B', labels: [], updated_at: recentDate, url: 'u2' },
    ];

    const result = summarizeRepo(issues, { now: NOW, staleDays: 30, criticalLabels: [] });

    expect(result.staleCount).toBe(0);
    expect(result.openCount).toBe(2);
  });

  it('marks all issues stale when all are beyond staleDays', () => {
    const oldDate = new Date(NOW.getTime() - 60 * 86_400_000).toISOString();
    const issues = [
      { iid: 1, title: 'Old A', labels: [], updated_at: oldDate, url: 'u1' },
      { iid: 2, title: 'Old B', labels: [], updated_at: oldDate, url: 'u2' },
    ];

    const result = summarizeRepo(issues, { now: NOW, staleDays: 30, criticalLabels: [] });

    expect(result.staleCount).toBe(2);
  });

  it('counts only stale issues when mix of fresh and stale', () => {
    const freshDate = new Date(NOW.getTime() - 5 * 86_400_000).toISOString();
    const staleDate = new Date(NOW.getTime() - 60 * 86_400_000).toISOString();
    const issues = [
      { iid: 1, title: 'Fresh', labels: [], updated_at: freshDate, url: 'u1' },
      { iid: 2, title: 'Stale', labels: [], updated_at: staleDate, url: 'u2' },
    ];

    const result = summarizeRepo(issues, { now: NOW, staleDays: 30, criticalLabels: [] });

    expect(result.staleCount).toBe(1);
    expect(result.openCount).toBe(2);
  });
});

describe('summarizeRepo — critical label detection', () => {
  it('counts issues that have any criticalLabel', () => {
    const updated = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();
    const issues = [
      { iid: 1, title: 'Critical bug', labels: ['priority:critical', 'bug'], updated_at: updated, url: 'u1' },
      { iid: 2, title: 'High priority', labels: ['priority:high'], updated_at: updated, url: 'u2' },
      { iid: 3, title: 'Normal issue', labels: ['enhancement'], updated_at: updated, url: 'u3' },
    ];

    const result = summarizeRepo(issues, {
      now: NOW,
      staleDays: 30,
      criticalLabels: ['priority:critical', 'priority:high'],
    });

    expect(result.criticalCount).toBe(2);
    expect(result.openCount).toBe(3);
  });

  it('counts 0 critical when no issues match criticalLabels', () => {
    const updated = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();
    const issues = [
      { iid: 1, title: 'Enhancement', labels: ['enhancement'], updated_at: updated, url: 'u1' },
    ];

    const result = summarizeRepo(issues, {
      now: NOW,
      staleDays: 30,
      criticalLabels: ['priority:critical'],
    });

    expect(result.criticalCount).toBe(0);
  });
});

describe('summarizeRepo — nextMilestone', () => {
  it('picks the soonest non-null due_date across issues', () => {
    const updated = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();
    const issues = [
      {
        iid: 1, title: 'A', labels: [], updated_at: updated, url: 'u1',
        milestone: { title: 'v2.0', due_date: '2026-03-01' },
      },
      {
        iid: 2, title: 'B', labels: [], updated_at: updated, url: 'u2',
        milestone: { title: 'v1.9', due_date: '2026-02-01' },
      },
    ];

    const result = summarizeRepo(issues, { now: NOW, staleDays: 30, criticalLabels: [] });

    expect(result.nextMilestone).toEqual({ title: 'v1.9', due_date: '2026-02-01' });
  });

  it('returns null nextMilestone when no issues have milestones', () => {
    const updated = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();
    const issues = [
      { iid: 1, title: 'A', labels: [], updated_at: updated, url: 'u1', milestone: null },
    ];

    const result = summarizeRepo(issues, { now: NOW, staleDays: 30, criticalLabels: [] });

    expect(result.nextMilestone).toBeNull();
  });
});

describe('summarizeRepo — topThree', () => {
  it('returns at most 3 issues ordered by most-recent updated_at', () => {
    const dates = [
      '2026-01-14T00:00:00Z', // newest
      '2026-01-13T00:00:00Z',
      '2026-01-12T00:00:00Z',
      '2026-01-11T00:00:00Z', // oldest — should be excluded
    ];
    const issues = dates.map((updated_at, idx) => ({
      iid: idx + 1,
      title: `Issue ${idx + 1}`,
      labels: [],
      updated_at,
      url: `https://example.com/${idx + 1}`,
    }));

    const result = summarizeRepo(issues, { now: NOW, staleDays: 30, criticalLabels: [] });

    expect(result.topThree).toHaveLength(3);
    expect(result.topThree[0].iid).toBe(1); // most recently updated
    expect(result.topThree[1].iid).toBe(2);
    expect(result.topThree[2].iid).toBe(3);
  });

  it('returns fewer than 3 when fewer issues exist', () => {
    const updated = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();
    const issues = [
      { iid: 10, title: 'Only one', labels: [], updated_at: updated, url: 'u10' },
    ];

    const result = summarizeRepo(issues, { now: NOW, staleDays: 30, criticalLabels: [] });

    expect(result.topThree).toHaveLength(1);
    expect(result.topThree[0].iid).toBe(10);
    expect(result.topThree[0].title).toBe('Only one');
  });

  it('topThree entries contain only iid, title, labels, url fields', () => {
    const updated = new Date(NOW.getTime() - 1 * 86_400_000).toISOString();
    const issues = [
      { iid: 5, title: 'Test issue', labels: ['bug'], updated_at: updated, url: 'https://example.com/5' },
    ];

    const result = summarizeRepo(issues, { now: NOW, staleDays: 30, criticalLabels: [] });

    expect(result.topThree[0]).toEqual({
      iid: 5,
      title: 'Test issue',
      labels: ['bug'],
      url: 'https://example.com/5',
    });
  });
});
