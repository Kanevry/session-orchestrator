import { describe, it, expect, vi } from 'vitest';
import { checkCiStatus, DEFAULT_TIMEOUT_MS } from '../../scripts/lib/ci-status-banner.mjs';

// ── DI helpers ────────────────────────────────────────────────────────────────
//
// The production code calls:  promisify(deps.execFile)(cmd, args, execOpts)
// So we supply a callback-style fake that the promisify wrapper will wrap.
//
// Helper: build a callback-style execFile mock that maps (cmd, args) to
// predetermined responses. Each entry in `responses` is matched in order;
// the first matcher whose { cmd, args? } predicate matches is used.
//
// Response shape per entry:
//   { cmd, args?, stdout, stderr? }  → resolves with { stdout, stderr }
//   { cmd, args?, error }            → rejects with error

function makeExecFileMock(responses) {
  return vi.fn(function (cmd, args, _opts, callback) {
    // Handle optional opts (execFile can be called with or without opts)
    if (typeof _opts === 'function') {
      callback = _opts;
    }

    for (const entry of responses) {
      const cmdMatch = entry.cmd === cmd;
      const argsMatch =
        !entry.args ||
        (Array.isArray(entry.args) &&
          entry.args.every((a, i) => a === args[i]));
      if (cmdMatch && argsMatch) {
        if (entry.error) {
          callback(entry.error);
        } else {
          callback(null, { stdout: entry.stdout ?? '', stderr: entry.stderr ?? '' });
        }
        return;
      }
    }

    // Unmatched call — fail loudly so tests catch missing stubs.
    callback(
      new Error(`[mock] unexpected execFile call: ${cmd} ${JSON.stringify(args)}`),
    );
  });
}

// Fixed timestamp for deterministic ageDays calculation.
const NOW = new Date('2026-05-10T12:00:00Z').getTime();

// A SHA that matches the pipeline fixture below.
const HEAD_SHA = 'abc1234def5678abc1234def5678abc1234def56';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const GITLAB_ORIGIN = 'https://gitlab.gotzendorfer.at/bg/session-orchestrator.git';
const GITHUB_ORIGIN = 'https://github.com/Kanevry/session-orchestrator.git';

const GLAB_REPO_VIEW = JSON.stringify({ id: 42, name: 'session-orchestrator' });
const GH_REPO_VIEW = JSON.stringify({ nameWithOwner: 'Kanevry/session-orchestrator' });

function gitRemoteResponse(origin) {
  return { cmd: 'git', args: ['remote', 'get-url', 'origin'], stdout: origin + '\n' };
}

function gitRevParseResponse(sha) {
  return { cmd: 'git', args: ['rev-parse', 'HEAD'], stdout: sha + '\n' };
}

const glabRepoViewResponse = {
  cmd: 'glab',
  args: ['repo', 'view', '--output', 'json'],
  stdout: GLAB_REPO_VIEW,
};

const ghRepoViewResponse = {
  cmd: 'gh',
  args: ['repo', 'view', '--json', 'nameWithOwner'],
  stdout: GH_REPO_VIEW,
};

function glabPipelinesResponse(pipelines) {
  return {
    cmd: 'glab',
    args: ['api', 'projects/42/pipelines?order_by=updated_at&sort=desc&per_page=15'],
    stdout: JSON.stringify(pipelines),
  };
}

function glabJobsResponse(pipelineId, jobs) {
  return {
    cmd: 'glab',
    args: ['api', `projects/42/pipelines/${pipelineId}/jobs`],
    stdout: JSON.stringify(jobs),
  };
}

function ghCheckRunsResponse(checkRuns) {
  return {
    cmd: 'gh',
    args: ['api', 'repos/Kanevry/session-orchestrator/commits/HEAD/check-runs'],
    stdout: JSON.stringify({ check_runs: checkRuns }),
  };
}

// ── Test 1: GitLab green ──────────────────────────────────────────────────────

