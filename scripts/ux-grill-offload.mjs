#!/usr/bin/env node
/**
 * ux-grill-offload.mjs — run ux-grill Stufe 1 on a remote-offload host, in one command.
 *
 * For a machine that must not build, serve or drive a browser itself. The app
 * and the browser then run together on the host, so the loopback rule of
 * `scripts/lib/ux-grill/manifest.mjs` holds for real: server and `agent-browser`
 * share one machine.
 *
 *   node scripts/ux-grill-offload.mjs --repo <target repo> [--app-dir website]
 *        [--host m5] [--ref HEAD] [--out <dir>] [--build <cmd>|--no-build]
 *        [--start "<cmd with {port}>"] [--klasse gate] [--timeout 1800] [--keep]
 *
 * Steps:
 *   1. admission from `offload status --json` (offload's own verdict, no own threshold);
 *   2. a `git archive <ref>` image of the target repo outside ~/Projects, named like
 *      the repo, with the repo's `origin` — offload resolves the host repo by that
 *      name and fetches objects into it. The target checkout itself is only read:
 *      `offload sync` of the checkout would append a line to its events ledger.
 *      The image carries the existing manifest and ledger from `--out`, so
 *      `compareRuns()` sees earlier runs;
 *   3. `offload run … -- true` of this session-orchestrator checkout (sync plus a
 *      finished job, so `clean` can remove it), then `offload run` of the image
 *      with `scripts/ux-grill-offload-host.mjs`;
 *   4. the artefacts come back framed on stdout and are unpacked into `--out`
 *      (default: the target repo). An existing manifest is never overwritten,
 *      the ledger only gains this run's lines;
 *   5. `offload clean --job … --apply` for both jobs, and the local image is removed.
 *
 * Exit: 0 ok · 1 usage · 2 offload missing or refused (overload: exit 10 of offload) ·
 * 3 the host run failed · 4 artefacts could not be read back.
 * Issues are never filed here; `reconcileFindings()` stays with the operator (SKILL.md § Phase 4).
 */

