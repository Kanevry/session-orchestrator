import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkCiStatus as checkCiStatusReal } from '@lib/ci-status-banner.mjs';

// ── stderr WARN capture (#1022 follow-up) ────────────────────────────────────
//
// `checkCiStatus` returns `null` for BOTH "no CI to report" and "the CLI was
// present but the invocation failed" — the return contract is shared with 13
// sibling banners and cannot distinguish them. The only observable difference
// is a `console.warn` line, which is therefore the single visibility mechanism
// for the whole #1022 defect class ("CLI installed, call rejected"). Spying it
// file-wide both silences the pre-existing failure-path tests and makes the
// warn assertable; `mockImplementation` keeps the real console quiet.
let warnSpy;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

// ── #1065 GitLab API target DI default ─────────────────────────────────────
//
// GitLab CI requests derive one { host, encodedProjectPath } target from the
// sanitized preferred remote. The production resolver shells out synchronously
// through the shared remote core, while this file injects async `execFile`.
// Keep ordinary banner tests hermetic by providing the resolved target directly.
// GitHub retains its #872 resolveRepoSpec/resolveRepoHost seams unchanged.
function checkCiStatus(opts, deps = {}) {
  return checkCiStatusReal(opts, {
    resolveRepoSpec: () => undefined,
    resolveRepoHost: () => undefined,
    resolveGitlabProjectTarget: () => GITLAB_PROJECT_TARGET,
    ...deps,
  });
}

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
      // FULL-argv equality, not a prefix match (#1022). A prefix matcher keys
      // on `entry.args` being a PREFIX of the real argv, so it stays green for
      // any suffix the production code appends — including a flag the CLI
      // rejects. That is what let `gh repo view … -R <spec>` be both mocked
      // and asserted here while the real binary exited 1 on it. An entry that
      // omits `args` still matches on `cmd` alone (used for error stubs).
      const argsMatch =
        !entry.args ||
        (Array.isArray(entry.args) &&
          entry.args.length === args.length &&
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

const GITLAB_ORIGIN = 'https://gitlab.example.com/org/session-orchestrator.git';
const GITHUB_ORIGIN = 'https://github.com/Kanevry/session-orchestrator.git';

const GITLAB_PROJECT_TARGET = {
  host: 'gitlab.example.com',
  encodedProjectPath: 'org%2Fsession-orchestrator',
};
const GH_REPO_VIEW = JSON.stringify({ nameWithOwner: 'Kanevry/session-orchestrator' });

// `git remote -v` stub (#1039). The probe no longer asks for a remote BY NAME
// (`remote get-url origin`), so the argv can no longer pin which remote is
// selected — it enumerates all of them and the selection happens in
// `detectVcsFamily`. Every assertion that used to ride on the old argv pin has
// therefore moved onto the RESOLVED VALUE (`details.cliUsed`), with a losing
// second remote present so the assertion cannot be satisfied by any arbitrary
// resolver; see the "remote selection" describe block below.
//
// Accepts either a bare URL (shorthand for a single remote named `origin`,
// which is what every pre-#1039 call site here means) or `[name, url]` pairs.
// Emits git's real two-lines-per-remote `(fetch)`/`(push)` shape, tab-separated.
function gitRemoteResponse(...entries) {
  const remotes = entries.map((entry) =>
    typeof entry === 'string' ? ['origin', entry] : entry,
  );
  const stdout = remotes
    .map(([name, url]) => `${name}\t${url} (fetch)\n${name}\t${url} (push)\n`)
    .join('');
  return { cmd: 'git', args: ['remote', '-v'], stdout };
}

function gitRevParseResponse(sha) {
  return { cmd: 'git', args: ['rev-parse', 'HEAD'], stdout: sha + '\n' };
}

const ghRepoViewResponse = {
  cmd: 'gh',
  args: ['repo', 'view', '--json', 'nameWithOwner'],
  stdout: GH_REPO_VIEW,
};

function glabPipelinesResponse(pipelines) {
  return {
    cmd: 'glab',
    args: [
      'api',
      'projects/org%2Fsession-orchestrator/pipelines?order_by=updated_at&sort=desc&per_page=15',
      '--hostname',
      'gitlab.example.com',
    ],
    stdout: JSON.stringify(pipelines),
  };
}

function glabJobsResponse(pipelineId, jobs) {
  return {
    cmd: 'glab',
    args: [
      'api',
      `projects/org%2Fsession-orchestrator/pipelines/${pipelineId}/jobs`,
      '--hostname',
      'gitlab.example.com',
    ],
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

// ── Test 1b: GitLab green hiding a failed allow_failure job ───────────────────
//
// Bug this catches: a pipeline reports `status: success` even when a job with
// `allow_failure: true` failed. Reading only the pipeline status reports a
// clean green and stays silent, so a job that is red on every single pipeline
// (observed in the field: 4 of 4 consecutive runs) never surfaces at all.
// Every pre-existing green test asserts `status === 'green'` only, so none of
// them would fail if the job list were ignored again.

describe('checkCiStatus — GitLab green with a soft-failed job', () => {
  it('names failed allow_failure jobs while still reporting green', async () => {
    const pipelines = [
      { id: 101, sha: HEAD_SHA, status: 'success', created_at: '2026-05-10T10:00:00Z' },
    ];
    const jobs = [
      { name: 'build', status: 'success', allow_failure: false },
      { name: 'test lighthouse', status: 'failed', allow_failure: true },
      { name: 'audit', status: 'failed', allow_failure: true },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(101, jobs),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    // The pipeline genuinely is green — that verdict must not flip.
    expect(result.status).toBe('green');
    expect(result.ok).toBe(true);
    // ...but the soft failures are now nameable.
    expect(result.allowFailureJobs).toEqual(['test lighthouse', 'audit']);
  });

  it('omits allowFailureJobs when every job passed', async () => {
    const pipelines = [
      { id: 101, sha: HEAD_SHA, status: 'success', created_at: '2026-05-10T10:00:00Z' },
    ];
    // A job may carry allow_failure: true and still succeed — that is not a finding.
    const jobs = [
      { name: 'build', status: 'success', allow_failure: false },
      { name: 'test lighthouse', status: 'success', allow_failure: true },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(101, jobs),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('green');
    expect(result.allowFailureJobs).toBeUndefined();
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
      // glab API request → ENOENT
      { cmd: 'glab', error: enoentError },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
    // A missing CLI is a normal, expected state on a machine without glab —
    // it must stay SILENT. If the WARN below fires here, every session-start
    // on a CLI-less machine prints a meaningless warning and the signal that
    // the WARN exists to carry (#1022: CLI present, call rejected) drowns.
    expect(warnSpy.mock.calls).toHaveLength(0);
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
  it('returns null SILENTLY when git reports the path is not a work tree', async () => {
    // Exit 128 is what `git remote -v` returns outside a work tree. Async
    // execFile reports the child's exit status in `err.code` as a NUMBER
    // (the spawn errno would be the STRING 'ENOENT') — the production
    // classifier discriminates on exactly that type difference.
    const gitError = new Error('fatal: not a git repository');
    gitError.code = 128;

    const mockExecFile = makeExecFileMock([
      { cmd: 'git', args: ['remote', '-v'], error: gitError },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/not/a/vcs/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
    // Running outside a repo is a legitimate, benign state — the same silence
    // the glab-ENOENT test above demands. Warning here would print on every
    // session-start in a non-repo directory and train the operator to skip the
    // line that carries the `git-unavailable` / `git-error` signal.
    expect(warnSpy.mock.calls).toHaveLength(0);
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

describe('checkCiStatus — error containment', () => {
  it('returns null on malformed JSON from glab pipelines API', async () => {
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      // Return garbage JSON for the pipelines call.
      {
        cmd: 'glab',
        args: [
          'api',
          'projects/org%2Fsession-orchestrator/pipelines?order_by=updated_at&sort=desc&per_page=15',
          '--hostname',
          'gitlab.example.com',
        ],
        stdout: 'not-valid-json{{{',
      },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
  });

  // Bug this catches (TV-001): an expired `gh` auth makes `gh repo view` print
  // an HTML login page on stdout with exit 0. The banner already survived that
  // — measured at 30940cb, it returned null — but the warn read
  // `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, which names
  // NEITHER the CLI nor the request. This banner spawns four different
  // subprocesses (git remote -v, git rev-parse, gh repo view, gh api), so that
  // line left an operator unable to tell which one returned garbage — the same
  // "could not read is indistinguishable from nothing to report" class as
  // #1022. The sibling test above covers the glab path's null; this one covers
  // the GitHub path AND the identification the warn channel owes.
  //
  // Goes red if `parseCliJson`'s try/catch is removed: the outer catch still
  // returns null, so only the message discriminates.
  it('names the failing gh command when its stdout is not JSON', async () => {
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      // gh with an expired session: an HTML login page, exit 0.
      { cmd: 'gh', stdout: '<!DOCTYPE html><html><body>Sign in to GitHub</body></html>' },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
    expect(warnSpy.mock.calls).toHaveLength(1);
    const [message] = warnSpy.mock.calls[0];
    expect(message).toContain('gh repo view --json nameWithOwner');
    expect(message).toContain('returned unparseable JSON');
    // The payload preview is what proves WHICH garbage came back.
    expect(message).toContain('<!DOCTYPE html>');
  });

  // Bug this catches (TV-001): the preview is raw stdout from a subprocess this
  // module does not control, printed into a `console.warn` that sits beside the
  // session-start banner. Interpolated verbatim, a payload carrying ANSI escapes
  // and a CR could repaint or overwrite the lines around it — a CLI answer
  // choosing what the operator's terminal shows. `JSON.stringify` escapes every
  // control byte, so the preview is one line of printable text. RED without it:
  // the raw ESC and CR reach the warn.
  it('escapes control bytes in the payload preview instead of printing them raw', async () => {
    const hostile = '\u001b[2J\u001b[H\rCI: all green{';
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      { ...ghRepoViewResponse, stdout: hostile },
    ]);

    const result = await checkCiStatus({ repoRoot: '/fake/repo', now: NOW }, { execFile: mockExecFile });

    expect(result).toBeNull();
    const [message] = warnSpy.mock.calls[0];
    expect(message).toContain('returned unparseable JSON');
    // The bytes are reported, but as escape SEQUENCES, never as control bytes.
    // eslint-disable-next-line no-control-regex -- matching control bytes is the assertion
    expect(message).not.toMatch(/[\u0000-\u001f]/);
    expect(message).toContain('\\u001b[2J');
    expect(message).toContain('\\r');
  });

  // ── wrong SHAPE, not wrong syntax (2026-08-28, W4 panel SEC-LOW-2) ─────────
  //
  // Bug this catches (TV-001): the two tests above cover payloads that fail to
  // PARSE. A payload that parses cleanly into the wrong TYPE escaped the named
  // channel entirely, and did so differently at each of the three call sites:
  //
  //   `gh repo view` → `null`  reached `const { nameWithOwner } = …` and threw
  //     a bare `TypeError: Cannot destructure property 'nameWithOwner' of
  //     'null'` — an operator-facing line naming neither CLI nor request.
  //   `gh api …/check-runs` → `null` reached `data.check_runs` and threw the
  //     same bare TypeError one frame later.
  //   `glab api …/pipelines` → any non-array was swallowed by
  //     `!Array.isArray(pipelines) → return null`: SILENT, indistinguishable
  //     from "no CI to report".
  //
  // TV-004: the HTML row is asserted here only for `gh api`, the one label the
  // two tests above do not already cover. Re-running HTML through `glab api`
  // and `gh repo view` would duplicate them.
  it.each([
    ['glab api', 'pipelines', 'null', 'expected an array, got null'],
    ['glab api', 'pipelines', '"ok"', 'expected an array, got string'],
    ['gh api', 'check-runs', 'null', 'expected an object, got null'],
    ['gh api', 'check-runs', '[]', 'expected an object, got array'],
    ['gh api', 'check-runs', '"ok"', 'expected an object, got string'],
    ['gh api', 'check-runs', '<!DOCTYPE html><html>Sign in</html>', 'returned unparseable JSON'],
    ['gh repo view', 'nameWithOwner', 'null', 'expected an object, got null'],
    ['gh repo view', 'nameWithOwner', '[]', 'expected an object, got array'],
    ['gh repo view', 'nameWithOwner', '"ok"', 'expected an object, got string'],
  ])('names %s (%s) when its stdout is %s', async (site, _what, payload, fragment) => {
    const result = await runWithStdout(site, payload);

    expect(result).toBeNull();
    expect(warnSpy.mock.calls).toHaveLength(1);
    const [message] = warnSpy.mock.calls[0];
    // The identification the warn channel owes: WHICH subprocess answered.
    expect(message).toContain(site);
    expect(message).toContain(fragment);
  });

  // The other half of the same gate, and the reason the grid above has no
  // `['glab api', …, '[]', …]` row: on the array site an empty array is a
  // LEGITIMATE answer ("this project has no pipelines"), not a shape failure.
  // A gate that warned here would fire on a correct response.
  it('treats an empty pipelines array as a real answer, not a shape failure', async () => {
    const result = await runWithStdout('glab api', '[]');

    expect(result).toEqual(expect.objectContaining({
      status: 'unknown',
      details: expect.objectContaining({ reason: 'no-pipeline-for-head-sha' }),
    }));
    expect(warnSpy.mock.calls).toHaveLength(0);
  });
});

/**
 * Drive `checkCiStatus` to the point where ONE named subprocess returns
 * `stdout`, and stub every earlier call with a valid response.
 *
 * @param {'glab api'|'gh api'|'gh repo view'} site
 * @param {string} stdout  Raw payload the site's CLI should print
 */
function runWithStdout(site, stdout) {
  const opts = { repoRoot: '/fake/repo', now: NOW };
  if (site === 'glab api') {
    return checkCiStatus(opts, {
      execFile: makeExecFileMock([
        gitRemoteResponse(GITLAB_ORIGIN),
        gitRevParseResponse(HEAD_SHA),
        { ...glabPipelinesResponse([]), stdout },
      ]),
    });
  }
  if (site === 'gh repo view') {
    return checkCiStatus(opts, {
      execFile: makeExecFileMock([
        gitRemoteResponse(GITHUB_ORIGIN),
        { ...ghRepoViewResponse, stdout },
      ]),
    });
  }
  return checkCiStatus(opts, {
    execFile: makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      ghRepoViewResponse,
      { ...ghCheckRunsResponse([]), stdout },
    ]),
  });
}

// ── Test 15: #1065 GitLab API target — no ambient project lookup ─────────────

describe('checkCiStatus — #1065 GitLab API target', () => {
  // Bug: `glab repo view` resolves a numeric ID through ambient GitLab config,
  // so a correct remote can still query an unrelated project on another host.
  it('uses the encoded remote project path and hostname for every GitLab request', async () => {
    const target = {
      host: 'gitlab.example.com',
      encodedProjectPath: 'example-group%2Fsubgroup%2Fexample-project',
    };
    const pipelines = [
      { id: 101, sha: HEAD_SHA, status: 'success', created_at: '2026-05-10T10:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      {
        cmd: 'glab',
        args: [
          'api',
          'projects/example-group%2Fsubgroup%2Fexample-project/pipelines?order_by=updated_at&sort=desc&per_page=15',
          '--hostname',
          'gitlab.example.com',
        ],
        stdout: JSON.stringify(pipelines),
      },
      {
        cmd: 'glab',
        args: [
          'api',
          'projects/example-group%2Fsubgroup%2Fexample-project/pipelines/101/jobs',
          '--hostname',
          'gitlab.example.com',
        ],
        stdout: JSON.stringify([]),
      },
    ]);

    const result = await checkCiStatusReal(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile, resolveGitlabProjectTarget: () => target },
    );

    expect(result).toEqual({
      status: 'green',
      ok: true,
      details: { currentPipelineId: 101, cliUsed: 'glab' },
    });
    expect(mockExecFile.mock.calls.filter(([cmd, args]) => cmd === 'glab' && args[0] === 'repo' && args[1] === 'view')).toHaveLength(0);
    expect(mockExecFile.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
      ['git', ['remote', '-v']],
      ['git', ['rev-parse', 'HEAD']],
      [
        'glab',
        [
          'api',
          'projects/example-group%2Fsubgroup%2Fexample-project/pipelines?order_by=updated_at&sort=desc&per_page=15',
          '--hostname',
          'gitlab.example.com',
        ],
      ],
      [
        'glab',
        [
          'api',
          'projects/example-group%2Fsubgroup%2Fexample-project/pipelines/101/jobs',
          '--hostname',
          'gitlab.example.com',
        ],
      ],
    ]);
  });

  // Bug: starting bare glab when either half of the API target is unknown lets
  // GITLAB_HOST and unrelated ambient repository state choose the project.
  it('warns instead of going silent when a GitLab host/path cannot be proven', async () => {
    const mockExecFile = makeExecFileMock([]);

    const result = await checkCiStatusReal(
      { repoRoot: '/fake/repo', vcs: 'gitlab', now: NOW },
      { execFile: mockExecFile, resolveGitlabProjectTarget: () => undefined },
    );

    expect(result).toBeNull();
    expect(mockExecFile).not.toHaveBeenCalled();
    // A GitLab remote WAS detected; only its form was rejected. That is a query
    // failure, not an absence, so silence here would restore exactly the
    // pre-#1039 state this module's own rule forbids: "CI green" and "could not
    // ask" rendering identically. Pinning toHaveLength(0) pinned that silence.
    expect(warnSpy.mock.calls).toHaveLength(1);
    expect(warnSpy.mock.calls[0][0]).toContain('CI state is UNKNOWN, not "green"');
  });

  // Bug: an API response containing benign metadata but no pipeline array could
  // escape as a result, exposing implementation-only sentinel data.
  //
  // The silence half of this test was itself a defect and was inverted on
  // 2026-08-28 (W4 panel, QA-LOW). `glab api …/pipelines` returning valid JSON
  // of the wrong shape is a QUERY FAILURE — the CLI answered, and the module
  // could not read the answer — so collapsing it onto a bare `null` restored
  // exactly the "could not ask" == "nothing to report" confusion #1039 fixed
  // one layer up. It now warns. What must still NOT escape is the payload:
  // the shape error names the JSON TYPE only, which is why the sentinel
  // assertion below is unchanged and still discriminating.
  it('warns without echoing the payload for unexpected benign pipeline metadata', async () => {
    const benignMetadataSentinel = 'benign-pipeline-metadata-sentinel';
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      {
        cmd: 'glab',
        args: [
          'api',
          'projects/org%2Fsession-orchestrator/pipelines?order_by=updated_at&sort=desc&per_page=15',
          '--hostname',
          'gitlab.example.com',
        ],
        stdout: JSON.stringify({ metadata: benignMetadataSentinel }),
      },
    ]);

    const result = await checkCiStatusReal(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile, resolveGitlabProjectTarget: () => GITLAB_PROJECT_TARGET },
    );

    expect(result).toBeNull();
    expect(warnSpy.mock.calls).toHaveLength(1);
    expect(warnSpy.mock.calls[0][0]).toContain('returned JSON of an unexpected shape');
    expect(warnSpy.mock.calls[0][0]).toContain('expected an array, got object');
    expect(JSON.stringify([result, warnSpy.mock.calls])).not.toContain(benignMetadataSentinel);
  });
});

// ── Test 16: #872 host-pinning — GitHub (-R on repo view, --hostname on api) ──

describe('checkCiStatus — #872/#1022 GitHub host-pinning', () => {
  it('pins `gh repo view` with a POSITIONAL <spec> (never -R) and `gh api` with --hostname <host>', async () => {
    const spec = 'github.example.com/owner/repo';
    const host = 'github.example.com';
    const checkRuns = [{ name: 'test', conclusion: 'success' }];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      { cmd: 'gh', args: ['repo', 'view', spec, '--json', 'nameWithOwner'], stdout: GH_REPO_VIEW },
      {
        cmd: 'gh',
        args: ['api', 'repos/Kanevry/session-orchestrator/commits/HEAD/check-runs', '--hostname', host],
        stdout: JSON.stringify({ check_runs: checkRuns }),
      },
    ]);

    const result = await checkCiStatusReal(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile, resolveRepoSpec: () => spec, resolveRepoHost: () => host },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('green');

    // #1022: assert the FULL argv, not `toContain('-R')`. `gh repo view` has
    // no -R/--repo flag — it exits 1 with "unknown shorthand flag: 'R'", which
    // checkCiStatus swallows to null, killing the banner on every GitHub repo.
    // A containment assert cannot see a wrong flag or a wrong argument order;
    // only the exact argv pins the shape the real binary accepts.
    const [, repoViewArgs] = mockExecFile.mock.calls.find(
      ([cmd, args]) => cmd === 'gh' && args.includes('view'),
    );
    expect(repoViewArgs).toEqual(['repo', 'view', spec, '--json', 'nameWithOwner']);

    const [, checkRunsArgs] = mockExecFile.mock.calls.find(
      ([cmd, args]) => cmd === 'gh' && args.includes('api'),
    );
    expect(checkRunsArgs).toEqual([
      'api',
      'repos/Kanevry/session-orchestrator/commits/HEAD/check-runs',
      '--hostname',
      host,
    ]);
  });
});

// ── Test 17: #1022 the stderr WARN is the only trace a rejected call leaves ───
//
// The argv pin above guards against THIS flag defect. The WARN is the catcher
// for the NEXT one: it is the sole difference between "CLI ran, call rejected"
// and "nothing to report", both of which return null. Untested, it is itself a
// silent-failure candidate — the exact shape of the bug it exists to surface.

describe('checkCiStatus — #1022 rejected-invocation WARN', () => {
  it('warns once and returns null when the CLI ran but rejected the invocation', async () => {
    // Golden shape of a Node execFile rejection: `Command failed: <argv>` plus
    // the child's stderr appended, `code` = the child's exit status.
    const rejectedFlag = new Error(
      "Command failed: gh repo view -R Kanevry/session-orchestrator --json nameWithOwner\n" +
        "unknown shorthand flag: 'R' in -R Kanevry/session-orchestrator\n",
    );
    rejectedFlag.code = 1;
    rejectedFlag.stderr = "unknown shorthand flag: 'R' in -R Kanevry/session-orchestrator\n";

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      { cmd: 'gh', error: rejectedFlag },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    // The return contract is shared with 13 sibling banners — null stays null.
    expect(result).toBeNull();
    // …so the WARN carries the whole signal. Exactly one, with the child's own
    // error text verbatim: an operator cannot act on "something failed".
    expect(warnSpy.mock.calls).toEqual([
      [
        'WARN ci-status-banner: CI status check failed, banner suppressed — ' +
          'Command failed: gh repo view -R Kanevry/session-orchestrator --json nameWithOwner\n' +
          "unknown shorthand flag: 'R' in -R Kanevry/session-orchestrator\n",
      ],
    ]);
  });

  // Bug: a GitLab API failure can still echo a credential-bearing URL from an
  // external error; the warning path must retain its source-level redaction.
  it('redacts URL-embedded credentials out of a rejected GitLab API warning', async () => {
    const credentialedUrl =
      'https://ci-bot:glpat-xxxxxxxxxxxx@gitlab.example.com/org/session-orchestrator.git';
    const rejected = new Error(
      'Command failed: glab api projects/org%2Fsession-orchestrator/pipelines --hostname gitlab.example.com ' +
        credentialedUrl + '\nexit status 1\n',
    );
    rejected.code = 1;

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      { cmd: 'glab', error: rejected },
    ]);

    const result = await checkCiStatusReal(
      { repoRoot: '/fake/repo', now: NOW },
      {
        execFile: mockExecFile,
        resolveGitlabProjectTarget: () => GITLAB_PROJECT_TARGET,
      },
    );

    expect(result).toBeNull();
    expect(warnSpy.mock.calls).toEqual([
      [
        'WARN ci-status-banner: CI status check failed, banner suppressed — ' +
          'Command failed: glab api projects/org%2Fsession-orchestrator/pipelines --hostname gitlab.example.com ' +
          'https://***@gitlab.example.com/org/session-orchestrator.git\nexit status 1\n',
      ],
    ]);
    expect(warnSpy.mock.calls[0][0]).not.toContain('ci-bot');
    expect(warnSpy.mock.calls[0][0]).not.toContain('glpat-');
  });
});

