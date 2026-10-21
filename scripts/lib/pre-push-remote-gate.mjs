#!/usr/bin/env node
// Optional pre-push router: 0 verified, 1 blocked, 2 SO_GATE_HOSTS invalid or none of its
// hosts could run the gate (blocked, no local fallback), 10 transport/readiness fallback.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfigFile } from './config/io.mjs';
import { _parseRemoteHosts } from './config/remote-hosts.mjs';
import { isMainModule } from './is-main-module.mjs';
import { admitSuiteCounts, joinGateKillFields } from './gates/gate-helpers.mjs';
import { resolveWaveNumber } from './quality-gate-wave.mjs';

const log = (message) => process.stderr.write(`pre-push: ${message}\n`);

// offload sync creates a snapshot commit even for a clean source. Check out the
// pushed SHA again and reject extra source files before invoking the real gate.
// A nonce-bound receipt separates command failures from offload's overlapping
// transport exit codes. No receipt is ever interpreted as a passing gate.
function remoteCommand(sha, nonce) {
  return `
    const { spawnSync } = require('node:child_process');
    const { writeSync } = require('node:fs');
    const sha = ${JSON.stringify(sha)}, nonce = ${JSON.stringify(nonce)};
      const env = { ...process.env };
      for (const key of Object.keys(env)) {
        if (/(PROJECT_DIR|PLUGIN_ROOT|RULES_DIR)$/.test(key) ||
            /^GIT_/.test(key) && !/^GIT_(AUTHOR_|COMMITTER_|EDITOR$|ASKPASS$|SSH$|SSH_COMMAND$|TERMINAL_PROMPT$|EXEC_PATH$)/.test(key)) delete env[key];
      }
    const git = (...args) => spawnSync('git', args, { env, encoding: 'utf8' });
    let result = { nonce, sha, exit_code: 1, report: null };
    const checkout = git('checkout', '--quiet', '--detach', sha);
    const head = git('rev-parse', 'HEAD');
    const tracked = git('status', '--porcelain', '--untracked-files=no');
    const extras = git('ls-files', '--others', '--exclude-standard', '--exclude=node_modules');
    if (checkout.status === 0 && head.status === 0 && head.stdout.trim() === sha &&
        tracked.status === 0 && !tracked.stdout.trim() && extras.status === 0 && !extras.stdout.trim()) {
      const gate = spawnSync('npm', ['run', '--silent', 'quality-gate'],
        { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (gate.stdout) writeSync(1, gate.stdout);
      if (gate.stderr) writeSync(2, gate.stderr);
      result.exit_code = gate.status;
      try { result.report = JSON.parse(gate.stdout); } catch {}
    }
    writeSync(1, '\\nSO_PRE_PUSH_RESULT=' + JSON.stringify(result) + '\\n');
    process.exit(result.exit_code === 0 ? 0 : 1);
  `;
}

const ALIAS_SHAPE = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the `SO_GATE_HOSTS` override (#1626) against the offload host registry.
 *
 * The registry rule mirrors offload's own `load_host`:
 * `${OFFLOAD_CONFIG_DIR:-$HOME/.config/remote-offload}/hosts/<alias>.env` must be a
 * regular file. The alias shape is checked BEFORE any path is built, so `/` and
 * `..` can never reach the filesystem.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ hosts: string[], source: 'override' } | { error: string } | null}
 *   null when the override is unset (whitespace-only counts as unset).
 */
export function resolveGateHostOverride(env = process.env) {
  const raw = (env.SO_GATE_HOSTS || '').trim();
  if (!raw) return null;
  const configDir = (env.OFFLOAD_CONFIG_DIR || '').trim() || join((env.HOME || '').trim() || homedir(), '.config/remote-offload');
  const registry = join(configDir, 'hosts');
  const hosts = raw.split(',').map((alias) => alias.trim()).filter(Boolean);
  for (const alias of hosts) {
    let known = false;
    if (ALIAS_SHAPE.test(alias) && alias !== '.' && alias !== '..') {
      try { known = statSync(join(registry, `${alias}.env`)).isFile(); } catch { known = false; }
    }
    if (!known) {
      return { error: `SO_GATE_HOSTS names unknown or invalid host '${alias}' — no regular file ${alias}.env in ${registry}. Push blocked (no local fallback).` };
    }
  }
  return hosts.length ? { hosts, source: 'override' } : { error: `SO_GATE_HOSTS='${raw}' contains no host alias. Push blocked.` };
}