import { Buffer } from 'node:buffer';
import { execFile as execFileCb, spawn } from './lib/native-command.mjs';
import { appendFileSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { isMainModule } from './lib/is-main-module.mjs';
import { DEFAULT_MANIFEST_PATH } from './lib/ux-grill/manifest.mjs';
import {
  OFFLOAD_EXIT_MESSAGES,
  OffloadGrillError,
  admissionFromStatus,
  decodeHostOutput,
  newLedgerLines,
  parseSyncWorktree,
  repoNameFromCommonDir,
} from './lib/ux-grill/offload.mjs';
import { assertRunId } from './lib/test-runner/artifact-paths.mjs';
import { UX_GRILL_LEDGER, UX_GRILL_METRICS_DIR, runRecordPath } from './lib/ux-grill/paths.mjs';

const execFile = promisify(execFileCb);
const SO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_SCRIPT = 'scripts/ux-grill-offload-host.mjs';

const USAGE = `usage: node scripts/ux-grill-offload.mjs --repo <target repo> [--app-dir <dir>] [--host m5] [--ref HEAD]
       [--out <dir>] [--build <cmd> | --no-build] [--start "<cmd with {port}>"] [--klasse gate] [--timeout 1800] [--keep]`;

/**
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const out = { repo: null, appDir: '.', host: 'm5', ref: 'HEAD', out: null, build: undefined, start: undefined, klasse: 'gate', timeout: 1800, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new OffloadGrillError('usage', `${arg} needs a value\n${USAGE}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case '--repo': out.repo = path.resolve(next()); break;
      case '--app-dir': out.appDir = next(); break;
      case '-H': case '--host': out.host = next(); break;
      case '--ref': out.ref = next(); break;
      case '--out': out.out = path.resolve(next()); break;
      case '--build': out.build = next(); break;
      case '--no-build': out.build = null; break;
      case '--start': out.start = next(); break;
      case '--klasse': out.klasse = next(); break;
      case '--timeout': out.timeout = Number(next()); break;
      case '--keep': out.keep = true; break;
      case '-h': case '--help': throw new OffloadGrillError('help', USAGE);
      default: throw new OffloadGrillError('usage', `unknown argument ${arg}\n${USAGE}`);
    }
  }
  if (!out.repo) throw new OffloadGrillError('usage', `--repo is required\n${USAGE}`);
  if (!Number.isInteger(out.timeout) || out.timeout <= 0) throw new OffloadGrillError('usage', '--timeout must be a positive integer (seconds)');
  if (path.isAbsolute(out.appDir) || out.appDir.split(/[\\/]/).includes('..')) {
    throw new OffloadGrillError('usage', '--app-dir must be a path inside the target repo');
  }
  out.out ??= out.repo;
  return out;
}

/**
 * argv for `offload run` of the image with the host script (contract-tested).
 * @param {object} o
 * @returns {string[]}
 */
export function buildRunArgv({ host, image, job, klasse, timeout, soWorktree, appDir, build, start }) {
  const hostArgs = ['--app-dir', appDir];
  if (build === null) hostArgs.push('--no-build');
  else if (typeof build === 'string') hostArgs.push('--build', build);
  if (typeof start === 'string') hostArgs.push('--start', start);
  return ['run', '-H', host, image, '--job', job, '--klasse', klasse, '--timeout', String(timeout),
    '--', 'node', path.posix.join(soWorktree, HOST_SCRIPT), ...hostArgs];
}

function log(line) {
  process.stderr.write(`ux-grill-offload: ${line}\n`);
}

/** Run offload, streaming its stderr through, capturing stdout. */
function offload(args, { capture = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('offload', args, { stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    const chunks = [];
    child.stdout?.on('data', (c) => chunks.push(c));
    child.once('error', (err) => reject(err.code === 'ENOENT'
      ? new OffloadGrillError('no-offload', 'offload is not on PATH — this path needs the remote-offload tool (projects-baseline scripts/remote-offload)')
      : err));
    child.once('close', (code) => resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') }));
  });
}

function offloadFailure(step, code) {
  const what = OFFLOAD_EXIT_MESSAGES[code] ?? `offload exited ${code}`;
  return new OffloadGrillError(code === 10 ? 'host-overloaded' : `offload-${step}`, `${step}: ${what} (offload exit ${code})`);
}

async function gitOut(args) {
  const { stdout } = await execFile('git', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout.trim();
}

/** The target repo as a fresh one-commit repo outside ~/Projects, plus the state ux-grill compares against. */
async function buildImage(o, stamp, parent) {
  const origin = await gitOut(['-C', o.repo, 'remote', 'get-url', 'origin']).catch(() => '');
  if (!origin) throw new OffloadGrillError('no-origin', 'the target repo has no origin remote; offload needs it to hold the objects on the host');
  const sha = await gitOut(['-C', o.repo, 'rev-parse', '--verify', `${o.ref}^{commit}`]);
  // The main checkout's name, also from a linked worktree (offload maps the image by folder name).
  const name = repoNameFromCommonDir(await gitOut(['-C', o.repo, 'rev-parse', '--path-format=absolute', '--git-common-dir']));
  const image = path.join(parent, name);
  mkdirSync(image);
  const tarFile = path.join(parent, 'src.tar');
  await execFile('git', ['-C', o.repo, 'archive', '--format=tar', '-o', tarFile, sha]);
  await execFile('tar', ['-xf', tarFile, '-C', image]);
  rmSync(tarFile);

  // State ux-grill compares against: manifest, ledger (where #1722 puts it for
  // --out, also from a linked worktree), each earlier run's findings.
  const carried = [];
  const sources = [[DEFAULT_MANIFEST_PATH, path.join(o.out, DEFAULT_MANIFEST_PATH)], [UX_GRILL_LEDGER, runRecordPath(o.out)]];
  for (const [rel, src] of sources) {
    if (existsSync(src)) {
      mkdirSync(path.dirname(path.join(image, rel)), { recursive: true });
      copyFileSync(src, path.join(image, rel));
      carried.push(rel);
    }
  }
  const metrics = path.join(o.out, UX_GRILL_METRICS_DIR);
  if (existsSync(metrics)) {
    for (const run of readdirSync(metrics)) {
      const findings = path.join(metrics, run, 'findings.jsonl');
      if (!isRunId(run) || !existsSync(findings)) continue;
      mkdirSync(path.join(image, UX_GRILL_METRICS_DIR, run), { recursive: true });
      copyFileSync(findings, path.join(image, UX_GRILL_METRICS_DIR, run, 'findings.jsonl'));
    }
  }
  const git = (...args) => execFile('git', ['-C', image, '-c', 'user.name=ux-grill-offload', '-c', 'user.email=ux-grill@example.org', '-c', 'commit.gpgsign=false', ...args]);
  await git('init', '-q');
  await git('add', '-A', '-f');
  await git('commit', '-q', '-m', `ux-grill image of ${name}@${sha.slice(0, 12)} (${stamp})`);
  await git('remote', 'add', 'origin', origin);
  log(`image ${name}@${sha.slice(0, 12)} in ${image} (carried: ${carried.join(', ') || 'nothing'})`);
  return { image, name, sha };
}

/** assertRunId() as a predicate: the pattern, and never "." or "..". */
function isRunId(value) {
  try { assertRunId(value); return true; } catch { return false; }
}

/** Every entry under dir must be a regular file or a directory — no symlink, device or fifo. */
function assertPlainTree(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const st = lstatSync(full);
    if (st.isDirectory()) assertPlainTree(full);
    else if (!st.isFile()) throw new OffloadGrillError('artefact-not-regular', `artefact ${entry.name} is not a regular file; refusing to land it`);
  }
}

/**
 * Unpack the host tarball into --out: manifest only when absent, ledger by
 * append, run dir copied. The host stream is untrusted input: the target repo's
 * build ran there, so the run id is validated and every member must be a
 * regular file before anything is read or copied.
 *
 * @param {{out: string}} o
 * @param {Buffer} artefacts - gzip'd tar from the host
 * @param {string} runId
 * @returns {Promise<string[]>} what was written, repo-relative
 */
export async function landArtefacts(o, artefacts, runId) {
  if (!isRunId(runId)) {
    throw new OffloadGrillError('bad-run-id', 'host result carries no valid runId');
  }
  const staging = mkdtempSync(path.join(os.tmpdir(), 'so-uxgrill-out-'));
  try {
    const tgz = path.join(staging, 'artefacts.tgz');
    writeFileSync(tgz, artefacts);
    const unpacked = path.join(staging, 'x');
    mkdirSync(unpacked);
    await execFile('tar', ['-xzf', tgz, '-C', unpacked]);
    assertPlainTree(unpacked);
    const written = [];

    const manifestSrc = path.join(unpacked, DEFAULT_MANIFEST_PATH);
    const manifestDst = path.join(o.out, DEFAULT_MANIFEST_PATH);
    if (existsSync(manifestSrc)) {
      if (!existsSync(manifestDst)) {
        mkdirSync(path.dirname(manifestDst), { recursive: true });
        copyFileSync(manifestSrc, manifestDst);
        written.push(DEFAULT_MANIFEST_PATH);
      } else if (readFileSync(manifestSrc, 'utf8') !== readFileSync(manifestDst, 'utf8')) {
        log(`kept the existing ${DEFAULT_MANIFEST_PATH}; the host copy differs and is not written`);
      }
    }
    const ledgerSrc = path.join(unpacked, UX_GRILL_LEDGER);
    if (existsSync(ledgerSrc)) {
      const ledgerDst = runRecordPath(o.out);
      const local = existsSync(ledgerDst) ? readFileSync(ledgerDst, 'utf8') : '';
      const fresh = newLedgerLines(local, readFileSync(ledgerSrc, 'utf8'));
      if (fresh.length > 0) {
        mkdirSync(path.dirname(ledgerDst), { recursive: true });
        appendFileSync(ledgerDst, `${local && !local.endsWith('\n') ? '\n' : ''}${fresh.join('\n')}\n`);
        written.push(`${UX_GRILL_LEDGER} (+${fresh.length})`);
      }
    }
    const runSrc = path.join(unpacked, UX_GRILL_METRICS_DIR, runId);
    if (existsSync(runSrc)) {
      cpSync(runSrc, path.join(o.out, UX_GRILL_METRICS_DIR, runId), { recursive: true, errorOnExist: true, force: false });
      written.push(`${UX_GRILL_METRICS_DIR}/${runId}/`);
    }
    return written;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  const jobBase = `uxgrill-${stamp.toLowerCase()}-${process.pid}`;

  const status = await offload(['status', '-H', o.host, '--json']);
  if (status.code !== 0) throw offloadFailure('status', status.code);
  let statusJson;
  try {
    statusJson = JSON.parse(status.stdout);
  } catch {
    throw new OffloadGrillError('status-unreadable', `offload status -H ${o.host} --json printed no JSON`);
  }
  const admission = admissionFromStatus(statusJson, o.klasse);
  if (!admission.ok) throw new OffloadGrillError('host-overloaded', `${o.host}: ${admission.reason} — retry later or pick another host with -H`);

  const parent = mkdtempSync(path.join(os.tmpdir(), 'so-uxgrill-'));
  const soJob = `${jobBase}-so`;
  const imgJob = `${jobBase}-app`;
  const jobs = [];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    if (o.keep) {
      log(`kept jobs ${jobs.join(', ') || 'none'} on ${o.host} and the image in ${parent}`);
      return;
    }
    for (const job of jobs) {
      const res = await offload(['clean', '-H', o.host, '--job', job, '--apply']).catch(() => ({ code: -1, stdout: '' }));
      // clean exits 0 also when it KEEPS an unfinished job; say so instead of hiding it.
      // Per-job line `kept    <job> (…)`; the summary `clean: N job(s) removed, 0 kept` is not one.
      if (res.code !== 0 || /^kept\s/m.test(res.stdout)) {
        log(`offload job ${job} is still on ${o.host}; remove it later with: offload clean -H ${o.host} --job ${job} --apply`);
      }
    }
    rmSync(parent, { recursive: true, force: true });
  };
  const onSigint = () => { cleanup().finally(() => process.exit(130)); };
  process.once('SIGINT', onSigint);
  try {
    const img = await buildImage(o, stamp, parent);
    // `run … -- true` rather than `sync`: a sync-only job never counts as
    // finished, so `offload clean --apply` keeps it for 2 h (measured 2026-11-21).
    jobs.push(soJob);
    const synced = await offload(['run', '-H', o.host, SO_ROOT, '--job', soJob, '--klasse', o.klasse, '--timeout', '900', '--', 'true']);
    if (synced.code !== 0) throw offloadFailure('sync', synced.code);
    const soWorktree = parseSyncWorktree(synced.stdout);

    jobs.push(imgJob);
    const ran = await offload(buildRunArgv({ host: o.host, image: img.image, job: imgJob, klasse: o.klasse, timeout: o.timeout, soWorktree, appDir: o.appDir, build: o.build, start: o.start }));
    let decoded;
    try {
      decoded = decodeHostOutput(ran.stdout);
    } catch (err) {
      // A cut stream after a timeout or a lost host is offload's failure, not a frame defect.
      if (ran.code !== 0) throw offloadFailure('run', ran.code);
      throw err;
    }
    const { result, artefacts } = decoded;
    if (ran.code !== 0 || result?.error) {
      const reason = result?.error ? `[${result.error.code}] ${result.error.message}` : (OFFLOAD_EXIT_MESSAGES[ran.code] ?? `exit ${ran.code}`);
      throw new OffloadGrillError(ran.code === 10 ? 'host-overloaded' : 'host-run-failed', `host run failed: ${reason}`);
    }
    if (!result || !artefacts) throw new OffloadGrillError('no-artefacts', 'the host run printed no result or artefacts');
    const written = await landArtefacts(o, artefacts, result.runId);
    process.stdout.write(`${JSON.stringify({ ...result, host: o.host, target: `${img.name}@${img.sha.slice(0, 12)}`, out: o.out, written })}\n`);
  } finally {
    process.removeListener('SIGINT', onSigint);
    await cleanup();
  }
}

if (isMainModule(import.meta.url)) {
  main().then(
    () => { process.exitCode = 0; },
    (err) => {
      if (err?.code === 'help') { process.stdout.write(`${err.message}\n`); process.exitCode = 0; return; }
      process.stderr.write(`ux-grill-offload: ${err?.message ?? String(err)}\n`);
      const exit = { usage: 1, 'no-offload': 2, 'host-overloaded': 2, 'status-unreadable': 2, 'no-origin': 1, 'host-run-failed': 3, 'no-artefacts': 4, 'bad-run-id': 4, 'artefact-not-regular': 4, 'frame-incomplete': 4, 'frame-checksum': 4, 'frame-ambiguous': 4, 'frame-unreadable': 4 };
      process.exitCode = exit[err?.code] ?? 3;
    },
  );
}