describe('checkCiStatus — GitLab green', () => {
  it('returns status=green ok=true when current SHA pipeline is success', async () => {
    const pipelines = [
      { id: 101, sha: HEAD_SHA, status: 'success', created_at: '2026-05-10T10:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabRepoViewResponse,
      glabPipelinesResponse(pipelines),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('green');
    expect(result.ok).toBe(true);
    expect(result.details.cliUsed).toBe('glab');
    expect(result.details.currentPipelineId).toBe(101);
  });
});

// ── Test 2: GitLab red with last-green ────────────────────────────────────────

describe('checkCiStatus — GitLab red with last-green', () => {
  it('returns status=red, redCount=3, correct lastGreen.pipelineId, failingJobName', async () => {
    const OLD_GREEN_SHA = 'aaa000bbb111ccc222ddd333eee444fff55566677';
    const pipelines = [
      { id: 104, sha: HEAD_SHA, status: 'failed',  created_at: '2026-05-10T11:00:00Z' },
      { id: 103, sha: 'sha2',   status: 'failed',  created_at: '2026-05-09T11:00:00Z' },
      { id: 102, sha: 'sha3',   status: 'failed',  created_at: '2026-05-08T11:00:00Z' },
      { id: 101, sha: OLD_GREEN_SHA, status: 'success', created_at: '2026-05-07T11:00:00Z' },
    ];

    const jobs = [
      { name: 'test', status: 'success' },
      { name: 'lint', status: 'failed' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabRepoViewResponse,
      glabPipelinesResponse(pipelines),
      glabJobsResponse(104, jobs),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('red');
    expect(result.ok).toBe(false);
    expect(result.redCount).toBe(3);
    expect(result.lastGreen).toBeDefined();
    expect(result.lastGreen.pipelineId).toBe(101);
    expect(result.lastGreen.sha).toBe(OLD_GREEN_SHA);
    expect(result.lastGreen.ageDays).toBe(3); // 2026-05-07 → 2026-05-10 = 3 days
    expect(result.lastGreen.ageCommits).toBe(3); // ageCommits === redCount (3 failed pipelines before last-green)
    expect(result.failingJobName).toBe('lint');
    expect(result.details.cliUsed).toBe('glab');
    expect(result.details.currentPipelineId).toBe(104);
  });
});

// ── Test 3: glab missing (ENOENT) ─────────────────────────────────────────────

describe('checkCiStatus — glab not in PATH', () => {
  it('returns null when glab execFile throws ENOENT', async () => {
    const enoentError = new Error('spawn glab ENOENT');
    enoentError.code = 'ENOENT';

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      // glab repo view → ENOENT
      { cmd: 'glab', error: enoentError },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
  });
});

// ── Test 4: GitHub green ──────────────────────────────────────────────────────

describe('checkCiStatus — GitHub green', () => {
  it('returns status=green ok=true when all check_runs have conclusion=success', async () => {
    const checkRuns = [
      { name: 'test', conclusion: 'success' },
      { name: 'lint', conclusion: 'success' },
      { name: 'typecheck', conclusion: 'success' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      ghRepoViewResponse,
      ghCheckRunsResponse(checkRuns),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('green');
    expect(result.ok).toBe(true);
    expect(result.details.cliUsed).toBe('gh');
  });
});

// ── Test 5: GitHub red ────────────────────────────────────────────────────────

describe('checkCiStatus — GitHub red', () => {
  it('returns status=red, failingJobName set when a check run has conclusion=failure', async () => {
    const checkRuns = [
      { name: 'test', conclusion: 'success' },
      { name: 'security-scan', conclusion: 'failure' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      ghRepoViewResponse,
      ghCheckRunsResponse(checkRuns),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('red');
    expect(result.ok).toBe(false);
    expect(result.failingJobName).toBe('security-scan');
    expect(result.details.cliUsed).toBe('gh');
    expect(result.details.reason).toBe('lastGreen-not-implemented-for-github');
  });
});

// ── Test 6: Non-VCS repo ──────────────────────────────────────────────────────

describe('checkCiStatus — non-VCS repo', () => {
  it('returns null when git remote get-url throws (no git origin)', async () => {
    const gitError = new Error('fatal: No such remote');
    gitError.code = 128;

    const mockExecFile = makeExecFileMock([
      { cmd: 'git', args: ['remote', 'get-url', 'origin'], error: gitError },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/not/a/vcs/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
  });
});

// ── Test 7: Timeout ───────────────────────────────────────────────────────────

describe('checkCiStatus — timeout', () => {
  it('returns null when CLI invocation exceeds timeoutMs', async () => {
    // Mock execFile that never calls callback → simulates a hung process.
    const hangingMock = vi.fn(function (_cmd, _args, _opts, _callback) {
      // Never invoke callback → the promise race should win via timeout.
    });

    // Use a very short timeout so the test doesn't actually wait.
    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', timeoutMs: 10, now: NOW },
      { execFile: hangingMock },
    );

    expect(result).toBeNull();
  });
});

// ── Test 8: GitLab running pipeline → unknown ─────────────────────────────────

describe('checkCiStatus — GitLab pipeline running', () => {
  it('returns status=unknown ok=false when current pipeline is running', async () => {
    const pipelines = [
      { id: 105, sha: HEAD_SHA, status: 'running', created_at: '2026-05-10T11:30:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabRepoViewResponse,
      glabPipelinesResponse(pipelines),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('unknown');
    expect(result.ok).toBe(false);
    expect(result.details.reason).toMatch(/running/);
  });
});

// ── Test 9: No pipeline found for HEAD SHA ────────────────────────────────────

describe('checkCiStatus — no pipeline for HEAD SHA', () => {
  it('returns status=unknown when no pipeline matches current SHA', async () => {
    const pipelines = [
      { id: 100, sha: 'other-sha-not-head', status: 'success', created_at: '2026-05-09T10:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabRepoViewResponse,
      glabPipelinesResponse(pipelines),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('unknown');
    expect(result.details.reason).toBe('no-pipeline-for-head-sha');
  });
});

// ── Test 10: VCS forced override ─────────────────────────────────────────────

describe('checkCiStatus — forced vcs', () => {
  it('skips VCS detection when vcs is forced to gitlab', async () => {
    const pipelines = [
      { id: 201, sha: HEAD_SHA, status: 'success', created_at: '2026-05-10T10:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      // No git remote get-url call expected — vcs is forced.
      gitRevParseResponse(HEAD_SHA),
      glabRepoViewResponse,
      glabPipelinesResponse(pipelines),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', vcs: 'gitlab', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('green');
    expect(result.ok).toBe(true);
  });
});

// ── Test 11: DEFAULT_TIMEOUT_MS export ───────────────────────────────────────

describe('DEFAULT_TIMEOUT_MS constant', () => {
  it('equals 8000', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(8000);
  });
});

// ── Test 12: GitLab red — no lastGreen in history ────────────────────────────

describe('checkCiStatus — GitLab red with no prior green', () => {
  it('returns status=red without lastGreen when all history is failed', async () => {
    const pipelines = [
      { id: 203, sha: HEAD_SHA, status: 'failed', created_at: '2026-05-10T11:00:00Z' },
      { id: 202, sha: 'sha2',   status: 'failed', created_at: '2026-05-09T11:00:00Z' },
    ];

    const jobs = [{ name: 'build', status: 'failed' }];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabRepoViewResponse,
      glabPipelinesResponse(pipelines),
      glabJobsResponse(203, jobs),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('red');
    expect(result.ok).toBe(false);
    expect(result.lastGreen).toBeUndefined();
    expect(result.redCount).toBe(2);
    expect(result.failingJobName).toBe('build');
  });
});

// ── Test 13: GitHub action_required → red ────────────────────────────────────

describe('checkCiStatus — GitHub action_required → red', () => {
  it('treats action_required as red and surfaces failingJobName', async () => {
    const checkRuns = [
      { name: 'approve-deploy', conclusion: 'action_required' },
      { name: 'test', conclusion: 'success' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      ghRepoViewResponse,
      ghCheckRunsResponse(checkRuns),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('red');
    expect(result.failingJobName).toBe('approve-deploy');
  });
});

// ── Test 14: never throws ─────────────────────────────────────────────────────

describe('checkCiStatus — never throws', () => {
  it('does not throw when called with a mock that immediately errors', async () => {
    // Use a mock that errors out immediately (simulates "no git" environment).
    const errorMock = makeExecFileMock([
      { cmd: 'git', error: new Error('fatal: not a git repository') },
    ]);
    const result = await checkCiStatus({ repoRoot: '/tmp' }, { execFile: errorMock });
    expect(result).toBeNull();
  });

  it('returns null on malformed JSON from glab pipelines API', async () => {
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabRepoViewResponse,
      // Return garbage JSON for the pipelines call.
      {
        cmd: 'glab',
        args: ['api', 'projects/42/pipelines?order_by=updated_at&sort=desc&per_page=15'],
        stdout: 'not-valid-json{{{',
      },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
  });
});