/** The `gate-ready=<value>` token of an `offload doctor --brief` run (stdout or stderr), or null. */
function gateReadyToken(doctor) {
  return /\bgate-ready=(\S+)/.exec(`${doctor.stdout ?? ''}\n${doctor.stderr ?? ''}`)?.[1] ?? null;
}

/**
 * Gate readiness of one host (#1627). doctor's exit code also covers headless
 * readiness, which a gate does not need: a Windows host reports `gate-ready=yes` with
 * exit 1 because `headless-ready=NO`. The token decides when present; an offload
 * without it keeps the old exit-code rule. A spawn error (timeout) is not ready.
 *
 * @param {{ error?: Error, status: number | null, stdout?: string, stderr?: string }} doctor
 * @returns {boolean}
 */
export function gateReady(doctor) {
  if (doctor.error) return false;
  const token = gateReadyToken(doctor);
  return token === null ? doctor.status === 0 : token === 'yes';
}

/**
 * Did the remote gate re-run its timeout-only failures clean (#1673)? Checked
 * here on the report's own fields, not on `rerun.status` alone: zero failures,
 * no timeout, no signal sent, no survivor, and exactly the first run's failing
 * files — no more, no fewer.
 */
function cleanRerun(test) {
  const rerun = test?.rerun;
  if (rerun?.status !== 'pass' || rerun.failed !== 0 || rerun.timed_out !== false) return false;
  if (!Array.isArray(rerun.kill_signals) || rerun.kill_signals.length !== 0) return false;
  if (!Array.isArray(rerun.survivors) || rerun.survivors.length !== 0) return false;
  const failedFiles = Array.isArray(test.failed_files) ? test.failed_files : [];
  const files = Array.isArray(rerun.files) ? rerun.files : [];
  return failedFiles.length > 0 && files.length === failedFiles.length &&
    new Set(files).size === files.length && failedFiles.every((f) => files.includes(f));
}

/**
 * Run the full quality gate for `sha` on a remote host via offload (the body of the
 * pre-push router, #1712). Exit-code contract of `code`: 0 verified, 1 blocked,
 * 2 SO_GATE_HOSTS invalid or none of its hosts could run the gate, 10 fallback.
 *
 * @param {object} opts
 * @param {string} opts.tree checkout offload syncs (its basename names the host repo)
 * @param {string} opts.sha commit the remote gate must check out and verify
 * @param {string} opts.ledgerRoot repo root for events and wave attribution
 * @param {NodeJS.ProcessEnv} [opts.env] source of the SO_GATE_HOSTS override
 * @param {boolean} [opts.emit=true] emit `orchestrator.quality_gate.*` — false for
 *   callers whose `sha` is not a pushed commit (snapshot probe)
 * @param {string} [opts.jobPrefix='pre-push'] offload job name prefix
 * @param {(message: string) => void} [opts.log]
 * @param {{ write: (chunk: string) => unknown }} [opts.stdout=process.stdout] sink for the remote
 *   run's stdout — a caller that owns its own stdout (snapshot probe `--json`) routes it elsewhere
 * @param {{ write: (chunk: string) => unknown }} [opts.stderr=process.stderr] sink for the remote run's stderr
 * @returns {Promise<{ code: number, passed: boolean, alias: string | null, report: object | null, hostSource: string }>}
 */
