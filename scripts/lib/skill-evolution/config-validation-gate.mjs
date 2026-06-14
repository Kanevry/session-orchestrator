/**
 * config-validation-gate.mjs — DETERMINISTIC config-validation gate for the C2
 * auto-repair engine (Epic #643 Skill Self-Evolution Foundation / issue #647 C2).
 *
 * This gate guards C2's autonomous-apply path: a proposed config repair may only
 * be applied autonomously when ALL three config sub-checks are GREEN.
 *
 * It composes three independent sub-checks, every one of which must pass:
 *   1. parse-config   — `scripts/parse-config.mjs` assembles the Session Config
 *                        JSON (run with SO_SKIP_CONFIG_VALIDATION=1 so it emits
 *                        the RAW assembled config without embedded validation,
 *                        decoupling it from sub-check 2).
 *   2. config-schema  — `validateSessionConfig()` (direct import, so the result
 *                        is independent of the repo's enforcement mode) run over
 *                        the JSON produced by sub-check 1.
 *   3. drift-check    — `skills/claude-md-drift-check/checker.mjs` (CLAUDE.md ↔
 *                        template parity). An infra error (exit 2) is treated as
 *                        a FAILURE — it must NOT silently pass the gate.
 *
 * IMPORTANT: this is NOT the code quality-gate (test / typecheck / lint). It does
 * not — and must not — import `scripts/lib/quality-gate.mjs`. It validates
 * configuration health only.
 *
 * The module never throws: a spawn failure or unparseable output degrades to a
 * red sub-check, which fails the aggregate gate (fail-closed).
 *
 * Consumer: the C2 auto-repair engine, which calls runConfigValidationGate()
 * before applying any autonomous config repair.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * @typedef {object} SubCheckResult
 * @property {'parse-config'|'config-schema'|'drift-check'} name — sub-check id
 * @property {boolean} ok — true iff this sub-check passed
 * @property {number} exitCode — process exit code (or synthetic 0/1)
 * @property {string} output — captured output / error detail (empty when ok)
 */

/**
 * @typedef {object} GateResult
 * @property {boolean} ok — true iff every sub-check passed
 * @property {SubCheckResult[]} checks — per-sub-check results, in run order
 */

/**
 * Run the deterministic config-validation gate.
 *
 * @param {object} args
 * @param {string} args.repoRoot — absolute path to the repo root; all sub-check
 *   paths are resolved from here (cwd is NOT assumed).
 * @param {string} [args.configFilePath] — optional explicit CLAUDE.md/AGENTS.md
 *   path passed to parse-config; when omitted parse-config resolves it itself.
 * @param {'hard'|'warn'|'off'} [args.driftMode='hard'] — drift-check `--mode`.
 * @param {object} [opts] — DI seam for testing.
 * @param {typeof spawnSync} [opts.spawn] — injectable spawnSync replacement.
 * @param {(json: unknown) => {ok: boolean, errors?: unknown}} [opts.validate]
 *   — injectable schema validator (defaults to the real validateSessionConfig).
 * @returns {Promise<GateResult>}
 */
export async function runConfigValidationGate(
  { repoRoot, configFilePath, driftMode = 'hard' },
  opts = {},
) {
  const spawn = opts.spawn ?? spawnSync;
  const validate = opts.validate ?? (await loadValidator());

  const checks = [];

  // --- Sub-check 1: parse-config -------------------------------------------
  // SO_SKIP_CONFIG_VALIDATION=1 → emit raw assembled-config JSON without the
  // embedded validation pass (that is sub-check 2's job).
  const parseResult = runParseConfig({ spawn, repoRoot, configFilePath });
  checks.push(parseResult.check);

  // --- Sub-check 2: config-schema ------------------------------------------
  const schemaResult = runConfigSchema({
    validate,
    parseConfigOk: parseResult.check.ok,
    parseConfigStdout: parseResult.stdout,
  });
  checks.push(schemaResult);

  // --- Sub-check 3: drift-check --------------------------------------------
  const driftResult = runDriftCheck({ spawn, repoRoot, driftMode });
  checks.push(driftResult);

  // --- Aggregate (fail-closed) ---------------------------------------------
  const ok = checks.every((c) => c.ok === true);

  return { ok, checks };
}

