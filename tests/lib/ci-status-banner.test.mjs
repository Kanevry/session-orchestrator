import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { checkCiStatus as checkCiStatusReal, DEGRADED_REASONS } from '@lib/ci-status-banner.mjs';

// ── stderr WARN capture (#1022 follow-up) ────────────────────────────────────
//
// Until #1031 `checkCiStatus` returned `null` for BOTH "no CI to report" and
// "the CLI was present but the invocation failed", so a `console.warn` line was
// the single visibility mechanism for the whole #1022 defect class ("CLI
// installed, call rejected"). The unreadable half now leaves as a DEGRADED
// result and the warn is the second channel rather than the only one — it is
// still asserted here, because the two carry different audiences (stderr trace
// vs. rendered banner) and a regression in either is a regression.
// `mockImplementation` keeps the real console quiet.
let warnSpy;

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
});

/**
 * Assert the #1031 third return state: a result that says "state UNKNOWN",
 * carrying a member of the frozen enum. Pinning `severity` + a non-empty
 * `message` is what makes the result RENDERABLE — `session-start-probes.mjs`
 * reads exactly those two fields, so a degraded object without them would be
 * scored `'ok'` and print nothing, i.e. exactly the old silent `null`.
 *
 * @param {*} result
 * @param {string} reason
 */
function expectDegraded(result, reason) {
  expect(result).not.toBeNull();
  expect(result.degraded).toBe(reason);
  expect(DEGRADED_REASONS).toContain(result.degraded);
  expect(result.severity).toBe('warn');
  expect(result.ok).toBe(false);
  expect(typeof result.message).toBe('string');
  expect(result.message).toContain('not "green"');
  // A degraded result must never masquerade as a reading.
  expect(result.status).toBeUndefined();
}

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

