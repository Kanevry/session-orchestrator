import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  scanBacklog,
  summarizeIssues,
  detectVcs,
  clearBacklogCache,
  DEFAULT_BACKLOG_LIMIT,
  STALE_THRESHOLD_DAYS,
} from '@lib/backlog-scan.mjs';
import { resolveRepoSpec } from '@lib/vcs-repo-spec.mjs';

const NOW = Date.parse('2026-04-25T00:00:00Z');

function ago(days) {
  return new Date(NOW - days * 86_400_000).toISOString();
}

/**
 * Build a `gitRun` stub that answers `git remote -v` from a remote table —
 * the same two-line-per-remote (fetch/push) shape git itself emits.
 */
function gitRunWithRemotes(remotes) {
  const stdout = remotes
    .flatMap(({ name, url }) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
    .join('\n');
  return () => ({ ok: true, stdout, stderr: '', status: 0 });
}

/**
 * Capture the `warn()` lines emitted during a test.
 *
 * Two hazards this helper exists to avoid, both measured while writing these
 * tests:
 *  1. Asserting on the RAW `process.stderr.write` call count judges the whole
 *     stderr CHANNEL, not the `warn()` unit — so the filter on the `WARNING: `
 *     prefix `common.mjs::warn` emits.
 *  2. `vi.spyOn` on an ALREADY-spied method returns the EXISTING spy, carrying
 *     its accumulated `mock.calls` (verified: a spy left installed by test A
 *     handed test B `["WARNING: from-a\n"]`). A test that fails before an
 *     inline `mockRestore()` therefore contaminates every later test in the
 *     file — which is why restoration is unconditional in `afterEach` below,
 *     never inline at the end of a test body.
 */
function captureWarnings() {
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  return {
    lines: () =>
      spy.mock.calls.map((call) => String(call[0])).filter((s) => s.startsWith('WARNING: ')),
  };
}

// Unconditional — a failing test must not leak its stderr spy forward (see 2. above).
afterEach(() => {
  vi.restoreAllMocks();
});

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

// ---------------------------------------------------------------------------
// detectVcs — remote-family detection (#1039)
//
// Replaces `expect([null, 'github', 'gitlab']).toContain(detectVcs())`, which
// enumerated the function's ENTIRE return type and therefore held for every
// possible return value — including the two wrong ones below.
// ---------------------------------------------------------------------------

describe('detectVcs — remote-family detection (#1039)', () => {
  it('detects gitlab from remotes named gitlab/github with NO origin', () => {
    // Bug: `git remote get-url origin` exits non-zero here, so detectVcs
    // returned null, scanBacklog short-circuited, and `signals.backlog: null`
    // made a 40-issue backlog with critical labels read to the mode-selector
    // exactly like an empty one ("contributes 0 delta").
    const r = detectVcs({
      gitRun: gitRunWithRemotes([
        { name: 'gitlab', url: 'git@gitlab.example.com:example-group/example-project.git' },
        { name: 'github', url: 'https://github.com/example-org/example-repo.git' },
      ]),
    });
    expect(r).toBe('gitlab');
  });

  it('classifies a GitHub Enterprise host as github', () => {
    // Bug: `url.includes('github.com')` is false for github.example.com, so
    // the old code fell through to 'gitlab' and pointed `glab` at a GitHub
    // instance.
    const r = detectVcs({
      gitRun: gitRunWithRemotes([
        { name: 'origin', url: 'git@github.example.com:example-org/example-repo.git' },
      ]),
    });
    expect(r).toBe('github');
  });

  it('outside a git repo: returns null AND emits exactly one WARNING', () => {
    // Bug: a broken query (git absent, not a work tree) and a legitimate
    // absence both produced a silent null, so a degraded measurement was
    // indistinguishable from a real answer on every channel.
    const warnings = captureWarnings();
    const r = detectVcs({
      gitRun: () => ({
        ok: false,
        stdout: '',
        stderr: 'fatal: not a git repository (or any of the parent directories): .git',
        status: 128,
      }),
    });
    expect(r).toBeNull();
    expect(warnings.lines()).toHaveLength(1);
    expect(warnings.lines()[0]).toContain('not-a-git-repo');
  });

  it('repo with zero remotes: returns null and stays SILENT', () => {
    // Bug: a fresh `git init` is a legitimate state, not a tool failure.
    // Warning on it trains the operator to ignore the WARNING above — the one
    // that reports an actually degraded measurement.
    const warnings = captureWarnings();
    const r = detectVcs({ gitRun: gitRunWithRemotes([]) });
    expect(r).toBeNull();
    expect(warnings.lines()).toEqual([]);
  });

  it('redacts userinfo credentials out of the WARNING it logs', () => {
    // Bug: git stderr echoes the remote URL, and a CI checkout URL carries
    // `https://user:<token>@host/...` (#907, CWE-214) — logging it verbatim
    // prints the token into the session banner and the CI log.
    const warnings = captureWarnings();
    const r = detectVcs({
      gitRun: () => ({
        ok: false,
        stdout: '',
        stderr: 'fatal: unable to access https://gitlab-ci-token:SECRET-TOKEN-VALUE@gitlab.example.com/g/p.git/',
        status: 128,
      }),
    });
    expect(r).toBeNull();
    const logged = warnings.lines()[0];
    expect(logged).not.toContain('SECRET-TOKEN-VALUE');
    expect(logged).toContain('gitlab.example.com');
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

  it('invalid limit values do not throw (the fallback VALUE is pinned in the c20d4d2 suite below)', async () => {
    // Retitled: the old title claimed "defaults to 50" while the default is
    // DEFAULT_BACKLOG_LIMIT (100), and this body asserts neither — vcs=null
    // short-circuits before the limit ever reaches the CLI args.
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

// ---------------------------------------------------------------------------
// scanBacklog — default window + truncation announcement
//
// Commit c20d4d2 shipped both behaviours across 13 files with none under
// tests/ (#1063 carryover). These two symptoms are what that commit changed.
// ---------------------------------------------------------------------------

describe('scanBacklog — default window + truncation (c20d4d2, #1063)', () => {
  beforeEach(() => clearBacklogCache());

  /** N issues, all fresh, all `priority:critical` — enough to fill a window. */
  function criticalIssues(n) {
    return Array.from({ length: n }, () => ({
      labels: ['priority:critical'],
      updated_at: ago(1),
    }));
  }

  it('the default window is DEFAULT_BACKLOG_LIMIT, in the CLI args AND in the result', async () => {
    // Bug: a second hand-written copy of the number (one in the arg builder,
    // one in the exported constant) drifts silently — the scan then reads a
    // different window than every caller and doc says it does.
    const runJsonFn = vi.fn(() => []);
    const r = await scanBacklog({
      vcs: 'gitlab',
      resolveRepoSpecFn: () => undefined,
      runJsonFn,
    });
    expect(runJsonFn.mock.calls[0][1]).toEqual([
      'issue',
      'list',
      '--per-page',
      String(DEFAULT_BACKLOG_LIMIT),
      '--output',
      'json',
    ]);
    expect(r.limit).toBe(DEFAULT_BACKLOG_LIMIT);
  });

  it('an invalid limit falls back to DEFAULT_BACKLOG_LIMIT, not to a second hard-coded default', async () => {
    // Same drift bug on the validation path: the fallback literal is the
    // second copy that outlives a change to the constant.
    const runJsonFn = vi.fn(() => []);
    const r = await scanBacklog({
      vcs: 'github',
      limit: -1,
      resolveRepoSpecFn: () => undefined,
      runJsonFn,
    });
    expect(runJsonFn.mock.calls[0][1]).toEqual([
      'issue',
      'list',
      '--limit',
      String(DEFAULT_BACKLOG_LIMIT),
      '--json',
      'number,labels,updatedAt,state',
    ]);
    expect(r.limit).toBe(DEFAULT_BACKLOG_LIMIT);
  });

  it('a FULL window sets truncated:true and announces the bound on stderr', async () => {
    // Bug: without the flag (and the WARNING) a LOWER BOUND reads as an exact
    // count — "3 critical issues" when the tracker may hold thirty.
    const warnings = captureWarnings();
    const r = await scanBacklog({
      vcs: 'gitlab',
      limit: 3,
      nowMs: NOW,
      resolveRepoSpecFn: () => undefined,
      runJsonFn: () => criticalIssues(3),
    });
    expect(r.truncated).toBe(true);
    expect(r.criticalCount).toBe(3);
    expect(warnings.lines()).toHaveLength(1);
    expect(warnings.lines()[0]).toContain('LOWER BOUNDS');
  });

  it('a window with room left sets truncated:false and stays silent', async () => {
    // The other half of the same bug: announcing a bound that was never
    // applied is the noise that makes the real announcement ignorable.
    const warnings = captureWarnings();
    const r = await scanBacklog({
      vcs: 'gitlab',
      limit: 5,
      nowMs: NOW,
      resolveRepoSpecFn: () => undefined,
      runJsonFn: () => criticalIssues(2),
    });
    expect(r.truncated).toBe(false);
    expect(r.criticalCount).toBe(2);
    expect(warnings.lines()).toEqual([]);
  });
});