// ── Test 18: #1039 remote selection is no longer the literal `origin` ─────────
//
// Bug this catches: the probe ran `git remote get-url origin`. In a repo whose
// remotes are named `gitlab`/`github` — a shape this very repo's sibling clones
// use — that call fails, the caller swallowed the failure to `null`, and the
// banner was STRUCTURALLY DARK: it could never report anything, not even a red
// pipeline. Nothing in the pre-#1039 suite noticed, because every fixture
// stubbed exactly one remote and named it `origin`.
//
// These three cases also carry the statement the old `args: ['remote',
// 'get-url', 'origin']` matcher used to make. That pin is gone with the argv
// (the probe now enumerates remotes and selects among them), so the statement
// moved onto the RESOLVED VALUE — `details.cliUsed` — and every case below
// plants a LOSING second remote of the other family. Without that loser the
// value assertion would be tautological: with one remote configured, any
// resolver whatsoever returns the same answer.

describe('checkCiStatus — #1039 remote selection', () => {
  const pipelines = [
    { id: 101, sha: HEAD_SHA, status: 'success', created_at: '2026-05-10T10:00:00Z' },
  ];

  it('still produces a banner in a repo with `gitlab` + `github` remotes and NO `origin`', async () => {
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(['gitlab', GITLAB_ORIGIN], ['github', GITHUB_ORIGIN]),
      gitRevParseResponse(HEAD_SHA),
      glabPipelinesResponse(pipelines),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    // The whole point: NOT null. Pre-#1039 this returned null for every repo
    // in this shape, silently, forever.
    expect(result).not.toBeNull();
    expect(result.status).toBe('green');
    // `gitlab` beats `github` in the vcs-less preference order — the losing
    // remote is real and present, so this cannot pass by accident.
    expect(result.details.cliUsed).toBe('glab');
  });

  it('prefers `origin` (gitlab) over a losing `github` remote', async () => {
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(['origin', GITLAB_ORIGIN], ['github', GITHUB_ORIGIN]),
      gitRevParseResponse(HEAD_SHA),
      glabPipelinesResponse(pipelines),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    // This repo's own shape (GitLab primary + GitHub mirror). git lists
    // remotes alphabetically, so `github` comes FIRST in the enumeration — a
    // resolver that took the first classifiable remote would answer 'gh' here
    // and re-namespace every downstream query onto the mirror.
    expect(result.details.cliUsed).toBe('glab');
  });

  it('prefers `origin` (github) over a losing `gitlab` remote', async () => {
    const checkRuns = [{ name: 'test', conclusion: 'success' }];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(['origin', GITHUB_ORIGIN], ['gitlab', GITLAB_ORIGIN]),
      ghRepoViewResponse,
      ghCheckRunsResponse(checkRuns),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    // Mirror image of the case above: same preference rule, opposite answer.
    // A resolver hard-wired to "gitlab unless proven otherwise" passes the
    // previous test and fails this one.
    expect(result.details.cliUsed).toBe('gh');
  });
});

