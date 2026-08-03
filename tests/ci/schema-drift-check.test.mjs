import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { load as loadYaml } from 'js-yaml';

const YAML_PATH = resolve(process.cwd(), '.gitlab-ci.yml');
const doc = loadYaml(readFileSync(YAML_PATH, 'utf8'));

// Every assertion below judges ONE job, so every assertion below is scoped to
// that job. The previous revision of this file asserted with
// `expect(yaml).toContain(...)` against the whole document, which made two of
// its checks vacuous: `toContain('exit 0')` was satisfied by a *comment*, and
// `toContain('SCHEMA_DRIFT_TOKEN')` by the job's header prose. A file-wide
// substring is not evidence about a job.
//
// Scoping is structural rather than textual on purpose. The old code sliced the
// block with `indexOf('schema-drift-check:') .. indexOf('\n\n')`, which ends the
// block at the first BLANK LINE — so a single blank line inside the job would
// silently truncate it, and every `not.toContain` assertion would then pass
// against a block that no longer contained the thing it was ruling out. Parsing
// removes that failure mode outright: js-yaml resolves the anchors/merge keys
// and drops comments, so what we assert on is the executable job, not its prose.
const JOB_NAME = 'schema-drift-check';
const job = doc[JOB_NAME];

/** Script steps that perform the cross-project clone. */
const cloneSteps = (job?.script ?? []).filter((step) => step.includes('git clone'));

/** The missing-token guard step: the branch taken when SCHEMA_DRIFT_TOKEN is unset. */
const guardSteps = (job?.script ?? []).filter((step) =>
  step.includes('-z "${SCHEMA_DRIFT_TOKEN}"'),
);

describe('schema-drift-check CI job (#279)', () => {
  it('uses SCHEMA_DRIFT_TOKEN instead of CI_JOB_TOKEN for the clone URL', () => {
    // The fix for #279: clone must use oauth2:${SCHEMA_DRIFT_TOKEN}.
    expect(cloneSteps).toHaveLength(1);
    expect(cloneSteps[0]).toContain('oauth2:${SCHEMA_DRIFT_TOKEN}');
  });

  it('does not use CI_JOB_TOKEN in the clone URL', () => {
    // CI_JOB_TOKEN returns 403 on cross-project access without an allowlist.
    // Asserted against the clone step itself — the previous revision searched
    // the whole file for a clone line and then wrapped the assertion in an
    // `if (cloneLine !== undefined)`, so a job that had lost its clone step
    // entirely would have asserted nothing at all.
    expect(cloneSteps[0]).not.toContain('gitlab-ci-token');
    expect(cloneSteps[0]).not.toContain('CI_JOB_TOKEN');
  });

  it('does not treat a missing SCHEMA_DRIFT_TOKEN as a passing check', () => {
    // Polarity is deliberate and is the inverse of what this test asserted
    // before (#933 Loch 1). The old form demanded the soft-skip path `exit 0`
    // and so encoded the defect as the contract: closing the hole broke the
    // test, which invites the next reader to restore the hole instead of the
    // check. A job that verified nothing must never report the same green as a
    // job that verified everything.
    expect(guardSteps).toHaveLength(1);
    const guard = guardSteps[0];

    // The operator-facing reason must survive; a silent non-zero exit is not
    // actionable in a pipeline log.
    expect(guard).toContain('SCHEMA_DRIFT_TOKEN is not set');

    // Every exit code reachable from the missing-token branch, in order:
    // 3 when the absence is explicitly declared acceptable, 1 otherwise.
    // A restored `exit 0` soft-skip shows up here as a '0' and fails.
    const exitCodes = [...guard.matchAll(/\bexit\s+(\d+)/g)].map((m) => m[1]);
    expect(exitCodes).toEqual(['3', '1']);
  });

  it('limits allow_failure to exit code 3 and nothing else', () => {
    // Three properties in one exact assertion:
    //   1. no blanket `allow_failure: true` (that would swallow real drift),
    //   2. the exception is expressed as `exit_codes`, not a bare boolean,
    //   3. the tolerated set is exactly [3] — the declared no-token code.
    // A looser check (e.g. "exit_codes contains 3") would wave through the next
    // widening, such as adding 0 or 1 to the list.
    expect(job.allow_failure).toEqual({ exit_codes: [3] });
  });
});

