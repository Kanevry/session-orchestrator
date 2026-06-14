/**
 * config-validation-gate.test.mjs — Unit tests for runConfigValidationGate
 * (Epic #643 / issue #647 C2 auto-repair engine).
 *
 * The SUT composes three sub-checks (parse-config, config-schema, drift-check)
 * via two DI seams: `opts.spawn` (replaces spawnSync) and `opts.validate`
 * (replaces validateSessionConfig). Every test exercises the REAL
 * runConfigValidationGate and asserts on the returned { ok, checks } envelope —
 * the seams only stand in for the subprocess + schema validator (BE-012:
 * no test merely asserts a mock was called).
 */

import { describe, it, expect } from 'vitest';
import { runConfigValidationGate } from '@lib/skill-evolution/config-validation-gate.mjs';

const REPO = '/tmp/fake-repo';

/**
 * Build a spawn seam that routes by which sub-check script is being invoked.
 * argv[0] is the resolved script path; we match on substring.
 *
 * @param {{ parseConfig: object, driftCheck: object }} responses
 *   each response = a spawnSync-like result { status, stdout?, stderr?, error? }
 */
function makeSpawn(responses) {
  return (cmd, argv) => {
    const scriptPath = argv[0];
    if (scriptPath.includes('parse-config.mjs')) return responses.parseConfig;
    if (scriptPath.includes('checker.mjs')) return responses.driftCheck;
    throw new Error(`unexpected spawn target: ${scriptPath}`);
  };
}

/** A parse-config response that emits a valid raw config JSON. */
const PARSE_OK = { status: 0, stdout: '{"persistence":true}', stderr: '' };

/** A drift-check response that reports zero errors (clean). */
const DRIFT_OK = { status: 0, stdout: '{"errors":[]}', stderr: '' };

/** A validate seam that always passes. */
const validatePass = () => ({ ok: true });

describe('runConfigValidationGate — all green', () => {
  it('returns ok:true with all three sub-checks ok:true when every check passes', async () => {
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      { spawn: makeSpawn({ parseConfig: PARSE_OK, driftCheck: DRIFT_OK }), validate: validatePass },
    );

    expect(result.ok).toBe(true);
    expect(result.checks).toHaveLength(3);
    expect(result.checks.map((c) => c.name)).toEqual([
      'parse-config',
      'config-schema',
      'drift-check',
    ]);
    expect(result.checks.every((c) => c.ok === true)).toBe(true);
  });
});

describe('runConfigValidationGate — parse-config failure', () => {
  it('returns ok:false with the parse-config check ok:false on non-zero exit', async () => {
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      {
        spawn: makeSpawn({
          parseConfig: { status: 1, stdout: '', stderr: 'config parse boom' },
          driftCheck: DRIFT_OK,
        }),
        validate: validatePass,
      },
    );

    expect(result.ok).toBe(false);
    const parse = result.checks.find((c) => c.name === 'parse-config');
    expect(parse.ok).toBe(false);
    expect(parse.exitCode).toBe(1);
    expect(parse.output).toBe('config parse boom');
  });

  it('cascades a parse-config failure into a red config-schema sub-check', async () => {
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      {
        spawn: makeSpawn({
          parseConfig: { status: 1, stdout: '', stderr: 'boom' },
          driftCheck: DRIFT_OK,
        }),
        validate: validatePass,
      },
    );

    const schema = result.checks.find((c) => c.name === 'config-schema');
    expect(schema.ok).toBe(false);
    expect(schema.output).toBe('parse-config produced no usable JSON');
  });
});

describe('runConfigValidationGate — config-schema failure', () => {
  it('returns ok:false when the validator reports ok:false with errors', async () => {
    const validateFail = () => ({ ok: false, errors: ['bad-key: unknown'] });
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      {
        spawn: makeSpawn({ parseConfig: PARSE_OK, driftCheck: DRIFT_OK }),
        validate: validateFail,
      },
    );

    expect(result.ok).toBe(false);
    const schema = result.checks.find((c) => c.name === 'config-schema');
    expect(schema.ok).toBe(false);
    expect(schema.exitCode).toBe(1);
    expect(schema.output).toBe(JSON.stringify(['bad-key: unknown']));
  });
});

describe('runConfigValidationGate — drift-check failure', () => {
  it('returns ok:false when drift-check reports a non-empty errors array', async () => {
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      {
        spawn: makeSpawn({
          parseConfig: PARSE_OK,
          driftCheck: { status: 0, stdout: '{"errors":["Check 6: missing key"]}', stderr: '' },
        }),
        validate: validatePass,
      },
    );

    expect(result.ok).toBe(false);
    const drift = result.checks.find((c) => c.name === 'drift-check');
    expect(drift.ok).toBe(false);
    expect(drift.output).toBe(JSON.stringify(['Check 6: missing key']));
  });

  it('treats drift-check infra exit code 2 as a FAILURE (must not silently pass)', async () => {
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      {
        spawn: makeSpawn({
          parseConfig: PARSE_OK,
          driftCheck: { status: 2, stdout: '', stderr: 'infra explosion' },
        }),
        validate: validatePass,
      },
    );

    expect(result.ok).toBe(false);
    const drift = result.checks.find((c) => c.name === 'drift-check');
    expect(drift.ok).toBe(false);
    expect(drift.exitCode).toBe(2);
    expect(drift.output).toBe('infra explosion');
  });

  it('returns ok:false when drift-check stdout is unparseable JSON', async () => {
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      {
        spawn: makeSpawn({
          parseConfig: PARSE_OK,
          driftCheck: { status: 0, stdout: 'not-json-at-all', stderr: '' },
        }),
        validate: validatePass,
      },
    );

    expect(result.ok).toBe(false);
    const drift = result.checks.find((c) => c.name === 'drift-check');
    expect(drift.ok).toBe(false);
    expect(drift.output).toBe('drift-check produced unparseable output');
  });
});

describe('runConfigValidationGate — aggregation contract', () => {
  it('ok equals checks.every(c => c.ok): one red sub-check makes the gate red', async () => {
    const validateFail = () => ({ ok: false, errors: ['x'] });
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      {
        // parse-config + drift-check green, only config-schema red
        spawn: makeSpawn({ parseConfig: PARSE_OK, driftCheck: DRIFT_OK }),
        validate: validateFail,
      },
    );

    expect(result.ok).toBe(false);
    expect(result.ok).toBe(result.checks.every((c) => c.ok === true));
    expect(result.checks.find((c) => c.name === 'parse-config').ok).toBe(true);
    expect(result.checks.find((c) => c.name === 'config-schema').ok).toBe(false);
    expect(result.checks.find((c) => c.name === 'drift-check').ok).toBe(true);
  });

  it('fails closed when spawn reports an error object (subprocess could not start)', async () => {
    const result = await runConfigValidationGate(
      { repoRoot: REPO },
      {
        spawn: makeSpawn({
          parseConfig: { error: new Error('spawn ENOENT node'), status: undefined },
          driftCheck: DRIFT_OK,
        }),
        validate: validatePass,
      },
    );

    expect(result.ok).toBe(false);
    const parse = result.checks.find((c) => c.name === 'parse-config');
    expect(parse.ok).toBe(false);
    expect(parse.output).toBe('spawn ENOENT node');
  });
});