// ── Test 19: #1039 GitHub Enterprise is not GitLab ───────────────────────────

describe('checkCiStatus — #1039 GitHub Enterprise host classification', () => {
  it('classifies git@github.example.com:o/r.git as github, not gitlab', async () => {
    // Bug this catches: the old test was `remoteUrl.includes('github.com')`.
    // A GitHub Enterprise host contains no `github.com` substring, so every
    // Enterprise repo fell through to the gitlab branch and the banner drove
    // `glab` at a GitHub instance — a guaranteed failure, swallowed to null.
    const checkRuns = [{ name: 'test', conclusion: 'success' }];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse('git@github.example.com:Kanevry/session-orchestrator.git'),
      ghRepoViewResponse,
      ghCheckRunsResponse(checkRuns),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).not.toBeNull();
    expect(result.status).toBe('green');
    expect(result.details.cliUsed).toBe('gh');
    // No glab stub is registered, so a gitlab misclassification cannot pass
    // quietly — it hits the mock's unexpected-call guard and returns null.
  });
});

// ── Test 20: #1039 absence stays silent, query failure warns ─────────────────
//
// Bug this catches: this module's own comment forbids a fifth silent path
// ("could not read" reported as "all clear"). Before #1039 the VCS probe had
// exactly one: git missing from PATH, git erroring, and a repo with no remotes
// all produced the same bare `null`. The WARN is the only observable difference
// the shared two-state return contract leaves available.

