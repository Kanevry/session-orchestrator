/**
 * gitleaks.mjs — Security-Delta check `gitleaks` (#1769, stage 1). COUNT ONLY.
 *
 * Runs gitleaks over the commit range `base..head` and reports one finding per
 * affected file with the distinct rule ids. SEC-008: report entries are mapped
 * to `{ File, RuleID }` the moment they are parsed — `Secret`, `Match`, `Line`
 * and every other value field are never kept, returned or logged — and the
 * temporary report is deleted in a `finally`.
 *
 * CLI form, measured 2026-10-23 against gitleaks 8.30.1 (Homebrew):
 *   gitleaks git [repo] --log-opts=<range> --redact=100 --report-format json
 *     --report-path <file> --exit-code 0 --no-banner [--config <toml>]
 * `git` exists since v8.19.0; older versions spell it
 *   gitleaks detect --source <repo> --log-opts=<range> …
 * (the `detect` help of 8.30.1 still lists `--log-opts`/`--source`).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { commandOnPath } from '../native-command.mjs';
import { BUDGET, makeCheckResult, makeFinding } from './contract.mjs';
import { isSafeRef } from './floating-tags.mjs';

/** First version with the `git` subcommand. */
const GIT_SUBCOMMAND_SINCE = [8, 19, 0];

/**
 * Run a command; resolve with exit code and captured stdout (capped). Never rejects.
 * @returns {Promise<{code:number|null, stdout:string, timedOut:boolean, error:boolean}>}
 */
function runCommand(spawnImpl, cmd, args, { cwd, timeoutMs, captureStdout = false }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(cmd, args, { cwd, shell: false, stdio: ['ignore', captureStdout ? 'pipe' : 'ignore', 'ignore'] });
    } catch {
      resolve({ code: null, stdout: '', timedOut: false, error: true });
      return;
    }
    let stdout = '';
    let timedOut = false;
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      finish({ code: null, stdout, timedOut: true, error: false });
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4096) stdout += String(chunk);
    });
    child.on('error', () => finish({ code: null, stdout, timedOut, error: true }));
    child.on('close', (code) => finish({ code, stdout, timedOut, error: false }));
  });
}

/**
 * Parse `gitleaks version` output (`8.30.1`, `v8.18.4`).
 * @param {string} text
 * @returns {number[]|null}
 */
export function parseGitleaksVersion(text) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Argument vector for the detected version. Unknown version → the modern `git` form.
 * @param {number[]|null} version
 * @param {{repoRoot:string, range:string, reportPath:string, configPath:string|null}} o
 * @returns {string[]}
 */
export function buildGitleaksArgs(version, { repoRoot, range, reportPath, configPath }) {
  const modern =
    !version ||
    version[0] > GIT_SUBCOMMAND_SINCE[0] ||
    (version[0] === GIT_SUBCOMMAND_SINCE[0] && version[1] >= GIT_SUBCOMMAND_SINCE[1]);
  const common = [
    `--log-opts=${range}`,
    '--redact=100',
    '--report-format',
    'json',
    '--report-path',
    reportPath,
    '--exit-code',
    '0',
    '--no-banner',
  ];
  if (configPath) common.push('--config', configPath);
  return modern ? ['git', ...common, repoRoot] : ['detect', '--source', repoRoot, ...common];
}

/**
 * Reduce a gitleaks JSON report to `{ File, RuleID }` pairs. Every other field
 * (Secret, Match, Line, …) is dropped here and never leaves this function.
 * @param {string} text
 * @returns {{File:string, RuleID:string}[]}
 */
export function reduceReport(text) {
  const parsed = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new TypeError('gitleaks report is not an array');
  return parsed
    .map((e) => ({ File: typeof e?.File === 'string' ? e.File : '', RuleID: typeof e?.RuleID === 'string' ? e.RuleID : '' }))
    .filter((e) => e.File && e.RuleID);
}

/**
 * Count secrets gitleaks finds in the commits of `base..head`. Never throws.
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string|null} [opts.base]          empty → skipped/no-range
 * @param {string} [opts.head]
 * @param {typeof spawn} [opts.spawnImpl]
 * @param {(bin:string) => boolean} [opts.onPath]
 * @param {number} [opts.timeoutMs]          ceiling for the scan
 * @returns {Promise<ReturnType<typeof makeCheckResult>>}
 */
export async function runGitleaksCheck({
  repoRoot,
  base,
  head,
  spawnImpl = spawn,
  onPath = commandOnPath,
  timeoutMs = BUDGET.totalMs,
} = {}) {
  const started = Date.now();
  const done = (r) => makeCheckResult({ id: 'gitleaks', ms: Date.now() - started, ...r });
  let dir = null;
  try {
    if (!base) return done({ status: 'skipped', reason: 'no-range' });
    if (!isSafeRef(base) || !isSafeRef(head)) return done({ status: 'degraded', reason: 'invalid-ref', unchecked: 1 });
    if (!onPath('gitleaks')) return done({ status: 'skipped', reason: 'binary-absent' });

    const ver = await runCommand(spawnImpl, 'gitleaks', ['version'], { cwd: repoRoot, timeoutMs: 2000, captureStdout: true });
    const version = parseGitleaksVersion(ver.stdout);

    dir = await mkdtemp(join(tmpdir(), 'secdelta-gitleaks-'));
    const reportPath = join(dir, 'report.json');
    const configFile = join(repoRoot, '.gitleaks.toml');
    const args = buildGitleaksArgs(version, {
      repoRoot,
      range: `${base}..${head}`,
      reportPath,
      configPath: existsSync(configFile) ? configFile : null,
    });
    const remaining = Math.max(1, timeoutMs - (Date.now() - started));
    const run = await runCommand(spawnImpl, 'gitleaks', args, { cwd: repoRoot, timeoutMs: remaining });
    if (run.timedOut) return done({ status: 'degraded', reason: 'timeout', unchecked: 1 });
    if (run.error || run.code !== 0) return done({ status: 'degraded', reason: 'gitleaks-error', unchecked: 1 });

    let entries;
    try {
      entries = reduceReport(await readFile(reportPath, 'utf8'));
    } catch {
      return done({ status: 'degraded', reason: 'report-unreadable', unchecked: 1 });
    }
    const byFile = new Map();
    for (const { File, RuleID } of entries) {
      if (!byFile.has(File)) byFile.set(File, new Set());
      byFile.get(File).add(RuleID);
    }
    const findings = [...byFile].map(([file, rules]) =>
      makeFinding({ class: 'secret', severity: 'high', ecosystem: null, package: null, file, ids: [...rules].sort(), introduced: true }),
    );    return done({ status: 'ok', checked: 1, findings });
  } catch {
    return done({ status: 'degraded', reason: 'internal-error', unchecked: 1 });
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