// #857: the branch HEAD sits on, used to tell THIS branch's pipelines from an
// MR's or a foreign branch's. Deliberately absent from the pre-#857 fixtures
// above — an unstubbed lookup rejects, which is the "branch unknown" path, and
// that path must keep behaving exactly as it did before #857.
function gitBranchResponse(branch) {
  return { cmd: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'], stdout: branch + '\n' };
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

// ── Test 2b: #857 several pipelines for ONE commit ────────────────────────────
//
// Every fixture above gives a commit exactly one pipeline, which is the
// assumption the module used to state outright ("pipelines are one-per-commit
// on this project"). Measured on the live project 2026-09-18 that is false for
// 14 of ~86 distinct shas in the last 100 pipelines, and on 7 of them the
// statuses CONTRADICT (`canceled`+`success`, `failed`+`success`, …). The 15-row
// window also mixes refs — `main`, `refs/merge-requests/39/head`, a `codex/…`
// branch — with no ref filter at all, so `.find(p => p.sha === sha)` could hand
// a foreign ref's verdict to the local HEAD.
//
// Fixtures below are the REAL shapes of those rows (`ref`, `source`, `status`).

describe('checkCiStatus — #857 multiple pipelines per commit', () => {
  const OLD_GREEN_SHA = 'aaa000bbb111ccc222ddd333eee444fff55566677';
  const OTHER_SHA = 'bbb111ccc222ddd333eee444fff555000aaa66677';

  // (a) Live shape of sha 81c9ffa7: one MR pipeline, one branch pipeline.
  // Without the ref preference the MR row (first in `updated_at desc` order)
  // becomes HEAD's verdict and the banner reports the branch red.
  it('prefers the current branch ref over a merge-request pipeline for the same sha', async () => {
    const pipelines = [
      {
        id: 402,
        sha: HEAD_SHA,
        ref: 'refs/merge-requests/39/head',
        source: 'merge_request_event',
        status: 'failed',
        created_at: '2026-05-10T11:00:00Z',
      },
      {
        id: 401,
        sha: HEAD_SHA,
        ref: 'main',
        source: 'push',
        status: 'success',
        created_at: '2026-05-10T10:00:00Z',
      },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('main'),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(401, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('green');
    expect(result.details.currentPipelineId).toBe(401);
    expect(result.details.matchedRef).toBe('main');
    // The MR row is not a candidate at all, so nothing is ambiguous here.
    expect(result.details.ambiguous).toBeUndefined();
    expect(result.details.candidateStatuses).toBeUndefined();
  });

  // (b) Live shape of sha 52ae12f1: SAME commit, SAME ref, contradicting
  // statuses from different sources. Worst-status-wins keeps the verdict
  // conservative; the disagreement itself is published beside it.
  it('reports the WORST status and publishes the disagreement when same-ref pipelines contradict', async () => {
    const pipelines = [
      {
        id: 502,
        sha: HEAD_SHA,
        ref: 'main',
        source: 'push',
        status: 'canceled',
        created_at: '2026-05-10T11:00:00Z',
      },
      {
        id: 501,
        sha: HEAD_SHA,
        ref: 'main',
        source: 'api',
        status: 'success',
        created_at: '2026-05-10T10:00:00Z',
      },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('main'),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(502, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('red');
    expect(result.details.currentPipelineId).toBe(502);
    // The operator can tell WHY it reads red — and that a green sibling exists.
    expect(result.details.reason).toBe('pipeline-canceled');
    expect(result.details.ambiguous).toBe(true);
    expect(result.details.candidateCount).toBe(2);
    expect(result.details.candidateStatuses).toEqual(['canceled', 'success']);
    expect(result.details.matchedRef).toBe('main');
  });

  // (c) The self-contradiction: the same commit named red AND named as its own
  // `lastGreen`, because the look-back slice started one ROW after the chosen
  // pipeline and the commit's other row was a `success`.
  it('never names the queried commit as its own lastGreen', async () => {
    const pipelines = [
      { id: 602, sha: HEAD_SHA, ref: 'main', source: 'push', status: 'canceled', created_at: '2026-05-10T11:00:00Z' },
      { id: 601, sha: HEAD_SHA, ref: 'main', source: 'api', status: 'success', created_at: '2026-05-10T10:30:00Z' },
      { id: 600, sha: OTHER_SHA, ref: 'main', source: 'push', status: 'failed', created_at: '2026-05-09T10:00:00Z' },
      { id: 599, sha: OLD_GREEN_SHA, ref: 'main', source: 'push', status: 'success', created_at: '2026-05-07T11:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('main'),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(602, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('red');
    expect(result.lastGreen.sha).not.toBe(HEAD_SHA);
    expect(result.lastGreen.sha).toBe(OLD_GREEN_SHA);
    expect(result.lastGreen.pipelineId).toBe(599);
    // Two commits back, two red pipeline rows (the `success` duplicate of HEAD
    // is excluded from the run, it is the same commit).
    expect(result.lastGreen.ageCommits).toBe(2);
    expect(result.lastGreen.agePipelines).toBe(2);
    expect(result.redCount).toBe(2);
  });

  // (d) Live shape of sha 81c9ffa7 seen from a THIRD branch: pipelines exist for
  // the commit, but every one of them belongs to someone else's BRANCH. Adopting
  // one would publish a foreign verdict; claiming "no pipeline" would hide that
  // runs exist. The finding is delivered as a REASON — the status vocabulary
  // stays green|red|unknown.
  //
  // Both refs here are branch refs on purpose: an MR HEAD ref carrying the
  // queried sha is NOT foreign (it is the same commit, only reached by another
  // name) and is an accepted tier-3 candidate — see the MR-only test below.
  it('reports unknown with `pipeline-unmatched-ref` when every pipeline for the sha is on a foreign ref', async () => {
    const pipelines = [
      {
        id: 702,
        sha: HEAD_SHA,
        ref: 'release/1.x',
        source: 'push',
        status: 'success',
        created_at: '2026-05-10T11:00:00Z',
      },
      {
        id: 701,
        sha: HEAD_SHA,
        ref: 'codex/ecc-systematic-review',
        source: 'push',
        status: 'failed',
        created_at: '2026-05-10T10:00:00Z',
      },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('main'),
      glabPipelinesResponse(pipelines),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('unknown');
    expect(result.ok).toBe(false);
    expect(result.details.reason).toBe('pipeline-unmatched-ref');
    expect(result.details.currentPipelineId).toBeNull();
    expect(result.details.candidateCount).toBe(2);
    expect(result.details.candidateStatuses).toEqual(['success', 'failed']);
  });

  // (e) A cancellation printed `🚨 CI RED on HEAD` indistinguishably from a real
  // failure. The status stays `red` (consumers key on that literal), the
  // distinction arrives through the reason both renderers already interpolate.
  it('names a cancellation as `pipeline-canceled` while keeping status red', async () => {
    const pipelines = [
      { id: 801, sha: HEAD_SHA, ref: 'main', source: 'push', status: 'canceled', created_at: '2026-05-10T11:00:00Z' },
      { id: 800, sha: OLD_GREEN_SHA, ref: 'main', source: 'push', status: 'success', created_at: '2026-05-09T11:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('main'),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(801, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('red');
    expect(result.details.reason).toBe('pipeline-canceled');
    // A single candidate is not ambiguous — the evidence fields stay absent so
    // an ordinary reading is byte-identical to a pre-#857 one.
    expect(result.details.ambiguous).toBeUndefined();
    expect(result.details.candidateCount).toBeUndefined();
  });

  // (f) `ageCommits` used to be the ROW count under a comment asserting
  // one-pipeline-per-commit. With a re-run in the window it overstated the
  // distance to the last green.
  it('counts ageCommits over DISTINCT shas and keeps the row count as agePipelines', async () => {
    const pipelines = [
      { id: 904, sha: HEAD_SHA, ref: 'main', source: 'push', status: 'failed', created_at: '2026-05-10T11:00:00Z' },
      { id: 903, sha: OTHER_SHA, ref: 'main', source: 'api', status: 'failed', created_at: '2026-05-09T12:00:00Z' },
      { id: 902, sha: OTHER_SHA, ref: 'main', source: 'push', status: 'failed', created_at: '2026-05-09T11:00:00Z' },
      { id: 901, sha: OLD_GREEN_SHA, ref: 'main', source: 'push', status: 'success', created_at: '2026-05-07T11:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('main'),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(904, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('red');
    // Three red ROWS, but only TWO commits between HEAD and the last green.
    expect(result.redCount).toBe(3);
    expect(result.lastGreen.agePipelines).toBe(3);
    expect(result.lastGreen.ageCommits).toBe(2);
    expect(result.lastGreen.sha).toBe(OLD_GREEN_SHA);
  });

  // (g) BUG this catches (HIGH-1, repro'd 2026-09-18): a repo whose
  // `workflow: rules:` admit only `$CI_PIPELINE_SOURCE == "merge_request_event"`
  // produces NO branch pipeline for the sha — only a detached MR pipeline on
  // `refs/merge-requests/<iid>/head`. Tiers 1-2 are then empty, and before the
  // MR tier the whole repo read `unknown / pipeline-unmatched-ref` for a commit
  // whose verdict was sitting right there (pre-#857 it read `green`). Sha
  // equality is the correctness argument; the ref only names WHO spoke.
  it('adopts a merge-request HEAD pipeline for the queried sha when no branch pipeline exists', async () => {
    const pipelines = [
      {
        id: 1002,
        sha: HEAD_SHA,
        ref: 'refs/merge-requests/41/head',
        source: 'merge_request_event',
        status: 'success',
        created_at: '2026-05-10T11:00:00Z',
      },
      { id: 1001, sha: OTHER_SHA, ref: 'main', source: 'push', status: 'success', created_at: '2026-05-09T11:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('feature/mr-only'),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(1002, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('green');
    expect(result.details.currentPipelineId).toBe(1002);
    // The operator sees WHICH ref spoke for the verdict.
    expect(result.details.matchedRef).toBe('refs/merge-requests/41/head');
  });

  // (h) BUG this catches (HIGH-2, vacuum-green proof): mutating
  // `statusSeverity('failed')` to 1 or 0 left all 55 tests in this file green —
  // no fixture paired a same-sha same-ref `failed` (older) with a `success`
  // (newer). Under such a mutant the newer `success` wins and a genuinely failed
  // commit reads green. Row order is the API's `updated_at desc`, so the
  // `success` comes FIRST — which is exactly what makes the mutant survive.
  it('reports red when an older same-ref `failed` contradicts a newer `success`', async () => {
    const pipelines = [
      { id: 1102, sha: HEAD_SHA, ref: 'main', source: 'api', status: 'success', created_at: '2026-05-10T11:00:00Z' },
      { id: 1101, sha: HEAD_SHA, ref: 'main', source: 'push', status: 'failed', created_at: '2026-05-10T10:00:00Z' },
      { id: 1100, sha: OLD_GREEN_SHA, ref: 'main', source: 'push', status: 'success', created_at: '2026-05-07T11:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('main'),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(1101, [{ name: 'test', status: 'failed' }]),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('red');
    expect(result.details.currentPipelineId).toBe(1101);
    expect(result.details.ambiguous).toBe(true);
    expect(result.details.candidateStatuses).toEqual(['success', 'failed']);
    expect(result.failingJobName).toBe('test');
  });

  // (i) BUG this catches (MED-1, repro'd 2026-09-18): `skipped` and `manual` are
  // TERMINAL non-failing states, but sat in the "unsettled" bucket above
  // `success`. The ordinary `rules:`-gated shape (`success` + `skipped` for one
  // commit) therefore read `unknown / unrecognised-status-skipped` where the
  // pre-#857 reading was `green`. They must never beat a real reading in either
  // direction — while a LONE `skipped` keeps today's `unknown`.
  it.each([
    { label: 'success beside skipped', second: 'skipped', expected: 'green' },
    { label: 'success beside manual', second: 'manual', expected: 'green' },
    { label: 'failed beside skipped', second: 'skipped', first: 'failed', expected: 'red' },
    { label: 'skipped alone', first: 'skipped', expected: 'unknown' },
  ])('resolves $label as $expected', async ({ first = 'success', second, expected }) => {
    const pipelines = [
      { id: 1202, sha: HEAD_SHA, ref: 'main', source: 'push', status: first, created_at: '2026-05-10T11:00:00Z' },
      ...(second
        ? [{ id: 1201, sha: HEAD_SHA, ref: 'main', source: 'api', status: second, created_at: '2026-05-10T10:00:00Z' }]
        : []),
      { id: 1200, sha: OLD_GREEN_SHA, ref: 'main', source: 'push', status: 'success', created_at: '2026-05-07T11:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse('main'),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(1202, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe(expected);
    // The verdict always speaks for the pipeline that carries it, never for the
    // terminal-but-silent sibling.
    expect(result.details.currentPipelineId).toBe(1202);
  });

  // (j) BUG this catches (#1390 P5, repro'd 2026-09-19): whenever a preference
  // tier matched, `selectShaPipelines` returned `foreign: []`, so a same-sha
  // `failed` pipeline on another ref was dropped with no trace — the reading
  // below was `{status:'green', details:{currentPipelineId:901, cliUsed:'glab'}}`
  // and pipeline 900 appeared nowhere. The ref preference itself is deliberate
  // (#857) and the verdict must NOT flip; the dropped rows are published BESIDE
  // it. One row per tier, because each tier returned its own `foreign: []`.
  it.each([
    { tier: '1 (branch match)', branch: 'main', keptRef: 'main' },
    { tier: '2 (ref-less, unjudgeable)', branch: 'main', keptRef: undefined },
    { tier: '3 (MR HEAD)', branch: 'feature/x', keptRef: 'refs/merge-requests/41/head' },
  ])('keeps the tier-$tier verdict but publishes a dropped same-sha foreign `failed`', async ({ branch, keptRef }) => {
    const pipelines = [
      { id: 900, sha: HEAD_SHA, ref: 'someone-elses-branch', source: 'push', status: 'failed', created_at: '2026-05-10T11:00:00Z' },
      { id: 901, sha: HEAD_SHA, ...(keptRef ? { ref: keptRef } : {}), source: 'push', status: 'success', created_at: '2026-05-10T10:00:00Z' },
    ];

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      gitBranchResponse(branch),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(901, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.status).toBe('green');
    expect(result.details.currentPipelineId).toBe(901);
    expect(result.details.droppedCount).toBe(1);
    expect(result.details.droppedStatuses).toEqual(['failed']);
  });
});

// ── Test 3: glab missing (ENOENT) ─────────────────────────────────────────────

describe('checkCiStatus — glab not in PATH', () => {
  it('degrades with `cli-missing` (silently, no warn) when glab execFile throws ENOENT', async () => {
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

    // #1031: a missing CLI never established that CI is green, so the RESULT
    // says so. The WARN channel stays silent — it is a normal state on a
    // machine without glab, and warning here would drown the signal the warn
    // exists to carry (#1022: CLI present, call rejected).
    expectDegraded(result, 'cli-missing');
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
  it('degrades with `timeout` when a CLI invocation exceeds timeoutMs', async () => {
    // Mock execFile that never calls callback → simulates a hung process.
    const hangingMock = vi.fn(function (_cmd, _args, _opts, _callback) {
      // Never invoke callback → the promise race should win via timeout.
    });

    // Use a very short timeout so the test doesn't actually wait.
    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', timeoutMs: 10, now: NOW },
      { execFile: hangingMock },
    );

    // The hang is on the FIRST spawn (`git remote -v`), i.e. the detectVcs
    // probe's own timeout race — the path that used to return a bare `null`
    // under the "a hang is not actionable" argument #1031 superseded. What the
    // operator acts on is not the hang; it is that CI state is unknown.
    expectDegraded(result, 'timeout');
    // Still silent on the warn channel — a hung subprocess is not a fact worth
    // a stderr line beside every other banner.
    expect(warnSpy.mock.calls).toHaveLength(0);
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

// ── #1332: verdict for a NAMED sha ───────────────────────────────────────────
//
// BUG these catch (TV-001): `checkCiStatus` could only ever answer for the
// local HEAD, so session-start could not report the verdict of the last
// PUSHED commit when HEAD had no pipeline. Each test stubs `git rev-parse HEAD`
// to a DIFFERENT commit whose pipeline disagrees, so an implementation that
// ignores `sha` produces a wrong verdict, not merely an unstubbed-call error.

describe('checkCiStatus — #1332 explicit sha', () => {
  const PUSHED_SHA = 'feedfacefeedfacefeedfacefeedfacefeedface';

  it('GitLab: matches the pipeline of the NAMED sha and never asks git for HEAD', async () => {
    const pipelines = [
      { id: 300, sha: HEAD_SHA, status: 'failed', created_at: '2026-05-10T11:00:00Z' },
      { id: 299, sha: PUSHED_SHA, status: 'success', created_at: '2026-05-10T10:00:00Z' },
    ];
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      glabPipelinesResponse(pipelines),
      glabJobsResponse(299, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW, sha: PUSHED_SHA },
      { execFile: mockExecFile },
    );

    expect(result).toEqual({
      status: 'green',
      ok: true,
      details: { currentPipelineId: 299, cliUsed: 'glab' },
    });
    expect(mockExecFile.mock.calls.map(([cmd, args]) => [cmd, args])).toEqual([
      ['git', ['remote', '-v']],
      // #857 branch lookup. It does NOT weaken the statement this test makes:
      // `rev-parse --abbrev-ref HEAD` asks for the NAME of the ref HEAD is on
      // (needed to tell this branch's pipelines from an MR's or a foreign
      // branch's), never for HEAD's object id — which is what `opts.sha`
      // replaces and what `rev-parse HEAD`, absent below, would have fetched.
      ['git', ['rev-parse', '--abbrev-ref', 'HEAD']],
      [
        'glab',
        [
          'api',
          'projects/org%2Fsession-orchestrator/pipelines?order_by=updated_at&sort=desc&per_page=15',
          '--hostname',
          'gitlab.example.com',
        ],
      ],
      [
        'glab',
        ['api', 'projects/org%2Fsession-orchestrator/pipelines/299/jobs', '--hostname', 'gitlab.example.com'],
      ],
    ]);
  });

  it('GitHub: queries check-runs for the NAMED sha instead of the HEAD ref', async () => {
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITHUB_ORIGIN),
      ghRepoViewResponse,
      ghCheckRunsResponse([{ name: 'test', conclusion: 'success' }]),
      {
        cmd: 'gh',
        args: ['api', `repos/Kanevry/session-orchestrator/commits/${PUSHED_SHA}/check-runs`],
        stdout: JSON.stringify({ check_runs: [{ name: 'test (macos-latest)', conclusion: 'failure' }] }),
      },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW, sha: PUSHED_SHA },
      { execFile: mockExecFile },
    );

    expect(result).toMatchObject({ status: 'red', ok: false, failingJobName: 'test (macos-latest)' });
    const [, checkRunsArgs] = mockExecFile.mock.calls.find(
      ([cmd, args]) => cmd === 'gh' && args[0] === 'api',
    );
    expect(checkRunsArgs).toEqual(['api', `repos/Kanevry/session-orchestrator/commits/${PUSHED_SHA}/check-runs`]);
  });

  // The sha is interpolated into a `gh api` PATH: `../..` would re-route the
  // request to another endpoint, and a short sha never equals GitLab's full one.
  it('refuses a sha that is not a full hex commit id before spawning anything', async () => {
    const mockExecFile = makeExecFileMock([]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW, sha: '../../user' },
      { execFile: mockExecFile },
    );

    expectDegraded(result, 'query-failed');
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  // BUG this catches (#1339 P3): the row above fails on non-hex characters
  // alone, so it stays green if the LENGTH bound is loosened (e.g. to
  // `{7,64}`). A caller passing `git rev-parse --short` output would then match
  // no GitLab pipeline (they carry full shas) and read a wrong/empty verdict
  // instead of being refused. Accepted rows run a full reading (4 spawns);
  // refused rows spawn nothing.
  it.each([
    { label: '8-hex (a --short sha)', sha: 'abc1234d', degraded: 'query-failed', status: undefined, spawns: 0 },
    { label: '63-hex', sha: `${HEAD_SHA}${'f'.repeat(23)}`, degraded: 'query-failed', status: undefined, spawns: 0 },
    { label: '40-hex (SHA-1)', sha: HEAD_SHA, degraded: undefined, status: 'green', spawns: 4 },
    { label: '64-hex (SHA-256)', sha: `${HEAD_SHA}${'f'.repeat(24)}`, degraded: undefined, status: 'green', spawns: 4 },
  ])('bounds the sha length exactly: $label', async ({ sha, degraded, status, spawns }) => {
    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitBranchResponse('main'),
      glabPipelinesResponse([{ id: 310, sha, ref: 'main', status: 'success', created_at: '2026-05-10T10:00:00Z' }]),
      glabJobsResponse(310, []),
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW, sha },
      { execFile: mockExecFile },
    );

    expect(result.degraded).toBe(degraded);
    expect(result.status).toBe(status);
    expect(mockExecFile).toHaveBeenCalledTimes(spawns);
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

  // BUG this catches (TV-001): `scripts/release.mjs` preflight asks this probe
  // for the GITHUB mirror (`vcs: 'github'`) from a repo whose `origin` — and
  // therefore whose DETECTED family — is GitLab, because the macOS matrix leg
  // runs only on the mirror. If the forced value were ignored, or detection ran
  // anyway, that row would read GitLab a second time and report a duplicate
  // green while macOS was red. The forced-gitlab case above cannot catch it:
  // there the forced value and the detected value agree. The mock fails on any
  // unstubbed call, so the absence of a `git remote -v` stub IS the assertion
  // that detection was skipped.
  it('skips VCS detection and queries gh when vcs is forced to github', async () => {
    const spec = 'github.com/Kanevry/session-orchestrator';
    const mockExecFile = makeExecFileMock([
      { cmd: 'gh', args: ['repo', 'view', spec, '--json', 'nameWithOwner'], stdout: GH_REPO_VIEW },
      {
        cmd: 'gh',
        args: ['api', 'repos/Kanevry/session-orchestrator/commits/HEAD/check-runs', '--hostname', 'github.com'],
        stdout: JSON.stringify({ check_runs: [{ name: 'test (macos-latest)', conclusion: 'success' }] }),
      },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', vcs: 'github', now: NOW },
      { execFile: mockExecFile, resolveRepoSpec: () => spec, resolveRepoHost: () => 'github.com' },
    );

    expect(result).toMatchObject({ status: 'green', ok: true, details: { cliUsed: 'gh' } });
    expect(mockExecFile.mock.calls.some(([cmd]) => cmd === 'git')).toBe(false);
  });

  it('reports the mirror red when only the macOS leg failed', async () => {
    const spec = 'github.com/Kanevry/session-orchestrator';
    const mockExecFile = makeExecFileMock([
      { cmd: 'gh', args: ['repo', 'view', spec, '--json', 'nameWithOwner'], stdout: GH_REPO_VIEW },
      {
        cmd: 'gh',
        args: ['api', 'repos/Kanevry/session-orchestrator/commits/HEAD/check-runs', '--hostname', 'github.com'],
        stdout: JSON.stringify({
          check_runs: [
            { name: 'test (ubuntu-latest)', conclusion: 'success' },
            { name: 'test (macos-latest)', conclusion: 'failure' },
          ],
        }),
      },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', vcs: 'github', now: NOW },
      { execFile: mockExecFile, resolveRepoSpec: () => spec, resolveRepoHost: () => 'github.com' },
    );

    expect(result).toMatchObject({ status: 'red', ok: false, failingJobName: 'test (macos-latest)' });
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
  it('degrades with `parse-error` on malformed JSON from glab pipelines API', async () => {
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

    expectDegraded(result, 'parse-error');
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

    expectDegraded(result, 'parse-error');
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

    expectDegraded(result, 'parse-error');
    // The escaping obligation extends to the RENDERED banner, not only the
    // warn: since #1031 the degraded message carries the same redacted text.
    // eslint-disable-next-line no-control-regex -- matching control bytes is the assertion
    expect(result.message).not.toMatch(/[\u0000-\u001f]/);
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

    // Both halves — unparseable AND wrong-shape — are one `parse-error` class:
    // in either case a CLI answered and this module could not read the answer.
    expectDegraded(result, 'parse-error');
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
      // #857: the ref-preference lookup (branch name, not object id).
      ['git', ['rev-parse', '--abbrev-ref', 'HEAD']],
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

    expect(mockExecFile).not.toHaveBeenCalled();
    // A GitLab remote WAS detected; only its form was rejected. That is a query
    // failure, not an absence, so a bare `null` here would restore exactly the
    // pre-#1039 state this module's own rule forbids: "CI green" and "could not
    // ask" rendering identically.
    expectDegraded(result, 'query-failed');
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

    expectDegraded(result, 'parse-error');
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

    // Since #1031 the residual bucket: a present CLI ran and rejected the
    // invocation. Neither missing-CLI, nor timeout, nor unreadable output.
    expectDegraded(result, 'query-failed');
    // The WARN still carries the child's own error text verbatim — an operator
    // cannot act on "something failed". Exactly one line.
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

    expectDegraded(result, 'query-failed');
    // The redaction obligation now covers the RENDERED banner too: the degraded
    // message carries the same redacted text the warn does.
    expect(result.message).not.toContain('ci-bot');
    expect(result.message).not.toContain('glpat-');
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

  it('WARNS and degrades (`cli-missing`) with reason `git-unavailable` when git is not on PATH', async () => {
    const enoent = new Error('spawn git ENOENT');
    enoent.code = 'ENOENT'; // string errno — NOT an exit status

    const mockExecFile = makeExecFileMock([
      { cmd: 'git', args: ['remote', '-v'], error: enoent },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    // git is a CLI, and "not on PATH" is one member of the enum, not two
    // spellings of it — the upstream `git-unavailable` reason projects onto
    // `cli-missing`. It still WARNS (unlike a missing glab/gh) because the
    // probe never got as far as choosing a platform.
    expectDegraded(result, 'cli-missing');
    expect(warnSpy.mock.calls).toHaveLength(1);
    const [message] = warnSpy.mock.calls[0];
    // The reason token is what separates this from the silent absence paths.
    expect(message).toContain('git-unavailable');
    // …and it survives into the rendered banner, so the operator sees WHICH
    // query failed rather than a bare enum member.
    expect(result.message).toContain('git-unavailable');
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

    expectDegraded(result, 'git-error');
    expect(warnSpy.mock.calls).toHaveLength(1);
    const [message] = warnSpy.mock.calls[0];
    expect(message).toContain('git-error');
    expect(message).toContain('gitlab.example.com');
    expect(message).not.toContain('ci-bot');
    expect(message).not.toContain('glpat-');
    // The redaction runs BEFORE the text is handed to the degraded message, so
    // it holds on the rendered banner too — the channel an operator actually
    // reads at session-start.
    expect(result.message).not.toContain('ci-bot');
    expect(result.message).not.toContain('glpat-');
  });

  it('ESCAPES control bytes in the degraded message, not just credentials', async () => {
    // BUG this catches (TV-001): redaction and control-byte escaping are
    // different protections, and the degraded path only ever ran the first.
    // `parseCliJson` escapes the text IT embeds, but a CLI stderr quoted into
    // `err.message` reaches the operator's terminal by a second route — so an
    // ANSI/CR payload from a hostile or merely noisy CLI was rendered RAW into
    // the session-start banner line.
    const esc = String.fromCharCode(27);
    const failed = new Error(
      `Command failed: glab ci status\n${esc}[31mFAKE ERROR${esc}[0m\rcleared`,
    );
    failed.code = 1;

    const mockExecFile = makeExecFileMock([
      gitRemoteResponse(GITLAB_ORIGIN),
      gitRevParseResponse(HEAD_SHA),
      { cmd: 'glab', error: failed },
    ]);

    const result = await checkCiStatus(
      { repoRoot: '/fake/repo', now: NOW },
      { execFile: mockExecFile },
    );

    expect(result.degraded).toBeTypeOf('string');
    // No raw ESC, CR or LF survives into the operator-facing line…
    expect(result.message).not.toContain(esc);
    expect(result.message).not.toContain('\r');
    expect(result.message).not.toContain('\n');
    // …and the escaped form is what is shown instead, so nothing is lost.
    expect(result.message).toContain('\\u001b');
  });
});

// ── Test 21: #1031 degraded-reason census ────────────────────────────────────

describe('ci-status-banner — DEGRADED_REASONS enum integrity', () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL('../../scripts/lib/ci-status-banner.mjs', import.meta.url)),
    'utf8',
  );

  // Bug this catches (TV-001): a new failure path added with a reason literal
  // that is NOT in the frozen enum. Nothing else notices — `degradedResult`
  // takes a plain string, so the probe would emit a member no consumer can
  // switch on, and `session-start-probes.mjs` would still render it as a
  // generic warn. The census is a REGEX OVER THE SOURCE, never a hand-typed
  // list: a list under a census title only ever tests itself.
  it('every degraded reason literal in the module is a member of the exported enum', () => {
    const emitted = [...SOURCE.matchAll(/degradedResult\(\s*'([^']+)'/g)].map((m) => m[1]);

    // Vacuum guard: an empty census passes trivially and would hide a rename
    // of `degradedResult` itself.
    expect(emitted.length).toBeGreaterThanOrEqual(5);
    for (const reason of new Set(emitted)) {
      expect(DEGRADED_REASONS).toContain(reason);
    }
  });

  it('every enum member is actually reachable from a call site in the module', () => {
    const emitted = new Set(
      [...SOURCE.matchAll(/degradedResult\(\s*'([^']+)'/g)].map((m) => m[1]),
    );
    // The only reason to freeze an enum is exhaustive switching; a member no
    // call site emits makes that promise false for consumers.
    expect([...DEGRADED_REASONS].filter((r) => !emitted.has(r))).toEqual([]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEGRADED_REASONS)).toBe(true);
  });
});