describe('checkCiStatus — #1039 VCS-detection failure taxonomy', () => {
  it('stays SILENT when git answers cleanly that there are no remotes', async () => {
    // Exit 0, empty stdout — a fresh `git init`. The question WAS answered.
    const mockExecFile = makeExecFileMock([
      { cmd: 'git', args: ['remote', '-v'], stdout: '' },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
    expect(warnSpy.mock.calls).toHaveLength(0);
  });

  it('WARNS with reason `git-unavailable` when git is not on PATH', async () => {
    const enoent = new Error('spawn git ENOENT');
    enoent.code = 'ENOENT'; // string errno — NOT an exit status

    const mockExecFile = makeExecFileMock([
      { cmd: 'git', args: ['remote', '-v'], error: enoent },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
    expect(warnSpy.mock.calls).toHaveLength(1);
    const [message] = warnSpy.mock.calls[0];
    // The reason token is what separates this from the silent absence paths.
    expect(message).toContain('git-unavailable');
    // The honesty clause — a suppressed banner is not a green one.
    expect(message).toContain('not "green"');
  });

  it('WARNS with reason `git-error` on any other git failure, credentials redacted', async () => {
    const failed = new Error('Command failed: git remote -v');
    failed.code = 1;
    // git's own stderr can quote a remote URL, and this WARN now forwards it —
    // so the redactor has to run on that path too, not just on the CLI-side
    // message the pre-existing #907 test covers.
    failed.stderr =
      "fatal: could not read Username for 'https://ci-bot:glpat-xxxxxxxxxxxx@gitlab.example.com'\n";

    const mockExecFile = makeExecFileMock([
      { cmd: 'git', args: ['remote', '-v'], error: failed },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result).toBeNull();
    expect(warnSpy.mock.calls).toHaveLength(1);
    const [message] = warnSpy.mock.calls[0];
    expect(message).toContain('git-error');
    expect(message).toContain('gitlab.example.com');
    expect(message).not.toContain('ci-bot');
    expect(message).not.toContain('glpat-');
  });
});
