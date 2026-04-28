import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const YAML_PATH = resolve(process.cwd(), '.gitlab-ci.yml');
const yaml = readFileSync(YAML_PATH, 'utf8');

describe('schema-drift-check CI job (#279)', () => {
  it('uses SCHEMA_DRIFT_TOKEN instead of CI_JOB_TOKEN for the clone URL', () => {
    // The fix for #279: clone must use oauth2:${SCHEMA_DRIFT_TOKEN}, not CI_JOB_TOKEN.
    expect(yaml).toContain('oauth2:${SCHEMA_DRIFT_TOKEN}');
  });

  it('does not use CI_JOB_TOKEN in the clone URL', () => {
    // CI_JOB_TOKEN returns 403 on cross-project access without an allowlist.
    // The variable may still appear in comments — we check the clone line only.
    const cloneLine = yaml
      .split('\n')
      .find((line) => line.includes('git clone') || line.includes('gitlab-ci-token'));
    // If a git clone line exists it must NOT use the old token form.
    if (cloneLine !== undefined) {
      expect(cloneLine).not.toContain('gitlab-ci-token:${CI_JOB_TOKEN}');
    }
    // Also verify the token-form clone is present somewhere in the file.
    expect(yaml).toContain('SCHEMA_DRIFT_TOKEN');
  });

  it('includes a missing-token fallback that exits 0', () => {
    // When SCHEMA_DRIFT_TOKEN is unset the job must warn and exit 0, not fail.
    expect(yaml).toContain('SCHEMA_DRIFT_TOKEN is not set');
    expect(yaml).toContain('exit 0');
  });

  it('sets allow_failure to false now that the token-based path is reliable', () => {
    // The old job had allow_failure: true as a band-aid. With SCHEMA_DRIFT_TOKEN
    // the clone will succeed and the failure mode is real drift, not infra noise.
    // Extract the schema-drift-check block to avoid matching other jobs.
    const jobStart = yaml.indexOf('schema-drift-check:');
    const jobEnd = yaml.indexOf('\n\n', jobStart);
    const jobBlock = yaml.slice(jobStart, jobEnd === -1 ? undefined : jobEnd);
    expect(jobBlock).toContain('allow_failure: false');
    expect(jobBlock).not.toContain('allow_failure: true');
  });
});
