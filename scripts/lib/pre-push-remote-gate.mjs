#!/usr/bin/env node
// Optional pre-push router: 0 verified, 1 blocked, 10 transport/readiness fallback.
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

async function main() {
  const [tree, sha, ledgerRoot] = process.argv.slice(2);
  let hosts;
  try {
    hosts = _parseRemoteHosts(await readConfigFile(tree)).filter((host) => host['roles-allowed'].includes('test'));
  } catch {
    log('remote configuration unavailable — using local gate.');
    return 10;
  }
  for (const { alias } of hosts) {
    log(`checking remote readiness (${alias}).`);
    const doctor = spawnSync('offload', ['doctor', '-H', alias, '--brief', '--no-probe'],
      { encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024 });
    if (doctor.error?.code === 'ENOENT') break;
    if (doctor.error || doctor.status !== 0) {
      log(`remote ${alias} not ready (exit ${doctor.status ?? doctor.error?.code}) — trying next route.`);
      continue;
    }
    const nonce = randomUUID();
    log(`running full quality gate remotely on ${alias} against pushed SHA ${sha}.`);
    const run = spawnSync('offload', ['run', '-H', alias, tree, '--job', `pre-push-${nonce}`,
      '--klasse', 'gate', '--link-modules', '--rm', '--timeout', '1800', '--', 'node', '-e', remoteCommand(sha, nonce)],
    { encoding: 'utf8', timeout: 1_860_000, maxBuffer: 64 * 1024 * 1024 });
    process.stdout.write(run.stdout ?? '');
    process.stderr.write(run.stderr ?? '');
    const receipts = (run.stdout ?? '').split(/\r?\n/).filter((line) => line.startsWith('SO_PRE_PUSH_RESULT='));
    let receipt;
    try { if (receipts.length === 1) receipt = JSON.parse(receipts[0].slice('SO_PRE_PUSH_RESULT='.length)); } catch { /* unknown blocks */ }
    if (receipts.length === 0 && !run.error && [2, 4, 8, 10, 255].includes(run.status)) {
      log(`remote ${alias} transport/readiness failure (exit ${run.status}) — trying next route.`);
      continue;
    }
    const report = receipt?.report;
    const stubbedChecks = Object.keys(report?.stubbed ?? {});
    if (stubbedChecks.length > 0) log(`remote gate contains stubbed checks: ${stubbedChecks.join(', ')} — Push blocked.`);
    const passed = !run.error && run.status === 0 && receipt?.nonce === nonce && receipt.sha === sha &&
      receipt.exit_code === 0 && report?.variant === 'full-gate' && report.test?.status === 'pass' &&
      stubbedChecks.length === 0 && !(report.test.failed > 0) && report.test.suite_died !== true &&
      ['pass', 'skip'].includes(report.typecheck?.status) && ['pass', 'skip'].includes(report.lint?.status) &&
      ![report.test, report.typecheck, report.lint].some((check) => check.timed_out === true);
    try {
      const { emitEvent, sessionAttribution } = await import('./events.mjs');
      const counts = admitSuiteCounts(report?.test);
      const waveNumber = resolveWaveNumber(ledgerRoot);
      await emitEvent(`orchestrator.quality_gate.${passed ? 'passed' : 'failed'}`, {
        variant: 'full-gate', exit_code: passed ? 0 : 1, remote_host: alias,
        pushed_sha: sha, ...sessionAttribution(ledgerRoot),
        ...joinGateKillFields({ outer: {}, gateStdout: JSON.stringify(report) }),
        ...(counts ? { counts } : {}),
        ...(waveNumber !== null ? { wave_number: waveNumber } : {}),
        ...(report?.test?.failed_files?.length ? { failed_files: report.test.failed_files } : {}),
      }, { repoRoot: ledgerRoot });
    } catch { /* telemetry cannot change the blocking verdict */ }
    log(`remote quality gate ${passed ? 'passed' : 'FAILED — Push blocked'} (${alias}).`);
    return passed ? 0 : 1;
  }
  log('remote routes unavailable — using local full quality gate.');
  return 10;
}

if (isMainModule(import.meta.url)) process.exitCode = await main();
