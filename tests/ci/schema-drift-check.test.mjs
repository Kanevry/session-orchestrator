import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load as loadYaml } from 'js-yaml';
import vitestConfig from '../../vitest.config.mjs';

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

/** Tmp dirs created by any test below; drained after each test. */
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
 * Execute real script steps with errexit and newline boundaries. An &&-joined
 * list changes errexit semantics and hid the coverage gate's failures (#1279).
 * Nothing is re-typed: the strings come from the parsed YAML.
 *
 * @param {string[]} steps script strings, in order
 * @param {Record<string,string>} env environment for the run (PATH is added)
 * @param {string} [pathPrefix] directory prepended to PATH (for command shims)
 * @param {string} [cwd] isolated working directory
 */
function runSteps(steps, env, pathPrefix, cwd) {
  const PATH = pathPrefix ? `${pathPrefix}:${process.env.PATH}` : process.env.PATH;
  return spawnSync('sh', ['-c', `set -e\n${steps.join('\n')}`], {
    cwd,
    encoding: 'utf8',
    timeout: 20_000,
    env: { PATH, ...env },
  });
}

describe('schema-drift-check CI job (#279)', () => {
  it('clones with SCHEMA_DRIFT_TOKEN and never with the CI job token', () => {
    // Consolidated from two tests asserting one fact (TV-004): the clone must
    // carry the cross-project credential. CI_JOB_TOKEN returns 403 on
    // cross-project access without an allowlist, so the positive and negative
    // halves are the same contract seen from two sides — #279.
    expect(cloneSteps).toHaveLength(1);
    expect(cloneSteps[0]).toContain('oauth2:${SCHEMA_DRIFT_TOKEN}');
    expect(cloneSteps[0]).not.toContain('gitlab-ci-token');
    expect(cloneSteps[0]).not.toContain('CI_JOB_TOKEN');
  });

  it('EXECUTES the missing-token guard: exit 3 when declared optional, exit 4 when required', () => {
    // Upgraded from a regex over the guard's source text to a real run of it.
    // bug_caught (the reason the regex was not enough): the flag flip that
    // activates the hard gate is the ONE transition this job has never taken,
    // and a quoting/nesting defect on the fail-closed branch — an unbalanced
    // `fi`, `[ "$X" = true ]` vs `= "true"`, a `$` lost to YAML folding — is
    // invisible to a source-text assertion and shows up only as a red pipeline
    // for a reason unrelated to schema drift. Running it proves the branch is
    // reachable and lands on its declared code.
    //
    // Polarity is deliberate (#933 Loch 1): this asserted `exit 0` once, which
    // encoded the soft-skip defect AS the contract.
    expect(guardSteps).toHaveLength(1);
    expect(guardSteps[0]).toContain('SCHEMA_DRIFT_TOKEN is not set');

    // Committed state: no token, absence declared acceptable -> amber.
    const amber = runSteps(guardSteps, { SCHEMA_DRIFT_OPTIONAL: 'true' });
    expect(amber.status).toBe(3);
    expect(amber.stdout).toContain('RESULT: SKIPPED');

    // The flipped state the operator will ship -> hard failure, and NOT on the
    // drift code. Exit 4 is what keeps "you forgot the token" distinguishable
    // from "the schema diverged"; both were exit 1 before.
    const closed = runSteps(guardSteps, { SCHEMA_DRIFT_OPTIONAL: 'false' });
    expect(closed.status).toBe(4);
    expect(closed.stdout).toContain('RESULT: MISCONFIGURED');
    expect(closed.stdout).toContain('NOT drift');
  });

  it('EXECUTES the token-present path: guard falls through, a failed clone exits 5 — never the drift code', () => {
    // Two bugs in one run, both of them "the flip breaks CI for a reason that
    // has nothing to do with schema drift":
    //   (a) an inverted `-z`/`-n` in the guard — with the token finally set,
    //       the job would short-circuit on the no-token branch forever and the
    //       check would never run. Status would be 3/4 here instead of 5.
    //   (b) a clone failure (wrong scope, expired token, unreachable host)
    //       surfacing as a bare git exit — indistinguishable from drift to the
    //       first responder, who then hunts a diff that does not exist.
    // `git` is shimmed to fail, so this needs no network and no private repo.
    const shimDir = mkdtempSync(join(tmpdir(), 'so-git-shim-'));
    tmpDirs.push(shimDir);
    writeFileSync(join(shimDir, 'git'), '#!/bin/sh\necho "fatal: authentication failed" >&2\nexit 128\n', {
      mode: 0o755,
    });

    const res = runSteps(
      [guardSteps[0], cloneSteps[0]],
      {
        SCHEMA_DRIFT_OPTIONAL: 'true',
        // Deliberately UNDER 20 chars after the `glpat-` prefix: the F8 fixture-shape
        // guard (scripts/lib/validate/check-test-fixture-shapes.mjs) flags
        // /glpat-[A-Za-z0-9_-]{20,}/, i.e. anything long enough to look like a real
        // PAT. The clone is shimmed to fail regardless, so the value is never used.
        SCHEMA_DRIFT_TOKEN: 'glpat-PLACEHOLDER',
        CI_SERVER_HOST: 'gitlab.invalid',
      },
      shimDir,
    );

    expect(res.status).toBe(5);
    expect(res.stdout).toContain('RESULT: UNAVAILABLE');
    expect(res.stdout).not.toContain('RESULT: SKIPPED');
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

// The real coverage job swallowed a missing XML file AND threshold failures in
// pipeline 8817. Run its parsed steps, replacing only the expensive test process
// with a result writer and relocating shared /tmp paths into an isolated cwd.
const coverageJob = doc.coverage;
const coverageMetrics = ['lines', 'functions', 'statements', 'branches'];
const coverageThresholds = vitestConfig.test.coverage.thresholds;

function coverageSummary() {
  return { total: Object.fromEntries(coverageMetrics.map((metric) => [metric, {
    total: 100, covered: coverageThresholds[metric], skipped: 0, pct: coverageThresholds[metric],
  }])) };
}

function cobertura(summary) {
  const { lines, branches } = summary.total;
  return `<?xml version="1.0" ?>\n<coverage lines-valid="${lines.total}" lines-covered="${lines.covered}" line-rate="${lines.pct / 100}" branches-valid="${branches.total}" branches-covered="${branches.covered}" branch-rate="${branches.pct / 100}"><sources><source>fixture</source></sources><packages><package name="fixture"><classes><class name="fixture" filename="fixture.mjs"><methods/><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>\n`;
}

function runCoverageJob({ summary = coverageSummary(), xml, log = '', stale = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'so-coverage-job-'));
  tmpDirs.push(dir);
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'coverage'));
  symlinkSync(resolve('scripts'), join(dir, 'scripts'), 'dir');
  if (stale) {
    writeFileSync(join(dir, 'coverage/coverage-summary.json'), JSON.stringify(coverageSummary()));
    writeFileSync(join(dir, 'coverage/cobertura-coverage.xml'), cobertura(coverageSummary()));
    mkdirSync(join(dir, '.ci-markers'));
    writeFileSync(join(dir, '.ci-markers/coverage.ok'), 'stale marker');
  }
  writeFileSync(join(dir, 'write-results.mjs'), `
    import { writeFileSync } from 'node:fs';
    if (process.env.COV_SUMMARY !== undefined) writeFileSync('coverage/coverage-summary.json', process.env.COV_SUMMARY);
    if (process.env.COV_XML !== undefined) writeFileSync('coverage/cobertura-coverage.xml', process.env.COV_XML);
    writeFileSync('cov-result.json', JSON.stringify({ success: true, numTotalTests: 6000, numPassedTests: 6000, numFailedTests: 0, numFailedTestSuites: 0 }));
    process.stdout.write(process.env.COV_LOG);
  `);
  writeFileSync(join(dir, 'bin/timeout'), '#!/bin/sh\nexec "$TEST_NODE" write-results.mjs\n', { mode: 0o755 });
  const env = { TEST_NODE: process.execPath, COV_LOG: log };
  if (summary !== null) env.COV_SUMMARY = typeof summary === 'string' ? summary : JSON.stringify(summary);
  if (xml !== null) env.COV_XML = xml ?? cobertura(typeof summary === 'object' && summary?.total ? summary : coverageSummary());
  const steps = coverageJob.script.map((step) => step
    .replaceAll('/tmp/cov-result.json', 'cov-result.json').replaceAll('/tmp/cov.log', 'cov.log'));
  return { ...runSteps(steps, env, join(dir, 'bin'), dir), marker: existsSync(join(dir, '.ci-markers/coverage.ok')) };
}

describe('coverage CI job fails closed before its verified marker (#1279)', () => {
  it('accepts complete reports exactly at the configured thresholds', () => {
    const result = runCoverageJob();
    expect(result.status, result.stderr).toBe(0);
    expect(result.marker).toBe(true);
    const match = result.stdout.match(new RegExp(coverageJob.coverage.slice(1, -1), 'm'));
    expect(match, 'GitLab must find the verified coverage line').not.toBeNull();
    expect(Number(match[0].match(/\d+(?:\.\d+)?/)[0])).toBe(coverageThresholds.lines);
  });

  it.each([
    ['missing Cobertura', { xml: null }],
    ['empty Cobertura', { xml: '' }],
    ['malformed Cobertura', { xml: '<coverage><packages></coverage>' }],
    ['Cobertura with totals but no body', { xml: cobertura(coverageSummary()).replace(/<sources>[\s\S]*<\/packages>/, '') }],
    ['Cobertura with only an unknown child', { xml: cobertura(coverageSummary()).replace(/<sources>[\s\S]*<\/packages>/, '<junk/>') }],
    ['contradictory duplicate XML attributes', { xml: cobertura(coverageSummary()).replace('line-rate="', 'line-rate="0" line-rate="') }],
    ['missing summary', { summary: null }],
    ['truncated summary', { summary: '{"total":' }],
    ['unknown summary shape', { summary: { result: 'success' } }],
  ])('rejects %s even when all tests passed', (_name, input) => {
    const result = runCoverageJob(input);
    expect(result.status).not.toBe(0);
    expect(result.marker).toBe(false);
  });

  it.each(coverageMetrics)('rejects %s below its canonical floor regardless of log wording', (metric) => {
    const summary = coverageSummary();
    summary.total[metric].covered--;
    summary.total[metric].pct--;
    const log = metric === 'lines'
      ? `ERROR: Coverage for lines (${summary.total.lines.pct}%) does not meet global threshold (${coverageThresholds.lines}%)\n`
      : metric === 'branches' ? 'Coverage for branches (59%) below\n' : '';
    const result = runCoverageJob({ summary, log });
    expect(result.status).not.toBe(0);
    expect(result.marker).toBe(false);
  });

  it('rejects incomplete or contradictory numeric coverage data', () => {
    for (const corrupt of [
      (summary) => { delete summary.total.statements; },
      (summary) => { summary.total.functions.pct = '100'; },
      (summary) => { summary.total.statements.covered = 101; },
      (summary) => { summary.total.statements.pct = 100; },
    ]) {
      const summary = coverageSummary();
      corrupt(summary);
      const result = runCoverageJob({ summary });
      expect(result.status).not.toBe(0);
      expect(result.marker).toBe(false);
    }
  });

  it('cannot reuse prior reports or a prior verified marker after an incomplete run', () => {
    const result = runCoverageJob({ summary: null, xml: null, stale: true });
    expect(result.status).not.toBe(0);
    expect(result.marker).toBe(false);
  });

  it('the configured Vitest reporters produce both CI artifacts in a real instrumented run', () => {
    const dir = mkdtempSync(join(tmpdir(), 'so-coverage-reporters-'));
    tmpDirs.push(dir);
    symlinkSync(resolve('node_modules'), join(dir, 'node_modules'), 'dir');
    writeFileSync(join(dir, 'fixture.mjs'), 'export function choose(value) { return value ? 1 : 2; }\n');
    writeFileSync(join(dir, 'fixture.test.mjs'), "import { it, expect } from 'vitest'; import { choose } from './fixture.mjs'; it('covers both branches', () => { expect(choose(true)).toBe(1); expect(choose(false)).toBe(2); });\n");
    writeFileSync(join(dir, 'vitest.config.mjs'), `import config from ${JSON.stringify(pathToFileURL(resolve('vitest.config.mjs')).href)};
      export default { ...config, test: { ...config.test, include: ['fixture.test.mjs'], setupFiles: [], globalSetup: [], maxWorkers: 1,
        coverage: { ...config.test.coverage, enabled: true, include: ['fixture.mjs'], exclude: [] } } };\n`);
    const result = spawnSync(process.execPath, [resolve('node_modules/vitest/vitest.mjs'), 'run'], {
      cwd: dir, encoding: 'utf8', timeout: 20_000,
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const verified = runCoverageJob({
      summary: readFileSync(join(dir, 'coverage/coverage-summary.json'), 'utf8'),
      xml: readFileSync(join(dir, 'coverage/cobertura-coverage.xml'), 'utf8'),
    });
    expect(verified.status, verified.stderr).toBe(0);
    expect(verified.marker).toBe(true);
  }, 25_000);
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
    // every pipeline red while the token is legitimately unconfigured → gate
    // deleted; (b) the missing marker reported as VERIFIED → the soft path is
    // green again, one level up. Asserting the NOT-VERIFIED notice pins (b).
    // Since the hard gate armed (2026-09-03, #1175), the committed default is
    // SCHEMA_DRIFT_OPTIONAL: "false" — this test exercises the amber branch
    // explicitly (still a real code path: a temporary revert or a token-
    // rotation window), not the committed default.
    const res = runGate({ markers: ['coverage.ok'], source: 'merge_request_event', optional: 'true' });

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

  it('ships ARMED: both jobs commit SCHEMA_DRIFT_OPTIONAL="false" (#1175)', () => {
    // bug_caught: a half-revert or a template refresh flipping ONE site back
    // to "true" after the hard gate was activated (2026-09-03, #1175) — the
    // parity test above catches a two-sided disagreement but is satisfied by
    // both sites drifting back to "true" together, which would silently
    // re-open the amber-tolerate hole #933 was written to close. Pinning the
    // literal committed value on both jobs is the only thing that catches
    // that case.
    expect(job.variables.SCHEMA_DRIFT_OPTIONAL).toBe('false');
    expect(gateJob.variables.SCHEMA_DRIFT_OPTIONAL).toBe('false');
  });
});