// ---------------------------------------------------------------------------
// Verified-marker guard (#940 — the open question from #932).
//
// pipeline-gate reads `.ci-markers/schema-drift.ok` as "this pipeline DID
// verify the schema". GitLab aborts the `script:` list at the first non-zero
// step, so the marker's reachability IS its position: as the last step, it is
// only reached when the token guard fell through AND the drift check exited 0.
// If the write ever moved BEFORE the guard, the exit-3 soft path would ship a
// verified artifact — the old `exit 0` disease, one level up.
// ---------------------------------------------------------------------------

const scriptSteps = job?.script ?? [];

/** Every script step that mentions the verified-marker artifact. */
const markerSteps = scriptSteps.filter((step) => step.includes('.ci-markers/schema-drift.ok'));

describe('schema-drift-check verified marker (#940)', () => {
  it('writes the marker in exactly one script step — and outside the token guard', () => {
    // bug_caught: a second marker write added to the guard's exit-3 branch
    // ("keep the gate green while the token is missing") — the soft path would
    // then produce the exact artifact whose absence pipeline-gate exists to
    // surface. A guard step containing the marker path shows up in this filter
    // and fails the exact-count.
    expect(markerSteps).toHaveLength(1);
    expect(guardSteps[0]).not.toContain('.ci-markers');
  });

  it('keeps the marker write LAST — after the token guard and the actual drift check', () => {
    // bug_caught: reordering the steps. GitLab semantics make order equal
    // reachability, so a marker write hoisted above the drift check (or above
    // the guard) records "verified" for a pipeline that verified nothing.
    const guardIdx = scriptSteps.indexOf(guardSteps[0]);
    const checkIdx = scriptSteps.findIndex(
      (step) => step.includes('sync-vault-schema.mjs') && step.includes('--check'),
    );
    const markerIdx = scriptSteps.indexOf(markerSteps[0]);

    expect(guardIdx).toBeGreaterThanOrEqual(0);
    expect(checkIdx).toBeGreaterThan(guardIdx);
    expect(markerIdx).toBeGreaterThan(checkIdx);
    expect(markerIdx).toBe(scriptSteps.length - 1);
  });

  it('uploads marker artifacts only on success — the second lock on the same door', () => {
    // bug_caught: `artifacts.when` flipped to `always` (a plausible "let's
    // debug the markers" edit). Under allow_failure the exit-3 path counts as
    // an ALLOWED FAILURE, so `on_success` is what guarantees that even a
    // wrongly-written marker never reaches pipeline-gate. `always` removes
    // that backstop single-handedly.
    expect(job.artifacts.when).toBe('on_success');
    expect(job.artifacts.paths).toContain('.ci-markers/');
  });
});

// ---------------------------------------------------------------------------
// pipeline-gate fan-in (#933 Loch 3, wired in #932, tested per #940).
//
// The gate's script is ONE folded block by design (single shell scope, no
// $(...) captures). That makes it executable outside GitLab: js-yaml resolves
// the folded scalar to the exact string the runner would execute, and `sh -c`
// runs it against a tmp dir with controlled markers + CI env vars. These are
// behavioral tests of the real fan-in logic, not prose pins.
// ---------------------------------------------------------------------------

const gateJob = doc['pipeline-gate'];
const gateScript = gateJob?.script ?? [];