export async function runRemoteGate({ tree, sha, ledgerRoot, env = process.env, emit = true, jobPrefix = 'pre-push', log: logFn = log,
  stdout = process.stdout, stderr = process.stderr }) {
  let hosts;
  let hostSource = 'config';
  const done = (code) => ({ code, passed: false, alias: null, report: null, hostSource });
  const override = resolveGateHostOverride(env);
  if (override?.error) {
    logFn(override.error);
    return done(2);
  }
  if (override) {
    hosts = override.hosts.map((alias) => ({ alias }));
    hostSource = 'override';
    logFn(`gate host order from SO_GATE_HOSTS (host_source: override): ${override.hosts.join(', ')}.`);
  } else {
    try {
      hosts = _parseRemoteHosts(await readConfigFile(tree)).filter((host) => host['roles-allowed'].includes('test'));
    } catch {
      logFn('remote configuration unavailable — using local gate (host_source: fallback).');
      return done(10);
    }
  }
  for (const { alias } of hosts) {
    logFn(`checking remote readiness (${alias}).`);
    const doctor = spawnSync('offload', ['doctor', '-H', alias, '--brief', '--no-probe'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (doctor.error?.code === 'ENOENT') break;
    if (!gateReady(doctor)) {
      const token = gateReadyToken(doctor);
      logFn(`remote ${alias} not ready (exit ${doctor.status ?? doctor.error?.code}${token ? `, gate-ready=${token}` : ''}) — trying next route.`);
      continue;
    }
    const nonce = randomUUID();
    logFn(`running full quality gate remotely on ${alias} (host_source: ${hostSource}) against pushed SHA ${sha}.`);
    // No --link-modules: offload snapshots a linked node_modules symlink into its commit (.gitignore's
    // `node_modules/` matches directories only), and the `git checkout <sha>` in remoteCommand then
    // deletes it, so vitest/eslint exit 127 and the gate reports them as "fail" (push blocked).
    const run = spawnSync('offload', ['run', '-H', alias, tree, '--job', `${jobPrefix}-${nonce}`,
      '--klasse', 'gate', '--rm', '--timeout', '1800', '--', 'node', '-e', remoteCommand(sha, nonce)],
    { encoding: 'utf8', timeout: 1_860_000, maxBuffer: 64 * 1024 * 1024 });
    stdout.write(run.stdout ?? '');
    stderr.write(run.stderr ?? '');
    const receipts = (run.stdout ?? '').split(/\r?\n/).filter((line) => line.startsWith('SO_PRE_PUSH_RESULT='));
    let receipt;
    try { if (receipts.length === 1) receipt = JSON.parse(receipts[0].slice('SO_PRE_PUSH_RESULT='.length)); } catch { /* unknown blocks */ }
    if (receipts.length === 0 && !run.error && [2, 4, 8, 10, 255].includes(run.status)) {
      logFn(`remote ${alias} transport/readiness failure (exit ${run.status}) — trying next route.`);
      continue;
    }
    const report = receipt?.report;
    const stubbedChecks = Object.keys(report?.stubbed ?? {});
    if (stubbedChecks.length > 0) logFn(`remote gate contains stubbed checks: ${stubbedChecks.join(', ')} — Push blocked.`);
    const passed = !run.error && run.status === 0 && receipt?.nonce === nonce && receipt.sha === sha &&
      receipt.exit_code === 0 && report?.variant === 'full-gate' && report.test?.status === 'pass' &&
      // `failed` stays the first, parallel run's count; it is acceptable only when
      // the gate re-ran exactly those timeout-only failures clean (#1673).
      stubbedChecks.length === 0 && !(report.test.failed > 0 && !cleanRerun(report.test)) &&
      report.test.suite_died !== true &&
      ['pass', 'skip'].includes(report.typecheck?.status) && ['pass', 'skip'].includes(report.lint?.status) &&
      ![report.test, report.typecheck, report.lint].some((check) => check.timed_out === true);
    if (emit) try {
      const { emitEvent, sessionAttribution } = await import('./events.mjs');
      const counts = admitSuiteCounts(report?.test);
      const waveNumber = resolveWaveNumber(ledgerRoot);
      await emitEvent(`orchestrator.quality_gate.${passed ? 'passed' : 'failed'}`, {
        variant: 'full-gate', exit_code: passed ? 0 : 1, remote_host: alias, host: alias, host_source: hostSource,
        pushed_sha: sha, ...sessionAttribution(ledgerRoot),
        ...joinGateKillFields({ outer: {}, gateStdout: JSON.stringify(report) }),
        ...(counts ? { counts } : {}),
        ...(waveNumber !== null ? { wave_number: waveNumber } : {}),
        ...(report?.test?.failed_files?.length ? { failed_files: report.test.failed_files } : {}),
        ...(Array.isArray(report?.test?.rerun?.files) && report.test.rerun.files.length
          ? { rerun: { files: report.test.rerun.files, status: report.test.rerun.status } } : {}),
      }, { repoRoot: ledgerRoot });
    } catch { /* telemetry cannot change the blocking verdict */ }
    logFn(`remote quality gate ${passed ? 'passed' : 'FAILED — Push blocked'} (${alias}).`);
    return { code: passed ? 0 : 1, passed, alias, report: report ?? null, hostSource };
  }
  if (hostSource === 'override') {
    // An explicit override names where the gate may run; silently falling back to the
    // local host is the case the override exists to prevent (#1626).
    logFn(`no SO_GATE_HOSTS route could run the gate (${hosts.map((h) => h.alias).join(', ')}) — Push blocked (no local fallback).`);
    return done(2);
  }
  logFn('remote routes unavailable — local fallback (host: local, host_source: fallback; an origin MR branch takes the partial gate, #1642).');
  return done(10);
}

async function main() {
  const [tree, sha, ledgerRoot] = process.argv.slice(2);
  const r = await runRemoteGate({ tree, sha, ledgerRoot });
  return r.code;
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
