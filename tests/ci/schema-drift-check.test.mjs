import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