/**
 * Lazily import the real schema validator. Kept out of the module top-level so a
 * (hypothetical) import failure can be reported rather than crashing the import.
 *
 * @returns {Promise<(json: unknown) => {ok: boolean, errors?: unknown}>}
 */
async function loadValidator() {
  const mod = await import('../config-schema.mjs');
  return mod.validateSessionConfig;
}

/**
 * Sub-check 1 — run scripts/parse-config.mjs with validation skipped.
 *
 * @returns {{ check: SubCheckResult, stdout: string }}
 */
function runParseConfig({ spawn, repoRoot, configFilePath }) {
  const scriptPath = join(repoRoot, 'scripts', 'parse-config.mjs');
  const argv = [scriptPath, ...(configFilePath ? [configFilePath] : [])];

  try {
    const res = spawn('node', argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, SO_SKIP_CONFIG_VALIDATION: '1' },
    });

    if (res.error) {
      return {
        check: {
          name: 'parse-config',
          ok: false,
          exitCode: res.status ?? 1,
          output: res.error.message,
        },
        stdout: '',
      };
    }

    const stdout = res.stdout ?? '';
    const ok = res.status === 0;
    return {
      check: {
        name: 'parse-config',
        ok,
        exitCode: res.status ?? 1,
        output: ok ? '' : (res.stderr ?? '') || stdout,
      },
      stdout,
    };
  } catch (err) {
    return {
      check: {
        name: 'parse-config',
        ok: false,
        exitCode: err.status ?? 1,
        output: err.message,
      },
      stdout: '',
    };
  }
}

/**
 * Sub-check 2 — validate the assembled config JSON against the schema.
 * Direct invocation of validateSessionConfig() so the verdict is independent of
 * the repo's enforcement mode.
 *
 * @returns {SubCheckResult}
 */
function runConfigSchema({ validate, parseConfigOk, parseConfigStdout }) {
  // If parse-config failed or produced nothing parseable, there is no JSON to
  // validate — fail closed.
  if (!parseConfigOk || typeof parseConfigStdout !== 'string' || parseConfigStdout.trim() === '') {
    return {
      name: 'config-schema',
      ok: false,
      exitCode: 1,
      output: 'parse-config produced no usable JSON',
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(parseConfigStdout);
  } catch {
    return {
      name: 'config-schema',
      ok: false,
      exitCode: 1,
      output: 'parse-config produced no usable JSON',
    };
  }

  try {
    const r = validate(parsed);
    const ok = r.ok === true;
    return {
      name: 'config-schema',
      ok,
      exitCode: ok ? 0 : 1,
      output: ok ? '' : JSON.stringify(r.errors),
    };
  } catch (err) {
    return {
      name: 'config-schema',
      ok: false,
      exitCode: 1,
      output: err.message,
    };
  }
}

/**
 * Sub-check 3 — run the claude-md-drift-check checker.
 *
 * Green iff the parsed JSON reports zero errors. Exit 2 (infra error) and any
 * unparseable stdout are treated as FAILURES — an infra failure must not
 * silently pass the gate.
 *
 * @returns {SubCheckResult}
 */
function runDriftCheck({ spawn, repoRoot, driftMode }) {
  const checkerPath = join(repoRoot, 'skills', 'claude-md-drift-check', 'checker.mjs');
  const argv = [checkerPath, '--mode', driftMode];

  try {
    const res = spawn('node', argv, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, VAULT_DIR: repoRoot },
    });

    if (res.error) {
      return {
        name: 'drift-check',
        ok: false,
        exitCode: res.status ?? 1,
        output: res.error.message,
      };
    }

    const exitCode = res.status ?? 1;
    const stdout = res.stdout ?? '';

    // Infra error (exit 2) must NOT silently pass the gate.
    if (exitCode === 2) {
      return {
        name: 'drift-check',
        ok: false,
        exitCode,
        output: (res.stderr ?? '') || stdout || 'drift-check infra error (exit 2)',
      };
    }

    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      return {
        name: 'drift-check',
        ok: false,
        exitCode,
        output: 'drift-check produced unparseable output',
      };
    }

    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    const ok = errors.length === 0;
    return {
      name: 'drift-check',
      ok,
      exitCode,
      output: ok ? '' : JSON.stringify(errors),
    };
  } catch (err) {
    return {
      name: 'drift-check',
      ok: false,
      exitCode: err.status ?? 1,
      output: err.message,
    };
  }
}