const tmpDirs = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    try {
      rmSync(tmpDirs.pop(), { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

/**
 * Execute the gate's real script block in a tmp dir.
 * @param {object} opts
 * @param {string[]} [opts.markers] marker filenames to create under .ci-markers/
 * @param {string} opts.source CI_PIPELINE_SOURCE
 * @param {string} [opts.branch] CI_COMMIT_BRANCH — omitted entirely for MR
 *   pipelines, where GitLab genuinely does not set it (this is what proves the
 *   `${CI_COMMIT_BRANCH:-}` guard holds under `set -u`)
 * @param {string} [opts.optional] SCHEMA_DRIFT_OPTIONAL override; defaults to
 *   the value the job itself declares, so the default cases test the gate
 *   exactly as committed
 */
function runGate({ markers = [], source, branch, optional } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'so-pipeline-gate-'));
  tmpDirs.push(dir);
  if (markers.length > 0) {
    mkdirSync(join(dir, '.ci-markers'));
    for (const name of markers) {
      writeFileSync(join(dir, '.ci-markers', name), 'marker fixture\n');
    }
  }
  const env = {
    PATH: process.env.PATH,
    CI_PIPELINE_ID: '424242',
    CI_PIPELINE_SOURCE: source,
    CI_DEFAULT_BRANCH: 'main',
    SCHEMA_DRIFT_OPTIONAL: optional ?? gateJob.variables.SCHEMA_DRIFT_OPTIONAL,
  };
  if (branch !== undefined) {
    env.CI_COMMIT_BRANCH = branch;
  }
  return spawnSync('sh', ['-c', gateScript[0]], { cwd: dir, encoding: 'utf8', timeout: 20_000, env });
}

describe('pipeline-gate fan-in evaluates the markers (#940)', () => {
  it('passes an MR pipeline when both markers are present', () => {
    // bug_caught: the gate rejecting a fully-verified pipeline — a gate that
    // reddens good pipelines gets allow_failure'd out of existence, taking the
    // whole fan-in mechanism with it. Also pins the single-folded-block shape
    // the executability of every test here depends on.
    expect(gateScript).toHaveLength(1);
    const res = runGate({ markers: ['coverage.ok', 'schema-drift.ok'], source: 'merge_request_event' });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('RESULT: PASS');
  });

  it('fails an MR pipeline whose coverage marker is missing', () => {
    // bug_caught: the pipeline-6815 disease — a skippable/optional job drops
    // out (rules drift, marker write deleted) and the pipeline stays green.
    // This is the fail-closed half the gate exists for.
    const res = runGate({ markers: ['schema-drift.ok'], source: 'merge_request_event' });

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('RESULT: FAIL');
  });

  it('does not require coverage on a non-default branch pipeline', () => {
    // bug_caught: the branch-scope condition inverted or lost — coverage runs
    // only on MR + default-branch pipelines by rule, so demanding its marker
    // on feature-branch pipelines reddens every branch push.
    const res = runGate({ markers: ['schema-drift.ok'], source: 'push', branch: 'feat/x' });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('RESULT: PASS');
  });

  it('tolerates a missing schema-drift marker as declared-optional — visibly, never as VERIFIED', () => {
    // bug_caught: two inversions of the amber path. (a) tolerance broken →
    // every pipeline red while the token is legitimately unconfigured (the
    // committed state, measured 2026-07-30: zero CI variables) → gate deleted;
    // (b) the missing marker reported as VERIFIED → the soft path is green
    // again, one level up. Asserting the NOT-VERIFIED notice pins (b).
    const res = runGate({ markers: ['coverage.ok'], source: 'merge_request_event' });

    expect(res.status).toBe(0);
    expect(res.stdout).toContain('schema-drift: NOT VERIFIED');
    expect(res.stdout).toContain('RESULT: PASS');
  });

  it('fails closed when the marker is missing and SCHEMA_DRIFT_OPTIONAL=false', () => {
    // bug_caught: the hard-gate activation flag being decorative. docs/ci-setup
    // instructs flipping SCHEMA_DRIFT_OPTIONAL to "false" once the token
    // exists; if the gate ignores the flag, that flip changes nothing and the
    // schema check stays optional forever.
    const res = runGate({ markers: ['coverage.ok'], source: 'merge_request_event', optional: 'false' });

    expect(res.status).toBe(1);
    expect(res.stdout).toContain('RESULT: FAIL');
  });

  it('keeps SCHEMA_DRIFT_OPTIONAL mirrored between producer job and gate, and the gate un-skippable', () => {
    // bug_caught: (a) a half-flip during hard-gate activation — flipping the
    // flag on one job but not the other makes the two enforcement points
    // disagree (one amber-tolerates what the other hard-fails); (b) the gate
    // itself granted allow_failure — one line that silently turns the entire
    // fan-in advisory while every pipeline stays green.
    expect(gateJob.variables.SCHEMA_DRIFT_OPTIONAL).toBe(job.variables.SCHEMA_DRIFT_OPTIONAL);
    expect(gateJob.allow_failure).toBe(false);
  });
});
